# Story 3.2: Offline Change Queue (Persistent)

Status: done

## Story

As a user,
I want my local file changes to be queued while offline,
so that nothing is lost and changes sync when the connection returns.

## Acceptance Criteria

### AC1 — Changes enqueued to SQLite when offline

**Given** the app is offline (networkMonitor reports `isCurrentlyOnline = false`)
**When** local files are modified in a watched sync pair folder
**Then** each change is written to the `change_queue` SQLite table
**And** each entry records: `pair_id`, `relative_path`, `change_type` (created/modified/deleted), `queued_at` (ISO 8601)
**And** `scheduleSync` is NOT triggered while offline (no noisy network-failure errors)

### AC2 — Queue persists across crashes

**Given** the change queue has entries in SQLite
**When** the app crashes or is force-killed
**When** the app restarts
**Then** all previously queued entries are still present in `change_queue`
**And** no queued change is silently lost

> **Implementation note:** WAL mode + synchronous=NORMAL is already in place from Story 2-1. No additional work needed for crash persistence — this AC verifies existing SQLite guarantees apply to `change_queue`.

### AC3 — `get_status_result` includes per-pair queued change count

**Given** the change queue has entries
**When** the UI sends `get_status`
**Then** `get_status_result` payload includes `queued_changes: number` on each pair object
**And** the count reflects the current `change_queue` row count for that pair

### AC4 — change_type is accurate

**Given** a `'change'` inotify event
**Then** `change_type = 'modified'`

**Given** a `'rename'` inotify event and the file exists at the path
**Then** `change_type = 'created'`

**Given** a `'rename'` inotify event and the file no longer exists
**Then** `change_type = 'deleted'`

**Given** inotify fires with a null filename (rare, platform-specific)
**Then** no entry is written (silently skipped — filename is required to compute relative_path)

### AC5 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit per logical group. Branch: `feat/3-2-offline-change-queue-persistent`.

---

## Tasks / Subtasks

