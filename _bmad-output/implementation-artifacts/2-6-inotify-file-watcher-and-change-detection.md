# Story 2.6: inotify File Watcher & Change Detection

Status: done

## Story

As a user,
I want the app to detect file changes in my synced folders automatically,
So that new or modified files sync without me manually triggering anything.

## Acceptance Criteria

**AC1 — Async initialization with `watcher_status` events:**

**Given** `handleTokenRefresh` succeeds and sync pairs exist in `stateDb.listPairs()`
**When** `fileWatcher.initialize()` is called (void-ed, non-blocking)
**Then** `{type: "watcher_status", payload: {status: "initializing"}}` is emitted before any `fs.watch()` call
**And** `fs.watch(dirPath, listener)` is called once per subdirectory (root included) of each pair's `local_path` — per-directory, NOT `{ recursive: true }`
**And** initialization never blocks the IPC loop (NFR3a) — `void fileWatcher.initialize()` in `main.ts`
**And** on completion `{type: "watcher_status", payload: {status: "ready"}}` is emitted

**AC2 — File change debounce and sync trigger:**

**Given** a file is modified in a watched directory
**When** inotify fires an event via `fs.watch`
**Then** a 1000ms debounce timer is (re)set for that `pair_id`
**And** when the timer fires, `syncEngine.startSyncAll()` is called
**And** the change-to-sync-trigger latency is within 5 seconds of the modification (NFR3)
**And** a burst of N events within 1000ms produces exactly ONE `startSyncAll()` call

**AC3 — ENOSPC handling (inotify watch limit):**

**Given** `fs.watch(dir, listener)` throws a synchronous error with `code === "ENOSPC"`
**When** setting up a watch for that directory
**Then** `{type: "error", payload: {code: "INOTIFY_LIMIT", message: "Too many files to watch — close other apps or increase system inotify limit", pair_id}}` is emitted
**And** the watcher does NOT crash — all `FSWatcher` instances already registered continue operating
**And** no further `fs.watch()` calls are attempted for that pair after the first `ENOSPC`

**AC4 — Watcher stop/cleanup:**

**Given** the watcher is running
**When** `fileWatcher.stop()` is called (token expiry, engine shutdown)
**Then** every `FSWatcher.close()` is called
**And** every pending debounce timer is cleared via `clearTimeout`

**AC5 — Python UI: `watcher_status` event handler:**

**Given** the engine emits a `watcher_status` push event
**When** `engine._dispatch_event` routes it (via the general `_event_handlers` path — line 332 of `engine.py`)
**Then** a registered `engine.on_event("watcher_status", self._on_watcher_status)` callback fires
**And** the handler stores the current watcher status on `self` (e.g., `self._watcher_status: str = status`)
**Note:** Actual "Initializing file watcher..." display in StatusFooterBar is Story 2.7. This story only wires the handler and stores state.

**AC6 — Unit tests (`engine/src/watcher.test.ts`):**

**Given** `node --import tsx --test engine/src/watcher.test.ts`
**When** all tests execute
**Then** debouncing: N rapid change events within 1000ms → single `onChangesDetected` call after timer fires
**And** ENOSPC: `watchFn` throws on 3rd dir → error event emitted with `code: "INOTIFY_LIMIT"` → 2 dirs already registered retain active watchers
**And** event aggregation: changes from multiple watched dirs in same pair → single debounced trigger
**And** `stop()` closes all watchers and clears all timers
**And** `watcher_status {status: "initializing"}` emitted before first watch; `{status: "ready"}` emitted after all dirs processed
**And** tests use `node:test` + `node:assert/strict` + `mock.fn()` — NOT Jest/Vitest/expect()

---

## Tasks / Subtasks

