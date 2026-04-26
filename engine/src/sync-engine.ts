import { readdir, stat, rename, unlink, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, dirname, basename } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { IpcPushEvent, FileSyncedPayload, ReconcileProgressPayload } from "./ipc.js";
import type { DriveClient, DriveEvent, EventSubscription, LatestEventIdProvider, RemoteFile } from "./sdk.js";
import { DriveEventType } from "./sdk.js";
import type { ChangeQueueEntry, StateDb, SyncPair, SyncState } from "./state-db.js";
import { listConfigPairs, type ConfigPair } from "./config.js";
import { AuthExpiredError, NetworkError, RateLimitError, SyncError } from "./errors.js";
import { detectConflict } from "./conflict.js";
import { debugLog } from "./debug-log.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when the error is a network-level fetch failure from undici or our own NetworkError. */
function isFetchFailure(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  // Use .name check (not instanceof) — Bun --compile can produce cross-realm
  // TypeErrors from bundled undici where instanceof TypeError is false.
  if (err instanceof Error && err.name === "TypeError" && err.message === "fetch failed") return true;
  return false;
}

function isAuthExpired(err: unknown): boolean {
  return err instanceof AuthExpiredError;
}

function isDiskFull(err: unknown): boolean {
  return err != null && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOSPC";
}

function isPermissionDenied(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return true;
  // SDK may re-throw without preserving .code — check message string as fallback
  const msg = (err as Error).message ?? "";
  return msg.includes("EACCES") || msg.includes("EPERM") || msg.includes("permission denied");
}

function isFileLocked(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EBUSY" || code === "ETXTBSY") return true;
  // SDK may re-throw without preserving .code — check message string as fallback
  const msg = (err as Error).message ?? "";
  return msg.includes("EBUSY") || msg.includes("ETXTBSY");
}

