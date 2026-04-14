import { readdir, stat, rename, unlink, mkdir } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { IpcPushEvent } from "./ipc.js";
import type { DriveClient, RemoteFile } from "./sdk.js";
import type { StateDb, SyncPair } from "./state-db.js";
import { listConfigPairs, type ConfigPair } from "./config.js";
import { SyncError } from "./errors.js";
import { debugLog } from "./debug-log.js";

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
  private isSyncing = false;

  constructor(
    private readonly stateDb: StateDb,
    private readonly emitEvent: (event: IpcPushEvent) => void,
    private readonly getConfigPairs: () => ConfigPair[] = listConfigPairs,
  ) {}

  setDriveClient(client: DriveClient | null): void {
    this.driveClient = client;
  }

  async startSyncAll(): Promise<void> {
    if (this.isSyncing) return; // re-entrancy guard (F1)
    this.isSyncing = true;
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
          process.stderr.write(`[ENGINE] sync_cycle_error pair=${pair.pair_id.slice(-8)}: ${msg}\n`);
          this.emitEvent({
            type: "error",
            payload: { code: "sync_cycle_error", message: msg, pair_id: pair.pair_id },
          });
        }
      }
    } finally {
      process.stderr.write("[ENGINE] startSyncAll: done\n");
      this.isSyncing = false;
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

  private async uploadOne(pair: SyncPair, item: WorkItem & { kind: "upload" }, client: DriveClient): Promise<void> {
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
      await client.uploadFileRevision(item.existingNodeUid, body);
    } else {
      await client.uploadFile(item.remoteFolderId, basename(item.relativePath), body);
    }
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
      await client.downloadFile(item.nodeUid, writableStream);
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
