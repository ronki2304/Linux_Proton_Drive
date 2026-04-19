# Story 5.7: Actionable Error — inotify Limit Exceeded

Status: done

## Story

As a user,
I want a clear message when the system can't watch all my files,
so that I understand the limitation and know how to fix it.

## Acceptance Criteria

### AC1 — INOTIFY_LIMIT error emitted on ENOSPC during fs.watch

**Given** the inotify watcher calls `fs.watch(dir)` and receives `ENOSPC`
**When** the error is caught in `setupPairWatches`
**Then** an `error` push event is emitted with:
  - `code: "INOTIFY_LIMIT"`
  - `message: "Too many files to watch — close other apps or increase system inotify limit"`
  - `pair_id: <affected pair's pair_id>`

### AC2 — Already-registered watchers continue operating after ENOSPC

**Given** N directories have been successfully registered before ENOSPC on directory N+1
**When** ENOSPC is encountered
**Then** the N already-registered watchers remain active and continue firing change events
**And** the watcher does not crash

### AC3 — No further watch registrations after ENOSPC

**Given** ENOSPC occurs on a directory during `setupPairWatches`
**When** `initialize()` continues
**Then** no further `fs.watch` calls are made for this pair's remaining dirs
**And** no `fs.watch` calls are made for any subsequent sync pairs

### AC4 — Error displayed inline on affected sync pair card

**Given** the UI receives an `INOTIFY_LIMIT` error event with `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a **red dot** (error state)
**And** the `status_label` shows "Sync error"
**And** the accessible label is `"[pair name] — error"`
**And** the error is non-fatal — no app-level banner, no restart button

### AC5 — Footer bar shows sync error state

**Given** the UI receives an `INOTIFY_LIMIT` error event with `pair_id`
**When** rendering the error
**Then** the `StatusFooterBar` shows `"Sync error in [pair name]"` with a **red dot**

---

## Developer Context

### Architecture Overview — READ THIS FIRST

**This story has zero new production code.** The complete implementation already exists in `engine/src/watcher.ts` from Story 2-6 development. The UI error pipeline is complete from Story 5-5.

This story's work is exclusively **test coverage** — three tests that verify the existing implementation satisfies the ACs.

```
Engine:  fs.watch(dir) throws ENOSPC
              ↓
watcher.ts:65-83 → inotifyExhausted = true
                 → emit INOTIFY_LIMIT error event
                 → break (inner dir loop)
                 ↓
initialize():30 → inotifyExhausted guard → break (outer pair loop)
                 (already-registered watchers in this.watchers stay active)
              ↓
UI:  error event → engine.py:319-323 → _on_engine_error()  (main.py:507)
                                      → window.on_pair_error(pair_id, message)
                                        → SyncPairRow.set_state("error")  ← already done (5-5)
                                        → StatusFooterBar.set_error()     ← already done (5-5)
```

### What's already implemented (watcher.ts)

```typescript
private inotifyExhausted = false;             // line 15 — flag persists across pairs

async initialize(): Promise<void> {
  ...
  for (const pair of this.pairs) {
    if (this.stopped || this.inotifyExhausted) break;  // line 30 — skips pair 2+ after ENOSPC
    ...
  }
}