function isLocalFolderMissing(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

// True when a SQLite FOREIGN KEY constraint failed — happens when remove_pair
// IPC deletes a sync_pair row while reconcilePair is awaiting for that pair.
function isForeignKeyConstraint(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const msg = (err as Error).message ?? "";
  return msg.includes("FOREIGN KEY constraint failed");
}

// ── Internal types ───────────────────────────────────────────────────────────

interface LocalFile {
  relativePath: string;
  mtime: string; // ISO 8601
  size: number;
}

type WorkItem =
  | {
      kind: "upload";
      relativePath: string;
      remoteFolderId: string;
      /** Set when updating an existing remote file — upload a new revision. */
      existingNodeUid?: string;
      size: number;
      localMtime: string;
    }
  | {
      kind: "download";
      relativePath: string;
      nodeUid: string;
      size: number;
      remoteMtime: string;
    }
  | { kind: "delete_local"; relativePath: string }
  | { kind: "trash_remote"; relativePath: string; remoteNodeId: string }
  | { kind: "clear_state"; relativePath: string }
  | {
      kind: "conflict";
      relativePath: string;
      remoteNodeId: string;   // needed by Story 4-3 to download winning version
      remoteMtime: string;    // needed by Story 4-3 for sync_state update
      remoteSize: number;     // needed by Story 4-3 for progress reporting
    }
  | {
      kind: "new_file_collision";
      relativePath: string;
      remoteNodeId: string;
      remoteMtime: string;
      remoteSize: number;
    }
  | {
      /** Both sides exist, no sync state, and mtime+size match — record as already synced. */
      kind: "bootstrap_match";
      relativePath: string;
      remoteNodeId: string;
      remoteMtime: string;
      localMtime: string;
    };

// ── Safety constants ─────────────────────────────────────────────────────────

const MAX_DRAIN_ATTEMPTS = 5;    // dead-letter change_queue entry after N "failed" outcomes
const MAX_REMOTE_TREE_DEPTH = 50; // guard against circular remote folder graphs

// ── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private driveClient: DriveClient | null = null;
  // Re-entrancy guard. True while a drainQueue() call is in flight; bounced
  // concurrent calls return zero counts immediately. See AC4 (Story 2-12).
  private isDraining = false;
  // Populated by reconcilePair; read by both sync_complete emitters.
  private _pairStats = new Map<string, { fileCount: number; totalBytes: number }>();
  private eventSubscription?: EventSubscription;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly stateDb: StateDb,
    private readonly emitEvent: (event: IpcPushEvent) => void,
    private readonly getConfigPairs: () => ConfigPair[] = listConfigPairs,
    private readonly onNetworkFailure: () => void = () => {},
    private readonly onTokenExpired: () => void = () => {},
    private readonly sleepMs: (ms: number) => Promise<void> =
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Retry `fn` with exponential backoff on RateLimitError.
   * Emits `rate_limited` push event before each sleep.
   * Max 5 attempts (attempts 0–4); re-throws on the 5th failure.
   * Sleep duration: min(2^attempt, 30) seconds.
   */
  private async withBackoff<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_RETRIES = 5;
    const MAX_BACKOFF_S = 30;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof RateLimitError && attempt < MAX_RETRIES - 1) {
          const resumeIn = Math.min(Math.pow(2, attempt), MAX_BACKOFF_S);
          this.emitEvent({
            type: "rate_limited",
            payload: { resume_in_seconds: resumeIn },
          });
          await this.sleepMs(resumeIn * 1000);
          continue;
        }
        throw err;
      }
    }
    // Unreachable (loop always returns or throws), but TypeScript needs this.
    throw new SyncError("withBackoff: exhausted retries");
  }

  setDriveClient(client: DriveClient | null): void {
    this.driveClient = client;
  }

  makeLatestEventIdProvider(): LatestEventIdProvider {
    return {
      getLatestEventId: async (scopeId: string) =>
        this.stateDb.getEventCheckpoint(scopeId),
    };
  }

  private makeEventCallback(): (event: DriveEvent) => Promise<void> {
    return async (event: DriveEvent) => {
      try {
        const newCheckpoint =
          event.type === DriveEventType.TreeRefresh ||
          event.type === DriveEventType.TreeRemove
            ? null
            : event.eventId ?? null;

        this.stateDb.persistEvent(
          event.treeEventScopeId,
          event.type,
          JSON.stringify(event),
          newCheckpoint,
        );

        this.scheduleDrain();
      } catch (err) {
        debugLog("Failed to persist event (non-fatal): " + String(err));
        // Never rethrow — DriveListener must not throw (SDK contract)
      }
    };
  }

  private scheduleDrain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      if (this.driveClient) void this.drainEventQueue(this.driveClient);
    }, 500);
  }

  async drainEventQueue(client: DriveClient): Promise<void> {
    let events = this.stateDb.getQueuedEvents();
    while (events.length > 0) {
      for (const entry of events) {
        try {
          const parsedEvent = JSON.parse(entry.event_payload) as DriveEvent;

          if (parsedEvent.type === DriveEventType.FastForward) {
            debugLog("Caught up to: " + parsedEvent.eventId);
            this.stateDb.deleteQueuedEvent(entry.id);

          } else if (parsedEvent.type === DriveEventType.TreeRefresh) {
            this.stateDb.deleteQueuedEvent(entry.id);
            this.stateDb.clearQueuedEvents(entry.tree_event_scope_id);
            await this.reconcileAndEnqueue(true);
            break; // restart drain loop after full walk

          } else if (
            parsedEvent.type === DriveEventType.NodeCreated ||
            parsedEvent.type === DriveEventType.NodeUpdated
          ) {
            const nodeEvent = parsedEvent as Extract<DriveEvent, { type: DriveEventType.NodeCreated | DriveEventType.NodeUpdated }>;
            const parentUid = (nodeEvent as { parentNodeUid?: string }).parentNodeUid;
            const pairs = this.stateDb.listPairs();

            // Fast path for NodeUpdated: look up the file we already track by its remote UID
            const knownFile = parsedEvent.type === DriveEventType.NodeUpdated
              ? this.stateDb.findSyncStateByRemoteNodeId(nodeEvent.nodeUid)
              : null;

            // For NodeCreated (or unknown NodeUpdated): check if parent is a sync pair root
            const rootPair = !knownFile && parentUid
              ? pairs.find(p => p.remote_id === parentUid)
              : null;

            if (knownFile) {
              // Updated file we already track — targeted enqueue, no API call needed
              this.stateDb.enqueue({
                pair_id: knownFile.pair_id,
                relative_path: knownFile.relative_path,
                change_type: "modified",
                queued_at: new Date().toISOString(),
              });
            } else if (rootPair) {
              // Direct child of a sync root — fetch name and enqueue targeted
              const result = await client.getRemoteNode(nodeEvent.nodeUid);
              if (!result.ok) {
                debugLog(`drainEventQueue: node ${nodeEvent.nodeUid} unavailable, skipping`);
                this.stateDb.deleteQueuedEvent(entry.id);
                continue;
              }
              this.stateDb.enqueue({
                pair_id: rootPair.pair_id,
                relative_path: result.value.name,
                change_type: "modified",
                queued_at: new Date().toISOString(),
              });
            } else {
              // Parent not locally known (deep subfolder or brand-new folder) — fall back
              debugLog(`drainEventQueue: parent ${parentUid ?? "unknown"} not locally known, falling back to reconcile-trigger`);
              for (const pair of pairs) {
                this.stateDb.enqueue({
                  pair_id: pair.pair_id,
                  relative_path: ".reconcile-trigger",
                  change_type: "modified",
                  queued_at: new Date().toISOString(),
                });
              }
            }
            this.stateDb.deleteQueuedEvent(entry.id);

          } else if (parsedEvent.type === DriveEventType.NodeDeleted) {
            const deletedEvent = parsedEvent as Extract<DriveEvent, { type: DriveEventType.NodeDeleted }>;
            const tracked = this.stateDb.findSyncStateByRemoteNodeId(deletedEvent.nodeUid);
            if (tracked) {
              this.stateDb.enqueue({
                pair_id: tracked.pair_id,
                relative_path: tracked.relative_path,
                change_type: "deleted",
                queued_at: new Date().toISOString(),
              });
            }
            // If not tracked, nothing to do — the node wasn't in any sync pair.
            this.stateDb.deleteQueuedEvent(entry.id);

          } else if (parsedEvent.type === DriveEventType.TreeRemove) {
            debugLog(`drainEventQueue: scope ${entry.tree_event_scope_id} removed`);
            this.stateDb.deleteQueuedEvent(entry.id);

          } else {
            // SharedWithMeUpdated and any unknown types
            this.stateDb.deleteQueuedEvent(entry.id);
          }
        } catch (err) {
          debugLog("drainEventQueue: error processing entry " + entry.id + ": " + String(err));
          return; // stop drain; preserve ordering; retry on next drain call
        }
      }
      events = this.stateDb.getQueuedEvents();
    }
  }

  async startRemoteEventSubscription(client: DriveClient): Promise<void> {
    if (this.eventSubscription) return;
    const scopeId = await client.getRootTreeEventScopeId();
    this.eventSubscription = await client.subscribeToRemoteEvents(
      scopeId,
      this.makeEventCallback(),
    );
  }

  disposeEventSubscription(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
  }

  /** Thin wrapper: reconcile then drain. Called on cold start, post-auth, and add_pair. */
  async startSyncAll(): Promise<void> {
    const networkFailed = await this.reconcileAndEnqueue();
    if (!networkFailed) {
      if (this.isDraining) {
        // A concurrent drain is in flight — it may not have seen items just
        // enqueued by reconcile. Schedule a one-shot retry so those entries
        // are processed once the current drain releases the lock.
        setTimeout(() => { void this.drainQueue(); }, 0);
      } else {
        await this.drainQueue();
      }
    }
  }

  /**
   * Discovery phase. Walks local + remote trees for each pair, creates
   * missing folders in both directions, enqueues uploads to `change_queue`,
   * and executes downloads directly. Called by `startSyncAll`.
   *
   * Returns `true` if a network failure was detected (caller should skip
   * drainQueue — the NetworkMonitor will trigger a fresh drain on reconnect).
   *
   * Cold-start: pairs present in config.yaml but absent from SQLite are
   * inserted before walking, preserving the fresh-install recovery path.
   *
   * Download handling: downloads are executed inline (not via queue) because
   * `change_queue` only supports `created|modified|deleted` change types.
   * Full download-queue unification is deferred to a follow-on story.
   */
  async reconcileAndEnqueue(force = false): Promise<boolean> {
    const client = this.driveClient;
    if (!client) return false;

    if (!force) {
      const scopeId = await client.getRootTreeEventScopeId?.().catch(() => null) ?? null;
      if (scopeId && this.stateDb.getEventCheckpoint(scopeId) !== null) {
        debugLog("Checkpoint present — skipping full walk");
        return false;
      }
    }

    // Cold-start: restore pairs in config but missing from SQLite (AC5)
    const configPairs = this.getConfigPairs();
    const dbPairIds = new Set(this.stateDb.listPairs().map((p) => p.pair_id));
    for (const cp of configPairs) {
      if (!dbPairIds.has(cp.pair_id)) {
        this.stateDb.insertPair({
          pair_id: cp.pair_id,
          local_path: cp.local_path,
          remote_path: cp.remote_path,
          remote_id: "",
          created_at: cp.created_at ?? new Date().toISOString(),
          last_synced_at: null,
        });
      }
    }

    const pairs = this.stateDb.listPairs();
    process.stderr.write(`[ENGINE] reconcileAndEnqueue: ${pairs.length} pair(s)\n`);
    for (let pairObj of pairs) {
      this.emitEvent({ type: "pair_reconciling", payload: { pair_id: pairObj.pair_id } });
      try {
        await this.reconcilePair(pairObj, client);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        if (isAuthExpired(err)) {
          process.stderr.write("[ENGINE] reconcile aborted — 401 session expired\n");
          this.onTokenExpired();
          return true; // halt reconcile; same return semantics as network failure
        }
        if (isFetchFailure(err)) {
          process.stderr.write(`[ENGINE] reconcile aborted — network failure detected, forcing connectivity check\n`);
          this.onNetworkFailure();
          return true;
        }
        if (isLocalFolderMissing(err)) {
          process.stderr.write(
            `[ENGINE] local_folder_missing pair=${pairObj.pair_id.slice(-8)} path=${pairObj.local_path}\n`
          );
          this.emitEvent({
            type: "local_folder_missing",
            payload: { pair_id: pairObj.pair_id, local_path: pairObj.local_path },
          });
          continue; // non-fatal — skip this pair, continue with others
        }
        // A FOREIGN KEY constraint failure means the pair was concurrently removed
        // (remove_pair IPC) while reconcilePair was awaiting. The pair no longer
        // exists — this is benign. Log for diagnostics and skip silently.
        if (isForeignKeyConstraint(err)) {
          debugLog(
            `sync-engine: pair=${pairObj.pair_id.slice(-8)} removed mid-reconcile (FOREIGN KEY), skipping`,
            err instanceof Error ? err : undefined,
          );
          continue;
        }
        if (err instanceof RateLimitError) {
          const resumeIn = 30;
          process.stderr.write(`[ENGINE] reconcile rate-limited pair=${pairObj.pair_id.slice(-8)}, retrying in ${resumeIn}s\n`);
          this.emitEvent({ type: "rate_limited", payload: { resume_in_seconds: resumeIn } });
          continue;
        }
        process.stderr.write(`[ENGINE] sync_cycle_error pair=${pairObj.pair_id.slice(-8)}: ${msg}\n`);
        this.emitEvent({
          type: "error",
          payload: { code: "sync_cycle_error", message: msg, pair_id: pairObj.pair_id },
        });
      }
    }
    return false;
  }

  /** Per-pair reconciliation: resolve remote_id, walk trees, create folders,
   *  enqueue uploads, execute downloads. */
  private async reconcilePair(pair: SyncPair, client: DriveClient): Promise<void> {
    // Resolve remote_id if empty (AC6 from Story 2-5)
    if (pair.remote_id === "") {
      try {
        process.stderr.write(`[ENGINE] resolving remote_id for pair=${pair.pair_id.slice(-8)} remote_path=${pair.remote_path}\n`);
        const resolvedId = await this.resolveRemoteId(pair, client);
        process.stderr.write(`[ENGINE] resolved remote_id=${resolvedId.slice(-8)} for pair=${pair.pair_id.slice(-8)}\n`);
        pair = { ...pair, remote_id: resolvedId };
      } catch (err) {
        if (isAuthExpired(err)) throw err;
        if (err instanceof RateLimitError) throw err; // let outer reconcile handler emit rate_limited
        const msg = err instanceof Error ? err.message : "unknown";
        process.stderr.write(`[ENGINE] remote_path_not_found pair=${pair.pair_id.slice(-8)}: ${msg}\n`);
        this.emitEvent({
          type: "error",
          payload: { code: "remote_path_not_found", message: msg, pair_id: pair.pair_id },
        });
        return;
      }
    }

    this.emitEvent({
      type: "reconcile_progress",
      payload: {
        pair_id: pair.pair_id,
        phase: "scanning",
        files_processed: 0,
        files_total: 0,
      } satisfies ReconcileProgressPayload,
    });

    const { files: localFiles, dirs: localDirs } = await this.walkLocalTree(pair.local_path);
    const { files: remoteFiles, folders: remoteFolders } = await this.walkRemoteTree(
      pair.remote_id,
      "",
      client,
    );
    const syncStates = new Map(
      this.stateDb.listSyncStates(pair.pair_id).map((s) => [s.relative_path, s]),
    );

    // ── Local dirs → remote ──────────────────────────────────────────────────
    const allLocalDirs = new Set(localDirs);
    for (const relPath of localFiles.keys()) {
      let d = dirname(relPath);
      while (d !== ".") { allLocalDirs.add(d); d = dirname(d); }
    }
    for (const localDir of [...allLocalDirs].sort()) {
      if (!remoteFolders.has(localDir)) {
        const parentDir = dirname(localDir);
        const parentId = parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
        if (parentId) {
          const newId = await client.createRemoteFolder(parentId, basename(localDir));
          remoteFolders.set(localDir, newId);
        }
      }
    }

    // ── Remote dirs → local ──────────────────────────────────────────────────
    for (const relDir of [...remoteFolders.keys()].sort()) {
      const localDir = join(pair.local_path, relDir);
      await mkdir(localDir, { recursive: true });
    }

    // Capture totals for sync_complete payload (both reconcile and drain emitters read this).
    let totalBytes = 0;
    for (const f of localFiles.values()) totalBytes += f.size;
    this._pairStats.set(pair.pair_id, { fileCount: localFiles.size, totalBytes });

    const workItems = await this.computeWorkList(pair, localFiles, remoteFiles, remoteFolders, syncStates);
    process.stderr.write(`[ENGINE] reconcilePair: ${workItems.length} item(s) (localFiles=${localFiles.size} remoteFiles=${remoteFiles.size})\n`);

    const deleteLocalItems       = workItems.filter((w): w is WorkItem & { kind: "delete_local" }     => w.kind === "delete_local");
    const trashRemoteItems       = workItems.filter((w): w is WorkItem & { kind: "trash_remote" }     => w.kind === "trash_remote");
    const clearStateItems        = workItems.filter((w): w is WorkItem & { kind: "clear_state" }      => w.kind === "clear_state");
    const downloadItems          = workItems.filter((w): w is WorkItem & { kind: "download" }         => w.kind === "download");
    const uploadItems            = workItems.filter((w): w is WorkItem & { kind: "upload" }           => w.kind === "upload");
    const conflictItems          = workItems.filter((w): w is WorkItem & { kind: "conflict" }          => w.kind === "conflict");
    const newFileCollisionItems  = workItems.filter((w): w is WorkItem & { kind: "new_file_collision" } => w.kind === "new_file_collision");
    const bootstrapMatchItems    = workItems.filter((w): w is WorkItem & { kind: "bootstrap_match" }   => w.kind === "bootstrap_match");

    const bytesTotal = [...downloadItems, ...uploadItems].reduce((a, w) => a + w.size, 0);

    // Execute clear_state items (no I/O)
    for (const item of clearStateItems) {
      this.stateDb.deleteSyncState(pair.pair_id, item.relativePath);
    }

    // Execute bootstrap_match items: hash local file and record sync state — no transfer needed.
    for (const item of bootstrapMatchItems) {
      const localFilePath = join(pair.local_path, item.relativePath);
      const hash = await this.hashLocalFile(localFilePath);
      this.stateDb.upsertSyncState({
        pair_id: pair.pair_id,
        relative_path: item.relativePath,
        local_mtime: item.localMtime,
        remote_mtime: item.remoteMtime,
        content_hash: hash ?? "",
        remote_node_id: item.remoteNodeId,
      });
    }

    let diskFull = false; // set on ENOSPC; causes early return after each loop

    // ── Execute conflict items (local wins: download remote → conflict copy, keep local) ──
    //
    // Rationale: the user's local work is never silently overwritten. The remote
    // version is saved alongside as file.conflict-YYYY-MM-DD-... for reference, and
    // the local file is immediately queued for upload so it wins on the remote too.
    // The user resolves by keeping the conflict copy (deletes local, renames conflict)
    // or doing nothing (local wins automatically once the upload completes).
    const conflictAlreadyQueued = new Set(
      this.stateDb.listQueue(pair.pair_id).map((e) => e.relative_path),
    );
    for (const item of conflictItems) {
      const localFilePath = join(pair.local_path, item.relativePath);
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      // Ensure uniqueness via epoch-ms timestamp — eliminates suffix exhaustion risk.
      let conflictCopyPath = `${localFilePath}.conflict-${date}-${Date.now()}`;
      try {
        await stat(conflictCopyPath);
        // Extremely unlikely: same millisecond collision — append random suffix.
        conflictCopyPath = `${localFilePath}.conflict-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      } catch {
        // Path does not exist — safe to use.
      }
      const conflictRelPath = relative(pair.local_path, conflictCopyPath);

      // Download remote version to conflict copy path (for user reference only).
      try {
        const downloadItem: WorkItem & { kind: "download" } = {
          kind: "download",
          relativePath: conflictRelPath,
          nodeUid: item.remoteNodeId,
          size: item.remoteSize,
          remoteMtime: item.remoteMtime,
        };
        await this.downloadOne(pair, downloadItem, client);
      } catch (err) {
        if (isAuthExpired(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`sync-engine: conflict remote-download failed for ${item.relativePath}: ${msg}`);
        if (isDiskFull(err)) {
          this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
          diskFull = true; break;
        }
        if (isPermissionDenied(err)) {
          this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${pair.local_path}`, pair_id: pair.pair_id } });
          continue;
        }
        // Remote version lost — emit so the user knows the conflict copy wasn't saved.
        this.emitEvent({
          type: "error",
          payload: {
            code: "SDK_ERROR",
            message: "Sync error — conflict copy could not be saved, try again or check ProtonDrive status",
            pair_id: pair.pair_id,
          },
        });
        continue;
      }

      // Update sync state: local_mtime stays as-is (local file unchanged),
      // remote_mtime records the remote version we just saw.
      const localFile = localFiles.get(item.relativePath);
      const localMtime = localFile?.mtime ?? new Date().toISOString();
      const localHash = await this.hashLocalFile(localFilePath);
      this.stateDb.upsertSyncState({
        pair_id: pair.pair_id,
        relative_path: item.relativePath,
        local_mtime: localMtime,
        remote_mtime: item.remoteMtime,
        content_hash: localHash,
        remote_node_id: item.remoteNodeId,
      });

      // Enqueue local file for upload so the local version wins on remote.
      if (!conflictAlreadyQueued.has(item.relativePath)) {
        this.stateDb.enqueue({
          pair_id: pair.pair_id,
          relative_path: item.relativePath,
          change_type: "modified",
          queued_at: new Date().toISOString(),
        });
        conflictAlreadyQueued.add(item.relativePath);
      }

      this.emitEvent({
        type: "conflict_detected",
        payload: {
          pair_id: pair.pair_id,
          local_path: localFilePath,
          conflict_copy_path: conflictCopyPath,
        },
      });
    }
    if (diskFull) return;

    // ── Execute new_file_collision items (local wins: download remote → conflict copy, keep local) ──
    // Same "local wins" principle as conflictItems above — local file is preserved,
    // remote is saved as a conflict copy for review.
    for (const item of newFileCollisionItems) {
      const localFilePath = join(pair.local_path, item.relativePath);
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const conflictCopyPath = `${localFilePath}.conflict-${date}-${Date.now()}`;
      const conflictRelPath = relative(pair.local_path, conflictCopyPath);

      // Download remote version to conflict copy path.
      try {
        const downloadItem: WorkItem & { kind: "download" } = {
          kind: "download",
          relativePath: conflictRelPath,
          nodeUid: item.remoteNodeId,
          size: item.remoteSize,
          remoteMtime: item.remoteMtime,
        };
        await this.downloadOne(pair, downloadItem, client);
      } catch (err) {
        if (isAuthExpired(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`sync-engine: collision remote-download failed for ${item.relativePath}: ${msg}`);
        if (isDiskFull(err)) {
          this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
          diskFull = true; break;
        }
        if (isPermissionDenied(err)) {
          this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${pair.local_path}`, pair_id: pair.pair_id } });
          continue;
        }
        continue;
      }

      // Enqueue local file for upload (new file, no existing sync state).
      if (!conflictAlreadyQueued.has(item.relativePath)) {
        this.stateDb.enqueue({
          pair_id: pair.pair_id,
          relative_path: item.relativePath,
          change_type: "created",
          queued_at: new Date().toISOString(),
        });
        conflictAlreadyQueued.add(item.relativePath);
      }

      this.emitEvent({
        type: "conflict_detected",
        payload: {
          pair_id: pair.pair_id,
          local_path: localFilePath,
          conflict_copy_path: conflictCopyPath,
        },
      });
    }
    if (diskFull) return;

    // Execute delete_local items (ENOENT = already gone = success)
    for (const item of deleteLocalItems) {
      try {
        await unlink(join(pair.local_path, item.relativePath));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          const errMsg = err instanceof Error ? err.message : "unknown";
          debugLog(`sync-engine: delete_local failed for ${item.relativePath}: ${errMsg}`);
          if (isPermissionDenied(err)) {
            this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${join(pair.local_path, item.relativePath)}`, pair_id: pair.pair_id } });
            continue;
          }
          if (isFileLocked(err)) {
            this.emitEvent({ type: "error", payload: { code: "FILE_LOCKED", message: `${basename(join(pair.local_path, item.relativePath))} is in use — sync will retry when it's released`, pair_id: pair.pair_id } });
            continue;
          }
          const errCode = (err as NodeJS.ErrnoException)?.code;
          const message = errCode
            ? `Sync error ${errCode} — try again or check ProtonDrive status`
            : "Sync error — try again or check ProtonDrive status";
          this.emitEvent({ type: "error", payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id } });
          continue;  // keep sync_state so next cycle retries
        }
      }
      this.stateDb.deleteSyncState(pair.pair_id, item.relativePath);
    }

    // Execute trash_remote items (withBackoff for rate limiting)
    for (const item of trashRemoteItems) {
      try {
        await this.withBackoff(() => client.trashNode(item.remoteNodeId));
        this.stateDb.deleteSyncState(pair.pair_id, item.relativePath);
      } catch (err) {
        if (isAuthExpired(err)) throw err;
        const msg = err instanceof Error ? err.message : "unknown";
        debugLog(`sync-engine: trash_remote failed for ${item.relativePath}: ${msg}`);
        this.emitEvent({ type: "error", payload: { code: "sync_cycle_error", message: msg, pair_id: pair.pair_id } });
        // sync_state intentionally preserved — retry on next cycle
      }
    }

    // Emit initial sync_progress covering downloads (AC7 — files_done: 0 before transfers)
    this.emitEvent({
      type: "sync_progress",
      payload: {
        pair_id: pair.pair_id,
        files_done: 0,
        files_total: downloadItems.length + uploadItems.length,
        bytes_done: 0,
        bytes_total: bytesTotal,
      },
    });

    // ── Execute downloads directly ───────────────────────────────────────────
    let filesDone = 0;
    let bytesDone = 0;
    if (downloadItems.length > 0) {
      this.emitEvent({
        type: "reconcile_progress",
        payload: {
          pair_id: pair.pair_id,
          phase: "downloading",
          files_processed: 0,
          files_total: downloadItems.length,
        } satisfies ReconcileProgressPayload,
      });
    }
    for (const item of downloadItems) {
      try {
        await this.downloadOne(pair, item as WorkItem & { kind: "download" }, client);
        const destPath = join(pair.local_path, item.relativePath);
        const s = await stat(destPath);
        const hash = await this.hashLocalFile(destPath);
        this.stateDb.upsertSyncState({
          pair_id: pair.pair_id,
          relative_path: item.relativePath,
          local_mtime: s.mtime.toISOString(),
          remote_mtime: (item as WorkItem & { kind: "download" }).remoteMtime,
          content_hash: hash,
          remote_node_id: (item as WorkItem & { kind: "download" }).nodeUid,
        });
        filesDone++;
        bytesDone += item.size;
        this.emitEvent({
          type: "file_synced",
          payload: {
            pair_id: pair.pair_id,
            file_name: basename(item.relativePath),
            direction: "download",
            timestamp: new Date().toISOString(),
          } satisfies FileSyncedPayload,
        });
        this.emitEvent({
          type: "reconcile_progress",
          payload: {
            pair_id: pair.pair_id,
            phase: "downloading",
            files_processed: filesDone,
            files_total: downloadItems.length,
          } satisfies ReconcileProgressPayload,
        });
        this.emitEvent({
          type: "sync_progress",
          payload: {
            pair_id: pair.pair_id,
            files_done: filesDone,
            files_total: downloadItems.length + uploadItems.length,
            bytes_done: bytesDone,
            bytes_total: bytesTotal,
          },
        });
      } catch (err) {
        if (isAuthExpired(err)) throw err;
        const msg = err instanceof Error ? err.message : "unknown";
        process.stderr.write(`[ENGINE] sync_file_error ${item.relativePath}: ${msg}\n`);
        if (isDiskFull(err)) {
          this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
          diskFull = true; break;
        }
        if (isPermissionDenied(err)) {
          this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${join(pair.local_path, item.relativePath)}`, pair_id: pair.pair_id } });
          continue;
        }
        if (isFileLocked(err)) {
          this.emitEvent({ type: "error", payload: { code: "FILE_LOCKED", message: `${basename(join(pair.local_path, item.relativePath))} is in use — sync will retry when it's released`, pair_id: pair.pair_id } });
          continue;
        }
        const errCode = (err as NodeJS.ErrnoException)?.code;
        const message = errCode
          ? `Sync error ${errCode} — try again or check ProtonDrive status`
          : "Sync error — try again or check ProtonDrive status";
        this.emitEvent({
          type: "error",
          payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id },
        });
      }
    }
    if (diskFull) return;

    // ── Enqueue uploads (skip already-queued paths to avoid duplicates) ──────
    const existingQueued = new Set(
      this.stateDb.listQueue(pair.pair_id).map((e) => e.relative_path),
    );
    for (const item of uploadItems) {
      if (!existingQueued.has(item.relativePath)) {
        const isModification = syncStates.has(item.relativePath);
        // Bootstrap upload: no sync state but remote exists (local newer case from bootstrap logic).
        // Pre-seed a sync state so drainQueue's decision table sees (defined, defined) → "upload"
        // instead of (undefined, defined) → "conflict".
        if (!isModification && item.existingNodeUid) {
          // Seed a sync state so drainQueue sees (defined, defined) → "upload"
          // instead of (undefined, defined) → "conflict".
          // remote_mtime matches the current remote so remoteUnchanged=true passes.
          // drain's commitUpload will overwrite with final post-upload values.
          const remoteFile = remoteFiles.get(item.relativePath);
          this.stateDb.upsertSyncState({
            pair_id: pair.pair_id,
            relative_path: item.relativePath,
            local_mtime: item.localMtime,
            remote_mtime: remoteFile?.remote_mtime ?? item.localMtime,
            content_hash: null,
            remote_node_id: item.existingNodeUid ?? null,
          });
        }
        this.stateDb.enqueue({
          pair_id: pair.pair_id,
          relative_path: item.relativePath,
          change_type: isModification ? "modified" : "created",
          queued_at: new Date().toISOString(),
        });
        existingQueued.add(item.relativePath);
      }
    }

    // Persist last_synced_at. Only emit sync_complete now if there are no
    // pending uploads — drainQueue will emit it (and update last_synced_at
    // again) once those uploads are processed, avoiding a double emission.
    const completedAt = new Date().toISOString();
    this.stateDb.updateLastSynced(pair.pair_id, completedAt);
    if (uploadItems.length === 0) {
      const stats = this._pairStats.get(pair.pair_id);
      this.emitEvent({
        type: "sync_complete",
        payload: {
          pair_id: pair.pair_id,
          timestamp: completedAt,
          file_count: stats?.fileCount ?? 0,
          total_bytes: stats?.totalBytes ?? 0,
        },
      });
      this.emitEvent({
        type: "reconcile_progress",
        payload: {
          pair_id: pair.pair_id,
          phase: "idle",
          files_processed: filesDone,
          files_total: downloadItems.length,
        } satisfies ReconcileProgressPayload,
      });
    }
  }

  /**
   * Drain the persisted `change_queue` entries. Called after an offline→online
   * transition, after watcher events (Phase 2+), or as the upload execution
   * step of `startSyncAll`. Processes per-entry against a one-shot remote
   * snapshot per pair and tallies `{synced, skipped_conflicts, failed}`.
   *
   * Re-entrancy: if another in-flight `drainQueue` holds the lock, the call
   * returns zero counts immediately. Callers that need retry-after-drain
   * semantics should call drainQueue() again from their own trigger (e.g. the
   * watcher debounce or the online-event callback). See AC4 (Story 2-12).
   *
   * Emission ordering (AC6a):
   *  1. Per-entry `sync_progress` events during upload/trash
   *  2. `queue_replay_complete` fired BEFORE any final `sync_complete`
   *  3. Per-pair `sync_complete` only for pairs with ≥1 successful entry
   */
  async drainQueue(): Promise<{
    synced: number;
    skipped_conflicts: number;
    failed: number;
  }> {
    // Re-entrancy guard — bounce immediately if already draining.
    if (this.isDraining) {
      return { synced: 0, skipped_conflicts: 0, failed: 0 };
    }
    this.isDraining = true;

    let synced = 0;
    let skipped_conflicts = 0;
    let failed = 0;
    const pairsWithSuccess = new Set<string>();
    let dirtied = false;

    try {
      // Snapshot driveClient at entry (matches syncPair pattern at line ~128).
      const client = this.driveClient;
      if (!client) {
        // No client — still emit queue_replay_complete (AC6: "even when both
        // counts are zero") so the UI can reliably clear any replaying state.
        return { synced, skipped_conflicts, failed };
      }
      dirtied = true;
      this.stateDb.setDirtySession(true);

      const pairs = this.stateDb.listPairs();
      let diskFullAbort = false; // set when DISK_FULL is detected; aborts all further drain work
      for (const pair of pairs) {
        const pairQueue = this.stateDb.listQueue(pair.pair_id);
        if (pairQueue.length === 0) continue;

        this.emitEvent({
          type: "reconcile_progress",
          payload: {
            pair_id: pair.pair_id,
            phase: "uploading",
            files_processed: 0,
            files_total: pairQueue.length,
          } satisfies ReconcileProgressPayload,
        });

        // One remote-tree walk per pair (not per entry) — avoids O(N²) API
        // calls and keeps us well under rate-limit thresholds (Story 3-4).
        let remoteFiles: Map<string, RemoteFile>;
        let remoteFolders: Map<string, string>;
        try {
          const tree = await this.walkRemoteTree(pair.remote_id, "", client);
          remoteFiles = tree.files;
          remoteFolders = tree.folders;
        } catch (err) {
          if (isAuthExpired(err)) throw err; // propagate to outer catch to halt drain
          // walkRemoteTree failure blocks all entries for this pair — count
          // them as failed and emit one error event per entry so the UI can
          // surface them individually (including the affected relative_path).
          const msg = err instanceof Error ? err.message : "unknown";
          const errCode = (err as NodeJS.ErrnoException)?.code;
          const message = errCode
            ? `Sync error ${errCode} — try again or check ProtonDrive status`
            : "Sync error — try again or check ProtonDrive status";
          for (const entry of pairQueue) {
            failed++;
            this.emitEvent({
              type: "error",
              payload: {
                code: "SDK_ERROR",
                message,
                pair_id: pair.pair_id,
                relative_path: entry.relative_path,
              },
            });
          }
          debugLog(
            `sync-engine: replay walkRemoteTree failed for pair=${pair.pair_id}: ${msg}`,
          );
          continue;
        }

        // Process entries sequentially — NOT in parallel. Rationale: (a)
        // rate-limit safety, (b) per-entry sync_state writes must observe
        // prior writes, (c) deterministic sync_progress ordering.
        for (let i = 0; i < pairQueue.length; i++) {
          const entry = pairQueue[i]!;
          const outcome = await this.processQueueEntry(
            pair,
            entry,
            remoteFiles,
            remoteFolders,
            client,
          );
          if (outcome === "synced") {
            synced++;
            pairsWithSuccess.add(pair.pair_id);
            this.emitEvent({
              type: "sync_progress",
              payload: {
                pair_id: pair.pair_id,
                files_done: i + 1,
                files_total: pairQueue.length,
                bytes_done: 0,
                bytes_total: 0,
              },
            });
          } else if (outcome === "conflict") {
            skipped_conflicts++;
          } else if (outcome === "disk_full") {
            failed++;
            diskFullAbort = true;
            break; // stop this pair's remaining entries
          } else { // "failed"
            failed++;
            const newAttempts = this.stateDb.incrementAttemptCount(entry.id);
            if (newAttempts >= MAX_DRAIN_ATTEMPTS) {
              this.stateDb.deadLetter(
                { id: entry.id, pair_id: entry.pair_id, relative_path: entry.relative_path, change_type: entry.change_type },
                `Failed ${newAttempts} times`,
              );
              this.emitEvent({
                type: "error",
                payload: {
                  code: "DEAD_LETTER",
                  message: `"${entry.relative_path}" failed to sync after ${newAttempts} attempts and was removed from the queue`,
                  pair_id: entry.pair_id,
                  relative_path: entry.relative_path,
                },
              });
              debugLog(
                `sync-engine: dead-lettered queue entry ${entry.id} (${entry.relative_path}) after ${newAttempts} attempts`,
              );
            }
          }
        }
        if (diskFullAbort) break; // stop all further pairs
      }
    } catch (err) {
      if (isAuthExpired(err)) {
        this.onTokenExpired();
        // fall through to finally — isDraining reset, queue_replay_complete emitted
      } else {
        throw err; // unexpected; propagate
      }
    } finally {
      // Ordered emission (AC6a): queue_replay_complete FIRST so the UI can
      // set _conflict_pending_count before any final sync_complete arrives.
      this.emitEvent({
        type: "queue_replay_complete",
        payload: { synced, skipped_conflicts },
      });
      for (const pair_id of pairsWithSuccess) {
        const timestamp = new Date().toISOString();
        this.stateDb.updateLastSynced(pair_id, timestamp);
        const stats = this._pairStats.get(pair_id);
        this.emitEvent({
          type: "sync_complete",
          payload: {
            pair_id,
            timestamp,
            file_count: stats?.fileCount ?? 0,
            total_bytes: stats?.totalBytes ?? 0,
          },
        });
        this.emitEvent({
          type: "reconcile_progress",
          payload: {
            pair_id,
            phase: "idle",
            files_processed: 0,
            files_total: 0,
          } satisfies ReconcileProgressPayload,
        });
      }
      if (dirtied) this.stateDb.setDirtySession(false);
      this.isDraining = false;
    }

    return { synced, skipped_conflicts, failed };
  }

  /**
   * Per-entry replay dispatch. Returns `"synced" | "conflict" | "failed"`.
   *
   * Decision table: see _bmad-output/implementation-artifacts/6-5-drain-decision-table-correctness.md
   */
  private async processQueueEntry(
    pair: SyncPair,
    entry: ChangeQueueEntry,
    remoteFiles: Map<string, RemoteFile>,
    remoteFolders: Map<string, string>,
    client: DriveClient,
  ): Promise<"synced" | "conflict" | "failed" | "disk_full"> {
    try {
      // Conflict copies, temp staging files, and legacy reconcile-trigger sentinels
      // are local-only artifacts — drop stale queue entries for them silently.
      if (
        /\.conflict-\d{4}-\d{2}-\d{2}-\d+(-[a-z0-9]+)?$/.test(entry.relative_path) ||
        /\.protondrive-tmp-\d+$/.test(entry.relative_path) ||
        entry.relative_path === ".reconcile-trigger"
      ) {
        this.stateDb.dequeue(entry.id);
        return "synced";
      }

      const state = this.stateDb.getSyncState(pair.pair_id, entry.relative_path);
      const remote = remoteFiles.get(entry.relative_path);
      const isDelete = entry.change_type === "deleted";

      // Resolve the outcome from the decision table.
      // Full table: _bmad-output/implementation-artifacts/6-5-drain-decision-table-correctness.md
      let outcome: "upload" | "trashNode" | "dequeue" | "conflict" | "inline_download";
      if (state === undefined && remote === undefined) {
        outcome = isDelete ? "dequeue" : "upload";
      } else if (state === undefined && remote !== undefined) {
        if (isDelete) {
          // Local delete of a file we never tracked — remote is unrelated, leave it alone.
          outcome = "dequeue";
        } else {
          try {
            const localStat = await stat(join(pair.local_path, entry.relative_path));
            // Local newer-or-equal → upload (bootstrap local wins); strictly older → remote wins, download.
            outcome = new Date(localStat.mtime).getTime() >= new Date(remote.remote_mtime).getTime() ? "upload" : "inline_download";
          } catch {
            // Local file gone before drain ran — remote is the only truth, download it.
            outcome = "inline_download";
          }
        }
      } else if (state !== undefined && remote === undefined) {
        // Remote gone. For deletes: both sides agree — dequeue. For uploads: local change
        // wins, recreate the file on remote.
        outcome = isDelete ? "dequeue" : "upload";
      } else {
        // Both defined — compare stored vs current remote_mtime.
        const remoteUnchanged = state!.remote_mtime === remote!.remote_mtime;
        if (remoteUnchanged) {
          outcome = isDelete ? "trashNode" : "upload";
        } else {
          // Remote changed since last sync. For uploads: genuine conflict (both sides changed).
          // For deletes: remote has a newer version the user hasn't seen — download it.
          outcome = isDelete ? "inline_download" : "conflict";
        }
      }

      switch (outcome) {
        case "upload": {
          // Locate the remote parent folder id for this entry.
          const parentDir = dirname(entry.relative_path);
          const remoteFolderId =
            parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
          if (!remoteFolderId) {
            // Parent folder doesn't exist remotely — rare edge case; count as
            // failed and re-surface on the next replay when walkRemoteTree may
            // have picked up the new folder.
            debugLog(
              `sync-engine: replay upload ${entry.relative_path} — remote parent not found`,
            );
            const message = "Sync error — try again or check ProtonDrive status";
            this.emitEvent({
              type: "error",
              payload: {
                code: "SDK_ERROR",
                message,
                pair_id: pair.pair_id,
                relative_path: entry.relative_path,
              },
            });
            return "failed";
          }

          // stat() the local file. Only ENOENT (file deleted mid-replay) is a
          // legitimate "conflict" here — that preserves the user's intent to
          // not drop the change entirely. Other errors (EACCES, EPERM, EIO,
          // …) are genuine failures and must route to `failed` with a surfaced
          // error event so the user can act on them.
          let fileStat: { size: number; mtime: Date };
          try {
            fileStat = await stat(join(pair.local_path, entry.relative_path));
          } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") {
              if (state === undefined && remote === undefined) {
                // File was created then deleted before the engine drained the
                // queue — both sides are empty, so there is nothing to conflict.
                // Silently dequeue rather than surfacing a false conflict count.
                debugLog(
                  `sync-engine: replay upload ${entry.relative_path} — created-then-deleted (ENOENT, no state/remote), dequeuing silently`,
                );
                this.stateDb.commitDequeue(pair.pair_id, entry.relative_path, entry.id, false);
                return "synced";
              }
              debugLog(
                `sync-engine: replay upload ${entry.relative_path} — local file missing (ENOENT), routing to conflict`,
              );
              return "conflict";
            }
            const msg = err instanceof Error ? err.message : "unknown";
            debugLog(
              `sync-engine: replay upload ${entry.relative_path} — stat failed (${code ?? "no-code"}): ${msg}`,
            );
            if (isPermissionDenied(err)) {
              this.emitEvent({
                type: "error",
                payload: {
                  code: "PERMISSION_DENIED",
                  message: `Check folder permissions for ${join(pair.local_path, entry.relative_path)}`,
                  pair_id: pair.pair_id,
                  relative_path: entry.relative_path,
                },
              });
              // Permission errors are permanent — dead-letter immediately instead of retrying.
              this.stateDb.deadLetter(
                { id: entry.id, pair_id: entry.pair_id, relative_path: entry.relative_path, change_type: entry.change_type },
                "PERMISSION_DENIED",
              );
              this.emitEvent({
                type: "error",
                payload: {
                  code: "DEAD_LETTER",
                  message: `"${entry.relative_path}" cannot sync due to permission error and was removed from the queue`,
                  pair_id: entry.pair_id,
                  relative_path: entry.relative_path,
                },
              });
              return "failed";
            }
            const message = code
              ? `Sync error ${code} — try again or check ProtonDrive status`
              : "Sync error — try again or check ProtonDrive status";
            this.emitEvent({
              type: "error",
              payload: {
                code: "SDK_ERROR",
                message,
                pair_id: pair.pair_id,
                relative_path: entry.relative_path,
              },
            });
            return "failed";
          }

          const workItem: WorkItem = {
            kind: "upload",
            relativePath: entry.relative_path,
            remoteFolderId,
            existingNodeUid: remote?.id,
            size: fileStat.size,
            localMtime: fileStat.mtime.toISOString(),
          };
          const uploadResult = await this.uploadOne(pair, workItem, client);
          // Same mtime rule as processOne (see sync-engine.ts:449–454):
          // remote_mtime = localMtime because the SDK stores
          // body.modificationTime as activeRevision.claimedModificationTime.
          // Commit atomically — crashing between upsert and dequeue would
          // leave the remote uploaded but the queue entry behind, producing a
          // duplicate upload on restart.
          const uploadedPath = join(pair.local_path, entry.relative_path);
          const hash = await this.hashLocalFile(uploadedPath);
          this.stateDb.commitUpload(
            {
              pair_id: pair.pair_id,
              relative_path: entry.relative_path,
              local_mtime: workItem.localMtime,
              remote_mtime: workItem.localMtime,
              content_hash: hash,
              remote_node_id: uploadResult.node_uid,
            },
            entry.id,
          );
          this.emitEvent({
            type: "file_synced",
            payload: {
              pair_id: pair.pair_id,
              file_name: basename(entry.relative_path),
              direction: "upload",
              timestamp: new Date().toISOString(),
            } satisfies FileSyncedPayload,
          });
          // Refresh the in-loop remote snapshot so a later queue entry for
          // the SAME relative_path (e.g. create+modify pairs while offline)
          // sees the just-uploaded node instead of the stale "undefined" from
          // the pre-replay walkRemoteTree.
          remoteFiles.set(entry.relative_path, {
            id: uploadResult.node_uid,
            name: basename(entry.relative_path),
            parent_id: remoteFolderId,
            remote_mtime: workItem.localMtime,
            size: workItem.size,
          });
          return "synced";
        }
        case "trashNode": {
          // remote is guaranteed defined by the decision table for this cell.
          await this.withBackoff(() => client.trashNode(remote!.id));
          // Atomic — crashing between deleteSyncState and dequeue would leave
          // the remote trashed, the sync_state row gone, and the queue entry
          // behind; next replay would hit (undefined, undefined, deleted) and
          // silently dequeue, but we lose the audit trail. Transaction closes
          // the gap.
          this.stateDb.commitTrash(pair.pair_id, entry.relative_path, entry.id);
          // Remove from the in-loop snapshot: any later entry for this path
          // now sees (state undef, remote undef) which matches reality.
          remoteFiles.delete(entry.relative_path);
          return "synced";
        }
        case "dequeue": {
          // Idempotent both-sides-agree path. If a sync_state row exists
          // (defined/undefined/deleted cell), drop it alongside the queue row.
          this.stateDb.commitDequeue(
            pair.pair_id,
            entry.relative_path,
            entry.id,
            state !== undefined,
          );
          return "synced";
        }
        case "inline_download": {
          // remote is guaranteed defined for every inline_download cell.
          const dlItem: WorkItem & { kind: "download" } = {
            kind: "download",
            relativePath: entry.relative_path,
            nodeUid: remote!.id,
            size: remote!.size,
            remoteMtime: remote!.remote_mtime,
          };
          await this.downloadOne(pair, dlItem, client);
          const dlPath = join(pair.local_path, entry.relative_path);
          const dlStat = await stat(dlPath);
          const dlHash = await this.hashLocalFile(dlPath);
          this.stateDb.commitUpload(
            {
              pair_id: pair.pair_id,
              relative_path: entry.relative_path,
              local_mtime: dlStat.mtime.toISOString(),
              remote_mtime: remote!.remote_mtime,
              content_hash: dlHash,
              remote_node_id: remote!.id,
            },
            entry.id,
          );
          this.emitEvent({
            type: "file_synced",
            payload: {
              pair_id: pair.pair_id,
              file_name: basename(entry.relative_path),
              direction: "download",
              timestamp: new Date().toISOString(),
            } satisfies FileSyncedPayload,
          });
          return "synced";
        }
        case "conflict": {
          // Preserve the local version as a conflict copy, then dequeue so
          // the entry is not replayed on every sync cycle. For delete-type
          // conflicts the local file is already gone — just dequeue silently.
          if (!isDelete) {
            const localFilePath = join(pair.local_path, entry.relative_path);
            const d = new Date();
            const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            let conflictCopyPath = `${localFilePath}.conflict-${date}-${Date.now()}`;
            try {
              await stat(conflictCopyPath);
              conflictCopyPath = `${localFilePath}.conflict-${date}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            } catch { /* path does not exist — safe to use */ }
            const tmpPath = `${conflictCopyPath}.protondrive-tmp-${Date.now()}`;
            try {
              await copyFile(localFilePath, tmpPath);
              await rename(tmpPath, conflictCopyPath);
              this.emitEvent({
                type: "conflict_detected",
                payload: {
                  pair_id: pair.pair_id,
                  local_path: localFilePath,
                  conflict_copy_path: conflictCopyPath,
                },
              });
            } catch (err) {
              try { await unlink(tmpPath); } catch { /* already gone */ }
              const msg = err instanceof Error ? err.message : String(err);
              debugLog(`sync-engine: conflict copy creation failed for ${entry.relative_path}: ${msg}`);
              if (isDiskFull(err)) {
                this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
              } else if (isPermissionDenied(err)) {
                this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${localFilePath}`, pair_id: pair.pair_id } });
              }
              // Copy failed — leave the entry in queue so it retries on the next cycle.
              return "conflict";
            }
          }
          this.stateDb.dequeue(entry.id);
          return "conflict";
        }
        default: {
          // Exhaustiveness guard: `outcome` is a literal-union. If a future
          // refactor adds a new outcome and forgets to handle it here, this
          // fails compile — never a silent `undefined` return.
          const _exhaustive: never = outcome;
          throw new SyncError(`processQueueEntry: unhandled outcome ${_exhaustive}`);
        }
      }
    } catch (err) {
      if (isAuthExpired(err)) throw err; // propagate to halt drain — do NOT emit "failed" or "queue_replay_failed"
      if (isDiskFull(err)) {
        this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
        return "disk_full"; // signals drainQueue to abort the entire drain pass
      }
      if (isPermissionDenied(err)) {
        this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${join(pair.local_path, entry.relative_path)}`, pair_id: pair.pair_id } });
        return "failed";
      }
      if (isFileLocked(err)) {
        this.emitEvent({ type: "error", payload: { code: "FILE_LOCKED", message: `${basename(join(pair.local_path, entry.relative_path))} is in use — sync will retry when it's released`, pair_id: pair.pair_id } });
        return "failed";
      }
      const msg = err instanceof Error ? err.message : "unknown";
      debugLog(
        `sync-engine: processQueueEntry failed pair=${pair.pair_id} entry=${entry.id} path=${entry.relative_path}: ${msg}`,
        err instanceof Error ? err : undefined,
      );
      const errCode = (err as NodeJS.ErrnoException)?.code;
      const message = errCode
        ? `Sync error ${errCode} — try again or check ProtonDrive status`
        : "Sync error — try again or check ProtonDrive status";
      this.emitEvent({
        type: "error",
        payload: {
          code: "SDK_ERROR",
          message,
          pair_id: pair.pair_id,
          relative_path: entry.relative_path,
        },
      });
      // Network failure mid-drain: trigger offline transition so the UI
      // reflects the connectivity loss (mirrors reconcileAndEnqueue behaviour).
      if (isFetchFailure(err)) {
        this.onNetworkFailure();
      }
      return "failed";
    }
  }

  private async resolveRemoteId(pair: SyncPair, client: DriveClient): Promise<string> {
    const segments = pair.remote_path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      throw new SyncError(`Cannot resolve empty remote_path for pair ${pair.pair_id}`);
    }

    let parentId: string | null = null;
    let resolvedId = "";

    for (const segment of segments) {
      const folders = await client.listRemoteFolders(parentId);
      process.stderr.write(`[ENGINE] resolveRemoteId: looking for "${segment}" among [${folders.map((f) => f.name).join(", ")}]\n`);
      const match = folders.find((f) => f.name === segment);
      if (!match) {
        process.stderr.write(`[ENGINE] resolveRemoteId: "${segment}" not found — creating it\n`);
        resolvedId = await client.createRemoteFolder(parentId, segment);
        process.stderr.write(`[ENGINE] resolveRemoteId: created "${segment}" id=${resolvedId.slice(-8)}\n`);
      } else {
        resolvedId = match.id;
      }
      parentId = resolvedId;
    }

    this.stateDb.updatePairRemoteId(pair.pair_id, resolvedId);
    return resolvedId;
  }

  private async hashLocalFile(fullPath: string): Promise<string | null> {
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(fullPath)) {
        hash.update(chunk as Buffer);
      }
      return hash.digest("hex");
    } catch {
      return null; // unreadable → null → detectConflict treats as conflict (conservative)
    }
  }

  private async walkLocalTree(localPath: string): Promise<{
    files: Map<string, LocalFile>;
    dirs: Set<string>;
  }> {
    const fileMap = new Map<string, LocalFile>();
    const dirSet = new Set<string>();
    const visited = new Set<string>([localPath]);

    const walkDir = async (dirPath: string, isRoot: boolean): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch (err) {
        if (isRoot) throw err; // root failure propagates — inaccessible pair path aborts sync cycle
        debugLog(`sync-engine: readdir failed for ${dirPath} — skipping`);
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // skip symlinks entirely — no traversal
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (visited.has(fullPath)) continue; // cycle guard (bind-mounts, hard-linked dirs)
          visited.add(fullPath);
          const relDir = relative(localPath, fullPath);
          if (relDir) dirSet.add(relDir);
          await walkDir(fullPath, false);
        } else if (entry.isFile()) {
          // Skip conflict copies — they are local-only artifacts and must never be synced.
          if (/\.conflict-\d{4}-\d{2}-\d{2}-\d+(-[a-z0-9]+)?$/.test(entry.name)) continue;
          const relPath = relative(localPath, fullPath);
          try {
            const s = await stat(fullPath);
            fileMap.set(relPath, {
              relativePath: relPath,
              mtime: s.mtime.toISOString(),
              size: s.size,
            });
          } catch {
            // File deleted between readdir and stat — skip it.
            debugLog(`sync-engine: stat failed for ${fullPath} — skipping`);
          }
        }
      }
    };

    await walkDir(localPath, true);
    return { files: fileMap, dirs: dirSet };
  }

  private async walkRemoteTree(
    folderId: string,
    prefix: string,
    client: DriveClient,
    depth = 0,
  ): Promise<{ files: Map<string, RemoteFile>; folders: Map<string, string> }> {
    if (depth >= MAX_REMOTE_TREE_DEPTH) {
      debugLog(`sync-engine: walkRemoteTree depth cap (${MAX_REMOTE_TREE_DEPTH}) at "${prefix}" — subtree skipped`);
      return { files: new Map(), folders: new Map() };
    }

    const fileMap = new Map<string, RemoteFile>();
    const folderMap = new Map<string, string>();

    const [files, subfolders] = await Promise.all([
      client.listRemoteFiles(folderId),
      client.listRemoteFolders(folderId),
    ]);

    for (const f of files) {
      fileMap.set(prefix + f.name, f);
    }

    for (const sf of subfolders) {
      const relDir = prefix + sf.name;
      folderMap.set(relDir, sf.id);
      const sub = await this.walkRemoteTree(sf.id, relDir + "/", client, depth + 1);
      for (const [k, v] of sub.files) fileMap.set(k, v);
      for (const [k, v] of sub.folders) folderMap.set(k, v);
    }

    return { files: fileMap, folders: folderMap };
  }

  private async computeWorkList(
    pair: SyncPair,
    localFiles: Map<string, LocalFile>,
    remoteFiles: Map<string, RemoteFile>,
    remoteFolders: Map<string, string>,
    syncStates: Map<string, SyncState>,
  ): Promise<WorkItem[]> {
    const workItems: WorkItem[] = [];

    // Process local files
    for (const [relPath, local] of localFiles) {
      const remote = remoteFiles.get(relPath);
      const state = syncStates.get(relPath);

      if (remote) {
        // File exists both locally and remotely
        if (!state) {
          // No prior sync record — bootstrap case (pair re-added or first sync on pre-existing files).
          // Compare mtime (second precision) and size to determine action rather than blindly colliding.
          const localMtimeSec  = local.mtime.slice(0, 19);
          const remoteMtimeSec = remote.remote_mtime.slice(0, 19);
          if (localMtimeSec === remoteMtimeSec && local.size === remote.size) {
            // Looks identical — record as already synced (bootstrap_match executor hashes to confirm).
            workItems.push({
              kind: "bootstrap_match",
              relativePath: relPath,
              remoteNodeId: remote.id,
              remoteMtime: remote.remote_mtime,
              localMtime: local.mtime,
            });
          } else if (remote.remote_mtime > local.mtime) {
            // Remote is newer — download to update local copy.
            workItems.push({
              kind: "download",
              relativePath: relPath,
              nodeUid: remote.id,
              size: remote.size,
              remoteMtime: remote.remote_mtime,
            });
          } else if (local.mtime > remote.remote_mtime) {
            // Local is newer — upload new revision.
            const parentDir = dirname(relPath);
            const remoteFolderId =
              parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
            if (!remoteFolderId) {
              debugLog(`sync-engine: skipping bootstrap upload ${relPath} — remote parent dir not found`);
              continue;
            }
            workItems.push({
              kind: "upload",
              relativePath: relPath,
              remoteFolderId,
              existingNodeUid: remote.id,
              size: local.size,
              localMtime: local.mtime,
            });
          } else {
            // Same mtime-second but different size — genuine collision.
            workItems.push({
              kind: "new_file_collision",
              relativePath: relPath,
              remoteNodeId: remote.id,
              remoteMtime: remote.remote_mtime,
              remoteSize: remote.size,
            });
          }
          continue;
        }
        const localChanged = local.mtime !== state.local_mtime;
        const remoteChanged = remote.remote_mtime !== state.remote_mtime;

        if (localChanged && remoteChanged) {
          // Conflict detection (Story 4-1).
          // Only compute local hash for same-second ambiguity (performance guard).
          const localSameSecond  = local.mtime.slice(0, 19) === state.local_mtime.slice(0, 19);
          const remoteSameSecond = remote.remote_mtime.slice(0, 19) === state.remote_mtime.slice(0, 19);
          let currentLocalHash: string | null = null;
          if (localSameSecond && remoteSameSecond) {
            currentLocalHash = await this.hashLocalFile(join(pair.local_path, relPath));
          }
          const result = detectConflict(
            local.mtime, state.local_mtime,
            remote.remote_mtime, state.remote_mtime,
            state.content_hash,
            currentLocalHash,
          );
          if (result.isConflict) {
            workItems.push({
              kind: "conflict",
              relativePath: relPath,
              remoteNodeId: remote.id,
              remoteMtime: remote.remote_mtime,
              remoteSize: remote.size,
            });
          }
          // If no conflict (same-second + same hash): file is effectively unchanged; skip.
          continue;
        }
        if (localChanged) {
          // Upload new revision of existing remote file
          const parentDir = dirname(relPath);
          const remoteFolderId =
            parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
          if (!remoteFolderId) {
            debugLog(`sync-engine: skipping upload ${relPath} — remote parent dir not found`);
            continue;
          }
          workItems.push({
            kind: "upload",
            relativePath: relPath,
            remoteFolderId,
            existingNodeUid: remote.id,
            size: local.size,
            localMtime: local.mtime,
          });
        } else if (remoteChanged) {
          // Download
          workItems.push({
            kind: "download",
            relativePath: relPath,
            nodeUid: remote.id,
            size: remote.size,
            remoteMtime: remote.remote_mtime,
          });
        }
        // else: unchanged — skip
      } else {
        if (state) {
          // Remote was deleted — remove local copy (AC2 of 4-0b)
          workItems.push({ kind: "delete_local", relativePath: relPath });
        } else {
          // Truly new local file → upload
          const parentDir = dirname(relPath);
          const remoteFolderId =
            parentDir === "." ? pair.remote_id : remoteFolders.get(parentDir);
          if (!remoteFolderId) {
            process.stderr.write(`[ENGINE] skip upload ${relPath} — parentDir="${parentDir}" not in remoteFolders\n`);
            continue;
          }
          workItems.push({
            kind: "upload",
            relativePath: relPath,
            remoteFolderId,
            size: local.size,
            localMtime: local.mtime,
          });
        }
      }
    }

    // Process remote-only files (new remote → download)
    for (const [relPath, remote] of remoteFiles) {
      if (localFiles.has(relPath)) continue; // already handled above

      const state = syncStates.get(relPath);
      if (state) {
        // Local was deleted — trash the remote (AC1 of 4-0b)
        workItems.push({ kind: "trash_remote", relativePath: relPath, remoteNodeId: remote.id });
        continue;
      }

      // New remote file
      workItems.push({
        kind: "download",
        relativePath: relPath,
        nodeUid: remote.id,
        size: remote.size,
        remoteMtime: remote.remote_mtime,
      });
    }

    // Both-sides-deleted: sync_state present but neither local nor remote has the path
    for (const relPath of syncStates.keys()) {
      if (!localFiles.has(relPath) && !remoteFiles.has(relPath)) {
        workItems.push({ kind: "clear_state", relativePath: relPath });
      }
    }

    return workItems;
  }

  private async uploadOne(pair: SyncPair, item: WorkItem & { kind: "upload" }, client: DriveClient): Promise<{ node_uid: string }> {
    const localPath = join(pair.local_path, item.relativePath);
    const stream = Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream<Uint8Array>;
    const body = {
      stream,
      sizeBytes: item.size,
      modificationTime: new Date(item.localMtime),
      mediaType: "application/octet-stream",
    };
    if (item.existingNodeUid) {
      // File already exists remotely — upload a new revision instead of creating a new node.
      const result = await this.withBackoff(() => client.uploadFileRevision(item.existingNodeUid!, body));
      return { node_uid: result.node_uid };
    }
    const result = await this.withBackoff(() => client.uploadFile(item.remoteFolderId, basename(item.relativePath), body));
    return { node_uid: result.node_uid };
  }

  private async downloadOne(
    pair: SyncPair,
    item: WorkItem & { kind: "download" },
    client: DriveClient,
  ): Promise<void> {
    const destPath = join(pair.local_path, item.relativePath);
    const tmpPath = `${destPath}.protondrive-tmp-${Date.now()}`;
    await mkdir(dirname(destPath), { recursive: true });
    const nodeWritable = createWriteStream(tmpPath);
    const writableStream = Writable.toWeb(nodeWritable) as WritableStream<Uint8Array>;
    try {
      await this.withBackoff(() => client.downloadFile(item.nodeUid, writableStream));
      // Explicitly end and flush — the SDK writes all chunks but does not
      // guarantee it closes the WritableStream, so nodeWritable.close/finish
      // may never fire if we just wait passively.
      await new Promise<void>((resolve, reject) => {
        if (nodeWritable.writableFinished) {
          resolve();
          return;
        }
        nodeWritable.once("finish", resolve);
        nodeWritable.once("error", reject);
        if (!nodeWritable.writableEnded) {
          nodeWritable.end();
        }
      });
      await rename(tmpPath, destPath);
    } catch (err) {
      // Close the underlying Node writable to release the file descriptor
      // before attempting to remove the tmp file.
      await new Promise<void>((resolve) => {
        if (nodeWritable.closed) {
          resolve();
        } else {
          nodeWritable.destroy();
          nodeWritable.once("close", resolve);
        }
      });
      try {
        await unlink(tmpPath);
      } catch {
        /* already gone */
      }
      throw err;
    }
  }
}
