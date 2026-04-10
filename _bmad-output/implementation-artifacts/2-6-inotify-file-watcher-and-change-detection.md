# Story 2.6: inotify File Watcher & Change Detection

Status: ready-for-dev

## Story

As a user,
I want the app to detect file changes in my synced folders automatically,
So that new or modified files sync without me manually triggering anything.

## Acceptance Criteria

**AC1 — Per-pair watcher setup:**
**Given** a sync pair is active
**When** the watcher initialises
**Then** `fs.watch()` with `{ recursive: true }` is set up on the pair's `local_path`
**And** initialisation is async and does not block the main IPC loop (NFR3a)

**AC2 — Debounced sync trigger:**
**Given** a file is modified in a watched directory
**When** inotify fires a `change` or `rename` event
**Then** the changed `relativePath` is recorded in `StateDb.enqueue()` with `change_type: 'change'`
**And** a 5-second debounce timer is reset for the pair (NFR3)
**And** after the debounce expires, `syncEngine.start(pair)` is called to process the queue

**AC3 — ENOSPC handling:**
**Given** the system runs out of inotify watches
**When** `fs.watch()` throws `ENOSPC` (system error code `ENOSPC` or `EMFILE`)
**Then** the engine pushes an `error` event: `{code: 'inotify_limit', message: 'Too many files to watch — close other apps or increase system inotify limit', pair_id}`
**And** the watcher does not crash — it logs the error and stops watching (graceful degradation)

**AC4 — Watcher lifecycle:**
**Given** a pair is removed or sync is stopped
**When** `FileWatcher.stop(pairId)` is called
**Then** the underlying `fs.FSWatcher` is closed for that pair
**And** pending debounce timers for the pair are cancelled

**AC5 — Engine wiring:**
**Given** `main.ts`
**When** a pair is added (after `add_pair` succeeds) or on startup
**Then** `fileWatcher.start(pair, syncEngine)` is called after `syncEngine.start(pair)` returns

**AC6 — Engine tests:**
**Given** unit tests in `watcher.test.ts`
**When** running `node --import tsx --test engine/src/watcher.test.ts`
**Then** tests verify: debounce timer resets on repeated events, `enqueue()` is called once per unique path per debounce window, ENOSPC triggers `error` event, `stop()` cancels debounce

## Tasks / Subtasks

