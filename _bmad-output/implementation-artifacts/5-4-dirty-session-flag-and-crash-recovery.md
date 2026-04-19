# Story 5.4: Dirty-Session Flag & Crash Recovery

Status: done

## Story

As a user,
I want the app to recover cleanly from crashes without losing data or requiring manual cleanup,
so that I can trust the app even if something goes wrong.

## Acceptance Criteria

### AC1 — Dirty flag is set when drainQueue begins

**Given** `drainQueue()` is called with an active `driveClient`
**When** it passes the re-entrancy guard (`isDraining = true`) and the null-client check
**Then** `stateDb.setDirtySession(true)` is called before any file I/O begins
**And** the flag persists in SQLite across process restarts

### AC2 — Dirty flag is cleared on normal completion

**Given** `drainQueue()` set the dirty flag and ran to completion (no crash)
**When** the `finally` block executes
**Then** `stateDb.setDirtySession(false)` is called
**And** this happens even when `drainQueue` exits via `AuthExpiredError` (flag is always cleared in `finally`)

### AC3 — Engine detects dirty flag and scans for tmp files on startup

**Given** the engine starts and `stateDb.isDirtySession()` returns `true`
**When** initialization runs (before IPC server starts accepting connections)
**Then** the engine calls `cleanTmpFiles` for every `local_path` in `stateDb.listPairs()`
**And** any file matching `*.protondrive-tmp-*` in those directories (recursively) is deleted
**And** `stateDb.setDirtySession(false)` is called after cleanup completes
**And** recovery is fully complete before any sync operation starts

### AC4 — UI receives crash recovery notification and shows toast

**Given** crash recovery ran on startup (dirty flag was set)
**When** the UI connects and the IPC server emits `ready`
**Then** a `crash_recovery_complete` push event is also emitted on the same connection
**And** `main.py` caches the event (`_pending_crash_recovery = True`)
**And** after `_on_session_ready` calls `window.show_main()`, the toast is shown:
  `"Recovered from unexpected shutdown — sync resuming"`
**And** the toast has a 5-second timeout and no action button

### AC5 — Sync state integrity preserved after crash recovery

**Given** crash recovery completes
**When** inspecting sync state after recovery
**Then** sync pairs are intact in the `sync_pair` table
**And** `sync_state` rows (last-known mtimes) are preserved — no data loss
**And** `change_queue` entries are preserved — changes queued before crash will retry
**And** no `.protondrive-tmp-*` files remain at any pair's `local_path`

---

## Developer Context

### Architecture overview — READ THIS FIRST

The dirty-session flag is a single boolean in a new `session_state` SQLite table (migration v3). It is set by `drainQueue()` in `sync-engine.ts` and cleared in the same function's `finally` block. On startup, `main.ts` checks the flag, runs cleanup (tmp file scan + delete), then defers a `crash_recovery_complete` IPC push event to be emitted on the first UI connection.

```
Startup:
  StateDb() → isDirtySession()? → cleanTmpFilesInDir(pair.local_path)…
           → setDirtySession(false) → store wasDirty flag

Runtime (per drainQueue call):
  drainQueue() past re-entrancy guard
    → setDirtySession(true)
    → … file I/O (downloads write *.protondrive-tmp-*) …
    → finally: setDirtySession(false)

IPC connection:
  onConnect:
    → emitEvent(ready)
    → if wasDirty: emitEvent(crash_recovery_complete)

UI:
  _on_crash_recovery_complete: self._pending_crash_recovery = True
  _on_session_ready + has_pairs:
    → show_main() → on_session_ready()
    → if _pending_crash_recovery: window.on_crash_recovery_complete()
```

### Tmp file naming — IMPORTANT

The epic spec says `.dl-tmp-*` but the actual code uses `.protondrive-tmp-` as the infix:

```ts
// sync-engine.ts:1122
const tmpPath = `${destPath}.protondrive-tmp-${Date.now()}`;
// sync-engine.ts:296 (conflict copy creation)
const tmpPath = `${conflictCopyPath}.protondrive-tmp-${Date.now()}`;
```

The glob pattern to match is: any file whose name contains `.protondrive-tmp-`. The scan function checks `entry.name.includes(".protondrive-tmp-")`.

### What this story delivers