- [x] **Task 1: Create `engine/src/watcher.ts`** (AC: 1, 2, 3, 4)
  - [x] 1.1 Imports — no `@protontech/drive-sdk`, inject `watchFn` for testability:
    ```typescript
    import { readdir } from "node:fs/promises";
    import { watch } from "node:fs";
    import type { FSWatcher, WatchListener } from "node:fs";
    import { join } from "node:path";
    import type { IpcPushEvent } from "./ipc.js";
    import type { SyncPair } from "./state-db.js";
    import { debugLog } from "./debug-log.js";
    ```
  - [x] 1.2 Define injectable `WatchFn` type and export `FileWatcher` class:
    ```typescript
    type WatchFn = (path: string, listener: WatchListener<string>) => FSWatcher;

    export class FileWatcher {
      private readonly watchers = new Map<string, FSWatcher>(); // dir → watcher
      private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

      constructor(
        private readonly pairs: SyncPair[],
        private readonly onChangesDetected: (pairId: string) => Promise<void>,
        private readonly emitEvent: (event: IpcPushEvent) => void,
        private readonly watchFn: WatchFn = watch,
        private readonly debounceMs: number = 1000,
      ) {}
    ```
  - [x] 1.3 `async initialize(): Promise<void>`:
    ```typescript
    async initialize(): Promise<void> {
      this.emitEvent({ type: "watcher_status", payload: { status: "initializing" } });
      for (const pair of this.pairs) {
        try {
          await this.setupPairWatches(pair);
        } catch (err) {
          debugLog(`watcher: setupPairWatches failed for ${pair.pair_id}: ${(err as Error).message}`);
        }
      }
      this.emitEvent({ type: "watcher_status", payload: { status: "ready" } });
    }
    ```
  - [x] 1.4 `private async setupPairWatches(pair: SyncPair): Promise<void>`:
    - Build dir list: start with `[pair.local_path]` then walk via `readdir(pair.local_path, { withFileTypes: true, recursive: true })` — for each entry where `entry.isDirectory()`, push `join(entry.parentPath, entry.name)`
    - For each dir, attempt `this.watchFn(dir, (_evt, _filename) => { this.scheduleSync(pair.pair_id); })`
    - Wrap in `try/catch (err)`: check `(err as NodeJS.ErrnoException).code === "ENOSPC"` → emit `INOTIFY_LIMIT` error event → `break` (stop trying more dirs)
    - On non-ENOSPC errors: `debugLog(...)` and `continue`
    - On success: `this.watchers.set(dir, watcher)` and `watcher.on("error", (e) => debugLog(...))`
  - [x] 1.5 `private scheduleSync(pairId: string): void`:
    ```typescript
    private scheduleSync(pairId: string): void {
      const existing = this.debounceTimers.get(pairId);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.debounceTimers.delete(pairId);
        void this.onChangesDetected(pairId);
      }, this.debounceMs);
      this.debounceTimers.set(pairId, timer);
    }
    ```
  - [x] 1.6 `stop(): void`:
    ```typescript
    stop(): void {
      for (const timer of this.debounceTimers.values()) clearTimeout(timer);
      this.debounceTimers.clear();
      for (const watcher of this.watchers.values()) watcher.close();
      this.watchers.clear();
    }
    ```

- [x] **Task 2: `main.ts` integration** (AC: 1, 4)
  - [x] 2.1 Add import at top of `main.ts`:
    ```typescript
    import { FileWatcher } from "./watcher.js";
    ```
  - [x] 2.2 Add module-level declaration after `let syncEngine`:
    ```typescript
    let fileWatcher: FileWatcher | undefined;
    ```
  - [x] 2.3 In `handleTokenRefresh` success path — after `void syncEngine?.startSyncAll()`:
    ```typescript
    fileWatcher?.stop();
    fileWatcher = new FileWatcher(
      stateDb!.listPairs(),
      async (_pairId) => { await syncEngine!.startSyncAll(); },
      (e) => server.emitEvent(e),
    );
    void fileWatcher.initialize();
    ```
  - [x] 2.4 In the `token_expired` path (where `syncEngine.setDriveClient(null)`):
    ```typescript
    fileWatcher?.stop();
    fileWatcher = undefined;
    ```
  - [x] 2.5 Export test injection helper:
    ```typescript
    export function _setFileWatcherForTests(fw: FileWatcher | undefined): void {
      fileWatcher = fw;
    }
    ```

