# Story 4.1: Conflict Detection (Existing Files)

Status: done  # review passed 2026-04-17

## Story

As a user,
I want the sync engine to detect when a file has been changed on both my machine and ProtonDrive since the last sync,
so that neither version is silently overwritten.

## Acceptance Criteria

### AC1 — Both mtimes changed → flagged as conflict

**Given** a file exists in `sync_state` with stored `local_mtime` and `remote_mtime`
**When** a sync cycle runs and both current local mtime ≠ stored local mtime AND current remote mtime ≠ stored remote mtime
**Then** the file is flagged as a `conflict` WorkItem (not uploaded, not downloaded)

### AC2 — Same-second mtime divergence → hash fallback

**Given** both mtimes changed but each change is within the same second (sub-second precision artifact)
**When** conflict detection runs
**Then** the engine computes a SHA-256 hash of the local file and compares against `content_hash` stored in `sync_state`
**And** if hashes differ → flagged as conflict
**And** if hashes match → NOT flagged as conflict (effective no-op — content unchanged)
**And** if either hash is null (no stored hash, or file unreadable) → conservative: flagged as conflict
**And** no live remote fetch is performed for hash comparison

### AC3 — Local-only changed → upload normally (no conflict)

**Given** only the local mtime changed (remote mtime matches stored)
**When** a sync cycle runs
**Then** the file is uploaded as a normal revision — `conflict` WorkItem NOT created

### AC4 — Remote-only changed → download normally (no conflict)

**Given** only the remote mtime changed (local mtime matches stored)
**When** a sync cycle runs
**Then** the file is downloaded normally — `conflict` WorkItem NOT created

### AC5 — Conflict WorkItems are logged and preserved (no copy creation in this story)

**Given** one or more `conflict` WorkItems are produced by `computeWorkList`
**When** `reconcilePair` processes them
**Then** each conflict is logged via `debugLog` (Story 4-3 adds copy creation and `conflict_detected` event)
**And** the conflicting file is NOT touched (no overwrite, no deletion)

### AC6 — Unit tests for `conflict.ts`

**When** running `bun test engine/src/conflict.test.ts`
**Then** tests cover: both-sides-changed (clear mtime divergence), same-second mtime with differing hashes, same-second mtime with same hash (no conflict), storedHash=null → hash_unavailable conflict, local-only change → no conflict, remote-only change → no conflict

### AC7 — `sync-engine.test.ts` integration coverage

**When** running `bun test engine/src/sync-engine.test.ts`
**Then** new tests verify: `computeWorkList` emits `conflict` WorkItem when both mtimes changed, `computeWorkList` skips conflict when same-second + same hash, `reconcilePair` does NOT overwrite or delete a conflicting file

### AC8 — Type-check passes

**When** running `bunx tsc --noEmit`
**Then** zero type errors

---

## Tasks / Subtasks

- [x] **Task 1: Create `engine/src/conflict.ts`** (AC: 1, 2, 6)
  - [x] 1.1 Create the file with zero internal engine imports
  - [x] 1.2 Export `ConflictReason` string-union type
  - [x] 1.3 Export `ConflictResult` interface
  - [x] 1.4 Implement private `sameSecond` helper
  - [x] 1.5 Implement and export `detectConflict`

- [x] **Task 2: Add `conflict` WorkItem variant to `sync-engine.ts`** (AC: 1, 5)
  - [x] 2.1 Added `conflict` variant to `WorkItem` union
  - [x] 2.2 Added `import { detectConflict } from "./conflict.js"`
  - [x] 2.3 Added `readFile` to `node:fs/promises` import
  - [x] 2.4 Added `createHash` from `node:crypto`
  - [x] 2.5 Added `SyncState` to `state-db.js` import

- [x] **Task 3: Add `hashLocalFile` private helper to `SyncEngine`** (AC: 2)
  - [x] 3.1 Added `hashLocalFile` near `walkLocalTree`

