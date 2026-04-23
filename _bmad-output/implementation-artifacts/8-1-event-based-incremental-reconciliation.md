# Story 8.1: Event-Based Incremental Reconciliation

Status: backlog

## Context

The Proton Drive SDK README lists **"Use event-based sync"** as a hard technical requirement:
> "Synchronize data using Drive events. Do not poll the API or perform frequent recursive traversals of the file tree."

The current engine performs a full remote tree walk on every startup for every sync pair (`GET /folders/.../children` recursively). For large pairs this generates hundreds of API calls, triggers HTTP 429 rate limits on the public-keys endpoint for pre-2024 nodes, and requires the app to stay resident to avoid the penalty on next launch.

The SDK already ships a complete events subsystem (confirmed in `engine/node_modules/@protontech/drive-sdk/dist/internal/events/`):
- `VolumeEventManager.getEvents(eventId)` — async generator yielding all node changes since a saved event ID
- `VolumeEventManager.getLatestEventId()` — bookmark the current position after a full walk
- `DriveEventType.NodeCreated / NodeUpdated / NodeDeleted` — the delta event types
- `DriveEventType.TreeRefresh` — server signals that the event log was pruned; fall back to full walk
- `DriveEventType.FastForward` — nothing changed since the saved ID; advance the bookmark

**Note:** Before implementation, confirm with the Proton Drive SDK team that `VolumeEventManager` is a stable, supported interface for third-party clients (not internal-only). See the open question documented in the dev team communication.

## Story

As a user,
I want the sync client to start up quickly and not hammer the ProtonDrive API on every launch,
so that reconciliation is near-instant after the first run and the client complies with Proton's SDK usage requirements.

## Acceptance Criteria

1. **State DB** — `sync_pairs` table gains a nullable `last_event_id TEXT` column; migration is additive (no data loss on upgrade from existing installs).

2. **First run per pair (no saved event ID)** — when a pair has no `last_event_id` (new install or newly added pair), engine performs a full remote tree walk as today; on completion calls `getLatestEventId()` and persists the result to `last_event_id` for that pair.

3. **Subsequent startups (saved event ID present)** — engine calls `getEvents(last_event_id)` instead of a full walk; processes only `NodeCreated`, `NodeUpdated`, `NodeDeleted` events; updates `last_event_id` after processing.

4. **TreeRefresh fallback** — if `getEvents` yields a `TreeRefresh` event, the engine discards the saved event ID and falls back to a full walk for that pair, then re-saves the new event ID.

5. **FastForward handling** — if `getEvents` yields `FastForward` (nothing changed), the engine advances `last_event_id` to the new value and skips reconciliation for that pair.

6. **Local-side reconciliation unchanged** — inotify-detected local changes are still enqueued and processed as today; the event-based path only replaces the remote tree walk.

7. **Per-pair isolation** — each pair has its own `last_event_id`; a `TreeRefresh` on one pair does not affect others.

8. **No regression** — all existing engine tests pass; the full-walk path (first run or `TreeRefresh`) produces identical queue entries to the current implementation.

## Deferred (same epic, separate story)

- **`x-pm-appversion` header correction** — currently hardcoded to `web-drive@5.0.0.0`; must be changed to `external-drive-ProtonDriveLinuxClient@{version}` to comply with the SDK identification requirement. Deferred until after confirmation from Proton SDK team and a version scheme is agreed.

## Tasks / Subtasks

- [ ] **Task 0 — Verify VolumeEventManager stability with Proton SDK team** ⛔ prerequisite gate — do not start Task 1 until resolved
  - [ ] 0.1 Confirm with the Proton Drive SDK team that `VolumeEventManager` in `dist/internal/events/volumeEventManager.js` is a supported, stable interface for third-party clients (not internal-use only or subject to breaking changes without notice)
  - [ ] 0.2 If confirmed **unstable / internal-only**: escalate to Jeremy; defer this story pending SDK team guidance; update story Status to `blocked`; record outcome in Dev Agent Record
  - [ ] 0.3 If confirmed **stable**: proceed to Task 1; document the confirmation channel (GitHub issue / email thread) in Dev Agent Record Completion Notes