- [x] **Task 3: Create `engine/src/watcher.test.ts`** (AC: 6)
  - [x] 3.1 File header — `node:test` + `node:assert/strict`, mock `FSWatcher`
  - [x] 3.2 Helper: `makeMockWatcher()` — returns `{ close: mock.fn(), on: mock.fn() } as unknown as FSWatcher`
  - [x] 3.3 Helper: `makeTestPair(localPath)` — minimal SyncPair with real tmp dir path
  - [x] 3.4 **watcher_status events test:** emits initializing then ready in order
  - [x] 3.5 **Debounce test:** 5 rapid events → single `onChangesDetected` call after timer fires
  - [x] 3.6 **ENOSPC test:** throws on 3rd dir → INOTIFY_LIMIT error, 2 watchers, no 4th call
  - [x] 3.7 **stop() test:** 3 dirs registered, stop() called, all close() called, debounce cleared
  - [x] 3.8 **Structural boundary test:** watcher.ts has no SDK import (string built dynamically)
  - [x] 3.9 Used real tmp dirs (mkdirSync) + beforeEach/afterEach for isolation

- [x] **Task 4: Python UI — `watcher_status` event handler** (AC: 5)
  - [x] 4.1 Found `engine.on_event(...)` calls in `ui/src/protondrive/main.py` (Application.do_startup)
  - [x] 4.2 Registered `self._engine.on_event("watcher_status", self._on_watcher_status)`
  - [x] 4.3 Implemented `_on_watcher_status` handler with type hints
  - [x] 4.4 Declared `self._watcher_status: str = "unknown"` in `__init__`

- [x] **Task 5: Update sprint status** (AC: all)
  - [x] 5.1 sprint-status.yaml updated to `review` on completion
  - [x] 5.2 `last_updated` updated to 2026-04-10

---

## Dev Notes

### CRITICAL: Engine Runtime is Node.js 22, NOT Bun

CLAUDE.md Bun defaults do NOT apply to the engine. `bun:sqlite`, `bun test`, `Bun.serve()` are all wrong for `engine/`. Test command:
```bash
node --import tsx --test engine/src/watcher.test.ts
# or full suite:
node --import tsx --test 'engine/src/**/*.test.ts'
```

### CRITICAL: Per-directory `fs.watch`, NOT `{ recursive: true }`

The epics require "inotify watches are set up **per subdirectory** within the synced folder tree". Use per-directory watches to allow graceful ENOSPC degradation — when the limit is hit, directories already registered keep their watchers. With `{ recursive: true }`, ENOSPC surfaces at the top level with no partial-success semantics:

```typescript
// CORRECT — per directory, no recursive flag
const watcher = this.watchFn(dirPath, (event, filename) => {
  this.scheduleSync(pair.pair_id);
});

// WRONG — do not use
// fs.watch(pair.local_path, { recursive: true }, callback)
```

### CRITICAL: IPC error code is `"INOTIFY_LIMIT"` (not `"inotify_limit"` or `"ENOSPC"`)

Story 5.7 defines the canonical IPC error code — must match exactly for future Story 5.7 UI handler:
```typescript
// CORRECT
this.emitEvent({
  type: "error",
  payload: {
    code: "INOTIFY_LIMIT",
    message: "Too many files to watch — close other apps or increase system inotify limit",
    pair_id: pair.pair_id,
  },
});
// NodeJS throws with err.code === "ENOSPC"; the IPC payload code is "INOTIFY_LIMIT"
```

### CRITICAL: `StateDb.enqueue()` does NOT exist

The pre-existing story draft referenced `StateDb.enqueue()` — this method has **never been added** to `state-db.ts`. Do NOT implement it or call it. The offline change queue is an Epic 3 concern (Story 3-2). For Story 2.6, a detected change simply triggers `syncEngine.startSyncAll()` after debounce — no queue, no DB write.

### CRITICAL: `syncEngine.startSyncAll()`, not `syncEngine.start(pair)`

The `SyncEngine` class (from `engine/src/sync-engine.ts`) exposes `startSyncAll(): Promise<void>`. There is no `start(pair)` method. The watcher calls `startSyncAll()` for all pairs on any change — per-pair targeting is a future optimization.

### CRITICAL: No `console.log` / `console.error` in `watcher.ts`

Same constraint as `sync-engine.ts`: stdout corrupts IPC framing. Use only `debugLog(...)` from `./debug-log.js`.

### Inject `watchFn` for testability — ESM modules cannot be module-mocked

`fs.watch` cannot be replaced via `mock.module()` reliably in Node 22 ESM. The constructor injects `watchFn` with Node's `watch` as default:
```typescript
// In tests:
const mockWatcher = { close: mock.fn(), on: mock.fn() } as unknown as FSWatcher;
const mockWatch = mock.fn((_path: string, _listener: unknown) => mockWatcher);
const fw = new FileWatcher([testPair], onChanges, emitEvent, mockWatch as unknown as WatchFn, 50);
//                                                                                              ^^ short debounceMs for fast tests
```