- [ ] **Task 1: Implement FileWatcher** (AC: #1, #2, #3, #4)
  - [ ] 1.1 Create `engine/src/watcher.ts`:
    - Import `fs` from `'node:fs'`
    - Import `path` from `'node:path'` (`relative`, `join`)
    - Import `StateDb` from `'./state-db.js'`
    - Import `SyncPair` from `'./state-db.js'`
    - Import `IpcServer` from `'./ipc.js'`
  - [ ] 1.2 Define `DEBOUNCE_MS = 5000`
  - [ ] 1.3 Implement `FileWatcher` class:
    ```typescript
    export class FileWatcher {
      private readonly watchers = new Map<string, fs.FSWatcher>();
      private readonly timers = new Map<string, NodeJS.Timeout>();
      constructor(
        private readonly db: StateDb,
        private readonly server: IpcServer,
      ) {}
      start(pair: SyncPair, onDebounceExpire: (pair: SyncPair) => void): void
      stop(pairId: string): void
    }
    ```
  - [ ] 1.4 Implement `start(pair, onDebounceExpire)`:
    - Call `fs.watch(pair.local_path, { recursive: true, persistent: false }, (event, filename) => ...)`
    - In the callback: compute `relativePath = relative(pair.local_path, join(pair.local_path, filename ?? ''))`; call `db.enqueue({ pair_id: pair.pair_id, relative_path: relativePath, change_type: 'change', queued_at: new Date().toISOString() })`
    - Reset debounce: `clearTimeout(this.timers.get(pair.pair_id))` then `this.timers.set(pair.pair_id, setTimeout(() => onDebounceExpire(pair), DEBOUNCE_MS))`
    - On `error` event from watcher (using `watcher.on('error', ...)`: if `err.code === 'ENOSPC' || err.code === 'EMFILE'`, push `server.emitEvent({ type: 'error', payload: { code: 'inotify_limit', message: 'Too many files to watch...', pair_id: pair.pair_id } })` and `watcher.close()`
    - Store watcher: `this.watchers.set(pair.pair_id, watcher)`
  - [ ] 1.5 Implement `stop(pairId)`:
    - `clearTimeout(this.timers.get(pairId))` and `this.timers.delete(pairId)`
    - `this.watchers.get(pairId)?.close()` and `this.watchers.delete(pairId)`

- [ ] **Task 2: Wire FileWatcher into main.ts** (AC: #5)
  - [ ] 2.1 Import `FileWatcher` from `'./watcher.js'` in `main.ts`
  - [ ] 2.2 Add module-level `let fileWatcher: FileWatcher | null = null;`
  - [ ] 2.3 In `handleTokenRefresh` (after creating `syncEngine`): `fileWatcher = new FileWatcher(stateDb, server)`
  - [ ] 2.4 In `handleTokenRefresh` (after `syncEngine.start(pair)` for each existing pair): `fileWatcher.start(pair, (p) => { void syncEngine!.start(p); })`
  - [ ] 2.5 In `handleAddPair` (after `syncEngine?.start(pair)`): `fileWatcher?.start(pair, (p) => { void syncEngine!.start(p); })`

- [ ] **Task 3: watcher.test.ts — unit tests** (AC: #6)
  - [ ] 3.1 Create `engine/src/watcher.test.ts`
  - [ ] 3.2 Test: after two rapid `change` events on the same path, `enqueue()` is called twice but `onDebounceExpire` is called only once after 5s
  - [ ] 3.3 Test: `stop()` cancels pending debounce timer (verify `onDebounceExpire` is NOT called)
  - [ ] 3.4 Test: ENOSPC error on watcher triggers `server.emitEvent` with `code: 'inotify_limit'`
  - [ ] 3.5 Mock `fs.watch` using `mock.fn()` to avoid actual filesystem watching in tests

- [ ] **Task 4: Run full test suite** (AC: #6)
  - [ ] 4.1 `node --import tsx --test 'engine/src/**/*.test.ts'` — all tests pass

## Dev Notes

### Node.js 22 recursive watch on Linux
`fs.watch(path, { recursive: true })` is supported on Linux in Node.js 22 via inotify. The `filename` argument in the callback may be `null` in some edge cases — always guard with `filename ?? ''`.

### Error event on FSWatcher
```typescript
const watcher = fs.watch(localPath, { recursive: true, persistent: false }, callback);
watcher.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOSPC' || err.code === 'EMFILE') {
    server.emitEvent({ type: 'error', payload: {
      code: 'inotify_limit',
      message: 'Too many files to watch — close other apps or increase system inotify limit',
      pair_id: pair.pair_id,
    }});
    watcher.close();
    this.watchers.delete(pair.pair_id);
  }
});
```

### Debounce pattern
```typescript
const resetDebounce = () => {
  const existing = this.timers.get(pair.pair_id);
  if (existing) clearTimeout(existing);
  this.timers.set(pair.pair_id, setTimeout(() => {
    this.timers.delete(pair.pair_id);
    onDebounceExpire(pair);
  }, DEBOUNCE_MS));
};
```

### Testing fs.watch without filesystem
Mock `fs.watch` to return a fake EventEmitter:
```typescript
import { EventEmitter } from 'node:events';
const fakeWatcher = new EventEmitter() as fs.FSWatcher;
(fakeWatcher as any).close = () => {};
mock.module('node:fs', () => ({ watch: mock.fn(() => fakeWatcher) }));
```

### References
- [Source: engine/src/state-db.ts] — StateDb.enqueue() method
- [Source: engine/src/ipc.ts] — IpcServer.emitEvent()
- [Source: engine/src/main.ts] — handleTokenRefresh, handleAddPair wiring points
- [Source: engine/src/sync-engine.ts] — SyncEngine.start(pair) signature

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `engine/src/watcher.ts` — new: FileWatcher class
- `engine/src/watcher.test.ts` — new: FileWatcher unit tests
- `engine/src/main.ts` — wire FileWatcher into handleTokenRefresh and handleAddPair

## Change Log

- 2026-04-09: Story 2.6 created — inotify File Watcher & Change Detection
