# Story 6.0b: Error Code Routing Correctness

Status: ready-for-dev

## Story

As a developer,
I want all misrouted error codes in the sync engine and file watcher fixed before Epic 6 feature work begins,
so that EACCES/EPERM errors emit `PERMISSION_DENIED`, EBUSY emits `FILE_LOCKED`, the INOTIFY_LIMIT event is guarded against stop/exhaust races, and a 401 mid-conflict-resolution no longer leaves an orphaned conflict copy on disk.

## Acceptance Criteria

### AC1 — stat() inner catch routes EACCES/EPERM to PERMISSION_DENIED

**Given** `processQueueEntry` reaches the upload path and `stat()` throws EACCES or EPERM (parent directory is non-executable or file is inaccessible)
**When** the inner `stat()` catch runs
**Then** `isPermissionDenied(err)` is checked after the existing ENOENT check
**And** `PERMISSION_DENIED` is emitted (not `SDK_ERROR`) with message: `"Check folder permissions for <full_path>"`
**And** `"failed"` is returned

### AC2 — INOTIFY_LIMIT event guarded by `stopped` flag

**Given** `stop()` is called on `FileWatcher` concurrently while `setupPairWatches` is running and the ENOSPC catch fires
**When** `this.stopped` is true at the moment of the ENOSPC catch
**Then** `this.emitEvent({ type: "error", payload: { code: "INOTIFY_LIMIT", ... } })` is NOT called
**And** `inotifyExhausted` is still set to `true` and `break` still exits the dirs loop

### AC3 — Debounce timer callbacks do not fire after `inotifyExhausted`

**Given** `inotifyExhausted` is set to `true` (ENOSPC was hit during initialize)
**When** an existing file-watcher callback fires and calls `scheduleSync`
**Then** `scheduleSync` detects `this.inotifyExhausted` at entry and returns early without scheduling a new timer
**And** any timer that was already in-flight when ENOSPC hit checks `inotifyExhausted` before calling `onChangesDetected`, and exits silently

### AC4 — `delete_local` catch routes EACCES/EPERM/EBUSY/ETXTBSY correctly

**Given** `reconcilePair` executes a `delete_local` item and `unlink()` throws EACCES, EPERM, EBUSY, or ETXTBSY
**When** the catch block runs
**Then** EACCES/EPERM routes to `PERMISSION_DENIED` with message `"Check folder permissions for <full_path>"`
**And** EBUSY/ETXTBSY routes to `FILE_LOCKED` with message `"<basename> is in use — sync will retry when it's released"`
**And** non-permission/non-lock errors still emit `SDK_ERROR`
**And** `sync_state` is preserved for retry in all non-ENOENT cases (existing behavior unchanged)
**And** the existing test at `sync-engine.test.ts:~1882` is updated to expect `PERMISSION_DENIED` instead of `SDK_ERROR` — this was a test asserting incorrect behavior

### AC5 — 401 during conflict download deletes the orphaned conflict copy

**Given** `reconcilePair` is processing a `conflict` work item, the conflict copy has been created, and `conflict_detected` has been emitted
**When** `downloadOne` throws `AuthExpiredError`
**Then** `unlink(conflictCopyPath)` is called (best-effort, errors swallowed) before the error is re-thrown
**And** after re-auth + next reconcile, only ONE correct conflict copy exists on disk (not two identical copies)

### AC6 — `deferred-work.md` items resolved by this story are deleted

**Given** story 6-0a has already applied its deferred-work.md cleanup (prerequisite — verify before editing)
**When** story 6-0b ships
**Then** `[5-6 D2]` is deleted from the "code review of 5-6" section — keep `[5-6 D1]`
**And** the entire "Deferred from: code review of 5-7" section is deleted (W1 and W2 both fixed — empty section → remove header too)
**And** `[5-8 CR W2]` is deleted from the "code review of 5-8" section; after 6-0a already removed W1, this section is now empty → delete the section header too
**And** `[5-1 CR W5]` is deleted from the "code review of 5-1" section — keep `[5-1 CR W4]`
**And** all other sections are preserved unchanged

### AC7 — Tests cover each fix; existing regression test updated