private async setupPairWatches(pair: SyncPair): Promise<void> {
  ...
  for (const dir of dirs) {
    ...
    try {
      const watcher = this.watchFn(dir, ...);
      this.watchers.set(dir, watcher);     // already-registered watchers stay here
      ...
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
        this.inotifyExhausted = true;
        this.emitEvent({
          type: "error",
          payload: {
            code: "INOTIFY_LIMIT",
            message: "Too many files to watch — close other apps or increase system inotify limit",
            pair_id: pair.pair_id,
          },
        });
        break;  // stops inner dir loop; outer loop stops via inotifyExhausted check
      } else {
        debugLog(...);
        continue;  // non-ENOSPC watch failures are silently skipped
      }
    }
  }
}
```

### Critical behavioral distinction from DISK_FULL

DISK_FULL (ENOSPC from file write in sync-engine.ts) aborts the drain pass entirely — `diskFull = true; break;` → `return "disk_full"`. **Do NOT apply this pattern here.**

INOTIFY_LIMIT (ENOSPC from `fs.watch()` in watcher.ts) uses `break` on the inner dir loop + `inotifyExhausted` flag on the outer pair loop. Already-registered watchers in `this.watchers` remain active and fire events. The watcher does not crash.

ENOSPC in watcher context = the kernel inotify watch table is full, not the disk. Two completely different things.

### What this story delivers

1. **`engine/src/watcher.test.ts`** — 3 new tests in the existing `"FileWatcher — ENOSPC handling"` describe block

That is the entire scope. No production code changes. No UI changes.

---

### Critical implementation details

#### What's already tested (do not duplicate)

The existing ENOSPC describe block at lines 162–217 of `watcher.test.ts` already covers:
- Error event emitted (code `"INOTIFY_LIMIT"`, pair_id `"p1"`)
- No 4th watchFn call after ENOSPC on 3rd dir
- Only 2 watchers successfully registered

#### What to add (3 new tests in the existing describe block)

**Test 1 — Message content:**
```typescript
it("ENOSPC emits correct message text", async () => {
  // Same setup as existing test — ENOSPC on 3rd dir
  // Additional assertion:
  expect(errorEvent!.payload["message"]).toBe(
    "Too many files to watch — close other apps or increase system inotify limit",
  );
});
```

**Test 2 — Already-registered watchers continue to fire after ENOSPC:**
```typescript
it("already-registered watchers still fire change events after ENOSPC", async () => {
  // tmpDir + sub1 + sub2 → 3 dirs; ENOSPC on 3rd
  // After initialize(), fire a change event on the 1st watcher's listener
  // Assert: onChangesDetected is called (or scheduleSync fires)
  // This proves the watcher did not crash and remains functional
});
```
Mock structure: ENOSPC on call 3; watchers 1 and 2 are mockWatcher with a `WatchListener<string>` captured via `mockWatch.mock.calls[0]![1]`. After `initialize()`, fire `listener("change", "file.txt")` and await debounce. Assert `onChanges.mock.calls.length === 1`.

**Test 3 — Multi-pair: inotifyExhausted blocks pair 2:**
```typescript
it("ENOSPC on pair-1 dir → pair-2 dirs not watched", async () => {
  // Two pairs: pair-1 uses beforeEach tmpDir (has sub1+sub2 → 3 dirs),
  // pair-2 uses a fresh tmpDir2 created inside this test.
  // watchFn throws ENOSPC on call 1 (pair-1's first dir).
  // ENOSPC on call 1 → break inner dir loop → inotifyExhausted = true →
  // outer pair loop breaks at initialize():30 before pair-2 is attempted.
  // Assert: watchFn called exactly 1 time (pair-2's dir never attempted)
  // Assert: INOTIFY_LIMIT error emitted with pair_id: "p1"
});
```
The `inotifyExhausted` guard at `initialize():30` is what prevents pair 2 from being attempted regardless of how many dirs pair-1 has. The test verifies `mockWatch.mock.calls.length === 1`.

**Cleanup note for Test 3:** Create a second tmpDir inside the test for pair-2's `localPath`. Declare `let tmpDir2: string | undefined` at describe scope (alongside `let tmpDir`), assign inside the test, and add `if (tmpDir2) rmSync(tmpDir2, { recursive: true, force: true }); tmpDir2 = undefined;` to `afterEach` alongside the existing `tmpDir` cleanup.

#### Where to add the tests

Add all 3 tests inside the existing describe block:
```
describe("FileWatcher — ENOSPC handling (AC3, AC6)", () => {
  // existing test here
  // ← insert 3 new tests here
});
```

Do NOT create a new describe block — these are extensions to the same scenario.

#### Existing test helper pattern (watcher.test.ts)

```typescript
function makeMockWatcher(): FSWatcher {
  return { close: mock(() => {}), on: mock(() => {}) } as unknown as FSWatcher;
}