1. **`engine/src/state-db.ts`** — Migration v3 adds `session_state` table; `setDirtySession()` / `isDirtySession()` methods.
2. **`engine/src/sync-engine.ts`** — `drainQueue()` sets/clears dirty flag.
3. **`engine/src/main.ts`** — `cleanTmpFilesInDir()` + `runCrashRecovery()` helpers; startup crash recovery; `onConnect` emits deferred `crash_recovery_complete`.
4. **`ui/src/protondrive/main.py`** — Registers `crash_recovery_complete` event; `_pending_crash_recovery` field; `_on_crash_recovery_complete()` handler; injection in `_on_session_ready`.
5. **`ui/src/protondrive/window.py`** — `on_crash_recovery_complete()` shows `AdwToast`.
6. **Tests** — state-db.test.ts, sync-engine.test.ts, main.test.ts, ui/tests/test_main.py, ui/tests/test_window_routing.py.

### Critical implementation details

**`session_state` table design (state-db.ts migration v3)**

```sql
CREATE TABLE IF NOT EXISTS session_state (
  id    INTEGER PRIMARY KEY DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO session_state (id, dirty) VALUES (1, 0);
```

Single row, single column. `INSERT OR IGNORE` guarantees the row exists after migration. `setDirtySession` does an `UPDATE WHERE id = 1`. `isDirtySession` returns `(row.dirty ?? 0) === 1`. Update `CURRENT_VERSION` from `2` to `3`. Add the migration to `MIGRATIONS` array with `version: 3`.

**Flag lifecycle in `drainQueue` (sync-engine.ts)**

Set the flag after `isDraining = true` but AFTER the `if (!client) return` guard — this prevents spurious dirty flags when there's no client:

```ts
this.isDraining = true;
// -- Set dirty only when we will actually process --
let dirtied = false;
try {
  const client = this.driveClient;
  if (!client) {
    return { synced, skipped_conflicts, failed }; // finally still runs
  }
  dirtied = true;
  this.stateDb.setDirtySession(true);
  // ... existing processing loop ...
} catch (err) { ... } finally {
  this.emitEvent({ type: "queue_replay_complete", ... });
  // ... existing sync_complete loop ...
  if (dirtied) this.stateDb.setDirtySession(false);
  this.isDraining = false;
}
```

`dirtied` tracks whether the flag was set so `finally` only clears it when needed. This avoids the false-positive crash recovery toast for empty-queue no-op drains.

**`cleanTmpFilesInDir` helper (main.ts)**

Recursively walks a directory, deletes files containing `.protondrive-tmp-` in their name. Errors on a specific file are swallowed (already gone, locked, etc.). Errors on `readdir` for a missing directory are also swallowed (pair path not mounted). Returns number of files deleted.

```ts
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export async function cleanTmpFilesInDir(dirPath: string): Promise<number> {
  let count = 0;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0; // directory doesn't exist or not readable — skip
  }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      count += await cleanTmpFilesInDir(fullPath);
    } else if (entry.name.includes(".protondrive-tmp-")) {
      try {
        await unlink(fullPath);
        count++;
      } catch { /* already gone or locked */ }
    }
  }
  return count;
}
```

**`runCrashRecovery` helper (main.ts)**

```ts
export async function runCrashRecovery(db: StateDb): Promise<boolean> {
  if (!db.isDirtySession()) return false;
  const pairs = db.listPairs();
  for (const pair of pairs) {
    await cleanTmpFilesInDir(pair.local_path);
  }
  db.setDirtySession(false);
  return true; // was dirty — caller should emit crash_recovery_complete
}
```

Returns `true` if recovery ran (dirty flag was set). The number of files cleaned is not included in the IPC payload — the toast message is always the same.

**Deferred `crash_recovery_complete` in `main()` (main.ts)**

```ts
async function main(): Promise<void> {
  stateDb = new StateDb();
  const wasDirty = await runCrashRecovery(stateDb!); // ! needed: module-level let not narrowed in async bodies

  syncEngine = new SyncEngine(...);
  // ...
  server.onConnect(() => {
    server.emitEvent({ type: "ready", payload: { version: ENGINE_VERSION, protocol_version: PROTOCOL_VERSION } });
    if (wasDirty) {
      server.emitEvent({ type: "crash_recovery_complete", payload: {} });
    }
  });
  // ...
}
```