Capture the listener to simulate inotify events:
```typescript
await fw.initialize();
// listener is in mockWatch.mock.calls[N].arguments[1]
const listener = mockWatch.mock.calls[0]!.arguments[1] as WatchListener<string>;
listener("change", "file.txt"); // simulate inotify event
await new Promise(resolve => setTimeout(resolve, 100)); // wait for 50ms debounce
assert.equal(onChangesMock.mock.callCount(), 1);
```

### `entry.parentPath` in `readdir` recursive output

`readdir` with `{ withFileTypes: true, recursive: true }` returns `Dirent`. Use `entry.parentPath` (Node.js 22) — NOT `entry.path` (deprecated). This is the same as Story 2.5 Task 3.8 (`sync-engine.ts:walkLocalTree`).

### `watcher_status` IPC push event routing in Python

`_dispatch_event` in `engine.py` hardcodes handlers for `ready`, `session_ready`, `token_expired`, and `error`. All other push events route via `self._event_handlers.get(event_type)` (line 332). Therefore `watcher_status` events reach the handler registered via `engine.on_event("watcher_status", ...)`. Do NOT add a hardcoded branch in `_dispatch_event`.

### Integration into `main.ts` — pattern mirrors `syncEngine`

The `fileWatcher` module-level pattern is identical to `syncEngine`:
```typescript
// module scope
let fileWatcher: FileWatcher | undefined;

// token_refresh success path (after syncEngine.startSyncAll()):
fileWatcher?.stop();
fileWatcher = new FileWatcher(
  stateDb!.listPairs(),
  async (_pairId) => { await syncEngine!.startSyncAll(); },
  (e) => server.emitEvent(e),
);
void fileWatcher.initialize();

// token_expired path:
fileWatcher?.stop();
fileWatcher = undefined;
```

### File locations — engine source is flat

New files: `engine/src/watcher.ts`, `engine/src/watcher.test.ts`. Modified files: `engine/src/main.ts`, `ui/src/protondrive/application.py` (or `window.py`). Do NOT create `engine/src/core/` or any subdirectories.

### Scope — what is NOT in this story

| Out-of-scope | Where |
|---|---|
| Offline change queue (persist changes during network outage) | Epic 3, Story 3-2 |
| StatusFooterBar "Initializing file watcher..." visual display | Story 2.7 |
| Per-pair targeted sync (only sync the changed pair) | Future optimization |
| New-subdirectory watch registration (dynamic inotify registration on mkdir) | Deferred |
| INOTIFY_LIMIT error UI display | Story 5.7 |

### NFRs

- **NFR3:** Change detection ≤5 seconds. Debounce is 1000ms → sync triggers ~1–2s after last change.
- **NFR3a:** `void fileWatcher.initialize()` — never awaited in main path; IPC and UI remain responsive during tree walk.
- **NFR5:** 150MB RSS for ≤10,000 files. Per-dir `FSWatcher` ≈1KB × 10,000 dirs ≈10MB — well within budget.

### Previous story patterns to follow

Story 2.5 (`sync-engine.ts`) established these patterns — follow them exactly:
- `emitEvent: (event: IpcPushEvent) => void` constructor parameter (not `IpcServer` injection)
- `_setFileWatcherForTests` test-injection export in `main.ts`
- `debugLog` from `./debug-log.js` for all observability
- Typed errors via `errors.ts` if needed (though watcher mostly catches and logs, not throws)

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — implementation was straightforward.

### Completion Notes List

