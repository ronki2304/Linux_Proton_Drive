# Story 6.0e: Test Gap Closure

Status: review

## Story

As a developer,
I want all test gaps identified during Epic 5 code reviews to be closed,
so that DISK_FULL, PERMISSION_DENIED, and queue-replay edge cases are verified and the deferred-work log is clean before Epic 6 feature work begins.

## Acceptance Criteria

1. **DISK_FULL Sites 1–5**: All five DISK_FULL error-emission sites in `reconcilePair` are covered by passing tests in `sync-engine.test.ts` that verify `emitPairStatus` is called with `status="error"` and `code="DISK_FULL"`. (Sites 1 and 3 have a Bun `mock.module` caveat — see Dev Notes; if the mock cannot intercept static imports, document as `[6-0e D1]` and remove the non-working test rather than leaving a false-passing one.)

2. **PERMISSION_DENIED Sites 1, 2, 4, 5**: Sites 1, 2, 4, and 5 in `reconcilePair` are covered by passing tests in `sync-engine.test.ts` verifying `code="PERMISSION_DENIED"` emission. **Site 3 (collision rename) is already covered at line 338 — do not add a duplicate.**

3. **Queue replay edge cases**: Three tests are added inside the existing `"SyncEngine — post-reauth queue drain (Story 5-3)"` describe block:
   - `change_type='deleted'` entry in queue → `client.trashNode` is called during drain
   - New file (no sync_state) with `change_type='modified'` → `client.uploadFile` is called during drain
   - File queued for upload but missing on disk at drain time → drain completes without throwing, `uploadFile` is NOT called, queue entry is removed

4. **`test_main.py` payload shape**: Both calls `app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})` in `TestTokenExpiredResetsWatcherStatus` are replaced with `app._on_token_expired({"queued_changes": 0})`. Both tests must still pass after the fix.

5. **`deferred-work.md` cleanup**: The following items are deleted from `_bmad-output/implementation-artifacts/deferred-work.md` upon story completion:
   - `[5-5 D1]` — Sites 1–5 DISK_FULL not tested
   - `[5-6 D1]` — Sites 2–5 PERMISSION_DENIED not tested
   - `[5-3 CR W1]` — failed return value never asserted
   - `[5-3 CR W2]` — change_type='deleted' not covered
   - `[5-3 CR W3]` — new file during expiry not tested
   - `[5-3 CR W4]` — ENOENT mid-replay not tested
   - `[5-1 CR W4]` — Wrong payload shape in `TestTokenExpiredResetsWatcherStatus`

   Items `[5-5 D6]`, `[5-3 CR W5]`, `[5-3 CR W6]`, `[5-3 CR W7]` are **won't-fix** and must remain untouched.

6. **Test suite passes**: `bun test` (run from `engine/`) exits 0 with all new and existing tests green. `.venv/bin/pytest ui/tests/` exits 0 with all tests green.

7. **Story stops at review**: Dev agent marks story `in-progress`, implements, then moves `sprint-status.yaml` to `review`. Do not self-merge or mark done.

## Tasks / Subtasks

- [x] Task 1 — DISK_FULL reconcilePair coverage (AC: 1)
  - [x] 1.1 — Add `describe("SyncEngine — DISK_FULL in reconcilePair (Story 6-0e)")` at the end of `sync-engine.test.ts` (after current last line ~2958)
  - [x] 1.2 — Add Site 5 test: new remote file, `downloadFile` throws ENOSPC → `DISK_FULL` emitted
  - [x] 1.3 — Add Site 4 test: local file + no sync_state + remote file, rename succeeds, `downloadFile` throws ENOSPC → `DISK_FULL` emitted
  - [x] 1.4 — Add Site 2 test: conflict scenario (both sides changed), `downloadFile` throws ENOSPC → `DISK_FULL` emitted
  - [x] 1.5 — Attempt Site 1 test via `mock.module('node:fs/promises', ...)` intercepting `copyFile`; if mock does not intercept (emitPairStatus not called with DISK_FULL), remove the test and add `[6-0e D1]` to deferred-work.md instead
  - [x] 1.6 — Attempt Site 3 test via `mock.module` intercepting `rename`; same fallback rule as 1.5

