import { readdir, stat, rename, unlink, mkdir } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { IpcPushEvent } from "./ipc.js";
import type { DriveClient, RemoteFile } from "./sdk.js";
import type { ChangeQueueEntry, StateDb, SyncPair } from "./state-db.js";
import { listConfigPairs, type ConfigPair } from "./config.js";
import { NetworkError, RateLimitError, SyncError } from "./errors.js";
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
    };

// ── Semaphore ────────────────────────────────────────────────────────────────

class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.count = limit;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.count > 0) {
          this.count--;
          resolve(() => {
            this.count++;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

// ── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private driveClient: DriveClient | null = null;
  // Unified state-machine for sync pathways. `startSyncAll` and `replayQueue`
  // are mutually exclusive: if one is running, the other bounces and sets
  // `replayPending` so the drain runs once after the current operation
  // completes. See Story 3-3 Task 2.2 for rationale.
  private busy: "idle" | "sync" | "replay" = "idle";
  private replayPending = false;

  constructor(
    private readonly stateDb: StateDb,
    private readonly emitEvent: (event: IpcPushEvent) => void,
    private readonly getConfigPairs: () => ConfigPair[] = listConfigPairs,
    private readonly onNetworkFailure: () => void = () => {},
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

  async startSyncAll(): Promise<void> {
    if (this.busy !== "idle") return; // re-entrancy guard (F1)
    this.busy = "sync";
    process.stderr.write("[ENGINE] startSyncAll: begin\n");
    try {
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
      process.stderr.write(`[ENGINE] startSyncAll: ${pairs.length} pair(s)\n`);
      // Sync all pairs sequentially; per-pair errors do not abort siblings
      for (const pair of pairs) {
        try {
          await this.syncPair(pair);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          // A fetch failure means the network dropped mid-sync. Trigger an
          // immediate NetworkMonitor re-check so isCurrentlyOnline transitions
          // to false and the watcher starts queuing instead of scheduling sync.
          // Don't emit sync_cycle_error — the offline event from NetworkMonitor
          // is the correct signal for the UI to act on.
          if (isFetchFailure(err)) {
            process.stderr.write(`[ENGINE] sync aborted — network failure detected, forcing connectivity check\n`);
            this.onNetworkFailure();
            break;
          }
          process.stderr.write(`[ENGINE] sync_cycle_error pair=${pair.pair_id.slice(-8)}: ${msg}\n`);
          this.emitEvent({
            type: "error",
            payload: { code: "sync_cycle_error", message: msg, pair_id: pair.pair_id },
          });
        }
      }
    } finally {
      process.stderr.write("[ENGINE] startSyncAll: done\n");
      this.busy = "idle";
      if (this.replayPending) {
        this.replayPending = false;
        // Fire-and-forget drain — any error is already handled inside
        // replayQueue's per-entry try/catch and emitted as an error push event.
        void this.replayQueue();
      }
    }
  }

  /**
   * Replay the persisted `change_queue` entries after an offline→online
   * transition. Processes per-entry against a one-shot remote snapshot per
   * pair and tallies `{synced, skipped_conflicts, failed}`.
   *
   * Re-entrancy: if another sync pathway (`startSyncAll` or another in-flight
   * `replayQueue`) holds the busy lock, the call sets `replayPending` and
   * returns zero counts; the drain runs exactly once after the current
   * operation releases busy. See Task 2.2/2.2a in Story 3-3.
   *
   * Emission ordering (AC6a):
   *  1. Per-entry `sync_progress` events during upload/trash
   *  2. `queue_replay_complete` fired BEFORE any final `sync_complete`
   *  3. Per-pair `sync_complete` only for pairs with ≥1 successful entry
   */
  async replayQueue(): Promise<{
    synced: number;
    skipped_conflicts: number;
    failed: number;
  }> {
    // Re-entrancy guard — bounce if another pathway is active. The pending
    // flag is one-shot: repeat calls during busy all collapse to a single
    // drain pass after busy clears (which is correct — one pass handles all
    // queued entries).
    if (this.busy !== "idle") {
      this.replayPending = true;
      return { synced: 0, skipped_conflicts: 0, failed: 0 };
    }
    this.busy = "replay";

    let synced = 0;
    let skipped_conflicts = 0;
    let failed = 0;
    const pairsWithSuccess = new Set<string>();

    try {
      // Snapshot driveClient at entry (matches syncPair pattern at line ~128).
      const client = this.driveClient;
      if (!client) {
        // No client — still emit queue_replay_complete (AC6: "even when both
        // counts are zero") so the UI can reliably clear any replaying state.
        return { synced, skipped_conflicts, failed };
      }

      const pairs = this.stateDb.listPairs();
      for (const pair of pairs) {
        const pairQueue = this.stateDb.listQueue(pair.pair_id);
        if (pairQueue.length === 0) continue;

        // One remote-tree walk per pair (not per entry) — avoids O(N²) API
        // calls and keeps us well under rate-limit thresholds (Story 3-4).
        let remoteFiles: Map<string, RemoteFile>;
        let remoteFolders: Map<string, string>;
        try {
          const tree = await this.walkRemoteTree(pair.remote_id, "", client);
          remoteFiles = tree.files;
          remoteFolders = tree.folders;
        } catch (err) {
          // walkRemoteTree failure blocks all entries for this pair — count
          // them as failed and emit one error event per entry so the UI can
          // surface them individually (including the affected relative_path).
          const msg = err instanceof Error ? err.message : "unknown";
          for (const entry of pairQueue) {
            failed++;
            this.emitEvent({
              type: "error",
              payload: {
                code: "queue_replay_failed",
                message: msg,
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
          } else {
            failed++;
          }
        }
      }
    } finally {
      // Ordered emission (AC6a): queue_replay_complete FIRST so the UI can
      // set _conflict_pending_count before any final sync_complete arrives.
      this.emitEvent({
        type: "queue_replay_complete",
        payload: { synced, skipped_conflicts },
      });
      for (const pair_id of pairsWithSuccess) {
        this.emitEvent({
          type: "sync_complete",
          payload: { pair_id, timestamp: new Date().toISOString() },
        });
      }
      this.busy = "idle";
      // Drain a one-shot replayPending flag: if an `online` event (or any
      // other trigger) fired during this replay's execution, the top-of-method
      // busy-check flipped replayPending to true instead of running. Drain it
      // exactly once here so the queued intent isn't lost. The drained call
      // itself processes whatever is now in the queue — if the queue is empty
      // it still emits a zero-count queue_replay_complete per AC6.
      if (this.replayPending) {
        this.replayPending = false;
        void this.replayQueue();
      }
    }

    return { synced, skipped_conflicts, failed };
  }

  /**
   * Per-entry replay dispatch. Returns `"synced" | "conflict" | "failed"`.
   *
   * The decision matrix (from Task 2.6, sole source of truth):
   *
   * | state      | remote     | created/modified            | deleted                  |
   * | undefined  | undefined  | upload (new file)           | dequeue (both agree)     |
   * | undefined  | defined    | conflict (collision)        | conflict (never knew)    |
   * | defined    | undefined  | conflict (remote deleted)   | dequeue (both gone)      |
   * | defined    | defined    | mtime match → upload/trash; mismatch → conflict         |
   */
  private async processQueueEntry(
    pair: SyncPair,
    entry: ChangeQueueEntry,
    remoteFiles: Map<string, RemoteFile>,
    remoteFolders: Map<string, string>,
    client: DriveClient,
  ): Promise<"synced" | "conflict" | "failed"> {
    try {
      const state = this.stateDb.getSyncState(pair.pair_id, entry.relative_path);
      const remote = remoteFiles.get(entry.relative_path);
      const isDelete = entry.change_type === "deleted";

      // Resolve the outcome from the decision table.
      let outcome: "upload" | "trashNode" | "dequeue" | "conflict";
      if (state === undefined && remote === undefined) {
        outcome = isDelete ? "dequeue" : "upload";
      } else if (state === undefined && remote !== undefined) {
        // Either a new-local/existing-remote collision OR a delete of a file
        // we never knew — both are conflicts.
        outcome = "conflict";
      } else if (state !== undefined && remote === undefined) {
        // Remote was deleted by another device. If this was a local delete,
        // we're idempotently in sync. If it was a create/modify, treat as
        // conflict — do NOT silently resurrect the file.
        outcome = isDelete ? "dequeue" : "conflict";
      } else {
        // Both defined — compare stored vs current remote_mtime.
        const remoteUnchanged = state!.remote_mtime === remote!.remote_mtime;
        if (remoteUnchanged) {
          outcome = isDelete ? "trashNode" : "upload";
        } else {
          outcome = "conflict";
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
            this.emitEvent({
              type: "error",
              payload: {
                code: "queue_replay_failed",
                message: "remote parent folder not found",
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
              debugLog(
                `sync-engine: replay upload ${entry.relative_path} — local file missing (ENOENT), routing to conflict`,
              );
              return "conflict";
            }
            const msg = err instanceof Error ? err.message : "unknown";
            debugLog(
              `sync-engine: replay upload ${entry.relative_path} — stat failed (${code ?? "no-code"}): ${msg}`,
            );
            this.emitEvent({
              type: "error",
              payload: {
                code: "queue_replay_failed",
                message: `stat failed: ${msg}`,
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
          this.stateDb.commitUpload(
            {
              pair_id: pair.pair_id,
              relative_path: entry.relative_path,
              local_mtime: workItem.localMtime,
              remote_mtime: workItem.localMtime,
              content_hash: null,
            },
            entry.id,
          );
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
        case "conflict": {
          // No DB mutation — entry stays in queue for Epic 4 resolution.
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
      const msg = err instanceof Error ? err.message : "unknown";
      debugLog(
        `sync-engine: queue_replay_failed pair=${pair.pair_id} entry=${entry.id} path=${entry.relative_path}: ${msg}`,
      );
      this.emitEvent({
        type: "error",
        payload: {
          code: "queue_replay_failed",
          message: msg,
          pair_id: pair.pair_id,
          relative_path: entry.relative_path,
        },
      });
      return "failed";
    }
  }

  private async syncPair(pair: SyncPair): Promise<void> {
    // Snapshot driveClient at cycle start — prevents null-dereference mid-flight
    // if setDriveClient(null) is called during an active Promise.all. (F8)
    const client = this.driveClient;
    if (!client) return;

    // Resolve remote_id if empty (AC6)
    if (pair.remote_id === "") {
      try {
        process.stderr.write(`[ENGINE] resolving remote_id for pair=${pair.pair_id.slice(-8)} remote_path=${pair.remote_path}\n`);
        const resolvedId = await this.resolveRemoteId(pair, client);
        process.stderr.write(`[ENGINE] resolved remote_id=${resolvedId.slice(-8)} for pair=${pair.pair_id.slice(-8)}\n`);
        // Update the in-memory pair for this cycle
        pair = { ...pair, remote_id: resolvedId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        process.stderr.write(`[ENGINE] remote_path_not_found pair=${pair.pair_id.slice(-8)}: ${msg}\n`);
        this.emitEvent({
          type: "error",
          payload: { code: "remote_path_not_found", message: msg, pair_id: pair.pair_id },
        });
        return;
      }
    }

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
    // Collect all local dirs (both from explicit dir entries and as parents of
    // files). Sort so parents are created before children.
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
    // Create any remote directories that don't exist locally yet.
    for (const relDir of [...remoteFolders.keys()].sort()) {
      const localDir = join(pair.local_path, relDir);
      await mkdir(localDir, { recursive: true });
    }

    const workItems = this.computeWorkList(pair, localFiles, remoteFiles, remoteFolders, syncStates);
    process.stderr.write(`[ENGINE] workList: ${workItems.length} items (localFiles=${localFiles.size} remoteFiles=${remoteFiles.size} remoteFolders=${remoteFolders.size})\n`);

    // Emit initial sync_progress (AC7)
    const bytesTotal = workItems.reduce((a, w) => a + w.size, 0);
    this.emitEvent({
      type: "sync_progress",
      payload: {
        pair_id: pair.pair_id,
        files_done: 0,
        files_total: workItems.length,
        bytes_done: 0,
        bytes_total: bytesTotal,
      },
    });

    await this.executeWorkList(pair, workItems, client);

    // Persist and emit sync_complete (AC7)
    const completedAt = new Date().toISOString();
    this.stateDb.updateLastSynced(pair.pair_id, completedAt);
    this.emitEvent({
      type: "sync_complete",
      payload: { pair_id: pair.pair_id, timestamp: completedAt },
    });
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

  private async walkLocalTree(localPath: string): Promise<{
    files: Map<string, LocalFile>;
    dirs: Set<string>;
  }> {
    const fileMap = new Map<string, LocalFile>();
    const dirSet = new Set<string>();
    // Let readdir failures propagate — an inaccessible local path aborts the pair
    // sync cycle via startSyncAll's catch, emitting sync_cycle_error. (F3)
    const entries = await readdir(localPath, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      // entry.parentPath is Node.js 21.2+; fallback to entry.path for older versions
      const dir = (entry as { parentPath?: string }).parentPath ?? (entry as { path?: string }).path ?? localPath;
      if (entry.isDirectory()) {
        const relDir = relative(localPath, join(dir, entry.name));
        if (relDir) dirSet.add(relDir);
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = join(dir, entry.name);
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
    return { files: fileMap, dirs: dirSet };
  }

  private async walkRemoteTree(
    folderId: string,
    prefix: string,
    client: DriveClient,
  ): Promise<{ files: Map<string, RemoteFile>; folders: Map<string, string> }> {
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
      const sub = await this.walkRemoteTree(sf.id, relDir + "/", client);
      for (const [k, v] of sub.files) fileMap.set(k, v);
      for (const [k, v] of sub.folders) folderMap.set(k, v);
    }

    return { files: fileMap, folders: folderMap };
  }

  private computeWorkList(
    pair: SyncPair,
    localFiles: Map<string, LocalFile>,
    remoteFiles: Map<string, RemoteFile>,
    remoteFolders: Map<string, string>,
    syncStates: Map<string, { local_mtime: string; remote_mtime: string }>,
  ): WorkItem[] {
    const workItems: WorkItem[] = [];

    // Process local files
    for (const [relPath, local] of localFiles) {
      const remote = remoteFiles.get(relPath);
      const state = syncStates.get(relPath);

      if (remote) {
        // File exists both locally and remotely
        if (!state) {
          // Both exist but no sync state → conflict, skip (Epic 4)
          debugLog(`sync-engine: skipping conflict (no sync_state) for ${relPath}`);
          continue;
        }
        const localChanged = local.mtime !== state.local_mtime;
        const remoteChanged = remote.remote_mtime !== state.remote_mtime;

        if (localChanged && remoteChanged) {
          // Both changed → conflict, skip (Epic 4)
          debugLog(`sync-engine: skipping both-changed conflict for ${relPath}`);
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
        // Local-only: new file → upload
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

    // Process remote-only files (new remote → download)
    for (const [relPath, remote] of remoteFiles) {
      if (localFiles.has(relPath)) continue; // already handled above

      const state = syncStates.get(relPath);
      if (state) {
        // Had sync state but local file is gone — don't re-download
        // (deletion handling is out of scope for 2.5)
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

    return workItems;
  }

  private async executeWorkList(pair: SyncPair, workItems: WorkItem[], client: DriveClient): Promise<void> {
    const sem = new Semaphore(3);
    let filesDone = 0;
    let bytesDone = 0;
    const bytesTotal = workItems.reduce((a, w) => a + w.size, 0);

    await Promise.all(
      workItems.map((item) =>
        this.processOne(pair, item, sem, client, () => {
          filesDone++;
          bytesDone += item.size;
          this.emitEvent({
            type: "sync_progress",
            payload: {
              pair_id: pair.pair_id,
              files_done: filesDone,
              files_total: workItems.length,
              bytes_done: bytesDone,
              bytes_total: bytesTotal,
            },
          });
        }),
      ),
    );
  }

  private async processOne(
    pair: SyncPair,
    item: WorkItem,
    sem: Semaphore,
    client: DriveClient,
    onComplete: () => void,
  ): Promise<void> {
    const release = await sem.acquire();
    try {
      if (item.kind === "upload") {
        await this.uploadOne(pair, item, client);
      } else {
        await this.downloadOne(pair, item, client);
      }

      // Determine post-transfer mtimes for state persistence
      const destPath = join(pair.local_path, item.relativePath);
      let localMtime: string;
      let remoteMtime: string;

      if (item.kind === "upload") {
        // For uploads: remote_mtime = localMtime because the SDK stores
        // body.modificationTime as activeRevision.claimedModificationTime.
        // Using any other value would cause an infinite sync loop.
        localMtime = item.localMtime;
        remoteMtime = item.localMtime;
      } else {
        // For downloads: stat the file after rename
        const s = await stat(destPath);
        localMtime = s.mtime.toISOString();
        remoteMtime = item.remoteMtime;
      }

      // 1. Write sync state first — durable before progress counter increments (AC3)
      this.stateDb.upsertSyncState({
        pair_id: pair.pair_id,
        relative_path: item.relativePath,
        local_mtime: localMtime,
        remote_mtime: remoteMtime,
        content_hash: null,
      });

      // 2. Then emit progress
      onComplete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      process.stderr.write(`[ENGINE] sync_file_error ${item.relativePath}: ${msg}\n`);
      this.emitEvent({
        type: "error",
        payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id },
      });
    } finally {
      release();
    }
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