- [x] **Task 1: Extend `FileWatcher` for offline queueing** (AC: #1, #4)
  - [x] 1.1 Extend existing imports in `engine/src/watcher.ts` (do NOT add new import lines — extend the ones already there):
        Line 2: `import { watch } from "node:fs"` → `import { watch, existsSync } from "node:fs"`
        Line 6: `import type { SyncPair } from "./state-db.js"` → `import type { SyncPair, ChangeQueueEntry, ChangeType } from "./state-db.js"`
  - [x] 1.2 Add two optional constructor params (positions 6 and 7, with defaults):
        `private readonly isOnline: () => boolean = () => true,`
        `private readonly enqueueChange: (entry: Omit<ChangeQueueEntry, "id">) => void = () => {},`
  - [x] 1.3 In `setupPairWatches`, change the watch callback. The existing params are `(_evt, _filename)` — **rename both: remove the underscore prefix** since they are now used. Final callback:
        ```typescript
        const watcher = this.watchFn(dir, (evt, filename) => {
          if (!this.isOnline() && filename !== null) {
            this.queueFileChange(pair, dir, evt ?? "change", filename);
          } else {
            this.scheduleSync(pair.pair_id);
          }
        });
        ```
  - [x] 1.4 Add private method `queueFileChange(pair: SyncPair, dir: string, evt: string, filename: string): void`:
        - `fullPath = join(dir, filename)`
        - `relPath = fullPath.slice(pair.local_path.length).replace(/^[/\\]/, "")`
        - `changeType`: `evt === "change"` → `"modified"`, else `existsSync(fullPath) ? "created" : "deleted"`
        - Call `this.enqueueChange({ pair_id: pair.pair_id, relative_path: relPath, change_type: changeType, queued_at: new Date().toISOString() })`
  - [x] 1.5 `bunx tsc --noEmit` — zero errors

- [x] **Task 2: Wire queueing and update `get_status` in `main.ts`** (AC: #3)
  - [x] 2.1 At **both** `FileWatcher` construction sites (lines ~215 and ~520):
        Add two new args after `(e) => server.emitEvent(e)`:
        `watchFn` (existing default — omit, leave position 4 as default),
        `debounceMs` (existing default — omit, leave position 5 as default),
        ...but since positions 4/5 are currently omitted anyway, just append:
        ```typescript
        new FileWatcher(
          stateDb!.listPairs(),
          async (_pairId) => { await syncEngine!.startSyncAll(); },
          (e) => server.emitEvent(e),
          undefined,   // watchFn: use default
          undefined,   // debounceMs: use default
          () => networkMonitor?.isCurrentlyOnline ?? true,
          (e) => stateDb!.enqueue(e),
        )
        ```
  - [x] 2.2 In `handleCommand` for `get_status`, extend each pair mapping to include `queued_changes`:
        ```typescript
        const pairs = stateDb.listPairs().map((p) => ({
          pair_id: p.pair_id,
          local_path: p.local_path,
          remote_path: p.remote_path,
          last_synced_at: p.last_synced_at ?? null,
          queued_changes: stateDb.queueSize(p.pair_id),
        }));
        ```
  - [x] 2.3 Update both `token_expired` emit sites (lines ~238 and ~350) to use real count:
        ```typescript
        const queuedTotal = stateDb
          ? stateDb.listPairs().reduce((sum, p) => sum + stateDb!.queueSize(p.pair_id), 0)
          : 0;
        server.emitEvent({ type: "token_expired", payload: { queued_changes: queuedTotal } });
        ```
  - [x] 2.4 `bunx tsc --noEmit` — zero errors

- [x] **Task 3: Tests for `FileWatcher` offline queueing** (AC: #1, #4)
  - [x] 3.1 Extend imports in `engine/src/watcher.test.ts` (extend existing lines, do not add duplicate imports):
        `import { mkdirSync, rmSync }` → `import { mkdirSync, rmSync, writeFileSync }`
        `import type { SyncPair } from "./state-db.js"` → `import type { SyncPair, ChangeQueueEntry } from "./state-db.js"`
        Add new describe block `FileWatcher — offline change queue`
  - [x] 3.2 Test: **online path unchanged** — `isOnline = () => true`, fire 'change' event → `onChanges` called, `enqueueChange` NOT called
  - [x] 3.3 Test: **offline + 'change' event** → `enqueueChange` called once with `change_type: "modified"`, `scheduleSync` NOT triggered
        (use `onChanges = mock(async () => {})` and verify `onChanges.mock.calls.length === 0` after debounce)
  - [x] 3.4 Test: **offline + 'rename' + file exists** → `change_type: "created"`
        Create a real temp file and fire `listener("rename", filename)` while `isOnline = () => false`
  - [x] 3.5 Test: **offline + 'rename' + file missing** → `change_type: "deleted"`
        Do NOT create the file; fire `listener("rename", "ghost.txt")` while offline
  - [x] 3.6 Test: **null filename** → `enqueueChange` NOT called, no crash
        Fire `listener("change", null)` while offline
  - [x] 3.7 Test: **multiple offline events are each enqueued** (no debounce on queue writes) — fire 3 events on 3 different filenames while offline → `enqueueChange` called 3 times before any debounce timer fires
  - [x] 3.8 Test: **relative path is correct** — fire event for `filename = "notes.txt"` in root dir of pair → `relative_path = "notes.txt"` (no leading slash)
  - [x] 3.9 `bun test engine/src/watcher.test.ts` — all pass, no regressions in prior tests

- [x] **Task 4: Update `get_status` tests in `main.test.ts`** (AC: #3)
  - [x] 4.1 Existing test `"returns pairs:[] and online:true when no pairs exist"`: `toEqual({ pairs: [], online: true })` still passes (empty pairs array, no `queued_changes` fields to check)
  - [x] 4.2 Add test: **`get_status_result` includes `queued_changes: 0` per pair** when pair exists but queue is empty:
        Insert a pair via `stateDb.insertPair(...)`, send `get_status`, assert `pairs[0].queued_changes === 0`
  - [x] 4.3 Add test: **`get_status_result` reflects non-zero queue count** — insert pair, call `stateDb.enqueue(...)` twice, send `get_status`, assert `pairs[0].queued_changes === 2`
  - [x] 4.4 `bun test engine/src/main.test.ts` — all pass

- [x] **Task 5: Final validation**
  - [x] 5.1 `bun test engine/src/` — all pass (170 tests, 0 fail)
  - [x] 5.2 UI tests unchanged — no Python code changes in this story
  - [x] 5.3 Set story status to `review`

---

## Dev Notes

### What Already Exists (Do NOT Recreate)

- **`change_queue` SQLite table**: defined in migration v1, `engine/src/state-db.ts:61-67`
- **`ChangeQueueEntry` interface**: `{ id, pair_id, relative_path, change_type: ChangeType, queued_at }` — `state-db.ts:28-34`
- **`ChangeType` type**: `"created" | "modified" | "deleted"` — `state-db.ts:26`
- **`StateDb.enqueue()`**: `state-db.ts:219-226` — inserts one entry, omits `id` (auto-generated)
- **`StateDb.queueSize(pairId)`**: `state-db.ts:242-247` — returns `COUNT(*)` for a pair
- **`StateDb.listQueue(pairId)`**: `state-db.ts:234-240` — returns all entries ordered by `id ASC`
- **`NetworkMonitor.isCurrentlyOnline`**: getter in `engine/src/network-monitor.ts`; accessed via module-level `networkMonitor` in `main.ts:154`

### `FileWatcher` Constructor Change — No Existing Test Breakage

Existing tests construct `FileWatcher` with 3-5 positional args. The new params are positions 6 and 7 with defaults `() => true` and `() => {}`. All existing tests will continue to pass because `isOnline` defaults to `true` — the offline path is never triggered.

### change_type Resolution Strategy

`node:fs`'s `watch()` callback fires with `eventType: 'rename' | 'change'`:
- `'change'` = content modified → `"modified"` (no stat needed)
- `'rename'` = file created or deleted → must check `existsSync(fullPath)`:
  - File exists → `"created"`
  - File gone → `"deleted"`

`existsSync` is synchronous and acceptable in the watch callback (it's a single `stat` syscall). No async needed.

```typescript
// engine/src/watcher.ts
private queueFileChange(pair: SyncPair, dir: string, evt: string, filename: string): void {
  const fullPath = join(dir, filename);
  const relPath = fullPath.slice(pair.local_path.length).replace(/^[/\\]/, "");
  const changeType: ChangeType =
    evt === "change"
      ? "modified"
      : existsSync(fullPath) ? "created" : "deleted";
  this.enqueueChange({
    pair_id: pair.pair_id,
    relative_path: relPath,
    change_type: changeType,
    queued_at: new Date().toISOString(),
  });
}
```

### `get_status_result` Payload Shape Change

Before story 3-2, each pair object was:
```typescript
{ pair_id, local_path, remote_path, last_synced_at }
```

After story 3-2, each pair object is:
```typescript
{ pair_id, local_path, remote_path, last_synced_at, queued_changes: number }
```

The UI (`main.py`) reads `pairs` in `_on_get_status_result`. The new `queued_changes` field is additive — Python reads `dict.get("queued_changes", 0)` pattern is safe. No UI change required for story 3-2; UI only needs to display the count in a future story.

### `FileWatcher` instantiation in `main.ts` — Two Sites

Both sites currently omit `watchFn` and `debounceMs` (positions 4 and 5 are implicitly `undefined`). To add the new args at positions 6 and 7, pass explicit `undefined` at 4 and 5:

```typescript
fileWatcher = new FileWatcher(
  stateDb!.listPairs(),
  async (_pairId) => { await syncEngine!.startSyncAll(); },
  (e) => server.emitEvent(e),
  undefined,  // watchFn: default
  undefined,  // debounceMs: default
  () => networkMonitor?.isCurrentlyOnline ?? true,
  (e) => stateDb!.enqueue(e),
);
```

### `token_expired` queued_changes — Accurate Count

In `handleTokenRefresh`, the `stateDb` module variable is always defined at the two `token_expired` emit points (it's set in `main()` before `handleTokenRefresh` can be called). However, use optional chaining for safety:

```typescript
const queuedTotal = stateDb
  ? stateDb.listPairs().reduce((sum, p) => sum + stateDb!.queueSize(p.pair_id), 0)
  : 0;
```

### What This Story Does NOT Do

- Does NOT replay the queue on reconnect (that is Story 3-3)
- Does NOT deduplicate queue entries (Story 3-3 handles this during replay)
- Does NOT remove entries from the queue (Story 3-3 dequeues after successful sync)
- Does NOT display queued count in the UI (no widget change needed — `queued_changes` is in the IPC payload but the UI doesn't render it distinctly yet)
- Does NOT pause `SyncEngine` when offline (sync failures follow existing error paths)

### Import Conventions (engine)

Extend existing import lines — never add a second `from "node:fs"` or `from "./state-db.js"` line:

```typescript
// watcher.ts — final import lines after changes
import { readdir } from "node:fs/promises";
import { watch, existsSync } from "node:fs";                           // ← add existsSync
import type { FSWatcher, WatchListener } from "node:fs";
import { join } from "node:path";
import type { IpcPushEvent } from "./ipc.js";
import type { SyncPair, ChangeQueueEntry, ChangeType } from "./state-db.js";  // ← add ChangeQueueEntry, ChangeType
import { debugLog } from "./debug-log.js";
```

```typescript
// watcher.test.ts — extend these two existing lines
import { mkdirSync, rmSync, writeFileSync } from "node:fs";          // ← add writeFileSync
import type { SyncPair, ChangeQueueEntry } from "./state-db.js";     // ← add ChangeQueueEntry
```

`import type` is mandatory for type-only imports (`verbatimModuleSyntax` is on). `existsSync`/`writeFileSync` are value imports — no `type` keyword. Local imports use `.js` extension.

### Testing offline queueing — using spyOn for existsSync

For tests 3.4/3.5, the cleanest approach is to use real temp files rather than mocking `existsSync`. Create the temp file before firing the 'rename' event (AC4 created case), and don't create it (AC4 deleted case):

```typescript
// Test: rename + file exists → 'created'
it("'rename' event on existing file → change_type: 'created'", async () => {
  const enqueueCalls: Array<Omit<ChangeQueueEntry, "id">> = [];
  const tmpFile = join(tmpDir, "newfile.txt");
  writeFileSync(tmpFile, "");  // file exists

  const fw = new FileWatcher(
    [pair],
    mock(async () => {}),
    (_e) => {},
    mockWatch as unknown as WatchFn,
    undefined, undefined,
    () => false,  // isOnline = false
    (e) => enqueueCalls.push(e),
  );
  await fw.initialize();
  const listener = mockWatch.mock.calls[0]![1] as WatchListener<string>;
  listener("rename", "newfile.txt");

  expect(enqueueCalls).toHaveLength(1);
  expect(enqueueCalls[0]!.change_type).toBe("created");
  fw.stop();
});
```

For the deleted case, simply don't write `tmpFile`.

### bun:test mock syntax

- Use `mock(fn)` factory (NOT `mock.fn()` — that is node:test syntax)
- `mock.mock.calls` tracks call args
- `mock.restore()` in `afterEach` to clean up spies
- `spyOn(obj, "method")` for spy on existing object

### Files to Create/Modify

**Modified:**
- `engine/src/watcher.ts` — add offline queueing (Task 1)
- `engine/src/main.ts` — wire queueing + update get_status (Task 2)
- `engine/src/watcher.test.ts` — add offline queue tests (Task 3)
- `engine/src/main.test.ts` — update get_status tests (Task 4)
- `_bmad-output/implementation-artifacts/3-2-offline-change-queue-persistent.md` — this file

**Not touched:**
- `engine/src/state-db.ts` — schema and CRUD already complete
- `engine/src/network-monitor.ts` — no changes
- `engine/src/sync-engine.ts` — unaffected
- All Python UI files — no UI change in this story

### Project Structure Notes

- Engine source is flat: `engine/src/*.ts` — no subdirectories (except `__integration__/`)
- `watcher.ts` already imports from `state-db.js` for `SyncPair` type; adding `ChangeQueueEntry`/`ChangeType` follows the same pattern
- Local imports use `.js` extension (Bun resolves `.ts` at runtime)

### References

- `change_queue` schema + CRUD: `engine/src/state-db.ts:26-34, 61-67, 217-247`
- `FileWatcher` constructor: `engine/src/watcher.ts:17-23`
- `setupPairWatches` watch callback: `engine/src/watcher.ts:49-51`
- `FileWatcher` instantiation (both sites): `engine/src/main.ts:215-222, 520-528`
- `get_status` handler: `engine/src/main.ts:538-557`
- `token_expired` emits: `engine/src/main.ts:238, 350`
- `networkMonitor` module var: `engine/src/main.ts:154`
- Existing watcher tests (constructor pattern): `engine/src/watcher.test.ts:52-66`
- Existing get_status test: `engine/src/main.test.ts:528-548`
- Story 3-1 file list (what 3-1 touched): `3-1-offline-detection-and-ui-indicators.md` → File List
- Offline detection architecture: `_bmad-output/planning-artifacts/architecture.md:648`
- `import type` + `.js` extension rules: `project-context.md:68-70`
- `bun:test` mock pattern: `project-context.md:140-141`
- Engine flat source rule: `project-context.md:191-193`

---

## Review Findings

- [x] [Review][Patch] Null-filename + offline falls through to `scheduleSync` — AC1+AC4 violation [engine/src/watcher.ts:52]
- [x] [Review][Patch] `relPath` string-slice fragile when `local_path` has trailing slash — use `path.relative()` [engine/src/watcher.ts:85]
- [x] [Review][Patch] `queueFileChange` has no try/catch — DB write errors propagate uncaught through fs.watch callback [engine/src/watcher.ts:83]
- [x] [Review][Patch] Empty-string filename not guarded — `""` passes `!== null` and enqueues dir-root entry [engine/src/watcher.ts:52]
- [x] [Review][Defer] TOCTOU race: `existsSync` called after rename event — file state may have changed; Linux inotify limitation [engine/src/watcher.ts:89] — deferred, pre-existing
- [x] [Review][Defer] Online→offline transition during active debounce window — scheduled sync fires against offline connection [engine/src/watcher.ts:52-56] — deferred, Story 3-3 scope
- [x] [Review][Defer] Cross-pair symlink aliasing — symlinked pair dirs may attribute changes to wrong pair [engine/src/watcher.ts:setupPairWatches] — deferred, pre-existing architectural gap
- [x] [Review][Defer] `local_path` trailing-slash storage convention unspecified — upstream insert/query convention not enforced [engine/src/state-db.ts] — deferred, pre-existing

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — implementation proceeded without blockers.

### Completion Notes List

- Task 1: Extended `FileWatcher` with `isOnline` and `enqueueChange` constructor params (positions 6/7, default-safe). Added `queueFileChange` private method that resolves `change_type` via `existsSync` for rename events, strips leading separator from `relPath`. Watch callback now branches: offline+non-null filename → enqueue; otherwise → scheduleSync. Null filename is silently skipped.
- Task 2: Both `FileWatcher` construction sites in `main.ts` wired with `() => networkMonitor?.isCurrentlyOnline ?? true` and `(e) => stateDb!.enqueue(e)`. Both `token_expired` emit sites updated to compute real `queuedTotal` via `reduce`. `get_status` pair mapping extended with `queued_changes: stateDb!.queueSize(p.pair_id)`. TSC non-null assertion required inside `.map()` callback due to narrowing loss.
- Task 3: Added 7 new tests in `FileWatcher — offline change queue` describe block covering: online path unchanged, offline+change→modified, offline+rename+exists→created, offline+rename+missing→deleted, null filename→no enqueue, 3 events→3 enqueue calls (no debounce), relative path correctness.
- Task 4: Existing `get_status` empty-pairs test unaffected. Added 2 new tests: `queued_changes:0` for empty queue, `queued_changes:2` after two enqueues.
- Task 5: 170 tests, 0 fail across all 9 engine test files.

### File List

engine/src/watcher.ts
engine/src/main.ts
engine/src/watcher.test.ts
engine/src/main.test.ts
_bmad-output/implementation-artifacts/3-2-offline-change-queue-persistent.md
