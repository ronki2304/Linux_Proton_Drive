import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { createConflictCopy, detectConflict } from "./conflict.js";
import type { StateDB } from "./state-db.js";
import type { DriveClient } from "../sdk/client.js";
import type { ConflictRecord, DriveItem, SyncPair, SyncStateRecord } from "../types.js";
import type { SessionToken } from "../types.js";

export interface SyncOptions {
  onProgress?: (msg: string) => void;
}

export interface SyncResult {
  transferred: number;
  conflicts: ConflictRecord[];
  errors: string[];
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function atomicDownload(
  client: DriveClient,
  remotePath: string,
  localPath: string,
): Promise<void> {
  const tmpPath = localPath + ".protondrive-tmp";
  const dir = path.dirname(localPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await client.downloadFile(remotePath, tmpPath);
    fs.renameSync(tmpPath, localPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // swallow
    }
    throw err;
  }
}

function getMtime(filePath: string): string {
  return fs.statSync(filePath).mtime.toISOString();
}

export class SyncEngine {
  constructor(private readonly stateDb: StateDB) {}

  async run(
    pairs: SyncPair[],
    _token: SessionToken,
    driveClient: DriveClient,
    opts: SyncOptions = {},
  ): Promise<SyncResult> {
    const result: SyncResult = { transferred: 0, conflicts: [], errors: [] };

    for (const pair of pairs) {
      await this.syncPair(pair, driveClient, opts, result);
    }

    return result;
  }