- [ ] **Task 1 — State DB migration** (AC: 1)
  - [ ] 1.1 Add `last_event_id TEXT` column to `sync_pairs` in `engine/src/state-db.ts` with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  - [ ] 1.2 Add `getLastEventId(pair_id)` and `setLastEventId(pair_id, event_id)` methods to `StateDb`
  - [ ] 1.3 Unit tests: verify column survives upgrade from a DB without it; verify get/set round-trip

- [ ] **Task 2 — VolumeEventManager wiring** (AC: 2, 3, 4, 5)
  - [ ] 2.1 In `engine/src/sdk.ts`, expose a `getVolumeEventManager(volumeId)` method that returns a `VolumeEventManager` instance
  - [ ] 2.2 Expose `getVolumeId()` so the engine can pass the correct volume ID
  - [ ] 2.3 Unit tests for the wrapper (mock `VolumeEventManager`)

- [ ] **Task 3 — Incremental reconcile path in sync-engine** (AC: 2–7)
  - [ ] 3.1 In `reconcilePair`: check `stateDb.getLastEventId(pair_id)`
  - [ ] 3.2 If null → run existing full walk → call `getLatestEventId()` → persist; no behaviour change for first run
  - [ ] 3.3 If present → call `getEvents(savedId)` → iterate events:
    - `NodeCreated` / `NodeUpdated` → enqueue download or conflict check for the affected node
    - `NodeDeleted` → enqueue remote-delete propagation
    - `TreeRefresh` → clear `last_event_id`, break loop, fall back to full walk for this pair only
    - `FastForward` → update `last_event_id` to the value carried by the event, skip remaining reconciliation for this pair
    - **Exception thrown by `getEvents()` (NetworkError, AuthExpiredError, etc.):** catch and re-throw via the engine's existing error propagation chain (matching the full-walk error handling pattern); do NOT update `last_event_id` — next startup retries from the same saved checkpoint (safe because all queue operations are idempotent)
    - **Generator ends without yielding any event** (edge case — SDK contract expects `FastForward` in the no-change case, but defensive handling required): do not update `last_event_id`; treat as no-op; next startup re-fetches from same checkpoint
  - [ ] 3.4 After a successful incremental pass (all events consumed, no exception), update `last_event_id` to the ID of the final event yielded by the generator
  - [ ] 3.5 Unit tests: each event type produces the correct queue entries; `TreeRefresh` triggers full walk; `FastForward` skips reconciliation
  - [ ] 3.6 Unit test — per-pair isolation: two pairs A and B both have saved `last_event_id`; pair A receives `TreeRefresh` → verify pair A's `last_event_id` is cleared (full walk triggered for A) and pair B's `last_event_id` is unchanged (AC: 7)
  - [ ] 3.7 Unit test — error propagation: `getEvents()` throws a `NetworkError` mid-iteration → verify `last_event_id` is NOT updated and the error is re-thrown as `NetworkError`

- [ ] **Task 4 — Validate** (AC: 1–8)
  - [ ] 4.1 Run full test suite: `bun test` (engine) + `pytest ui/tests/`
  - [ ] 4.2 Manual smoke: fresh install (first run does full walk, saves event ID); restart (incremental path fires, no tree-walk API calls in log); modify a remote file from ProtonDrive Web → restart → change is picked up via delta
  - [ ] 4.3 Observational smoke (not a CI gate — requires real account with many remote nodes): on a second launch, confirm the engine debug log shows markedly fewer `GET .../children` API calls than the first launch, confirming the incremental path fires; 429 rate-limit errors should be absent or rare on subsequent startups
  - [ ] 4.4 Set story status to `review`

## Dev Notes