`wasDirty` is captured in the closure. `crash_recovery_complete` is emitted on EVERY reconnect if `wasDirty` is true — but since it's captured at startup, re-connections (window close/reopen) will also receive it. This is intentional: the crash toast should appear whenever the user opens the window after a crash.

**main.py changes**

Add field in `Application.__init__` after existing `_pending_reauth_dialog`:
```python
self._pending_crash_recovery: bool = False
```

Add event registration in `do_startup` after the `conflict_detected` line (line ~97):
```python
self._engine.on_event("crash_recovery_complete", self._on_crash_recovery_complete)
```

Add handler method:
```python
def _on_crash_recovery_complete(self, payload: dict[str, Any]) -> None:
    """Cache crash recovery flag — toast shown after main window is visible (Story 5-4 AC4)."""
    self._pending_crash_recovery = True
```

Inject into `_on_session_ready` in the `has_pairs` branch after `on_session_ready(payload)`:
```python
if has_pairs:
    self._window.show_main()
    self._window.on_session_ready(payload)
    if self._pending_crash_recovery:
        self._pending_crash_recovery = False
        self._window.on_crash_recovery_complete()
    if self._engine is not None:
        ...
```

**window.py change**

Add method after `on_queue_replay_complete`:
```python
def on_crash_recovery_complete(self) -> None:
    """Show crash recovery toast (Story 5-4 FR44)."""
    toast = Adw.Toast.new("Recovered from unexpected shutdown — sync resuming")
    toast.set_timeout(5)
    self.toast_overlay.add_toast(toast)
```

### Key file locations

| File | Change | Location |
|------|--------|----------|
| `engine/src/state-db.ts:40` | `MIGRATIONS` array — add v3 `session_state` | After v2 migration |
| `engine/src/state-db.ts:76` | `CURRENT_VERSION` — change from `2` to `3` | Line 76 |
| `engine/src/state-db.ts` | Add `setDirtySession(dirty: boolean): void` | After `queueSize()` method |
| `engine/src/state-db.ts` | Add `isDirtySession(): boolean` | After `setDirtySession` |
| `engine/src/sync-engine.ts:530` | `drainQueue()` — add `dirtied` flag logic | After null-client guard |
| `engine/src/sync-engine.ts:631` | `finally` block — add `if (dirtied) setDirtySession(false)` | Before `isDraining = false` |
| `engine/src/main.ts` | Add imports: `readdir`, `unlink` from `node:fs/promises`; `join` from `node:path` | Top of file |
| `engine/src/main.ts` | Add `cleanTmpFilesInDir` exported function | Before `main()` |
| `engine/src/main.ts` | Add `runCrashRecovery` exported function | Before `main()` |
| `engine/src/main.ts:606` | `main()` — call `runCrashRecovery` after `new StateDb()` | Line ~608 |
| `engine/src/main.ts:640` | `server.onConnect` — emit `crash_recovery_complete` if `wasDirty` | Inside `onConnect` callback |
| `ui/src/protondrive/main.py:42` | Add `self._pending_crash_recovery: bool = False` | After `_pending_reauth_dialog` |
| `ui/src/protondrive/main.py:97` | Add `on_event("crash_recovery_complete", ...)` | After `conflict_detected` handler |
| `ui/src/protondrive/main.py` | Add `_on_crash_recovery_complete` method | Near other `_on_*` handlers |
| `ui/src/protondrive/main.py:358` | Inject `on_crash_recovery_complete` call in `_on_session_ready` | After `on_session_ready(payload)`, before `get_status` |
| `ui/src/protondrive/window.py` | Add `on_crash_recovery_complete` method | After `on_queue_replay_complete` |

### What NOT to touch

- **`engine/src/sync-engine.ts` `startSyncAll()`** — not involved in dirty flag; it calls `drainQueue` which handles the flag
- **`engine/src/watcher.ts`** — watcher changes do not write tmp files; no flag needed
- **`engine/src/ipc.ts`** — `IpcPushEvent` uses `type: string`, no update needed
- **Flatpak manifest** — no new permissions or XDG paths needed; `session_state` is in the existing state DB
- **`engine/src/config.ts`** — config YAML atomic write uses `.tmp` (not `.protondrive-tmp-`), will not be cleaned
- **`ui/data/ui/*.blp`** — no Blueprint changes needed; toast_overlay already exists in main-window.blp