- [x] Task 2 — PERMISSION_DENIED Sites 1, 2, 4, 5 coverage (AC: 2)
  - [x] 2.1 — Add `describe("SyncEngine — PERMISSION_DENIED Sites 1,2,4,5 (Story 6-0e)")` block in `sync-engine.test.ts` (inside or immediately after the Task 1 block)
  - [x] 2.2 — Add Site 1 test: conflict scenario + `chmodSync(tmpDir, 0o555)` → `copyFile` throws EACCES → `PERMISSION_DENIED` emitted, `downloadFile` NOT called
  - [x] 2.3 — Add Site 2 test: conflict scenario, `downloadFile` throws EACCES → `PERMISSION_DENIED` emitted
  - [x] 2.4 — Add Site 4 test: collision scenario, `downloadFile` throws EACCES → `PERMISSION_DENIED` emitted
  - [x] 2.5 — Add Site 5 test: new remote file, `downloadFile` throws EACCES → `PERMISSION_DENIED` emitted

- [x] Task 3 — Queue replay edge cases (AC: 3)
  - [x] 3.1 — Locate `"SyncEngine — post-reauth queue drain (Story 5-3)"` describe block (~line 578 in `sync-engine.test.ts`); read it in full before adding tests to understand `enqueueFile()`/`db.enqueueChange()` pattern and existing `drainQueue` call conventions
  - [x] 3.2 — Add `change_type='deleted'` test inside that block: seed sync_state + remote, enqueue deletion, call `drainQueue`, assert `trashNode` called with correct node UID
  - [x] 3.3 — Add new-file test: no sync_state, no remote, write local file, enqueue as 'modified', call `drainQueue`, assert `uploadFile` called
  - [x] 3.4 — Add ENOENT mid-replay test: enqueue 'modified' for a file that does not exist on disk, call `drainQueue`, assert no throw, `uploadFile` NOT called, queue empty after drain

- [x] Task 4 — Fix test_main.py payload shape (AC: 4)
  - [x] 4.1 — In `ui/tests/test_main.py`, find `TestTokenExpiredResetsWatcherStatus` (~line 41)
  - [x] 4.2 — Replace both occurrences of `app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})` with `app._on_token_expired({"queued_changes": 0})`
  - [x] 4.3 — Run `.venv/bin/pytest ui/tests/test_main.py::TestTokenExpiredResetsWatcherStatus -v` and confirm both tests pass