function makeTestPair(localPath: string): SyncPair {
  return {
    pair_id: "p1",
    local_path: localPath,
    remote_path: "/r",
    remote_id: "r1",
    created_at: "2026-01-01T00:00:00Z",
    last_synced_at: null,
  };
}
```

For the multi-pair test, create a second pair with `pair_id: "p2"` and a different `localPath`.

#### Mock pattern for ENOSPC on Nth call

```typescript
let callCount = 0;
const mockWatch = mock((_path: string, _listener: unknown): FSWatcher => {
  callCount++;
  if (callCount === N) {
    throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
  }
  const w = makeMockWatcher();
  mockWatchers.push(w);
  return w;
});
```

---

### What NOT to touch

- **`engine/src/watcher.ts`** — implementation already complete; no changes
- **`engine/src/sync-engine.ts`** — unrelated; `isDiskFull` in sync-engine handles file-write ENOSPC; do NOT add INOTIFY_LIMIT logic here
- **`engine/src/ipc.ts`** — no type changes needed
- **All UI files** — `engine.py`, `main.py`, `window.py`, `sync_pair_row.py`, `status_footer_bar.py`, all `.blp` files — zero changes needed; pipeline complete from Story 5-5

---

### Key file locations

| File | Change |
|------|--------|
| `engine/src/watcher.test.ts` | Add 3 tests inside existing `"ENOSPC handling"` describe block |

---

### Previous story learnings (5-1 through 5-6)

- **5-6**: `isPermissionDenied` added to sync-engine.ts for EACCES/EPERM; watcher EACCES on `readdir` is silently skipped (only the subdir is omitted from watching) — do NOT confuse with INOTIFY_LIMIT. These are separate.
- **5-5**: `isDiskFull` helper handles ENOSPC from file *write* in sync-engine.ts. Story 5-7 handles ENOSPC from `fs.watch()` in watcher.ts. Same errno code, completely different paths, different abort behavior.
- **5-5**: Test baseline (still current): `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 101 pass, 0 fail.
- **5-5**: UI pipeline is code-agnostic — `_on_engine_error()` routes any error event with `pair_id` to `on_pair_error()`. INOTIFY_LIMIT flows through identically to DISK_FULL. No UI tests needed.
- **5-4**: `engine.on_error()` registered at `main.py:102`; IPC dispatch at `engine.py:319-323` — don't touch.
- **5-1**: `SyncEngine` constructor takes 6 params — applies to sync-engine tests only; `FileWatcher` constructor takes 7 params (pairs, onChangesDetected, emitEvent, watchFn, debounceMs, isOnline, enqueueChange) with the last 4 having defaults.

### Test baseline (from 5-6 context)

- Watcher: `bun test engine/src/watcher.test.ts` → **14 pass, 0 fail** (established during this story prep)
- Engine: `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 101 pass, 0 fail
- UI: `.venv/bin/pytest ui/tests/` → 572 passed

---

## Tasks / Subtasks

- [x] **Task 1: Add message-content test** (AC: #1)
  - [x] 1.1 Open `engine/src/watcher.test.ts`
  - [x] 1.2 Inside `describe("FileWatcher — ENOSPC handling (AC3, AC6)")`, add test that verifies `payload["message"]` equals exact string: `"Too many files to watch — close other apps or increase system inotify limit"`
  - [x] 1.3 Reuse the ENOSPC-on-3rd-call mock pattern already in the describe block

- [x] **Task 2: Add continued-operation test** (AC: #2)
  - [x] 2.1 Inside same describe block, add test that fires a change event on a pre-ENOSPC watcher's listener after `initialize()` completes
  - [x] 2.2 Assert `onChangesDetected` is called (await debounce ~50ms) — proves watcher not crashed
  - [x] 2.3 Setup: ENOSPC on 3rd dir, capture listener from 1st successful watch call, debounceMs=50

- [x] **Task 3: Add multi-pair isolation test** (AC: #3)
  - [x] 3.1 Inside same describe block, add test with 2 pairs (pair p1 + pair p2, each with separate tmpDir, no subdirs)
  - [x] 3.2 Configure watchFn to throw ENOSPC on call 1 (p1's only dir)
  - [x] 3.3 Assert `mockWatch.mock.calls.length === 1` — pair 2's dir is never attempted
  - [x] 3.4 Assert INOTIFY_LIMIT error event emitted with `pair_id: "p1"` (not p2)

### Review Findings

- [x] [Review][Defer] INOTIFY_LIMIT error emitted without `stopped` check [engine/src/watcher.ts:66-76] — deferred, pre-existing
- [x] [Review][Defer] Pending debounce timers from pre-ENOSPC watchers not cleared on ENOSPC [engine/src/watcher.ts:77] — deferred, pre-existing

---

- [x] **Task 4: Final validation**
  - [x] 4.1 `bun test engine/src/watcher.test.ts` → **17 pass** (14 baseline + 3 new), 0 fail
  - [x] 4.2 `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 107 pass, 0 fail (no regressions)
  - [x] 4.3 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 4.4 `.venv/bin/pytest ui/tests/` → 572 passed (no UI changes, confirms nothing broken)
  - [x] 4.5 Set story Status to `review`

---

## Dev Notes

### §1 — Why INOTIFY_LIMIT is in watcher.ts, not sync-engine.ts