### Previous story learnings (5-1 through 5-3)

- **5-1**: `onTokenExpired` is 5th param to `SyncEngine` constructor — if adding test construction in new test blocks, always pass all 6 params (`sleepMs` is 6th).
- **5-2**: `show_reauth_dialog()` is mocked in `_make_app()` in test fixtures — don't remove this mock.
- **5-3**: `dirtied` flag pattern in `drainQueue` is analogous to the null-client early-return guard; re-entrant bounce path (returns immediately when `isDraining`) does NOT set dirty flag — this is correct.
- **5-3**: `drainQueue`'s `finally` block runs even for early returns from inside the `try` block — e.g. `if (!client) return` — so `if (dirtied) setDirtySession(false)` in `finally` is safe even when `dirtied = false`.

### Test patterns

#### state-db.test.ts — new describe block

```ts
describe("StateDb — session_state dirty flag", () => {
  let db: StateDb;
  beforeEach(() => { db = new StateDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("isDirtySession() returns false on fresh DB", () => {
    expect(db.isDirtySession()).toBe(false);
  });

  it("setDirtySession(true) → isDirtySession() returns true", () => {
    db.setDirtySession(true);
    expect(db.isDirtySession()).toBe(true);
  });

  it("setDirtySession(false) clears flag", () => {
    db.setDirtySession(true);
    db.setDirtySession(false);
    expect(db.isDirtySession()).toBe(false);
  });

  it("flag persists across separate StateDb instances on same DB", () => {
    // Use a real temp file, not :memory:
    const tmpPath = join(tmpdir(), `state-db-dirty-${Date.now()}.db`);
    try {
      const db1 = new StateDb(tmpPath);
      db1.setDirtySession(true);
      db1.close();
      const db2 = new StateDb(tmpPath);
      expect(db2.isDirtySession()).toBe(true);
      db2.close();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});
```

#### sync-engine.test.ts — new describe block

```ts
describe("SyncEngine — dirty-session flag lifecycle (Story 5-4)", () => {
  // Per-block beforeEach/afterEach — same pattern as other describe blocks

  it("drainQueue with client sets dirty flag, clears in finally", async () => {
    db.upsertSyncState(...); // seed minimal state
    // engine has a mock client set
    expect(db.isDirtySession()).toBe(false);
    await engine.drainQueue();
    expect(db.isDirtySession()).toBe(false); // cleared after completion
  });

  it("drainQueue without client does NOT set dirty flag", async () => {
    // engine created with no setDriveClient call
    await engine.drainQueue();
    expect(db.isDirtySession()).toBe(false);
  });

  it("re-entrant drainQueue bounce does NOT change dirty flag", async () => {
    // Force re-entrant state by setting the private field directly (matches
    // existing test patterns in sync-engine.test.ts for private access)
    (engine as any).isDraining = true;
    db.setDirtySession(true); // pre-set to known state
    await engine.drainQueue(); // hits re-entrancy guard immediately — returns early
    expect(db.isDirtySession()).toBe(true); // unchanged — bounce path never touches flag
    (engine as any).isDraining = false; // cleanup so afterEach doesn't hang
  });

  it("dirty flag cleared even when AuthExpiredError thrown during drain", async () => {
    // mock client.listRemoteFiles to throw AuthExpiredError
    // seed a queue entry so the loop runs
    db.setDirtySession(true); // pre-set (simulating in-flight drain)
    // ... set up engine with dirty=true, trigger AuthExpiredError
    // After drainQueue returns, flag must be false
  });
});
```

Note: for the "dirty flag cleared even when AuthExpiredError" test, you'll need to seed a queue entry and a pair so `pairQueue.length > 0`, then mock `listRemoteFiles` to throw `AuthExpiredError`. The engine's `onTokenExpired` callback runs but `finally` still clears the flag. Use `makeMockClient` and `mock(async () => { throw new AuthExpiredError(); })`.

#### main.test.ts — new tests for crash recovery helpers

Export `cleanTmpFilesInDir` and `runCrashRecovery` from `engine/src/main.ts` with underscore prefix to signal test-helper exports (matching existing `_setDriveClientForTests` pattern):
```ts
// NOT underscore-prefixed since these are real functions, not test-only:
export async function cleanTmpFilesInDir(...)
export async function runCrashRecovery(...)
```