- [x] Task 5 — deferred-work.md cleanup (AC: 5)
  - [x] 5.1 — Delete items `[5-5 D1]`, `[5-6 D1]`, `[5-3 CR W1]`, `[5-3 CR W2]`, `[5-3 CR W3]`, `[5-3 CR W4]`, `[5-1 CR W4]` from `_bmad-output/implementation-artifacts/deferred-work.md`
  - [x] 5.2 — Confirm items `[5-5 D6]`, `[5-3 CR W5]`, `[5-3 CR W6]`, `[5-3 CR W7]` remain (won't-fix)

- [x] Task 6 — Full test suite validation (AC: 6)
  - [x] 6.1 — `cd engine && bun test` — all tests green, exit 0
  - [x] 6.2 — `.venv/bin/pytest ui/tests/` from project root — all tests green, exit 0

- [x] Task 7 — Mark story for review (AC: 7)
  - [x] 7.1 — Update `sprint-status.yaml`: `6-0e-test-gap-closure: review`
  - [x] 7.2 — Do NOT self-merge or mark done

## Dev Notes

### Scope: Pure Test Story

**No production code changes.** Files touched:
- `engine/src/sync-engine.test.ts` — new describe blocks + additions to existing block
- `ui/tests/test_main.py` — two-line payload shape fix
- `_bmad-output/implementation-artifacts/deferred-work.md` — item removal

If you find yourself editing `engine/src/sync-engine.ts` or any `ui/src/` file, stop and reconsider. The only exception is if a test physically cannot be written without a small production hook (which is not expected here).

### reconcilePair Error Sites — Exact Line Numbers

All five DISK_FULL/PERMISSION_DENIED sites are in `engine/src/sync-engine.ts`:

| Site | Approx Line | Loop | Operation | How to trigger |
|------|-------------|------|-----------|----------------|
| 1 | 328 (DISK_FULL) / 332 (PD) | `conflictItems` | `copyFile` for conflict copy | `mock.module` or `chmodSync` |
| 2 | 381 / 385 | `conflictItems` | `downloadOne` after conflict copy created | mock `downloadFile` to throw |
| 3 | 416 / 420 | `newFileCollisionItems` | `rename(local → conflictCopy)` | `chmodSync` (**already covered for PD**) |
| 4 | 469 / 473 | `newFileCollisionItems` | `downloadOne` after collision rename | mock `downloadFile` to throw |
| 5 | 571 / 575 | `downloadItems` | `downloadOne` for net-new remote file | mock `downloadFile` to throw |

**Site 3 PERMISSION_DENIED is already covered** at `sync-engine.test.ts` line 338 ("rename fails → PERMISSION_DENIED emitted (EACCES), downloadFile NOT called"). Do not duplicate it.

Key predicates in `sync-engine.ts`:
```ts
// line 29
isDiskFull = (err) => err?.code === "ENOSPC"

// line 33
isPermissionDenied = (err) => err?.code === "EACCES" || err?.code === "EPERM"
  || (typeof err?.message === "string" && err.message.toLowerCase().includes("permission denied"))
```

`isDiskFull` returns `false` for EACCES — so Site 1 PERMISSION_DENIED using `chmodSync` is safe even though the same site also has DISK_FULL logic.

### ENOSPC / EACCES Error Object Construction

```ts
const enospc = Object.assign(
  new Error("ENOSPC: no space left on device"),
  { code: "ENOSPC" }
) as NodeJS.ErrnoException;

const eacces = Object.assign(
  new Error("EACCES: permission denied"),
  { code: "EACCES" }
) as NodeJS.ErrnoException;
```

### Sites 2, 4, 5 — Standard Mock Pattern

These are straightforward: `downloadFile` is on the mock client and interceptable.

```ts
describe("SyncEngine — DISK_FULL in reconcilePair (Story 6-0e)", () => {
  let db: StateDb;
  let tmpDir: string;
  let pairId: number;
  let engine: SyncEngine;

  beforeEach(() => {
    db = new StateDb(":memory:");
    tmpDir = mkdtempSync(join(tmpdir(), "sync-test-"));
    pairId = setupPair(db, tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  test("Site 5 — downloadItems: downloadFile ENOSPC → DISK_FULL emitted", async () => {
    const enospc = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) as NodeJS.ErrnoException;
    const emitPairStatus = mock(() => {});
    const client = makeMockClient({
      listFiles: mock(async () => [
        makeRemoteFile({ name: "newfile.txt", nodeUid: "uid-5", modifiedAt: Date.now() }),
      ]),
      downloadFile: mock(async () => { throw enospc; }),
    });
    engine = new SyncEngine(db, client, emitPairStatus);
    await engine.reconcilePair(pairId);
    expect(emitPairStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", code: "DISK_FULL" })
    );
  });

  test("Site 4 — newFileCollisionItems: downloadFile ENOSPC → DISK_FULL emitted", async () => {
    const enospc = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) as NodeJS.ErrnoException;
    const emitPairStatus = mock(() => {});
    // Local file exists but no sync_state → collision → rename to conflict copy → then downloadFile throws
    writeLocalFile(tmpDir, "collide.txt", "local content");
    const client = makeMockClient({
      listFiles: mock(async () => [
        makeRemoteFile({ name: "collide.txt", nodeUid: "uid-4", modifiedAt: Date.now() }),
      ]),
      downloadFile: mock(async () => { throw enospc; }),
    });
    engine = new SyncEngine(db, client, emitPairStatus);
    await engine.reconcilePair(pairId);
    expect(emitPairStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", code: "DISK_FULL" })
    );
  });

  test("Site 2 — conflictItems: downloadFile ENOSPC → DISK_FULL emitted", async () => {
    const enospc = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) as NodeJS.ErrnoException;
    const emitPairStatus = mock(() => {});
    // Both sides changed → conflict copy created (succeeds) → downloadFile throws ENOSPC
    const fileName = "conflicted.txt";
    writeLocalFile(tmpDir, fileName, "local modified");
    const oldMtime = Date.now() - 10_000;
    db.upsertSyncState(pairId, fileName, "uid-2", oldMtime, "sha-old");
    const client = makeMockClient({
      listFiles: mock(async () => [
        makeRemoteFile({ name: fileName, nodeUid: "uid-2", modifiedAt: Date.now() }),
      ]),
      downloadFile: mock(async () => { throw enospc; }),
    });
    engine = new SyncEngine(db, client, emitPairStatus);
    await engine.reconcilePair(pairId);
    expect(emitPairStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", code: "DISK_FULL" })
    );
  });
});
```

> **Site 4 setup note**: The `rename(local → conflictCopy)` in the newFileCollision path uses the real filesystem. For Site 4, that rename must succeed so execution reaches `downloadOne`. Keep `tmpDir` writable (default). The ENOSPC only needs to come from `downloadFile`.

### Sites 1 and 3 — mock.module Limitation

`copyFile` (Site 1) and `rename` (Sites 3/4) are imported statically from `'node:fs/promises'` at the top of `sync-engine.ts`. Bun's `mock.module` patches the module registry but **cannot retroactively replace bindings already captured by a static `import`**. The mock likely has no effect.

**Try it anyway** — Bun may lazily resolve in some configurations:

```ts
test("Site 1 — conflictItems: copyFile ENOSPC → DISK_FULL emitted", async () => {
  const enospc = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) as NodeJS.ErrnoException;
  mock.module("node:fs/promises", () => ({
    ...require("node:fs/promises"),
    copyFile: mock(async () => { throw enospc; }),
  }));
  const emitPairStatus = mock(() => {});
  const fileName = "conflicted.txt";
  writeLocalFile(tmpDir, fileName, "local modified");
  const oldMtime = Date.now() - 10_000;
  db.upsertSyncState(pairId, fileName, "uid-1a", oldMtime, "sha-old");
  const client = makeMockClient({
    listFiles: mock(async () => [
      makeRemoteFile({ name: fileName, nodeUid: "uid-1a", modifiedAt: Date.now() }),
    ]),
    downloadFile: mock(async () => {}),
  });
  engine = new SyncEngine(db, client, emitPairStatus);
  await engine.reconcilePair(pairId);
  expect(emitPairStatus).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", code: "DISK_FULL" })
  );
});
```

**Decision rule**: Run the test. If `emitPairStatus` IS called with `DISK_FULL` → mock worked, keep the test. If the assertion fails (mock did not intercept) → remove the test and add to `deferred-work.md`:
```
[6-0e D1] Sites 1 and 3 DISK_FULL not tested — copyFile/rename statically imported;
  mock.module cannot intercept. Won't-fix until engine refactors to injectable fs.
```

Do NOT leave a test that passes vacuously (e.g., by asserting `toHaveBeenCalled()` on something that was never guarded by the site being tested).

### PERMISSION_DENIED Sites 2, 4, 5 — Mock Pattern

Identical structure to DISK_FULL Sites 2/4/5 but throw `eacces`:

```ts
test("Site 5 — downloadItems: downloadFile EACCES → PERMISSION_DENIED emitted", async () => {
  const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" }) as NodeJS.ErrnoException;
  const emitPairStatus = mock(() => {});
  const client = makeMockClient({
    listFiles: mock(async () => [
      makeRemoteFile({ name: "remote.txt", nodeUid: "uid-p5", modifiedAt: Date.now() }),
    ]),
    downloadFile: mock(async () => { throw eacces; }),
  });
  engine = new SyncEngine(db, client, emitPairStatus);
  await engine.reconcilePair(pairId);
  expect(emitPairStatus).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", code: "PERMISSION_DENIED" })
  );
});
```

Apply the same conflict/collision setup for Sites 2 and 4 (same scenarios as DISK_FULL Sites 2/4, just swap `enospc` → `eacces` and `DISK_FULL` → `PERMISSION_DENIED`).

### PERMISSION_DENIED Site 1 — chmodSync Pattern

Site 1 is triggered by `copyFile` throwing when the directory is unwritable. Same approach as the already-passing Site 3 test at line 338:

```ts
test("Site 1 — conflictItems: copyFile EACCES → PERMISSION_DENIED emitted, downloadFile NOT called", async () => {
  const emitPairStatus = mock(() => {});
  const downloadFile = mock(async () => {});
  const fileName = "conflicted.txt";
  writeLocalFile(tmpDir, fileName, "local modified");
  const oldMtime = Date.now() - 10_000;
  db.upsertSyncState(pairId, fileName, "uid-p1", oldMtime, "sha-old");
  const client = makeMockClient({
    listFiles: mock(async () => [
      makeRemoteFile({ name: fileName, nodeUid: "uid-p1", modifiedAt: Date.now() }),
    ]),
    downloadFile,
  });
  engine = new SyncEngine(db, client, emitPairStatus);
  chmodSync(tmpDir, 0o555);
  try {
    await engine.reconcilePair(pairId);
  } finally {
    chmodSync(tmpDir, 0o755);
  }
  expect(emitPairStatus).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", code: "PERMISSION_DENIED" })
  );
  expect(downloadFile).not.toHaveBeenCalled();
});
```

> `chmodSync` is from `'node:fs'` — already imported in the test file. `isDiskFull` returns false for EACCES, so `isPermissionDenied` is the correct predicate and will fire.

### Queue Replay Edge Cases — AC3

These tests go **inside** the existing `describe("SyncEngine — post-reauth queue drain (Story 5-3)")` block at ~line 578. **Read the existing tests in that block first** — understand whether it uses `db.enqueueChange(pairId, name, changeType)` directly or has a local `enqueueFile()` wrapper, and how `drainQueue(pairId)` is called.

**change_type='deleted' drain test**:
```ts
test("drain: change_type='deleted' → trashNode called", async () => {
  const fileName = "deleted-file.txt";
  // File existed in sync state and on remote (unchanged)
  db.upsertSyncState(pairId, fileName, "uid-del", Date.now() - 5_000, "sha-del");
  db.enqueueChange(pairId, fileName, "deleted");  // adjust to actual API
  const trashNode = mock(async () => {});
  const client = makeMockClient({
    listFiles: mock(async () => [
      makeRemoteFile({ name: fileName, nodeUid: "uid-del", modifiedAt: Date.now() - 10_000 }),
    ]),
    trashNode,
  });
  engine = new SyncEngine(db, client, emitPairStatus);
  await engine.drainQueue(pairId);
  expect(trashNode).toHaveBeenCalledWith("uid-del");
});
```

**New file drain test**:
```ts
test("drain: new file (no sync_state) → uploadFile called", async () => {
  const fileName = "brand-new.txt";
  writeLocalFile(tmpDir, fileName, "new content");
  // No sync_state, no remote record
  db.enqueueChange(pairId, fileName, "modified");  // adjust to actual API
  const uploadFile = mock(async () => ({ nodeUid: "uid-new", size: 11 }));
  const client = makeMockClient({
    listFiles: mock(async () => []),
    uploadFile,
  });
  engine = new SyncEngine(db, client, emitPairStatus);
  await engine.drainQueue(pairId);
  expect(uploadFile).toHaveBeenCalled();
});
```

**ENOENT mid-replay test**:
```ts
test("drain: file missing on disk (ENOENT) → no crash, uploadFile not called, queue cleared", async () => {
  const fileName = "vanished.txt";
  // Queued but file does NOT exist on disk
  db.enqueueChange(pairId, fileName, "modified");  // adjust to actual API
  const uploadFile = mock(async () => {});
  const client = makeMockClient({
    listFiles: mock(async () => []),
    uploadFile,
  });
  engine = new SyncEngine(db, client, emitPairStatus);
  await engine.drainQueue(pairId);  // must not throw
  expect(uploadFile).not.toHaveBeenCalled();
  // Queue entry must be gone (no infinite retry loop)
  const remaining = db.getPendingChanges(pairId);  // adjust to actual StateDb API
  expect(remaining.length).toBe(0);
});
```

> Adjust `db.enqueueChange`, `engine.drainQueue`, and `db.getPendingChanges` to the exact method names used in `sync-engine.ts` / `state-db.ts`. Read the existing Story 5-3 tests for the correct signatures before writing.

### test_main.py Fix (AC4)

`ui/src/protondrive/main.py` line 426 — `_on_token_expired` reads:
```python
queued_changes: int = payload.get("queued_changes", 0) if isinstance(payload, dict) else 0
```

The correct IPC payload is `{"queued_changes": N}` at the top level. The existing tests pass `{"payload": {"code": "SESSION_EXPIRED"}}` which causes `payload.get("queued_changes", 0)` to silently return 0 without exercising the actual key.

**In `ui/tests/test_main.py` at `TestTokenExpiredResetsWatcherStatus` (~line 41):**

Before:
```python
app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})
```

After:
```python
app._on_token_expired({"queued_changes": 0})
```

There are exactly two such calls — fix both. The test assertions (watcher status checks) remain unchanged. If either test begins failing after the fix, the assertion was inadvertently relying on the wrong shape — investigate before overriding.

### Parallel Story Caution

Stories 6-0b, 6-0c, 6-0d are also `ready-for-dev` and may be in-flight concurrently. 6-0b adds a PERMISSION_DENIED test around the `delete_local` catch (~line 1882 in `sync-engine.test.ts`). **Do not touch that area.** Your new tests go in:
- New describe blocks appended at the end of the file (after current ~line 2958)
- Inside the existing "post-reauth queue drain" block only

If a merge conflict occurs with 6-0b, resolve it by keeping both sets of tests intact.

### Test Runner Commands

```bash
# Engine tests (from engine/ directory)
cd engine && bun test

# Targeted engine run
cd engine && bun test --grep "DISK_FULL in reconcilePair"
cd engine && bun test --grep "PERMISSION_DENIED Sites"
cd engine && bun test --grep "post-reauth queue drain"

# UI tests (from project root)
.venv/bin/pytest ui/tests/ -v
.venv/bin/pytest ui/tests/test_main.py::TestTokenExpiredResetsWatcherStatus -v
```

### Project Structure Notes

- Alignment: all changes are within existing files in established patterns
- No new files to create
- `db.upsertSyncState` / `db.enqueueChange` / `db.getPendingChanges` — verify exact method names in `engine/src/state-db.ts` before using; the above are illustrative

### References

- [Source: engine/src/sync-engine.ts#isDiskFull] line 29 — ENOSPC-only check
- [Source: engine/src/sync-engine.ts#isPermissionDenied] line 33 — EACCES/EPERM/message check
- [Source: engine/src/sync-engine.ts#reconcilePair] lines 328,381,416,469,571 — DISK_FULL sites
- [Source: engine/src/sync-engine.ts#reconcilePair] lines 332,385,420,473,575 — PERMISSION_DENIED sites
- [Source: engine/src/sync-engine.ts#processQueueEntry] line 924 — deleted → trashNode path
- [Source: engine/src/sync-engine.ts#processQueueEntry] line 802 — new file → upload path
- [Source: engine/src/sync-engine.ts#processQueueEntry] lines 857–863 — ENOENT from stat → returns "conflict"
- [Source: engine/src/sync-engine.test.ts] line 338 — Site 3 PERMISSION_DENIED already covered
- [Source: engine/src/sync-engine.test.ts] line 578 — post-reauth queue drain describe block
- [Source: engine/src/sync-engine.test.ts] line 2958 — end of file; append new describe blocks here
- [Source: ui/tests/test_main.py] line 41 — TestTokenExpiredResetsWatcherStatus
- [Source: ui/src/protondrive/main.py] line 426 — _on_token_expired; correct IPC shape: `{"queued_changes": N}`
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — items to delete vs keep
- [Source: _bmad-output/implementation-artifacts/epic-5-retro-2026-04-20.md] — 6-0e definitive spec

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

N/A — no external debug logs referenced.

### Completion Notes List

- **DISK_FULL Sites 1 & 3**: `mock.module("node:fs/promises", ...)` DOES intercept statically-imported bindings in Bun (contrary to dev notes). Both implemented via `mock.module` with `copyFile`/`rename` throwing ENOSPC.

- **mock.module isolation issue**: `mock.restore()` resets mock function implementations but does NOT unregister `mock.module()` registrations from Bun's module registry. The cycle-guard test's readdir mock leaked into DISK_FULL Sites 2/4/5 and PD Sites 1/2/4. Fix: convert all tests in these blocks to use `mock.module` for full isolation.

- **AC3 ENOENT claim vs. code**: Story said "queue entry is removed" after ENOENT; actual code in `processQueueEntry` routes ENOENT to "conflict" outcome (entry stays). Test written to match code: `skipped_conflicts=1`, `queueSize=1`.

- **PD Site 1 approach**: Switched from `chmodSync(tmpDir, 0o555)` to `mock.module` with `copyFile: mock(async () => { throw eacces; })` — eliminates real-FS side effects and resolves mock.module contamination from earlier describe blocks.

### File List

- `engine/src/sync-engine.test.ts` — added 13 new tests (3 inside existing post-reauth block; 5 DISK_FULL sites; 5 PD sites); converted 6 tests from real-fs to `mock.module` for isolation
- `ui/tests/test_main.py` — fixed payload shape in `TestTokenExpiredResetsWatcherStatus` (2 calls)
- `_bmad-output/implementation-artifacts/deferred-work.md` — removed 7 closed items
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — moved `6-0e-test-gap-closure` to `review`

### Review Findings

- [ ] [Review][Decision] AC3 ENOENT queue-entry behavior mismatch — AC3 states "queue entry is removed" after ENOENT mid-replay, but `processQueueEntry` routes ENOENT to `"conflict"` (entry stays, `skipped_conflicts++`). Test correctly asserts `queueSize=1`. Need human decision: (a) accept code behavior and update AC3 wording, or (b) change `processQueueEntry` to dequeue on ENOENT. [`engine/src/sync-engine.ts:888-894`, `engine/src/sync-engine.test.ts:887`]

- [ ] [Review][Patch] drain-deleted test missing sync_state removal assertion — after `trashNode` succeeds, the `sync_state` row for the deleted file should be purged; test only checks `result.synced` and queue size but not `db.getSyncState(PAIR_ID, fileName) === undefined`. [`engine/src/sync-engine.test.ts:842`]

- [ ] [Review][Patch] PERMISSION_DENIED Site 2 test missing `pair_id` assertion — Sites 4 and 5 in the PD describe block both assert `errorEvent.payload.pair_id === PAIR_ID`, but Site 2 stops at `expect(errorEvent).toBeTruthy()` — inconsistency would mask a bug where `pair_id` is absent from the Site 2 error payload. [`engine/src/sync-engine.test.ts`]

- [ ] [Review][Patch] ENOENT drain test should assert no error event emitted — the "file missing on disk" test confirms `skipped_conflicts=1` and `queueSize=1` but does not assert `emittedEvents.filter(e => e.type === "error").length === 0`; silent conflict routing should produce no error event and this is unverified. [`engine/src/sync-engine.test.ts:882-888`]

- [ ] [Review][Patch] DISK_FULL Site 1 test should assert `downloadFile` NOT called — when `copyFile` throws ENOSPC at Site 1 (conflict copy), the engine should short-circuit without calling `downloadFile`; test only asserts DISK_FULL was emitted, not that `downloadFile` was not invoked. [`engine/src/sync-engine.test.ts`]

- [x] [Review][Defer] Site 3 DISK_FULL test doesn't assert `downloadFile` NOT called — secondary assertion quality; primary DISK_FULL emission check is correct — deferred, pre-existing [`engine/src/sync-engine.test.ts`]
- [x] [Review][Defer] `mock.module` accumulates in Bun's module registry across tests — `mock.restore()` does not unregister `mock.module` registrations; DISK_FULL/PD describe blocks are last in file so no subsequent tests are contaminated — deferred, pre-existing Bun limitation [`engine/src/sync-engine.test.ts`]
- [x] [Review][Defer] PERMISSION_DENIED Site 1 loop short-circuit not verified — test uses one conflict item, doesn't verify `continue` vs `break` loop semantics on error — deferred, out of scope for 6-0e ACs [`engine/src/sync-engine.test.ts`]
- [x] [Review][Defer] EPERM variant of `isPermissionDenied` untested — all PD tests throw EACCES; EPERM path through `isPermissionDenied` has no test coverage — deferred, pre-existing gap [`engine/src/sync-engine.ts:33`]
- [x] [Review][Defer] No multi-pair DISK_FULL loop-abort test — when `diskFull=true` on pair 1, subsequent pairs are skipped; no test verifies this — deferred, out of scope (Epic 6 multi-pair feature scope) [`engine/src/sync-engine.ts`]
- [x] [Review][Defer] No `mkdir` ENOSPC test in `downloadOne` — `mkdir(dirname(dest), { recursive: true })` can throw ENOSPC before `downloadFile` is called; path is untested — deferred, out of scope for 6-0e [`engine/src/sync-engine.ts`]
- [x] [Review][Defer] No `attempt_count` dead-lettering drain test — `drainQueue` dequeues after `MAX_DRAIN_ATTEMPTS` failures; no test exercises this path — deferred, out of scope for 6-0e [`engine/src/sync-engine.ts`]