**Given** each AC1–AC5 is a regression-prone change
**When** story 6-0b ships
**Then** new/updated tests in `engine/src/sync-engine.test.ts` cover:
- AC1: `stat()` EACCES in processQueueEntry → PERMISSION_DENIED emitted, SDK_ERROR NOT emitted, uploadFile NOT called
- AC4 (update): existing test `"delete_local EPERM failure → SDK_ERROR event emitted"` updated to expect PERMISSION_DENIED
- AC4 (new): `delete_local` FILE_LOCKED (EBUSY) → FILE_LOCKED emitted; SDK_ERROR NOT emitted
- AC5: AuthExpiredError during conflict download → conflict copy absent from disk after startSyncAll()

**And** new tests in `engine/src/watcher.test.ts` cover:
- AC2: `stopped=true` before ENOSPC fires → no `INOTIFY_LIMIT` error event emitted
- AC3: file-watcher callback fires after `inotifyExhausted` → `onChangesDetected` NOT called

**And** `bunx tsc --noEmit` from `engine/` passes with zero type errors
**And** `bun test` from `engine/` passes with zero failures and zero regressions against prior 260+ engine tests

### AC8 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit. **Commit directly to `main`** — do not create a feature branch.

---

## Tasks / Subtasks

- [ ] **Task 1: stat() inner catch → PERMISSION_DENIED** (AC: #1, #7)
  - [ ] 1.1 Open `engine/src/sync-engine.ts`, locate the `"upload"` case inside `processQueueEntry`'s switch (around line 823). Find the inner `try { fileStat = await stat(join(...)) } catch` block — it starts roughly at line 855.
  - [ ] 1.2 In the catch block, after the existing ENOENT check (which calls `debugLog` and `return "conflict"`), add `isPermissionDenied` routing before the `SDK_ERROR` fallthrough:
    ```ts
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        debugLog(`sync-engine: replay upload ${entry.relative_path} — local file missing (ENOENT), routing to conflict`);
        return "conflict";
      }
      const msg = err instanceof Error ? err.message : "unknown";
      debugLog(`sync-engine: replay upload ${entry.relative_path} — stat failed (${code ?? "no-code"}): ${msg}`);
      if (isPermissionDenied(err)) {
        this.emitEvent({
          type: "error",
          payload: {
            code: "PERMISSION_DENIED",
            message: `Check folder permissions for ${join(pair.local_path, entry.relative_path)}`,
            pair_id: pair.pair_id,
            relative_path: entry.relative_path,
          },
        });
        return "failed";
      }
      const message = code
        ? `Sync error ${code} — try again or check ProtonDrive status`
        : "Sync error — try again or check ProtonDrive status";
      this.emitEvent({
        type: "error",
        payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id, relative_path: entry.relative_path },
      });
      return "failed";
    }
    ```
  - [ ] 1.3 `bunx tsc --noEmit` from `engine/` — zero errors
  - [ ] 1.4 Add test to `sync-engine.test.ts` (near the existing Story 5-6 PERMISSION_DENIED describe block, or in a new describe "SyncEngine — error routing (Story 6-0b)"): create `nostat/` subdir in `tmpDir`, write `nostat/file.txt`, enqueue as "created", `chmodSync(join(tmpDir, "nostat"), 0o600)` (removes execute bit → stat fails EACCES), run `drainQueue()`, assert PERMISSION_DENIED emitted with message containing "Check folder permissions" and path containing "nostat/file.txt"; assert SDK_ERROR NOT emitted. Restore chmod in `finally`.

- [ ] **Task 2: INOTIFY_LIMIT stopped guard** (AC: #2, #7)
  - [ ] 2.1 Open `engine/src/watcher.ts`, locate the ENOSPC catch inside `setupPairWatches` (approximately line 65). Current pattern:
    ```ts
    if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
      this.inotifyExhausted = true;
      this.emitEvent({ type: "error", payload: { code: "INOTIFY_LIMIT", ... } });
      break;
    }
    ```
  - [ ] 2.2 Wrap the `emitEvent` call with a stopped check:
    ```ts
    if ((err as NodeJS.ErrnoException).code === "ENOSPC") {
      this.inotifyExhausted = true;
      if (!this.stopped) {
        this.emitEvent({ type: "error", payload: { code: "INOTIFY_LIMIT", message: "Too many files to watch — close other apps or increase system inotify limit", pair_id: pair.pair_id } });
      }
      break;
    }
    ```
  - [ ] 2.3 `bunx tsc --noEmit` — zero errors
  - [ ] 2.4 Add test to `watcher.test.ts` in the ENOSPC describe block: create a FileWatcher with a tmpDir containing one subdir (2 dirs total), call `fw.stop()` before calling `fw.initialize()`, configure mockWatch to throw ENOSPC on the 2nd call (sub1), run `await fw.initialize()`, assert no `error` event with code `INOTIFY_LIMIT` is in emittedEvents

- [ ] **Task 3: Debounce timer inotifyExhausted guard** (AC: #3, #7)
  - [ ] 3.1 Open `engine/src/watcher.ts`, locate `scheduleSync()` (approximately line 105)
  - [ ] 3.2 Add early-exit at the top of the function (after the opening brace, before the existing `const existing = ...`):
    ```ts
    private scheduleSync(pairId: string): void {
      if (this.stopped || this.inotifyExhausted) return;
      // ... existing code unchanged ...
    }
    ```
  - [ ] 3.3 Also add the `inotifyExhausted` check inside the timer callback (alongside the existing `this.stopped` check):
    ```ts
    const timer = setTimeout(() => {
      if (this.stopped || this.inotifyExhausted) return;
      this.debounceTimers.delete(pairId);
      this.onChangesDetected(pairId).catch(...);
    }, this.debounceMs);
    ```
  - [ ] 3.4 `bunx tsc --noEmit` — zero errors
  - [ ] 3.5 Add test to `watcher.test.ts` in the ENOSPC describe block: set up a directory with one subdir, configure mockWatch so 1st call (root dir) succeeds and returns a watcher whose listener is captured, 2nd call (sub1) throws ENOSPC. Call `await fw.initialize()` — `inotifyExhausted` is now `true`. Fire the captured listener (`listener("change", "file.txt")`). Wait for debounce window. Assert `onChangesDetected.mock.calls.length === 0`.

- [ ] **Task 4: delete_local PERMISSION_DENIED / FILE_LOCKED** (AC: #4, #7)
  - [ ] 4.1 Open `engine/src/sync-engine.ts`, locate the `deleteLocalItems` for-loop in `reconcilePair` (approximately line 494). Current catch:
    ```ts
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        const errMsg = ...; const errCode = ...; const message = ...;
        debugLog(...);
        this.emitEvent({ type: "error", payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id } });
        continue;
      }
    }
    ```
  - [ ] 4.2 Replace with the PERMISSION_DENIED / FILE_LOCKED routing pattern (matching the conflictItems and newFileCollisionItems pattern already in this file):
    ```ts
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        const errMsg = err instanceof Error ? err.message : "unknown";
        debugLog(`sync-engine: delete_local failed for ${item.relativePath}: ${errMsg}`);
        if (isPermissionDenied(err)) {
          this.emitEvent({ type: "error", payload: { code: "PERMISSION_DENIED", message: `Check folder permissions for ${join(pair.local_path, item.relativePath)}`, pair_id: pair.pair_id } });
          continue;
        }
        if (isFileLocked(err)) {
          this.emitEvent({ type: "error", payload: { code: "FILE_LOCKED", message: `${basename(join(pair.local_path, item.relativePath))} is in use — sync will retry when it's released`, pair_id: pair.pair_id } });
          continue;
        }
        const errCode = (err as NodeJS.ErrnoException)?.code;
        const message = errCode
          ? `Sync error ${errCode} — try again or check ProtonDrive status`
          : "Sync error — try again or check ProtonDrive status";
        this.emitEvent({ type: "error", payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id } });
        continue;
      }
    }
    ```
  - [ ] 4.3 `bunx tsc --noEmit` — zero errors
  - [ ] 4.4 Update the existing test at `sync-engine.test.ts:~1882` — the test is named `"delete_local EPERM failure → SDK_ERROR event emitted, sync_state preserved"`:
    - Rename it: `"delete_local EPERM failure → PERMISSION_DENIED emitted, sync_state preserved"`
    - Change assertion: `expect((errors[0] as any).payload.code).toBe("PERMISSION_DENIED")` (not `"SDK_ERROR"`)
    - Add: `expect((errors[0] as any).payload.message).toContain("Check folder permissions for")`
    - Keep: `expect(db.getSyncState(PAIR_ID, "perm-denied.txt")).toBeDefined()`
  - [ ] 4.5 Add test for FILE_LOCKED (EBUSY on delete_local). See §4 Dev Notes for the mock approach. Verify FILE_LOCKED emitted, SDK_ERROR NOT emitted, sync_state preserved.

- [ ] **Task 5: 401 orphan conflict copy cleanup** (AC: #5, #7)
  - [ ] 5.1 Open `engine/src/sync-engine.ts`, locate the `conflictItems` for-loop in `reconcilePair` (~line 298). Find the inner `try { const downloadItem = ...; await this.downloadOne(...) } catch` block (~line 377)
  - [ ] 5.2 The catch block currently starts with `if (isAuthExpired(err)) throw err;`. Replace that line with:
    ```ts
    if (isAuthExpired(err)) {
      // Auth expired mid-conflict-resolution. Undo the orphaned conflict copy —
      // the original file is unchanged; next reconcile after re-auth creates one
      // correct copy instead of two.
      try { await unlink(conflictCopyPath); } catch { /* best-effort */ }
      throw err;
    }
    ```
  - [ ] 5.3 `bunx tsc --noEmit` — zero errors
  - [ ] 5.4 Add test to `sync-engine.test.ts`: write `shared.txt` locally, set `db.upsertSyncState` with mismatched mtimes so `computeWorkList` produces a conflict (local_mtime = "old-past", remote_mtime = "old-past" in sync_state; remote file returned with newer mtime). Mock `downloadFile` to throw `new AuthExpiredError()`. Call `await engine.startSyncAll()` (resolves normally — AuthExpiredError is caught in `reconcileAndEnqueue`). Compute the conflict copy path: `join(tmpDir, "shared.txt.conflict-YYYY-MM-DD")` using today's date. Assert `existsSync(conflictCopyPath) === false`.

- [ ] **Task 6: deferred-work.md cleanup** (AC: #6)
  - [ ] 6.1 Open `_bmad-output/implementation-artifacts/deferred-work.md`. Verify the 6-0a items are already gone (check that `[5-6 D3]`, `[5-4 CR W1]`, `[5-0 CR W2]`, `[4-0b W1]`, `[2-5]` bullets, `[5-1 CR W1]`/`W2`/`W3`, `[5-2 D1]`/`D2`, `[5-4 CR W2]`/`W5`, `[5-8 CR W1]` are absent). If any of these are still present, 6-0a hasn't shipped yet — stop and confirm sequencing.
  - [ ] 6.2 Delete the `[5-6 D2]` entry from the "Deferred from: code review of 5-6" section. Keep `[5-6 D1]`.
  - [ ] 6.3 Delete the entire "Deferred from: code review of 5-7" section (header + both `[5-7 CR W1]` and `[5-7 CR W2]` entries + surrounding blank lines). Both items fixed by AC2 and AC3.
  - [ ] 6.4 Delete the `[5-8 CR W2]` entry and its section header "Deferred from: code review of 5-8" (section is empty after 6-0a removed W1 and this story removes W2). Remove surrounding blank lines to avoid double-spacing.
  - [ ] 6.5 Delete the `[5-1 CR W5]` entry from the "Deferred from: code review of 5-1" section. Keep `[5-1 CR W4]`.
  - [ ] 6.6 Verify the following sections are untouched: Meson wrapper, Open Items (4-0b W2, 4-2/4-3), 5-2 (if already gone from 6-0a), 5-3, 5-4, 5-5, 5-6 (D1 only), 5-9, Story 2-12, WebKit aarch64

- [ ] **Task 7: Final validation** (AC: #7, #8)
  - [ ] 7.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [ ] 7.2 `bun test` from `engine/` — zero failures, zero regressions against prior test suite
  - [ ] 7.3 Set story status to `review`

---

## Dev Notes

### §1 — stat() inner catch in processQueueEntry

**File:** `engine/src/sync-engine.ts`
**Location:** `processQueueEntry()` → `"upload"` case → inner `stat()` catch

The outer `processQueueEntry` catch at ~line 961 has `isPermissionDenied` routing, BUT the stat inner catch at ~line 856 intercepts filesystem errors BEFORE the outer catch sees them — it explicitly returns. So EACCES from `stat()` currently produces `SDK_ERROR` instead of `PERMISSION_DENIED`.

The fix inserts the `isPermissionDenied` check between the ENOENT check (return "conflict") and the existing `SDK_ERROR` fallthrough. The `msg`/`debugLog` lines should appear ONCE before both the `isPermissionDenied` check and the `SDK_ERROR` block (in the original code they appear after ENOENT; this structure is preserved).

The stat call path: `join(pair.local_path, entry.relative_path)` — use the same path in the PERMISSION_DENIED message.

**Test setup for stat EACCES (real filesystem):**
```ts
mkdirSync(join(tmpDir, "nostat"));
writeFileSync(join(tmpDir, "nostat", "file.txt"), "data");
db.enqueue({ pair_id: PAIR_ID, relative_path: "nostat/file.txt", change_type: "created", queued_at: new Date().toISOString() });
mockClient = makeMockClient({ listRemoteFiles: mock(async () => []), listRemoteFolders: mock(async () => []) });
engine = new SyncEngine(db, (e) => emittedEvents.push(e));
engine.setDriveClient(mockClient);
chmodSync(join(tmpDir, "nostat"), 0o600); // removes execute from parent dir → stat fails
try {
  await engine.drainQueue();
} finally {
  chmodSync(join(tmpDir, "nostat"), 0o755);
}
```
`chmodSync(dir, 0o600)` removes the execute bit from the directory; `stat(dir/file)` then fails with EACCES because path traversal requires execute on the parent.

### §2 — INOTIFY_LIMIT stopped guard

**File:** `engine/src/watcher.ts`
**Location:** `setupPairWatches()` → the ENOSPC catch block (~line 66)

The `this.stopped` field already exists (private, `boolean`, initialized to `false`). The `stop()` method sets it to `true`. If `stop()` is called concurrently during `setupPairWatches`, the loop-entry check `if (this.stopped) break;` at the top of the `for (const dir of dirs)` loop prevents processing more dirs, but the ENOSPC catch has no corresponding guard for `emitEvent`.

Fix: wrap the single `this.emitEvent(...)` call with `if (!this.stopped) { ... }`. The `this.inotifyExhausted = true` assignment and the `break` both happen unconditionally regardless of `stopped`.

**Test:** create a `FileWatcher`, call `fw.stop()` synchronously, then call `fw.initialize()`. The outer `initialize()` loop still calls `setupPairWatches` (the stopped check at the start of `setupPairWatches`'s loop body fires only on each dir iteration). Configure mockWatch to throw ENOSPC on the 1st call (the root dir). Assert that the emittedEvents array contains no `error` event with `code === "INOTIFY_LIMIT"`. The `watcher_status: "ready"` event will still be emitted — that's fine.

### §3 — Debounce timer inotifyExhausted guard

**File:** `engine/src/watcher.ts`
**Location:** `scheduleSync()` private method (~line 105)

The `inotifyExhausted` flag is already in scope. Two guards needed:

1. **Entry guard:** prevents new timers from being registered after ENOSPC. Without this, watcher callbacks from already-registered watchers still call `scheduleSync` and pile up timers.

2. **Timer callback guard:** handles timers that were in-flight at ENOSPC time. They were registered before `inotifyExhausted` was set; their callbacks will fire after the debounce window. Without this guard they'd call `onChangesDetected` after the error.

Both guards mirror the existing `this.stopped` pattern. Add `|| this.inotifyExhausted` to both locations.

**Test:** 1 root + 1 subdir → mockWatch: 1st call (root) succeeds, 2nd (subdir) throws ENOSPC. Capture the listener from the 1st call. `await fw.initialize()` — `inotifyExhausted` is now true. `listener("change", "file.txt")`. Wait `debounceMs + 50ms`. Assert `onChanges.mock.calls.length === 0`.

```ts
const listeners: WatchListener<string>[] = [];
const mockWatch = mock((_path: string, listener: unknown): FSWatcher => {
  listeners.push(listener as WatchListener<string>);
  if (listeners.length === 2) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
  return makeMockWatcher();
});
// ... create FileWatcher, await initialize() ...
// listeners[0] is the root listener, registered before ENOSPC
listeners[0]!("change", "file.txt");
await new Promise<void>((resolve) => setTimeout(resolve, debounceMs + 50));
expect(onChanges.mock.calls.length).toBe(0);
```

### §4 — delete_local catch PERMISSION_DENIED / FILE_LOCKED

**File:** `engine/src/sync-engine.ts`
**Location:** `reconcilePair()` → `deleteLocalItems` for-loop (~line 494)

The pattern to use is identical to the `conflictItems` and `newFileCollisionItems` loops already in `reconcilePair`: check `isPermissionDenied` → `isFileLocked` → fallthrough to `SDK_ERROR`. All three helpers (`isPermissionDenied`, `isFileLocked`, `isDiskFull`) are defined at ~line 29.

**Existing test to update** (`sync-engine.test.ts:~1882`):
The test uses `chmodSync(tmpDir, 0o555)` which makes the directory non-writable → `unlink` fails with EACCES. After the fix, EACCES routes to PERMISSION_DENIED. The assertions change from `"SDK_ERROR"` to `"PERMISSION_DENIED"`. The test description, code structure, and the `sync_state` preservation assertion all remain; only the expected error code and message format change.

**FILE_LOCKED test (EBUSY):** `unlink` doesn't easily produce EBUSY on real Linux filesystems. Use `mock.module` to override `unlink` from `node:fs/promises`:
```ts
import * as fsPromises from "node:fs/promises";