`ENOSPC` from `fs.watch()` means the Linux kernel's inotify watch table is full (`/proc/sys/fs/inotify/max_user_watches`). This is a watcher registration failure, not a filesystem write failure. The watcher handles it at watch-registration time. `isDiskFull` in `sync-engine.ts` handles ENOSPC from `fs.open()`/`fs.writeFile()`/`copyFile()` — these are file-write failures. Same errno, completely different origin and handling.

### §2 — Why already-registered watchers keep running

When ENOSPC occurs at dir N, the `break` exits the `for (const dir of dirs)` loop inside `setupPairWatches`. Watchers for dirs 0..N-1 are already stored in `this.watchers`. The `stop()` method closes all watchers in `this.watchers` — these will be properly cleaned up on shutdown. Between ENOSPC and shutdown, they continue to fire change events. This is the correct behavior: partial watching is better than no watching.

### §3 — Why the test count is 3, not more

The existing test at watcher.test.ts:180 covers the core scenario well (event emitted, correct code, pair_id, no extra calls, watchers count). The 3 new tests each cover exactly one gap: message string, continued operation, multi-pair. No additional tests are needed.

### §4 — Why no UI test is added

`_on_engine_error()` in `main.py:507` routes based on `pair_id` presence, not `code`. The handler is code-agnostic — it has processed DISK_FULL and PERMISSION_DENIED through the same path with existing tests. Adding a INOTIFY_LIMIT-specific UI test would be redundant and add no safety margin.

### §5 — Deferred items from 5-5 that apply here

Same as PERMISSION_DENIED (Story 5-6) and DISK_FULL (Story 5-5):
- **Multi-pair error footer overwrite** — second INOTIFY_LIMIT event for a different pair replaces first pair name in StatusFooterBar — deferred to Story 5-9
- **`on_online` clears error state** — deferred to Story 5-9
- **`on_watcher_status("ready")` clears footer** — deferred to Story 5-9

Do not attempt to fix these in this story.

### Project Structure Notes

**Files to modify:**
- `engine/src/watcher.test.ts` — 3 new tests in existing `"ENOSPC handling"` describe block

**Files to create:** none

**Do NOT modify:**
- `engine/src/watcher.ts` — already complete
- `engine/src/sync-engine.ts` — unrelated
- `engine/src/ipc.ts` — no type changes needed
- All `ui/` files — pipeline complete from Story 5-5

---

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.7`
- INOTIFY_LIMIT implementation (complete): `engine/src/watcher.ts:14-15,30,65-83`
- Existing ENOSPC test: `engine/src/watcher.test.ts:162-217`
- UI error dispatch (code-agnostic): `ui/src/protondrive/engine.py:319-323`
- `_on_engine_error()` (routes any non-fatal+pair_id to pair card): `ui/src/protondrive/main.py:507-512`
- `on_pair_error()`: `ui/src/protondrive/window.py`
- `SyncPairRow.set_state("error")`: `ui/src/protondrive/widgets/sync_pair_row.py`
- `StatusFooterBar.set_error()`: `ui/src/protondrive/widgets/status_footer_bar.py`
- `isDiskFull` in sync-engine (handles file-write ENOSPC, NOT watch ENOSPC): `engine/src/sync-engine.ts:29-31`
- Story 5-5 (establishes complete UI error pipeline): `_bmad-output/implementation-artifacts/5-5-actionable-error-disk-full.md`
- Story 5-6 (PERMISSION_DENIED pattern, notes watcher ENOSPC is separate): `_bmad-output/implementation-artifacts/5-6-actionable-error-permission-denied.md`

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None.

### Completion Notes List

Added 3 tests inside the existing `"FileWatcher — ENOSPC handling (AC3, AC6)"` describe block in `engine/src/watcher.test.ts`:
1. `"ENOSPC emits correct message text"` — verifies exact message string (AC1)
2. `"already-registered watchers still fire change events after ENOSPC"` — fires listener post-ENOSPC, asserts onChangesDetected called after debounce (AC2)
3. `"ENOSPC on pair-1 dir → pair-2 dirs not watched"` — two-pair setup, ENOSPC on call 1, asserts watchFn called exactly once and error carries pair_id "p1" (AC3)

Also added `let tmpDir2: string | undefined` at describe scope with cleanup in `afterEach` for Test 3.

No production code changed. All gates: watcher 17/0, engine 107/0, tsc clean, UI 572/0.

### File List

- `engine/src/watcher.test.ts`