- [x] **Task 4: Update `computeWorkList` to async + wire conflict detection** (AC: 1, 2, 3, 4)
  - [x] 4.1 Signature updated to `async ... Promise<WorkItem[]>` with `syncStates: Map<string, SyncState>`
  - [x] 4.2 Call site updated to `await this.computeWorkList(...)`
  - [x] 4.3 "Both changed" stub replaced with full conflict detection logic

- [x] **Task 5: Handle `conflict` WorkItems in `reconcilePair`** (AC: 5)
  - [x] 5.1 Added `conflictItems` filter
  - [x] 5.2 Added conflict logging block after `clearStateItems` execution
  - [x] 5.3 Confirmed `conflictItems` NOT in `bytesTotal`

- [x] **Task 6: Create `engine/src/conflict.test.ts`** (AC: 6)
  - [x] 6.1–6.3 All 8 unit tests written and passing

- [x] **Task 7: Add integration tests to `sync-engine.test.ts`** (AC: 7)
  - [x] 7.1–7.2 New describe block with 4 tests all passing

- [x] **Task 8: Validate** (AC: 8)
  - [x] 8.1 `bunx tsc --noEmit` — zero type errors
  - [x] 8.2 `bun test engine/src/conflict.test.ts` — 8/8 pass
  - [x] 8.3 `bun test engine/src/sync-engine.test.ts` — 52/52 pass
  - [x] 8.4 `bun test engine/src` — 225/225 pass

---

## Dev Notes

### §1 — Architectural Boundaries (Critical)

**`conflict.ts` must have zero imports from other engine files.** The `errors.ts` exception is allowed IF needed, but this module needs no error classes — it returns a result type. Violating this creates circular dependencies because `conflict.ts` will be imported by `sync-engine.ts`, which is already the hub of the engine graph.

**`conflict.ts` is a pure module**: input → output, no I/O, no DB, no side effects. All async work (hash computation) lives in `sync-engine.ts`. This is the same design pattern as `errors.ts`.

### §2 — Why `computeWorkList` Must Become Async

Hash computation (`readFile` + `createHash`) is async. The only alternative — pre-computing hashes for all candidate files before calling `computeWorkList` — would require two passes and complicate the caller. Making `computeWorkList` async is cleaner and consistent with the project's `async/await everywhere` rule.

**Regression risk:** `computeWorkList` is called from `reconcilePair` which is already `async`. No callers outside of `SyncEngine` (private method). No test mocks `computeWorkList` directly — tests go through `startSyncAll()`. Type-checker will catch the missing `await` at line 228.

### §3 — `syncStates` Type Widening

The `computeWorkList` signature currently declares `syncStates: Map<string, { local_mtime: string; remote_mtime: string }>`. The call site (line ~228) already passes the full `SyncState[]` objects from `stateDb.listSyncStates()` — TypeScript accepted the narrower type because structural subtyping meant the extra fields were ignored. Widening to `Map<string, SyncState>` is a pure type change with no runtime impact.

`SyncState` is already exported from `state-db.ts` (line 18). Add it to the existing import on line 7.

### §4 — Same-Second Hash Guard (Performance)

Hash computation reads the entire file. Only compute the hash when the same-second condition is true for BOTH sides. Pre-check this in `computeWorkList` before calling `detectConflict`:

```ts
const localSameSecond  = local.mtime.slice(0, 19) === state.local_mtime.slice(0, 19);
const remoteSameSecond = remote.remote_mtime.slice(0, 19) === state.remote_mtime.slice(0, 19);
let currentLocalHash: string | null = null;
if (localSameSecond && remoteSameSecond) {
  currentLocalHash = await this.hashLocalFile(join(pair.local_path, relPath));
}
```

This duplicates the same-second check that `detectConflict` does internally — that's intentional. The duplicate is a performance guard (avoid I/O), not logic. `detectConflict` is the authority on conflict semantics; the guard in `computeWorkList` is just an optimization.

### §5 — Integration Test Setup for Same-Second Case (Task 7.2)