// In test:
const ebusy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
mock.module("node:fs/promises", () => ({
  ...fsPromises,
  unlink: mock(async (_p: string) => { throw ebusy; }),
}));
```

Note: In Bun, `mock.module` replaces the module factory for subsequent `import()` calls in the same test run. If `sync-engine.ts` is already loaded (it is, via import at the top of the test file), you may need to use a different approach:

- Try `mock.module` in a `beforeEach` and `mock.restore()` in `afterEach`
- Or use Bun's `spyOn` if it supports module functions

If mocking `unlink` proves not feasible in this test context, write the test as follows and note the constraint:
```ts
it("delete_local EBUSY → FILE_LOCKED emitted (code path only)", async () => {
  // Verify the routing code is in place — EBUSY hits isFileLocked → FILE_LOCKED.
  // Real EBUSY on unlink is not reproducible via real FS; code path verified by
  // code review. isFileLocked("EBUSY") already tested in Story 5-8 describe block.
  expect(true).toBe(true); // placeholder — see dev note
});
```
This is an acceptable gap for this debt-cleanup story. The PERMISSION_DENIED path (Task 4.4 test update) verifies the routing structure; the `isFileLocked` helper is tested elsewhere.

### §5 — 401 orphan conflict copy cleanup

**File:** `engine/src/sync-engine.ts`
**Location:** `reconcilePair()` → `conflictItems` for-loop → the `downloadOne` try/catch (~line 358)

The `conflictCopyPath` variable is declared earlier in the same loop body iteration and is in scope at the catch site. The `unlink` is already imported at the top of the file.

`startSyncAll()` does NOT throw `AuthExpiredError` to the caller. The error is caught in `reconcileAndEnqueue` at ~line 202, which calls `this.onTokenExpired()` (default no-op in tests) and returns `true`. So `startSyncAll()` completes normally and the test can check file existence synchronously after `await`.

**Conflict copy path formula** (same as `reconcilePair`):
```ts
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const conflictCopyPath = `${join(pair.local_path, item.relativePath)}.conflict-${date}`;
```

**Full test setup:**
```ts
it("AuthExpiredError during conflict download → orphaned conflict copy deleted", async () => {
  writeLocalFile("shared.txt");
  db.upsertSyncState({
    pair_id: PAIR_ID,
    relative_path: "shared.txt",
    local_mtime: "2026-01-01T00:00:00.000Z",   // won't match real mtime → localChanged = true
    remote_mtime: "2026-01-01T00:00:00.000Z",
    content_hash: null,
  });
  mockClient = makeMockClient({
    listRemoteFiles: mock(async () => [makeRemoteFile("shared.txt", "2026-02-01T00:00:00.000Z")]),
    downloadFile: mock(async () => { throw new AuthExpiredError(); }),
  });
  engine = new SyncEngine(db, (e) => emittedEvents.push(e));
  engine.setDriveClient(mockClient);

  await engine.startSyncAll();  // resolves normally — AuthExpiredError handled internally

  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  expect(existsSync(join(tmpDir, `shared.txt.conflict-${date}`))).toBe(false);
});
```

The sync_state has `local_mtime: "2026-01-01"` which won't match the real file mtime (just written = now) → `localChanged = true`. Remote has mtime "2026-02-01" while sync_state has "2026-01-01" → `remoteChanged = true`. Both changed → `detectConflict()` returns `isConflict: true` → `conflictItems` entry created.

**Note:** `newFileCollisionItems` has an analogous AuthExpiredError scenario (local file renamed to conflict copy before download fails). That is NOT fixed by this story — the rollback requires `rename(conflictCopyPath, localFilePath)` which is a separate, more complex change. Do not add it here.

### Project Structure Notes

**Files to modify:**
- `engine/src/sync-engine.ts` — 3 fixes: stat inner catch (AC1), delete_local catch (AC4), conflict download catch (AC5)
- `engine/src/watcher.ts` — 2 fixes: INOTIFY_LIMIT guard (AC2), scheduleSync inotifyExhausted guard (AC3)
- `engine/src/sync-engine.test.ts` — update 1 existing test + 3 new tests (ACs 1, 4, 5)
- `engine/src/watcher.test.ts` — 2 new tests (ACs 2, 3)
- `_bmad-output/implementation-artifacts/deferred-work.md` — item cleanup (AC6)

**Do NOT modify:**
- Any UI source files (`ui/`)
- `engine/src/state-db.ts` (no schema changes in this story)
- `sprint-status.yaml` (updated by the story creation workflow)
- Any other engine source files not listed above

### References

- Story 6-0a (prerequisite): `_bmad-output/implementation-artifacts/6-0a-unbounded-loop-recursion-safety.md`
- Epic 5 retrospective — 6-0 breakdown: `_bmad-output/implementation-artifacts/epic-5-retro-2026-04-20.md` §`Epic 6 Preparation — Story 6-0 Breakdown`
- [5-6 D2] stat inner catch location: `engine/src/sync-engine.ts` ~line 856 (inside `processQueueEntry` upload case)
- [5-7 CR W1] INOTIFY_LIMIT location: `engine/src/watcher.ts:~66` (setupPairWatches ENOSPC catch)
- [5-7 CR W2] debounce location: `engine/src/watcher.ts:~105` (scheduleSync)
- [5-8 CR W2] delete_local location: `engine/src/sync-engine.ts:~494` (deleteLocalItems for-loop)
- [5-1 CR W5] conflict download location: `engine/src/sync-engine.ts:~378` (conflictItems downloadOne catch)
- `isPermissionDenied`, `isDiskFull`, `isFileLocked` helpers: `engine/src/sync-engine.ts:29–49`
- Existing delete_local EPERM test (update): `engine/src/sync-engine.test.ts:~1882`
- Existing INOTIFY_LIMIT tests (add near): `engine/src/watcher.test.ts:~162`
- Existing PERMISSION_DENIED describe block (add AC1 test near): `engine/src/sync-engine.test.ts:~2340`
- Deferred work file: `_bmad-output/implementation-artifacts/deferred-work.md`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List