  private async syncPair(
    pair: SyncPair,
    driveClient: DriveClient,
    opts: SyncOptions,
    result: SyncResult,
  ): Promise<void> {
    const expandedLocal = pair.local.replace(/^~/, process.env["HOME"] ?? "~");

    // Get remote file list
    let remoteItems: DriveItem[] = [];
    try {
      remoteItems = await driveClient.listFolder(pair.remote);
    } catch (err) {
      result.errors.push(
        `Failed to list remote folder ${pair.remote}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Build remote map: remotePath → DriveItem
    const remoteMap = new Map<string, DriveItem>();
    for (const item of remoteItems) {
      if (!item.isFolder) {
        remoteMap.set(item.remotePath, item);
      }
    }

    // Collect local files
    const localFiles: string[] = [];
    if (fs.existsSync(expandedLocal)) {
      const stat = fs.statSync(expandedLocal);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(expandedLocal, {
          recursive: true,
          encoding: "utf8",
        }) as string[];
        for (const entry of entries) {
          const fullPath = path.join(expandedLocal, entry);
          if (fs.statSync(fullPath, { throwIfNoEntry: false })?.isFile()) {
            localFiles.push(fullPath);
          }
        }
      } else {
        localFiles.push(expandedLocal);
      }
    }

    // Build set of local paths mapped to remote paths
    const localToRemote = new Map<string, string>();
    for (const localPath of localFiles) {
      const relPath = path.relative(expandedLocal, localPath);
      const remotePath = path.posix.join(pair.remote, relPath.replace(/\\/g, "/"));
      localToRemote.set(localPath, remotePath);
    }

    // Sync local → remote (uploads)
    for (const [localPath, remotePath] of localToRemote) {
      await this.handleLocalFile(
        localPath,
        remotePath,
        pair,
        driveClient,
        remoteMap,
        opts,
        result,
      );
    }

    // Sync remote → local (downloads for remote-only files)
    for (const [remotePath, remoteItem] of remoteMap) {
      // Check if we already handled this remote path from local side
      const alreadyHandled = [...localToRemote.values()].includes(remotePath);
      if (!alreadyHandled) {
        const relPath = remotePath.startsWith(pair.remote + "/")
          ? remotePath.slice(pair.remote.length + 1)
          : path.basename(remotePath);
        const localDest = path.join(expandedLocal, relPath);
        await this.handleRemoteOnlyFile(
          localDest,
          remoteItem,
          pair,
          driveClient,
          opts,
          result,
        );
      }
    }
  }

  private async handleLocalFile(
    localPath: string,
    remotePath: string,
    pair: SyncPair,
    driveClient: DriveClient,
    remoteMap: Map<string, DriveItem>,
    opts: SyncOptions,
    result: SyncResult,
  ): Promise<void> {
    const stored = this.stateDb.get(localPath);
    const currentMtime = getMtime(localPath);

    // Delta check: skip if mtime unchanged
    if (stored && stored.lastSyncMtime === currentMtime) {
      return;
    }

    // Hash check: skip if content unchanged despite mtime change
    const currentHash = sha256File(localPath);
    if (stored && stored.lastSyncHash === currentHash) {
      // Update mtime only
      this.stateDb.upsert({ ...stored, lastSyncMtime: currentMtime });
      return;
    }

    const remoteItem = remoteMap.get(remotePath);
    const isConflict =
      stored &&
      remoteItem &&
      detectConflict(currentMtime, remoteItem.mtime, stored.lastSyncMtime);

    if (isConflict) {
      // Conflict: create conflict copy, upload both
      opts.onProgress?.(`Conflict detected: ${localPath}`);
      let conflictRecord: ConflictRecord;
      const conflictDate = new Date();
      try {
        conflictRecord = createConflictCopy(localPath, conflictDate);
      } catch (err) {
        result.errors.push(
          `Failed to create conflict copy for ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      try {
        await driveClient.uploadFile(localPath, remotePath);
        const conflictRemotePath = remotePath + ".conflict-" + conflictDate.toISOString().slice(0, 10);
        await driveClient.uploadFile(conflictRecord.conflictCopy, conflictRemotePath);
        const newRecord: SyncStateRecord = {
          syncPairId: pair.id,
          localPath,
          remotePath,
          lastSyncMtime: currentMtime,
          lastSyncHash: currentHash,
          state: "conflict",
        };
        this.stateDb.upsert(newRecord);
        const conflictCopyHash = sha256File(conflictRecord.conflictCopy);
        this.stateDb.upsert({
          syncPairId: pair.id,
          localPath: conflictRecord.conflictCopy,
          remotePath: conflictRemotePath,
          lastSyncMtime: getMtime(conflictRecord.conflictCopy),
          lastSyncHash: conflictCopyHash,
          state: "synced",
        });
        result.conflicts.push(conflictRecord);
        result.transferred += 2;
      } catch (err) {
        result.errors.push(
          `Failed to upload conflict files for ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Local-only change: upload
      opts.onProgress?.(`Uploading: ${localPath}`);
      try {
        await driveClient.uploadFile(localPath, remotePath);
        this.stateDb.upsert({
          syncPairId: pair.id,
          localPath,
          remotePath,
          lastSyncMtime: currentMtime,
          lastSyncHash: currentHash,
          state: "synced",
        });
        result.transferred++;
      } catch (err) {
        result.errors.push(
          `Failed to upload ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleRemoteOnlyFile(
    localPath: string,
    remoteItem: DriveItem,
    pair: SyncPair,
    driveClient: DriveClient,
    opts: SyncOptions,
    result: SyncResult,
  ): Promise<void> {
    const stored = this.stateDb.get(localPath);
    // If we have a state record and the remote mtime matches last sync, skip
    if (stored && stored.lastSyncMtime === remoteItem.mtime) {
      return;
    }

    opts.onProgress?.(`Downloading: ${remoteItem.remotePath}`);
    try {
      await atomicDownload(driveClient, remoteItem.remotePath, localPath);
      const newHash = sha256File(localPath);
      this.stateDb.upsert({
        syncPairId: pair.id,
        localPath,
        remotePath: remoteItem.remotePath,
        lastSyncMtime: remoteItem.mtime,
        lastSyncHash: newHash,
        state: "synced",
      });
      result.transferred++;
    } catch (err) {
      result.errors.push(
        `Failed to download ${remoteItem.remotePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