The same-second integration test is tricky because `writeFileSync` sets a real OS mtime, which will differ from the stored mtime in DB. The approach:

1. Write the local file (establishes current mtime via `stat`)
2. `db.upsertSyncState(...)` with `local_mtime` set to the same SECOND as the real file mtime (e.g., `statSync(path).mtime.toISOString().slice(0,19) + ".000Z"`) — this simulates the stored mtime being one millisecond earlier
3. Set `content_hash` in the upserted state to the SHA-256 of the file content
4. Mock `listRemoteFiles` to return `remote_mtime` one millisecond earlier than the stored remote mtime (same second), with `remote_mtime.slice(0,19) === storedRemoteMtime.slice(0,19)`
5. After `startSyncAll()`: assert `uploadFile` NOT called AND `downloadFile` NOT called

The "both hashes match" scenario requires the upserted `content_hash` to equal the actual SHA-256 of the local file. Compute it via `createHash("sha256").update(readFileSync(path)).digest("hex")` in the test setup.

### §6 — Conflict WorkItem in `reconcilePair` Execution Order

The existing execution order in `reconcilePair` is:
1. `clearStateItems` (no I/O)
2. `delete_local` items
3. `trash_remote` items
4. `sync_progress` emit
5. Downloads
6. Enqueue uploads

Insert conflict logging between steps 1 and 2 (before any file I/O). This ensures conflicts are logged even if subsequent deletion execution fails. Conflicts must NOT be counted in `bytesTotal` or `files_total` — they produce no bytes transfer in Story 4-1.

### §7 — `content_hash` Is Always `null` Until Story 4-3

Story 4-1 does NOT update `upsertSyncState` calls to store hashes. The `content_hash` column will be `null` for all existing sync states. Consequence: the `hash_unavailable` branch of `detectConflict` fires for all same-second conflicts — conservative behavior (flag as conflict). This is correct and safe.

Story 4-3 will add hash computation on upload/download completion so that future sync cycles can use the hash for same-second disambiguation.

### §8 — No New-File Collision Stub (Keep Existing)

The existing stub at line ~789-792:
```ts
if (!state) {
  // Both exist but no sync state → conflict, skip (Epic 4)
  debugLog(`sync-engine: skipping conflict (no sync_state) for ${relPath}`);
  continue;
}
```
This handles the **new-file collision** case (4-2, not 4-1). **Do NOT touch this stub.** Story 4-1 only replaces the "both sides changed" stub (lines ~796-800).

### §9 — TypeScript Strict Flag Reminders

- `state.content_hash` is `string | null` — already handled by `detectConflict`'s `null` checks
- `noUncheckedIndexedAccess`: `array[0]!` pattern — not needed here (no index access)
- `verbatimModuleSyntax`: `import type { ... }` for all type-only imports — `SyncState` is added as part of `import type`
- Local imports always `.js` extension: `import { detectConflict } from "./conflict.js"`

### §10 — `driveClient.trashNode` is NOT in `makeMockClient`

The `makeMockClient` helper in `sync-engine.test.ts` (line ~37-53) does NOT include `trashNode` by default. If any new test triggers a `trash_remote` WorkItem, pass it as an override:
```ts
mockClient = makeMockClient({ trashNode: mock(async () => {}) });
```
The conflict detection tests should NOT trigger `trash_remote` items — just ensure the test scenario only has existing (state-tracked) files on both sides.

### Project Structure Notes

- `conflict.ts` goes in `engine/src/` (flat structure — no subdirectories except `__integration__/`)
- `conflict.test.ts` goes in `engine/src/` co-located with source (naming convention: `*.test.ts`)
- Files modified: `engine/src/sync-engine.ts`
- Files created: `engine/src/conflict.ts`, `engine/src/conflict.test.ts`
- Files with test additions: `engine/src/sync-engine.test.ts`
- Do NOT modify: `engine/src/state-db.ts` (no schema changes), `engine/src/sdk.ts`, any UI files, `processQueueEntry` (queue-drain conflict path is separate — untouched in 4-1)

