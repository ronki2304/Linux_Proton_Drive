import { readdir } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import type { FSWatcher, WatchListener } from "node:fs";
import { join, relative } from "node:path";
import type { IpcPushEvent } from "./ipc.js";
import type { SyncPair, ChangeQueueEntry, ChangeType } from "./state-db.js";
import { debugLog } from "./debug-log.js";

export type WatchFn = (path: string, listener: WatchListener<string>) => FSWatcher;

export class FileWatcher {
  private readonly watchers = new Map<string, FSWatcher>(); // dir → watcher
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private inotifyExhausted = false;

  constructor(
    private readonly pairs: SyncPair[],
    private readonly onChangesDetected: (pairId: string) => Promise<void>,
    private readonly emitEvent: (event: IpcPushEvent) => void,
    private readonly watchFn: WatchFn = watch,
    private readonly debounceMs: number = 1000,
    private readonly isOnline: () => boolean = () => true,
    private readonly enqueueChange: (entry: Omit<ChangeQueueEntry, "id">) => void = () => {},
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
    const entries = await readdir(pair.local_path, { withFileTypes: true, recursive: true });
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
          if (!this.isOnline()) {
            this.queueFileChange(pair, dir, evt ?? "change", filename);
          } else {
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
          this.emitEvent({
            type: "error",
            payload: {
              code: "INOTIFY_LIMIT",
              message:
                "Too many files to watch — close other apps or increase system inotify limit",
              pair_id: pair.pair_id,
            },
          });
          break;
        } else {
          debugLog(`watcher: fs.watch failed for ${dir}: ${(err as Error).message}`);
          continue;
        }
      }
    }
  }

  private queueFileChange(pair: SyncPair, dir: string, evt: string, filename: string): void {
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
    const existing = this.debounceTimers.get(pairId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.stopped) return;
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
