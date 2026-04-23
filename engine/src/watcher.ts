import { readdir } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import type { FSWatcher, WatchListener } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import type { IpcPushEvent } from "./ipc.js";
import type { SyncPair, ChangeQueueEntry, ChangeType } from "./state-db.js";
import { debugLog } from "./debug-log.js";

export type WatchFn = (path: string, listener: WatchListener<string>) => FSWatcher;
export type ReaddirFn = (path: string, opts: { withFileTypes: true; recursive: true }) => Promise<import("node:fs").Dirent[]>;

export class FileWatcher {
  private readonly watchers = new Map<string, FSWatcher>(); // dir → watcher
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private inotifyExhausted = false;

  private readonly missingPairs = new Set<string>(); // pair_ids already reported missing

  constructor(
    private readonly pairs: SyncPair[],
    private readonly onChangesDetected: (pairId: string) => Promise<void>,
    private readonly emitEvent: (event: IpcPushEvent) => void,
    private readonly watchFn: WatchFn = watch,
    private readonly debounceMs: number = 1000,
    private readonly isOnline: () => boolean = () => true,
    private readonly enqueueChange: (entry: Omit<ChangeQueueEntry, "id">) => void = () => {},
    private readonly readdirFn: ReaddirFn = readdir as ReaddirFn,
  ) {}

  async initialize(): Promise<void> {
    this.emitEvent({ type: "watcher_status", payload: { status: "initializing" } });
    for (const pair of this.pairs) {
      if (this.stopped || this.inotifyExhausted) break;
      try {
        await this.setupPairWatches(pair);
      } catch (err) {
        debugLog(`watcher: setupPairWatches failed for ${pair.pair_id}: ${(err as Error).message}`);
      }
    }
    this.emitEvent({ type: "watcher_status", payload: { status: "ready" } });
  }

  private async setupPairWatches(pair: SyncPair): Promise<void> {
    const dirs: string[] = [pair.local_path];
    const entries = await this.readdirFn(pair.local_path, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(join(entry.parentPath, entry.name));
      }
    }
    for (const dir of dirs) {
      if (this.stopped) break;
      try {
        const watcher = this.watchFn(dir, (evt, filename) => {
          if (filename === null || filename === "") return;
          // Always enqueue the change regardless of online state (AC2 — Story 2-12).
          // When online, also schedule a drain so queued entries are processed
          // immediately rather than waiting for the next reconnect.
          this.queueFileChange(pair, dir, evt ?? "change", filename);
          if (this.isOnline()) {
            this.scheduleSync(pair.pair_id);
          }
        });
        this.watchers.set(dir, watcher);
        watcher.on("error", (e) =>
          debugLog(`watcher: FSWatcher error on ${dir}: ${(e as Error).message}`),
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
          this.inotifyExhausted = true;
          if (!this.stopped) {
            this.emitEvent({
              type: "error",
              payload: {
                code: "INOTIFY_LIMIT",
                message:
                  "Too many files to watch — close other apps or increase system inotify limit",
                pair_id: pair.pair_id,
              },
            });
          }
          break;
        } else {
          debugLog(`watcher: fs.watch failed for ${dir}: ${(err as Error).message}`);
          continue;
        }
      }
    }

    // Watch the parent directory to detect if the pair root itself is renamed
    // or deleted. inotify fires on the parent for IN_MOVE_FROM/IN_DELETE, not on
    // the watched inode, so subdirectory watches above never see it.
    // Skip if the pair root has no meaningful parent (e.g. "/" where dirname===self
    // and basename==="") — watching root would be both useless and noisy.
    const parentDir = dirname(pair.local_path);
    const pairRootName = basename(pair.local_path);
    if (!this.stopped && !this.inotifyExhausted && parentDir !== pair.local_path && pairRootName !== "") {
      try {
        const parentWatcher = this.watchFn(parentDir, (evt, filename) => {
          if (!filename || filename !== pairRootName) return;
          if (!existsSync(pair.local_path)) {
            if (!this.missingPairs.has(pair.pair_id)) {
              this.missingPairs.add(pair.pair_id);
              debugLog(`watcher: local_folder_missing (parent watch) pair=${pair.pair_id.slice(-8)} path=${pair.local_path}`);
              this.emitEvent({
                type: "local_folder_missing",
                payload: { pair_id: pair.pair_id, local_path: pair.local_path },
              });
            }
          } else if (this.missingPairs.has(pair.pair_id)) {
            // Folder restored — clear flag and trigger a resync.
            this.missingPairs.delete(pair.pair_id);
            debugLog(`watcher: pair root restored pair=${pair.pair_id.slice(-8)}, scheduling sync`);
            if (this.isOnline()) this.scheduleSync(pair.pair_id);
          }
        });
        // Key by pair_id so multiple pairs with the same parent don't clobber each other.
        this.watchers.set(`parent:${pair.pair_id}`, parentWatcher);
        parentWatcher.on("error", (e) =>
          debugLog(`watcher: FSWatcher error on parent ${parentDir}: ${(e as Error).message}`),
        );
      } catch (err) {
        // Non-fatal: reconcile will still catch folder-missing on the next cycle.
        debugLog(`watcher: fs.watch failed for parent ${parentDir}: ${(err as Error).message}`);
      }
    }
  }

  private queueFileChange(pair: SyncPair, dir: string, evt: string, filename: string): void {
    // inotify watches inodes, not paths — if the pair root was renamed or
    // deleted the watch keeps firing. Detect this here for immediate feedback
    // rather than waiting for the next reconcile cycle.
    if (!existsSync(pair.local_path)) {
      if (!this.missingPairs.has(pair.pair_id)) {
        this.missingPairs.add(pair.pair_id);
        debugLog(`watcher: local_folder_missing detected for pair=${pair.pair_id.slice(-8)} path=${pair.local_path}`);
        this.emitEvent({
          type: "local_folder_missing",
          payload: { pair_id: pair.pair_id, local_path: pair.local_path },
        });
      }
      return;
    }
    // Folder restored — clear missing flag so future events are processed again.
    this.missingPairs.delete(pair.pair_id);

    const fullPath = join(dir, filename);
    const relPath = relative(pair.local_path, fullPath);
    const changeType: ChangeType =
      evt === "change"
        ? "modified"
        : existsSync(fullPath) ? "created" : "deleted";
    try {
      this.enqueueChange({
        pair_id: pair.pair_id,
        relative_path: relPath,
        change_type: changeType,
        queued_at: new Date().toISOString(),
      });
    } catch (e) {
      debugLog(`watcher: enqueueChange failed for ${pair.pair_id}/${relPath}: ${(e as Error).message}`);
    }
  }

  private scheduleSync(pairId: string): void {
    if (this.stopped || this.inotifyExhausted) return;
    const existing = this.debounceTimers.get(pairId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.stopped || this.inotifyExhausted) return;
      this.debounceTimers.delete(pairId);
      this.onChangesDetected(pairId).catch((e) =>
        debugLog(`watcher: onChangesDetected failed for ${pairId}: ${(e as Error).message}`),
      );
    }, this.debounceMs);
    this.debounceTimers.set(pairId, timer);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch (e) {
        debugLog(`watcher: close() failed: ${(e as Error).message}`);
      }
    }
    this.watchers.clear();
  }
}
