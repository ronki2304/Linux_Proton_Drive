# Story 6.0e: Test Gap Closure

Status: ready-for-dev

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

- [ ] Task 1 — DISK_FULL reconcilePair coverage (AC: 1)
  - [ ] 1.1 — Add `describe("SyncEngine — DISK_FULL in reconcilePair (Story 6-0e)")` at the end of `sync-engine.test.ts` (after current last line ~2958)
  - [ ] 1.2 — Add Site 5 test: new remote file, `downloadFile` throws ENOSPC → `DISK_FULL` emitted
  - [ ] 1.3 — Add Site 4 test: local file + no sync_state + remote file, rename succeeds, `downloadFile` throws ENOSPC → `DISK_FULL` emitted
  - [ ] 1.4 — Add Site 2 test: conflict scenario (both sides changed), `downloadFile` throws ENOSPC → `DISK_FULL` emitted
  - [ ] 1.5 — Attempt Site 1 test via `mock.module('node:fs/promises', ...)` intercepting `copyFile`; if mock does not intercept (emitPairStatus not called with DISK_FULL), remove the test and add `[6-0e D1]` to deferred-work.md instead
  - [ ] 1.6 — Attempt Site 3 test via `mock.module` intercepting `rename`; same fallback rule as 1.5

- [ ] Task 2 — PERMISSION_DENIED Sites 1, 2, 4, 5 coverage (AC: 2)
  - [ ] 2.1 — Add `describe("SyncEngine — PERMISSION_DENIED Sites 1,2,4,5 (Story 6-0e)")` block in `sync-engine.test.ts` (inside or immediately after the Task 1 block)
  - [ ] 2.2 — Add Site 1 test: conflict scenario + `chmodSync(tmpDir, 0o555)` → `copyFile` throws EACCES → `PERMISSION_DENIED` emitted, `downloadFile` NOT called
  - [ ] 2.3 — Add Site 2 test: conflict scenario, `downloadFile` throws EACCES → `PERMISSION_DENIED` emitted
  - [ ] 2.4 — Add Site 4 test: collision scenario, `downloadFile` throws EACCES → `PERMISSION_DENIED` emitted
  - [ ] 2.5 — Add Site 5 test: new remote file, `downloadFile` throws EACCES → `PERMISSION_DENIED` emitted

- [ ] Task 3 — Queue replay edge cases (AC: 3)
  - [ ] 3.1 — Locate `"SyncEngine — post-reauth queue drain (Story 5-3)"` describe block (~line 578 in `sync-engine.test.ts`); read it in full before adding tests to understand `enqueueFile()`/`db.enqueueChange()` pattern and existing `drainQueue` call conventions
  - [ ] 3.2 — Add `change_type='deleted'` test inside that block: seed sync_state + remote, enqueue deletion, call `drainQueue`, assert `trashNode` called with correct node UID
  - [ ] 3.3 — Add new-file test: no sync_state, no remote, write local file, enqueue as 'modified', call `drainQueue`, assert `uploadFile` called
  - [ ] 3.4 — Add ENOENT mid-replay test: enqueue 'modified' for a file that does not exist on disk, call `drainQueue`, assert no throw, `uploadFile` NOT called, queue empty after drain

- [ ] Task 4 — Fix test_main.py payload shape (AC: 4)
  - [ ] 4.1 — In `ui/tests/test_main.py`, find `TestTokenExpiredResetsWatcherStatus` (~line 41)
  - [ ] 4.2 — Replace both occurrences of `app._on_token_expired({"payload": {"code": "SESSION_EXPIRED"}})` with `app._on_token_expired({"queued_changes": 0})`
  - [ ] 4.3 — Run `.venv/bin/pytest ui/tests/test_main.py::TestTokenExpiredResetsWatcherStatus -v` and confirm both tests pass

- [ ] Task 5 — deferred-work.md cleanup (AC: 5)
  - [ ] 5.1 — Delete items `[5-5 D1]`, `[5-6 D1]`, `[5-3 CR W1]`, `[5-3 CR W2]`, `[5-3 CR W3]`, `[5-3 CR W4]`, `[5-1 CR W4]` from `_bmad-output/implementation-artifacts/deferred-work.md`
  - [ ] 5.2 — Confirm items `[5-5 D6]`, `[5-3 CR W5]`, `[5-3 CR W6]`, `[5-3 CR W7]` remain (won't-fix)

- [ ] Task 6 — Full test suite validation (AC: 6)
  - [ ] 6.1 — `cd engine && bun test` — all tests green, exit 0
  - [ ] 6.2 — `.venv/bin/pytest ui/tests/` from project root — all tests green, exit 0

- [ ] Task 7 — Mark story for review (AC: 7)
  - [ ] 7.1 — Update `sprint-status.yaml`: `6-0e-test-gap-closure: review`
  - [ ] 7.2 — Do NOT self-merge or mark done

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

### Completion Notes List

### File List