In `main.test.ts`, import and test directly:
```ts
import { cleanTmpFilesInDir, runCrashRecovery } from "./main.js";

describe("crashRecovery helpers", () => {
  it("cleanTmpFilesInDir deletes .protondrive-tmp- files", async () => {
    // Create tmpDir with a .protondrive-tmp-<ts> file
    // Call cleanTmpFilesInDir(tmpDir)
    // Assert file is gone, count === 1
  });

  it("cleanTmpFilesInDir ignores non-tmp files", async () => {
    // Create regular file — should not be deleted
    // count === 0
  });

  it("cleanTmpFilesInDir recurses into subdirectories", async () => {
    // Create tmpDir/sub/.protondrive-tmp- file
    // count === 1
  });

  it("cleanTmpFilesInDir returns 0 for missing directory", async () => {
    const count = await cleanTmpFilesInDir("/nonexistent/path");
    expect(count).toBe(0);
  });

  it("runCrashRecovery returns false when flag is not set", async () => {
    const db = new StateDb(":memory:");
    const result = await runCrashRecovery(db);
    expect(result).toBe(false);
    db.close();
  });

  it("runCrashRecovery clears flag and returns true when set", async () => {
    const db = new StateDb(":memory:");
    db.setDirtySession(true);
    const result = await runCrashRecovery(db);
    expect(result).toBe(true);
    expect(db.isDirtySession()).toBe(false);
    db.close();
  });
});
```

#### UI tests (pytest)

**`ui/tests/test_main.py`** — add to existing app fixture tests:
```python
def test_crash_recovery_complete_sets_pending_flag(mock_app):
    """crash_recovery_complete event sets _pending_crash_recovery."""
    app, mock_engine = mock_app
    app._on_crash_recovery_complete({})
    assert app._pending_crash_recovery is True

def test_session_ready_shows_crash_recovery_toast(mock_app, mock_window):
    """session_ready with _pending_crash_recovery=True calls on_crash_recovery_complete."""
    app, mock_engine = mock_app
    app._window = mock_window
    app._pending_crash_recovery = True
    # Ensure has_pairs returns True
    with patch.object(app, '_has_configured_pairs', return_value=True):
        app._on_session_ready({})
    mock_window.on_crash_recovery_complete.assert_called_once()
    assert app._pending_crash_recovery is False  # consumed

def test_session_ready_without_crash_recovery_flag_no_toast(mock_app, mock_window):
    """session_ready without _pending_crash_recovery does not call on_crash_recovery_complete."""
    app, mock_engine = mock_app
    app._window = mock_window
    app._pending_crash_recovery = False
    with patch.object(app, '_has_configured_pairs', return_value=True):
        app._on_session_ready({})
    mock_window.on_crash_recovery_complete.assert_not_called()
```

**`ui/tests/test_window_routing.py`** — add toast test:
```python
def test_crash_recovery_complete_shows_toast(window_with_overlay):
    """on_crash_recovery_complete adds an AdwToast with correct text."""
    window, toast_overlay = window_with_overlay
    window.on_crash_recovery_complete()
    # Assert toast added with text "Recovered from unexpected shutdown — sync resuming"
```

---

## Tasks / Subtasks