- **Task 1:** `engine/src/watcher.ts` created with `FileWatcher` class. Per-directory `fs.watch` (not recursive), ENOSPC → INOTIFY_LIMIT IPC error with break, 1000ms debounce, `WatchFn` injectable for testability (exported for tests). No `@protontech/drive-sdk` import. `debugLog` only — no console.log/error.
- **Task 2:** `engine/src/main.ts` updated — `FileWatcher` imported, `fileWatcher` module-level var added, watcher created/started in success path of `handleTokenRefresh`, stopped in both `token_expired` paths (missing-token and catch), `_setFileWatcherForTests` exported.
- **Task 3:** `engine/src/watcher.test.ts` created with 6 tests using `node:test` + `node:assert/strict`. Used real temp directories (mkdirSync + rmSync) to avoid mocking `readdir`. SDK boundary string constructed dynamically to avoid triggering `sdk.test.ts` scanner. All 135 engine tests pass (6 new, 0 regressions).
- **Task 4:** `ui/src/protondrive/main.py` updated — `self._watcher_status: str = "unknown"` in `__init__`, `on_event("watcher_status", self._on_watcher_status)` registered in `do_startup`, `_on_watcher_status` handler implemented. Routes via `_event_handlers` in engine.py (not hardcoded dispatch).
- **Task 5:** `sprint-status.yaml` updated to `review`.

### File List

- `engine/src/watcher.ts` (created)
- `engine/src/watcher.test.ts` (created)
- `engine/src/main.ts` (modified)
- `ui/src/protondrive/main.py` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)
- `_bmad-output/implementation-artifacts/2-6-inotify-file-watcher-and-change-detection.md` (modified)

### Change Log

- 2026-04-10: Implemented Story 2.6 — inotify file watcher + change detection. Created `watcher.ts` (FileWatcher class), `watcher.test.ts` (6 unit tests), wired into `main.ts`, Python `watcher_status` handler added to `main.py`.

### Review Findings

- [x] [Review][Patch] Missing `stopped` flag — debounce timer fires after `stop()`, and `setupPairWatches` loop continues after `stop()` is called mid-init (rapid re-auth race) [`engine/src/watcher.ts:72-87`, `engine/src/main.ts:76-81`]
- [x] [Review][Patch] `onChangesDetected` rejection swallowed via `void` — unhandled Promise rejection from `syncEngine.startSyncAll()` surfaces at runtime instead of being logged or emitted as an error event [`engine/src/watcher.ts:77`]
- [x] [Review][Patch] `watcher.close()` can throw in `stop()` loop — if an FSWatcher was already closed via an error event, `close()` throws, aborting the loop and leaving remaining watchers open [`engine/src/watcher.ts:85`]
- [x] [Review][Patch] Python `_on_watcher_status` — `payload.get("status", ...)` called without guarding against non-dict `payload` (e.g. `None`) → `AttributeError` crash in GTK callback [`ui/src/protondrive/main.py:138`]
- [x] [Review][Patch] Redundant `INOTIFY_LIMIT` error events — ENOSPC on one pair breaks its loop, but `initialize()` continues to next pair which also hits ENOSPC and emits a separate `INOTIFY_LIMIT` event; N pairs → N error events [`engine/src/watcher.ts:53-63`]
- [x] [Review][Patch] Test missing assertion: `watcher_status "initializing"` fires before first `watchFn()` call — test only checks status event ordering among themselves, not relative to `mockWatch` call count [`engine/src/watcher.test.ts:45-65`]
- [x] [Review][Defer] Stale pairs snapshot at construction time — pairs added via `add_pair` after `fileWatcher` is created are not watched until next re-auth cycle [`engine/src/main.ts:77`] — deferred, Story 6-2 / future watcher lifecycle work
- [x] [Review][Defer] Silent non-ENOSPC failure paths — ENOENT/EACCES on `readdir` or non-ENOSPC `watchFn` errors only `debugLog`, emitting no user-visible error event [`engine/src/watcher.ts:37`, `64-67`] — deferred, Story 6-4 (local-folder-missing-detection)
- [x] [Review][Defer] Overlapping `local_path` between pairs — second pair's `watchFn` calls overwrite the first pair's entries in `watchers` Map without `close()`, leaking FSWatcher handles [`engine/src/watcher.ts:43-51`] — deferred, Story 6-2 (nesting-and-overlap-validation)
- [x] [Review][Defer] `_watcher_status` not reset on `token_expired` / logout — stale `"ready"` state persists across re-auth for future consumers [`ui/src/protondrive/main.py:39`, `137-139`] — deferred, Story 2.7 (StatusFooterBar display)
- [x] [Review][Defer] `stateDb!` / `syncEngine!` non-null assertion risk before `main()` sets them — pre-existing design gap; caught by outer `catch` block [`engine/src/main.ts:77`] — deferred, pre-existing
