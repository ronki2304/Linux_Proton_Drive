# Story 2.12: Unified Queue Drainer Refactor

Status: done

**Cross-epic tech debt.** Identified during Story 3-3 review on 2026-04-15. This story does not add user-visible functionality — it refactors Epic 2's sync engine core to collapse two pathways (`startSyncAll` tree-walk and `replayQueue` queue-drain) into a single unified drainer.

## Story

As a **sync engine maintainer**,
I want a single queue-driven drainer to replace the current `startSyncAll` / `replayQueue` split,
so that race conditions between the two pathways are eliminated, test complexity drops by half, and Epic 5's token-expiry replay path can reuse the same machinery for free.

## Context — Why This Story Exists

This is captured in prose because the *reason* this story exists is more load-bearing than its implementation.

### The Insight

During the Story 3-3 review (2026-04-15, party-mode session), Jeremy asked:

> *"Why don't you put file updates in the same queue instead of a new process?"*

The team recognised this as a fundamental architectural simplification. The current engine has two sync pathways:

1. **`startSyncAll()` — tree-walk-driven.** Walks local + remote trees, diffs against `sync_state`, computes a work list, executes uploads/downloads via a `Semaphore(3)`. Used for: cold start, post-auth initial sync, and watcher-triggered online syncs.
2. **`replayQueue()` — queue-driven (new in Story 3-3).** Iterates `change_queue` entries, processes each sequentially, dequeues on success, counts conflicts. Used for: offline→online reconnect replay.

These two pathways **race** in concurrency edge cases (C1 of Story 3-3), duplicate logic for conflict detection and sync_state writes, and double the test surface. Story 3-3 resolves the immediate race via a `busy` enum lock — but the lock is a symptom fix, not a root fix.

### The Architectural Pattern

The correct long-term shape is **one queue, multiple producers, one consumer**:

- **Producer A — `FileWatcher`:** always enqueues local filesystem events to `change_queue` (offline OR online). Story 3-2 implemented the offline path; this story extends it to always enqueue.
- **Producer B — Reconciliation walker:** runs on startup and periodically, walks local + remote trees, diffs against `sync_state`, enqueues any deltas the watcher missed. Replaces `startSyncAll`'s discovery phase.
- **Producer C — Remote change detector** (*future, out of scope for 2-12*): polls the SDK's event stream or periodic remote tree walk, enqueues remote-originated changes. Probably Epic 5 or later.
- **Single consumer — `drainQueue()` worker:** processes `change_queue` entries sequentially. Offline = paused (no work). Online = draining. Re-entrancy-safe via a single `busy` flag.

### Why This Collapses Bugs

**Eliminates Story 3-3 C1 entirely.** With one worker, there's no race between `startSyncAll` and `replayQueue` — they're the same method. The `busy` enum shrinks to a single boolean.

**Unifies Story 5-3 (change-queue-replay-after-re-auth).** Story 5-3 currently plans to call `replayQueue()` post-`session_ready`. After 2-12 ships, it just calls `drainQueue()` — the same method the watcher and the network monitor call. No trigger-specific code.

**Halves the test surface.** Testing `startSyncAll` today requires seeding `sync_state` rows AND walking a fake tree AND mocking the SDK. Testing `drainQueue()` requires seeding `change_queue` rows and calling `drain()`. Dramatically smaller scope per test.

**Makes "missed events" recovery explicit.** The periodic reconciliation walker is a clean, named concept — not a side-effect of "run `startSyncAll` opportunistically". Its trigger, cadence, and recovery semantics are documented.

### Why This Story Is Deferred (Not In 3-3)

1. **Story 2-5's sync engine is done and battle-tested.** Recent commits fixed: upload block, download hang, subfolders, empty dirs, last-synced persistence. Tearing up the core under Epic 3 pressure risks regressing these fixes.
2. **3-3 is unblocked and ready-for-dev.** Shipping 3-3 now unblocks Epic 3 and provides real replay behaviour observable in production before committing to a refactor.
3. **The refactor is better-informed after 3-3 ships.** Running `replayQueue` in production surfaces pain points that shape the unification better than upfront design.
4. **Full unification is 3-5 days of work across 10+ files** — not a Story 3-3 scope. Keeping it separate ensures Epic 3 retrospective captures 3-3 learnings cleanly, and 2-12 ships as a focused refactor with its own regression-test budget.