- [x] **Task 1: Add `session_state` table to StateDB (migration v3)** (AC: #1, #2, #5)
  - [x] 1.1 Open `engine/src/state-db.ts`, locate `MIGRATIONS` array (line ~40)
  - [x] 1.2 Add migration version 3 after version 2:
  - [x] 1.3 Update `CURRENT_VERSION` from `2` to `3` (line ~76)
  - [x] 1.4 Add `setDirtySession(dirty: boolean): void` method after `queueSize`
  - [x] 1.5 Add `isDirtySession(): boolean` method immediately after
  - [x] 1.6 No changes to `SAFE_PRAGMAS` needed (not a pragma)
  - [x] 1.7 `bunx tsc --noEmit` — zero type errors

- [x] **Task 2: Set/clear dirty flag in `drainQueue`** (AC: #1, #2)
  - [x] 2.1 Open `engine/src/sync-engine.ts`, locate `drainQueue()`
  - [x] 2.2 Add `let dirtied = false;` after `this.isDraining = true;`
  - [x] 2.3 After null-client guard, add `dirtied = true; this.stateDb.setDirtySession(true);`
  - [x] 2.4 In `finally` block, add `if (dirtied) this.stateDb.setDirtySession(false);`
  - [x] 2.5 `bunx tsc --noEmit` — zero type errors

- [x] **Task 3: Crash recovery helpers and startup in `main.ts`** (AC: #3, #4)
  - [x] 3.1 Add `readdir`, `unlink` from `node:fs/promises`; `join` from `node:path` imports
  - [x] 3.2 Add `cleanTmpFilesInDir` exported function before `main()`
  - [x] 3.3 Add `runCrashRecovery` exported function immediately after
  - [x] 3.4 In `main()`, after `stateDb = new StateDb()`, add `const wasDirty = await runCrashRecovery(stateDb!);`
  - [x] 3.5 In `server.onConnect(...)`, emit `crash_recovery_complete` if `wasDirty`
  - [x] 3.6 `bunx tsc --noEmit` — zero type errors

- [x] **Task 4: UI handler for `crash_recovery_complete`** (AC: #4)
  - [x] 4.1 Open `ui/src/protondrive/main.py`
  - [x] 4.2 Add `self._pending_crash_recovery: bool = False` after `_pending_reauth_dialog`
  - [x] 4.3 Register `crash_recovery_complete` event in `do_startup`
  - [x] 4.4 Add `_on_crash_recovery_complete` handler method
  - [x] 4.5 Inject crash recovery call in `_on_session_ready` `has_pairs` branch
  - [x] 4.6 Open `ui/src/protondrive/window.py`
  - [x] 4.7 Add `on_crash_recovery_complete` method after `on_queue_replay_complete`

- [x] **Task 5: Tests** (all ACs)
  - [x] 5.1 `engine/src/state-db.test.ts`: 4-test dirty flag describe block; updated user_version assertion to 3
  - [x] 5.2 `engine/src/sync-engine.test.ts`: 4-test dirty flag lifecycle describe block
  - [x] 5.3 `engine/src/main.test.ts`: 6-test crash recovery helpers describe block
  - [x] 5.4 `ui/tests/test_main.py`: 3 tests — flag set, session_ready with/without flag
  - [x] 5.5 `ui/tests/test_window_routing.py`: 1 test — on_crash_recovery_complete toast
  - [x] 5.6 `bunx tsc --noEmit` — zero type errors
  - [x] 5.7 `bun test` from `engine/` — 251 pass, 0 fail

- [x] **Task 6: Final validation**
  - [x] 6.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 6.2 `bun test` from `engine/` — 251 pass (new tests included)
  - [x] 6.3 `meson compile -C builddir` — zero errors
  - [x] 6.4 `.venv/bin/pytest ui/tests/` — 548 passed (new tests included)
  - [x] 6.5 Story status set to `review`

---

## Dev Notes

### §1 — Why `dirtied` instead of unconditional setDirtySession

Setting the dirty flag unconditionally (even when `!client`) would cause a false-positive crash recovery toast every time the engine starts after a no-client drain (e.g., token expired, engine restarted). The `dirtied` boolean ensures the flag is only set when actual file I/O is possible. The `finally` block safely checks `if (dirtied)` before clearing — this is a one-liner addition, not a complex pattern.

### §2 — Why defer `crash_recovery_complete` to `onConnect`, not emit during startup

There is no IPC connection during `main()` startup. The IPC server hasn't accepted any client yet. `server.emitEvent()` would silently no-op (or throw) before a client is connected. The `onConnect` callback is the first moment a message can be sent to the UI. The `wasDirty` closure variable is captured from startup and remains correct for the lifetime of the process.

### §3 — `crash_recovery_complete` on re-connections

Since `wasDirty` is captured at process startup, every re-connection (window close/reopen) will receive `crash_recovery_complete`. This means if the user closes and reopens the window without restarting the engine, they'll see the crash recovery toast again. This is acceptable behavior — the engine process hasn't restarted, so the `wasDirty` flag correctly reflects that a crash was detected on the most recent startup.

### §4 — Tmp files from conflict copy creation vs download

Two places in `sync-engine.ts` create `.protondrive-tmp-*` files:
- `downloadOne` (line 1122): `${destPath}.protondrive-tmp-${Date.now()}`
- `processQueueEntry` conflict copy creation (line 296): `${conflictCopyPath}.protondrive-tmp-${Date.now()}`

Both are covered by `cleanTmpFilesInDir` scanning recursively for files containing `.protondrive-tmp-`. The `Date.now()` suffix ensures uniqueness — no false collisions with non-tmp files.

### §5 — StateDB schema evolution

Current `CURRENT_VERSION` is 2 (after Story 2-1's v1 base + Story 2-9's v2 `last_synced_at` column). Story 5-4 adds v3. The migration system in `state-db.ts:migrate()` runs all pending migrations in order — adding v3 is a pure additive change (new table, no existing table modifications). No destructive migration steps.

### §6 — No changes to `IpcPushEvent` type definition

`IpcPushEvent` in `ipc.ts` uses `type: string` (fully generic). Adding `crash_recovery_complete` requires no type changes — it's just a new string. The UI's `on_event("crash_recovery_complete", ...)` wiring is sufficient.

### Project Structure Notes

**Files to create:** none

**Files to modify:**
- `engine/src/state-db.ts` — migration v3, `setDirtySession`, `isDirtySession`
- `engine/src/sync-engine.ts` — `dirtied` flag in `drainQueue`
- `engine/src/main.ts` — `cleanTmpFilesInDir`, `runCrashRecovery`, startup call, `onConnect` emit
- `ui/src/protondrive/main.py` — `_pending_crash_recovery`, event registration, `_on_crash_recovery_complete`, `_on_session_ready` injection
- `ui/src/protondrive/window.py` — `on_crash_recovery_complete`
- `engine/src/state-db.test.ts` — new describe block
- `engine/src/sync-engine.test.ts` — new describe block
- `engine/src/main.test.ts` — new describe block
- `ui/tests/test_main.py` — new tests
- `ui/tests/test_window_routing.py` — new test

**Do NOT modify:**
- `engine/src/ipc.ts` — IpcPushEvent type is generic string
- `ui/data/ui/*.blp` — toast_overlay already in main-window.blp
- `engine/src/watcher.ts` — no tmp files written here
- `engine/src/config.ts` — config YAML uses `.tmp` suffix (not `.protondrive-tmp-`), excluded from cleanup
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — dev agent sets to `review`, not `done`

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.4`
- Story 5-3 (completed): `_bmad-output/implementation-artifacts/5-3-change-queue-replay-after-re-auth.md`
- `drainQueue` method: `engine/src/sync-engine.ts:530`
- `drainQueue` finally block: `engine/src/sync-engine.ts:631`
- `downloadOne` tmp file pattern: `engine/src/sync-engine.ts:1122`
- Conflict copy tmp file pattern: `engine/src/sync-engine.ts:296`
- `MIGRATIONS` array: `engine/src/state-db.ts:40`
- `CURRENT_VERSION`: `engine/src/state-db.ts:76`
- `StateDb.migrate()`: `engine/src/state-db.ts:127`
- `main()` function: `engine/src/main.ts:606`
- `server.onConnect` callback: `engine/src/main.ts:640`
- `Application.__init__` fields: `ui/src/protondrive/main.py:33`
- Event registrations: `ui/src/protondrive/main.py:88`
- `_on_session_ready`: `ui/src/protondrive/main.py:322`
- `on_queue_replay_complete` (model for new toast method): `ui/src/protondrive/window.py:420`
- Project context (test commands, naming conventions): `_bmad-output/project-context.md`

---

## Dev Agent Record

### Implementation Plan

Followed story task sequence exactly. All implementation matched story Dev Notes spec.

### Completion Notes

- **Task 1** (`state-db.ts`): Added migration v3 (`session_state` table, single row), updated `CURRENT_VERSION` to 3, added `setDirtySession`/`isDirtySession` methods. Updated pre-existing `user_version` assertion in tests from 2→3.
- **Task 2** (`sync-engine.ts`): Added `dirtied` boolean guard in `drainQueue`; set dirty after null-client check, clear in `finally` only when `dirtied`. Re-entrant bounce path unchanged.
- **Task 3** (`main.ts`): Added `readdir`/`unlink`/`join` imports; `cleanTmpFilesInDir` recursive helper (swallows per-file errors); `runCrashRecovery` helper; `wasDirty` captured at startup; `onConnect` emits `crash_recovery_complete` if `wasDirty`.
- **Task 4** (`main.py`, `window.py`): `_pending_crash_recovery` field, event registration, `_on_crash_recovery_complete` handler, injection in `_on_session_ready` has_pairs branch, `on_crash_recovery_complete` toast method in window.
- **Task 5** (Tests): 251 engine tests pass (4 state-db, 4 sync-engine, 6 main.test new tests); 548 Python tests pass (3 test_main, 1 test_window_routing new tests). Zero regressions.
- **Task 6**: All validation gates pass — tsc clean, bun test 251/251, meson 0 errors, pytest 548/548.

### Debug Log

No blockers or unexpected issues.

---

## File List

- `engine/src/state-db.ts` — migration v3, CURRENT_VERSION=3, setDirtySession, isDirtySession
- `engine/src/sync-engine.ts` — dirtied flag in drainQueue set/clear
- `engine/src/main.ts` — imports, cleanTmpFilesInDir, runCrashRecovery, wasDirty startup, onConnect emit
- `ui/src/protondrive/main.py` — _pending_crash_recovery field, event registration, _on_crash_recovery_complete, _on_session_ready injection
- `ui/src/protondrive/window.py` — on_crash_recovery_complete method
- `engine/src/state-db.test.ts` — dirty flag describe block (4 tests); user_version assertion updated to 3
- `engine/src/sync-engine.test.ts` — dirty flag lifecycle describe block (4 tests)
- `engine/src/main.test.ts` — crash recovery helpers describe block (6 tests)
- `ui/tests/test_main.py` — _make_app updated, 3 crash recovery tests
- `ui/tests/test_window_routing.py` — 1 crash recovery toast test

---

## Review Findings

- [x] [Review][Patch] `_pending_crash_recovery` leaked in setup-wizard path — AC4 violated: the `else:` branch of `_on_session_ready` (no-pairs / setup wizard) never clears `_pending_crash_recovery`. If crash recovery ran on a machine with no pairs, the flag persists indefinitely and fires a stale "Recovered from unexpected shutdown" toast on the next unrelated `session_ready` with pairs. Fix: add `self._pending_crash_recovery = False` in the `else:` branch. [ui/src/protondrive/main.py:_on_session_ready]

- [x] [Review][Defer] `cleanTmpFilesInDir` no depth limit — no stack-overflow guard for deep directory trees; unlikely in practice for user sync folders but has no hard cap [engine/src/main.ts:cleanTmpFilesInDir] — deferred, pre-existing pattern (matches `walkLocalTree`/`walkRemoteTree` [2-5] open items)
- [x] [Review][Defer] Missing `session_state` row silently no-ops — `isDirtySession` returns false and `setDirtySession` no-ops when the row is absent; migration guarantees the row via `INSERT OR IGNORE` so this only triggers on abnormal DB corruption; consequence is same as pre-feature behavior [engine/src/state-db.ts] — deferred, pre-existing
- [x] [Review][Defer] `runCrashRecovery` clears flag without try/finally guard — `setDirtySession(false)` is called unconditionally after the loop; if `cleanTmpFilesInDir` were to throw, the flag would be cleared despite incomplete cleanup; currently latent because `cleanTmpFilesInDir` swallows all errors [engine/src/main.ts:runCrashRecovery] — deferred, latent
- [x] [Review][Defer] `unlink` error suppression hides EACCES/EBUSY failures — bare `catch` in `cleanTmpFilesInDir` silences all unlink errors including permission-denied; return count undercounts real failures; return value is unused by all callers so no functional impact today [engine/src/main.ts:cleanTmpFilesInDir] — deferred, pre-existing
- [x] [Review][Defer] `on_event` callback signature inconsistency — `_on_crash_recovery_complete` receives `payload: dict` directly while older handlers (e.g., `_on_watcher_status`) receive the full `message: dict` and extract payload manually; pre-existing inconsistency not introduced here; no AC impact [ui/src/protondrive/main.py] — deferred, pre-existing

---

## Change Log

- 2026-04-19: Story 5-4 implemented — dirty session flag, crash recovery helpers, UI toast notification