### References

- Epic 4 story definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-41`
- `WorkItem` union type: `engine/src/sync-engine.ts:31`
- `computeWorkList` signature: `engine/src/sync-engine.ts:773`
- `computeWorkList` "both changed" stub (to replace): `engine/src/sync-engine.ts:796-800`
- `computeWorkList` "no sync_state" stub (do NOT touch): `engine/src/sync-engine.ts:789-792`
- `reconcilePair` call site for `computeWorkList`: `engine/src/sync-engine.ts:228`
- `reconcilePair` filter block: `engine/src/sync-engine.ts:231-235`
- `reconcilePair` deletion execution: `engine/src/sync-engine.ts:239-270`
- `SyncState` interface: `engine/src/state-db.ts:18`
- `content_hash` column in sync_state: `engine/src/state-db.ts:57`
- `upsertSyncState`: `engine/src/state-db.ts:186`
- Existing test helpers (`makeMockClient`, `makeRemoteFile`, `writeLocalFile`, `setupPair`): `engine/src/sync-engine.test.ts:28-76`
- `hashLocalFile` pattern from `node:crypto`: Node.js built-in, always available in Bun
- Deferred items (4-0b review): `_bmad-output/implementation-artifacts/deferred-work.md` — W2 specifically: "Local file modified + remote deleted → delete_local silently discards unsaved edits" — still deferred, not in scope for 4-1
- Current test count (baseline): 213 pass across 9 files (`bun test engine/src` as of 2026-04-17)

## Review Findings

- [x] [Review][Patch] `hashLocalFile` loads entire file into memory via `readFile` — use streaming SHA-256 to avoid OOM on large files [engine/src/sync-engine.ts]
- [x] [Review][Defer] `delete_local` retries indefinitely on persistent EPERM/EACCES — no backoff or dead-letter [engine/src/sync-engine.ts] — deferred, already tracked as 4-0b W1 in deferred-work.md
- [x] [Review][Defer] `trash_remote` atomicity — `sync_state` deleted on apparent `trashNode` success; no idempotency guard for partial server failure [engine/src/sync-engine.ts] — deferred, pre-existing distributed-systems pattern across all engine I/O
- [x] [Review][Defer] Local-modified + remote-deleted → `delete_local` silently discards unsaved edits [engine/src/sync-engine.ts] — deferred, already tracked as 4-0b W2 in deferred-work.md
- [x] [Review][Defer] Re-download triggered while local deletion is pending in change_queue [engine/src/sync-engine.ts] — deferred, pre-existing queue/sync-cycle architectural gap
- [x] [Review][Defer] `clear_state` emitted for paths with pending change_queue entries — may orphan queue entries on next drain [engine/src/sync-engine.ts] — deferred, pre-existing queue/sync-cycle architectural gap

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — clean implementation, no unexpected branching.

### Completion Notes List

- `conflict.ts` is pure (zero internal imports) as required by §1.
- `computeWorkList` is now async; the only call site (`reconcilePair`) was already async — no propagation required.
- Same-second hash guard in `computeWorkList` duplicates the check inside `detectConflict` intentionally (performance, not logic — avoids I/O on the common clear-divergence case).
- `content_hash` is `null` in all existing sync states (Story 4-3 will populate it); the `hash_unavailable` branch fires conservatively for all same-second conflicts until then.
- Integration test for same-second+same-hash seeds `local_mtime` as `actualMtime.slice(0,19)+".000Z"` and sets `content_hash` to the actual SHA-256 of the file content so the engine's hash guard can match.

### File List

- `engine/src/conflict.ts` (created)
- `engine/src/conflict.test.ts` (created)
- `engine/src/sync-engine.ts` (modified — imports, WorkItem union, hashLocalFile, computeWorkList, reconcilePair)
- `engine/src/sync-engine.test.ts` (modified — readFileSync/createHash imports, new describe block)