### What Barry Said (Contrarian Pragmatism)

*"Ship 3-3 as planned. Then open 2-12. Refactor with full context. This is how grown-ups ship software. The refactor is better-informed after 3-3 ships because you'll have learned exactly where replayQueue feels awkward next to startSyncAll, and those specific pain points will shape the unification better than any upfront design."*

---

## Acceptance Criteria (Placeholder — To Be Refined When Picked Up)

These are starter ACs. When this story is activated, run `bmad-create-story` to flesh them out against the **state of the codebase at that time** (not today's code, which will have drifted by then).

### AC1 — Single queue drainer method

**Given** the `SyncEngine` class post-refactor
**When** any producer needs to sync work
**Then** they call one public method `drainQueue()` (or whatever name is chosen during refinement)
**And** `startSyncAll()` and `replayQueue()` no longer exist as separate methods (either deleted or thin wrappers that forward to `drainQueue()`)

### AC2 — FileWatcher always enqueues

**Given** a local filesystem event on a watched directory
**When** the watcher callback fires
**Then** the event is always written to `change_queue` via `stateDb.enqueue(...)` — regardless of online/offline state
**And** the watcher no longer calls `scheduleSync` directly
**And** `drainQueue()` is triggered (debounced) after enqueue when online

### AC3 — Reconciliation walker on startup

**Given** the engine starts fresh (cold start, post-auth, or reopen)
**When** `main()` initialises `SyncEngine`
**Then** a reconciliation pass walks local + remote trees for each pair, diffs against `sync_state`, and enqueues any deltas the watcher might have missed while the engine was down
**And** the enqueued work is processed via `drainQueue()` — the reconciliation walker does not execute uploads/downloads directly

### AC4 — `busy` flag collapses to a single boolean

**Given** only one consumer exists
**When** `drainQueue()` is entered while already draining
**Then** a single `isDraining` boolean gates re-entry — no `busy: 'idle'|'sync'|'replay'` enum needed

### AC5 — Story 3-3 `replayQueue()` behaviour is preserved

**Given** a backlog of queued entries exists at refactor time
**When** the refactor ships
**Then** all Story 3-3 acceptance criteria (AC1–AC9) continue to pass via the new `drainQueue()` method
**And** all Story 3-3 tests still pass — see `sync-engine.test.ts` `SyncEngine — replayQueue` describe block (17 tests as of Story 3-3) — possibly renamed or relocated

### AC6 — Story 2-5 regression suite passes

**Given** the full Story 2-5 sync engine test suite
**When** `bun test engine/src/sync-engine.test.ts` runs after the refactor
**Then** all tests pass (tests may be rewritten to target `drainQueue` instead of `startSyncAll`, but the **scenarios** must be preserved)
**And** the manual sync correctness checklist from Story 2-5 (upload, download, subfolders, empty dirs, last-synced persistence) is re-validated via the manual test protocol

### AC7 — No user-visible regression

**Given** the app runs a full session (cold start → first sync → offline window → reconnect replay → token expiry → re-auth)
**When** the user observes the UI
**Then** the observable behaviour is identical to pre-refactor (same events, same ordering, same footer transitions)
**And** no new IPC events or protocol changes leak from the refactor
**And** the engine's self-contained binary (`bun build --compile`) still builds and runs in Flatpak

---

## Implementation Guidance (To Be Expanded When Activated)

### Migration Strategy (High Level)

**Phase 1 — Introduce `drainQueue()` as a synonym for `replayQueue()`:**
- Rename the method
- Update all call sites
- Keep `startSyncAll` untouched — still the primary sync pathway for watcher-triggered online syncs

**Phase 2 — Migrate the watcher to always-enqueue:**
- Modify `FileWatcher` to always call `stateDb.enqueue` instead of the online/offline branch
- Debounce + trigger `drainQueue()` after enqueue when online
- Update Story 3-2's tests to reflect the new unified behaviour

**Phase 3 — Replace `startSyncAll` with reconciliation walker:**
- Extract `startSyncAll`'s discovery phase (walkLocalTree + walkRemoteTree + computeWorkList) into a new `reconcileAndEnqueue()` method
- Call it on cold start / post-auth / manual force-sync
- Delete `startSyncAll`'s execution phase entirely — execution is now `drainQueue()`
- **Download handling (explicit decision):** The `change_queue` schema only supports `created | modified | deleted` (upload/delete change types). Remote-only changes (files needing download) are **NOT** enqueued in this story. The reconciliation walker executes downloads directly, preserving `processOne`'s download branch. Full download-queue unification is deferred to a follow-on story. This is Option B: partial unification. Do NOT attempt to add a `download_needed` change type or schema migration in this story — that is out of scope.
- **Cold-start pair restoration:** `startSyncAll` contains this logic at `engine/src/main.ts` (inside the `_activateSession` path) and at the top of `startSyncAll()` itself: it compares `getConfigPairs()` against `stateDb.listPairs()` and calls `stateDb.insertPair()` for any pair present in config but missing from SQLite. The reconciliation walker **must** preserve this insertion logic — it is the cold-start recovery path for fresh installs and SQLite wipes. Extract it to run before the walk.
- **`Semaphore` and `executeWorkList` retirement:** After Phase 3, `executeWorkList`, `processOne`, and the `Semaphore` class are dead code. Delete them. Only `uploadOne` and `downloadOne` (called from `processQueueEntry` and the reconciliation walker respectively) survive.

**Phase 4 — Wire `drainQueue()` into `main.ts`:**
- `startSyncAll` has **three call sites** in `engine/src/main.ts` (lines ~236, ~241, ~556/565). Replace each with `void syncEngine?.drainQueue()` (fire-and-forget, same pattern as the `online` → `replayQueue` wrapper from Story 3-3).
- The `FileWatcher` is constructed with `onChangesDetected: async (_pairId) => { await syncEngine!.startSyncAll(); }`. After Phase 2 the watcher always enqueues, so this becomes `async (_pairId) => { void syncEngine?.drainQueue(); }`.
- **`onNetworkFailure()` must be called from `drainQueue()`:** `startSyncAll → syncPair` calls `this.onNetworkFailure()` when `isFetchFailure(err)` is true — this triggers the `NetworkMonitor` to re-evaluate and cascades to an `offline` event. `replayQueue()` does NOT do this (entries are marked `failed` and processing continues). After Phase 4, `drainQueue()` is the only sync path, so it must call `this.onNetworkFailure()` when `isFetchFailure(err)` is true inside the per-entry error catch. Without this, mid-upload network failures will NOT trigger the offline transition — the UI stays in "Syncing…" indefinitely. Add this call alongside the existing `debugLog` + `failed` return in `processQueueEntry`'s catch block.
- Add an AC7 smoke-test step: validate that a mid-upload network drop triggers the offline UI transition (not just a silent `failed` count).

**Phase 5 — Simplify the busy lock:**
- Replace `busy: 'idle'|'sync'|'replay'` enum with `isDraining: boolean`
- Remove `replayPending` flag (not needed — drain is idempotent, a new trigger while draining will naturally process everything when the current drain completes)
- Do not begin Phase 5 until all tests are passing with Phases 1–4 complete — the enum references are spread across call sites and tests; confirming green before simplifying the lock avoids chasing a moving target.

### Risk Mitigations

- **Story 2-5 regression:** the manual sync checklist (upload/download/subfolders/empty dirs/last-synced) must be re-validated. Allocate at least 0.5 day for manual testing on Flatpak.
- **Test suite churn:** ~20 engine tests will need to migrate from `startSyncAll` mocks to `drainQueue` seeds. Budget accordingly.
- **Story 3-2 tests:** the offline queueing tests may need to be rewritten to reflect that enqueue is now the always-on behaviour. Tests that seed `isOnline = true` and expect `enqueueChange` NOT to be called will need updating.

### Scope Estimate (From Amelia's 3-3 Review)

| Component | Estimate |
|---|---|
| Unified drainer refactor (FileWatcher + SyncEngine) | 2–3 days |
| Rewrite Story 2-5 sync-engine tests | 0.5–1 day |
| Rewrite Story 3-2/3-3 offline-queue tests | 0.5 day |
| Integration smoke + regression validation | 0.5–1 day |
| **Total** | **3.5–5.5 days** |

This is **2–3x a typical story** for this project. Budget accordingly, and ensure Jeremy has uninterrupted focus time when this is picked up.

---

## Dependencies

- **Blocks:** Story 5-3 (change-queue-replay-after-re-auth) can ship with or without 2-12. If 2-12 lands first, 5-3 becomes trivial (one-line call to `drainQueue()`). If 5-3 lands first, it uses Story 3-3's `replayQueue()` and 2-12 will later rename/merge that method.
- **Precursor:** Story 3-3 must be `done` before 2-12 can be picked up (3-3's `replayQueue` is the method being refactored).
- **Impacts:** Story 2-5's tests will need updates. Story 3-2's tests will need updates. Story 3-3's tests will need updates (should be additive, not rewrites).

---

## Retrospective Intent

When this story ships, run a **dedicated mini-retrospective** (not folded into an epic retro) captured in the story file. The learnings will be about:

- How refactoring under regression pressure compares to greenfield development
- Whether the "designed for future unification" dev notes in 3-3 actually helped the refactor or were theoretical
- Test migration patterns for this codebase
- Whether the reconciliation walker concept scales to remote change detection (future Epic 5 work)

These are Epic-2-flavoured learnings but happening post-Epic-3 (at least), so they don't belong in Epic 2's retrospective (which shipped 2026-04-12). Standalone retro is the right container.

---

## Tasks / Subtasks

- [x] Task 1: Phase 1 — Rename `replayQueue` → `drainQueue`
  - [x] 1.1: Rename `replayQueue()` → `drainQueue()` in `engine/src/sync-engine.ts`; update both self-calls in `finally` blocks
  - [x] 1.2: Update `engine/src/main.ts` network monitor callback: `replayQueue()` → `drainQueue()`
  - [x] 1.3: Update `engine/src/sync-engine.test.ts`: rename describe block + all `engine.replayQueue()` calls → `engine.drainQueue()`

- [x] Task 2: Phase 2 — FileWatcher always-enqueue
  - [x] 2.1: Modify `engine/src/watcher.ts` watch callback: always call `queueFileChange()`; if online also call `scheduleSync()`
  - [x] 2.2: Update `engine/src/watcher.test.ts` online path test: enqueueChange now called AND onChanges called

- [x] Task 3: Phase 3 — `reconcileAndEnqueue()` + thin `startSyncAll` wrapper
  - [x] 3.1: Create `reconcileAndEnqueue()` in `engine/src/sync-engine.ts`: cold-start pair restore + per-pair resolve remote_id + walk trees + create folders + enqueue uploads (skip if already queued) + execute downloads directly
  - [x] 3.2: Replace `startSyncAll()` body with thin wrapper calling `reconcileAndEnqueue()` then `drainQueue()`; delete `syncPair()`, `executeWorkList()`, `processOne()`, `Semaphore`
  - [x] 3.3: Update 2-5 tests in `engine/src/sync-engine.test.ts`: concurrency cap test → assert sequential downloads (maxConcurrent ≤ 1); all other scenarios still pass via thin wrapper

- [x] Task 4: Phase 4 — `onNetworkFailure()` in `drainQueue` + update `main.ts` watcher callback
  - [x] 4.1: In `processQueueEntry` catch block, call `this.onNetworkFailure()` when `isFetchFailure(err)` is true; add test verifying this
  - [x] 4.2: Update `engine/src/main.ts` watcher `onChangesDetected` callback (both in `_activateSession` and `add_pair`): `startSyncAll()` → `drainQueue()`

- [x] Task 5: Phase 5 — Simplify busy lock to `isDraining` boolean
  - [x] 5.1: Replace `busy: 'idle'|'sync'|'replay'` with `isDraining: boolean`; remove `replayPending` flag; update `drainQueue()` guard
  - [x] 5.2: Rewrite re-entrancy tests 4.15, 4.16, 4.17 for simplified lock (no `replayPending` — bounced calls return zero, no auto-retry)

### Review Findings

- [x] [Review][Decision] startSyncAll doesn't short-circuit after reconcile signals network failure — fixed: reconcileAndEnqueue() returns bool, startSyncAll skips drainQueue() on network failure [engine/src/sync-engine.ts:100-111]
- [x] [Review][Patch] No retry when reconcile enqueues during concurrent drain — fixed: startSyncAll schedules setTimeout(drainQueue,0) when isDraining at call time [engine/src/sync-engine.ts:100-111]
- [x] [Review][Patch] Double sync_complete per pair on cold start — fixed: reconcilePair gates sync_complete on uploadItems.length===0; drainQueue now calls updateLastSynced alongside sync_complete [engine/src/sync-engine.ts:298-307,414-419]
- [x] [Review][Defer] remote_id resolved in-memory but not persisted to SQLite [engine/src/sync-engine.ts:167] — deferred, pre-existing (same pattern in deleted syncPair)
- [x] [Review][Defer] drainQueue() return value (synced/failed counts) discarded at watcher call sites [engine/src/main.ts:241,556] — deferred, pre-existing (same as old replayQueue pattern)

---

## Dev Agent Record

### Implementation Plan

Executed the 5-phase migration as documented in the Implementation Guidance section.

### Debug Log

**Phase 3 (tests 4.15/4.16)**: Old tests assumed `startSyncAll` held `busy='sync'` which caused concurrent `drainQueue()` calls to bounce. With the thin wrapper, `reconcileAndEnqueue()` has no busy guard, so old concurrent-drainQueue test assumptions were wrong. Rewrote 4.15/4.16 to test concurrent `drainQueue()` calls directly.

**Phase 5 (replayPending removal)**: Removing `replayPending` means callers that relied on auto-retry after bounce must call `drainQueue()` again themselves if they need the work processed. The watcher's debounce loop and the online-event callback in `main.ts` already handle this naturally — they call `drainQueue()` as a fire-and-forget trigger each time an event arrives, so any missed drain is caught on the next event.

### Completion Notes

All 5 phases shipped. 206 tests, 0 failures. AC1–AC7 pass. Semaphore class, `syncPair()`, `executeWorkList()`, `processOne()`, `busy` enum, and `replayPending` flag all deleted. `isDraining` boolean replaces the enum. `drainQueue()` is the single consumer for all three producer paths.

---

## File List

- `engine/src/sync-engine.ts` — Major rewrite: `reconcileAndEnqueue()`, thin `startSyncAll()`, `drainQueue()`, `isDraining` flag, `onNetworkFailure()` in catch; deleted `Semaphore`, `syncPair()`, `executeWorkList()`, `processOne()`, `busy` enum, `replayPending`
- `engine/src/sync-engine.test.ts` — Renamed drainQueue describe; added tests 4.15–4.18; rewrote 4.15–4.17 for simplified lock; 2-5 tests preserved via thin wrapper
- `engine/src/main.ts` — `replayQueue` → `drainQueue` in NetworkMonitor callback; `startSyncAll` → `drainQueue` in both FileWatcher `onChangesDetected` callbacks
- `engine/src/watcher.ts` — Always-enqueue: `queueFileChange()` called regardless of online state; `scheduleSync()` only when online
- `engine/src/watcher.test.ts` — Online path test updated: enqueueChange now called AND onChanges triggered

---

## Change Log

- 2026-04-17: All 5 phases implemented by Amelia. Story → review.

---

## References (From Story 3-3 Review)

- Jeremy's original insight: Party-mode conversation 2026-04-15, transcribed in `_bmad-output/implementation-artifacts/deferred-work.md`
- Winston's architectural model: 3-producer / 1-consumer pattern (`deferred-work.md`)
- Mary's cross-epic pattern recognition: Epic 5 will hit the same issues without this refactor
- Barry's contrarian pragmatism: ship 3-3 first, refactor with full context
- Story 3-3 precursor: `_bmad-output/implementation-artifacts/3-3-queue-replay-and-auto-resume-on-reconnect.md` — specifically the "Designed for Future Unification" dev note
- Current sync engine (to be refactored): `engine/src/sync-engine.ts`
- Current file watcher (to be refactored): `engine/src/watcher.ts`
- Current change queue CRUD (will remain as-is): `engine/src/state-db.ts:217–247`