- `VolumeEventManager` is in `engine/node_modules/@protontech/drive-sdk/dist/internal/events/volumeEventManager.js` — it is an internal module not re-exported from the SDK's public `index.js`. Verify with Proton SDK team before release that this is safe to use directly.
- The `DriveClient` wrapper in `sdk.ts` already accesses SDK internals (e.g. `iterateFolderChildren`); accessing `VolumeEventManager` follows the same pattern.
- Volume ID is available via `getOwnVolumeId()` on the SDK client — already called during `getRootIDs` in `sdk.ts`.
- `getEvents` is an async generator — use `for await` and handle the `TreeRefresh`/`FastForward` sentinel types before processing normal node events.

---

## Party-Mode Validation Record

**Session:** 2026-04-23 — agents: Winston (Architect), Amelia (Dev), Quinn (QA), Bob (SM)

All findings resolved autonomously per party-mode directive. Rationale documented inline.

- [x] **F1 [CRITICAL] — "Confirm with Proton SDK team" prerequisite buried in Context prose, not a task.**
  If `VolumeEventManager` is internal-only or unstable, the entire story's approach is invalid before a single line of code is written. A dev agent could implement all 4 tasks, then discover the SDK team blocked usage, wasting a full sprint. **Resolution:** Added Task 0 as an explicit prerequisite gate with a `⛔ do not start Task 1 until resolved` warning. Task 0 includes branch logic: confirmed-stable → proceed; confirmed-unstable → escalate and mark story `blocked`. Documentation of the confirmation channel required in Dev Agent Record.

- [x] **F2 [CRITICAL] — No error handling specified for `getEvents()` mid-iteration failures.**
  Task 3.3 listed `TreeRefresh` and `FastForward` as expected sentinel events but said nothing about the `getEvents()` generator *throwing* (NetworkError, AuthExpiredError, SDK error). Task 3.4 implied safe behavior ("after successful incremental pass") without making it explicit. No unit test existed for this path. **Resolution:** Added two bullets to Task 3.3 covering exception propagation (catch, re-throw via existing error chain, do NOT update `last_event_id`) and the empty-generator edge case (no-op, safe retry on next startup). Added Task 3.7 unit test to explicitly verify `last_event_id` is not mutated on `NetworkError`. Rationale for safe-retry: all queue operations are idempotent — re-processing events from an old checkpoint produces no data corruption.

- [x] **F3 [ENHANCEMENT] — Task 3.5 missing multi-pair isolation test (AC 7).**
  AC 7 claims "a TreeRefresh on one pair does not affect others" but no test covered this. **Resolution:** Added Task 3.6 unit test: two pairs A and B with saved `last_event_id`; `TreeRefresh` on A clears only A's checkpoint; B's checkpoint unchanged. Tagged `(AC: 7)` for traceability.

- [x] **F4 [ENHANCEMENT] — Task 4.3 formatted as a required CI gate but is unverifiable in standard CI.**
  "Verify 429 rate-limit errors reduced" requires a real Proton account with pre-2024 nodes and manual log inspection. It cannot be automated or enforced in unit tests or the smoke protocol. Leaving it as a checkbox implied it was a required pass/fail gate, which it is not. **Resolution:** Reworded as an observational smoke note with explicit "not a CI gate" qualifier, specifying the concrete observable (fewer `GET .../children` calls in the debug log on second launch vs. first).

- [x] **F5 [ENHANCEMENT] — Empty-generator edge case unaddressed in Task 3.3.**
  If `getEvents()` ends without yielding any event (edge case — SDK contract expects `FastForward` in the no-change scenario, but defensive code should not assume this), Task 3.4's "final event ID yielded" logic would have nothing to apply, silently leaving `last_event_id` unchanged. This is safe (idempotent retry) but was unspecified. **Resolution:** Added explicit bullet to Task 3.3 for the empty-generator case: treat as no-op, do not update `last_event_id`, next startup retries from same checkpoint. This makes the defensive behavior intentional rather than accidental.
