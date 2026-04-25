# Sprint Change Proposal — 2026-04-25 (Phase State Machine)

**Scope:** Minor
**Status:** Pending Approval

---

## Section 1: Issue Summary

During the Story 8-2 code review, two error paths were identified where the `reconcile_progress` phase lifecycle never reaches a terminal state:

- **W4**: `reconcilePair` throws a non-auth exception after emitting `scanning` → no `idle` follows. The engine emits `{ type: "error" }` and returns — but the UI, tracking `scanning` phase for that pair, never receives a terminal signal.
- **W5**: `diskFull` early return in `reconcilePair`'s download loop → pair is left in `downloading` with no `idle`. The engine emits `{ code: "DISK_FULL" }` but skips the idle emission.

**Design decision made during review:** `idle` is intentionally only emitted on clean exits. The `error` event is the terminal signal for blocked pairs. Story 8-3 (Activity Feed UI) was expected to handle this — but Story 8-3's existing spinner AC only says *"disappears when phase transitions to `idle`."* That AC is unachievable on error paths as written. Without explicit error-terminal handling, the spinner will be permanently stuck after any `DISK_FULL` or `reconcilePair` exception.

**Discovery context:** Story 8-2 code review (2026-04-25). Deferred as W4/W5 in `deferred-work.md` with the note "Story 8-3 owns the UI state machine."

---

## Section 2: Impact Analysis

| Area | Impact |
|------|--------|
| **Epic 8** | Add Story 8-2a (sequenced before 8-3, which depends on this contract). |
| **Story 8-3** | Spinner AC must be updated: `idle` clears spinner AND `error` event clears spinner. |
| **PRD** | No impact — error recovery UX is consistent with existing Epic 5 patterns. |
| **Architecture / Engine** | No engine changes. This is purely UI-side state machine work. |
| **sprint-status.yaml** | Add `8-2a-reconcile-progress-state-machine: backlog` before `8-3`. |
| **deferred-work.md** | W4/W5 resolved by this story — remove or mark resolved when 8-2a is done. |

---

## Section 3: Recommended Approach

**Option 1 — Direct Adjustment (selected)**

Add Story 8-2a to Epic 8. Update Story 8-3's spinner AC. No rollback, no MVP change.

- Effort: **Low** (UI-only, ~50 lines of Python: error handler + watchdog timer + 3-4 tests)
- Risk: **Low** (no engine changes, no IPC protocol changes)
- Timeline: No impact on other stories. 8-2a can run in parallel with 8-5 or immediately before 8-3.

---

## Section 4: Detailed Change Proposals

### New Story 8-2a: Reconcile Progress — Clean State on Error

**Add to `epic-8-sdk-compliance-incremental-sync.md` after Story 8.2:**

```markdown
## Story 8-2a: Reconcile Progress — Clean State on Error

As a user,
I want the sync progress indicator to always reach a resting state even when a sync error occurs,
So that I never see a permanently spinning indicator after a failure.

**Background:** Story 8-2 implemented `reconcile_progress` phase events. On clean paths, `idle`
is the terminal phase — the only signal that truly clears the indicator. All other non-clean exits
leave the pair in a **paused** state: sync is halted but will resume when the blocking condition
is resolved. Two engine signals trigger the paused state:

- `{ type: "error", payload: { pair_id, code } }` — pair-scoped block (DISK_FULL, PERMISSION_DENIED,
  etc.). Indicator pauses until the user resolves the condition; the engine will retry and emit new
  phase events when sync resumes.
- `{ type: "token_expired" }` — session-wide auth expiry; ALL pair indicators pause. After re-auth
  the engine relaunches automatically and emits fresh `scanning` events that resume the indicators.
  No watchdog for this path — re-auth is the resume mechanism.

A watchdog (30s no update) acts as a safety net for paused pairs where the `error` signal may not
have been emitted (e.g. reconcilePair exception). The watchdog fully clears the indicator rather
than pausing it, since the root cause is unknown. It does NOT apply to `token_expired`-paused pairs.

**Acceptance Criteria:**

**Given** the engine emits `{ type: "error", payload: { pair_id, code } }` for a pair
**When** the UI receives it
**Then** the phase indicator for that `pair_id` transitions to a **paused** state (visually distinct
  from active and from idle — sync is blocked, not finished)
**And** the existing error state UI for that pair (error banner/row) explains why sync is paused
**And** when the engine resumes and emits `reconcile_progress { phase: "scanning"|"uploading"|"downloading" }`
  for that pair, the paused indicator transitions to active (watchdog resets)
**And** when the engine emits `reconcile_progress { phase: "idle" }` for that pair (clean cycle
  completed after retry), the indicator is fully cleared — `idle` exits pause the same as it exits
  active: it is the only true clean-finish terminal state

**Given** the engine emits `{ type: "token_expired" }`
**When** the UI receives it
**Then** the phase indicator for ALL active pairs transitions to a **paused** state (visually distinct
  from both active and idle — sync is halted, not finished)
**And** the re-auth modal (existing, Story 5-2) takes over
**And** when the engine restarts after re-auth it emits `reconcile_progress { phase: "scanning" }`
  which the normal event handler uses to transition paused → active — no special `session_ready`
  handling required in this story

**Given** a pair is in an active or paused phase (but NOT paused by `token_expired`)
**When** no `reconcile_progress` event for that pair has been received for 30 seconds
**Then** the UI fully clears the phase indicator (watchdog — safety net when cause is unknown)
**And** no error or paused state is shown (the watchdog clears silently)
**Note:** The watchdog is NOT armed for pairs paused by `token_expired` — re-auth auto-relaunches
sync and emits fresh phase events when the session resumes.

**Given** the UI later receives `{ type: "reconcile_progress", phase: "idle" }` for a pair whose
indicator was already cleared by an error event, token_expired, or the watchdog
**When** the UI processes the event
**Then** it is a no-op — the pair is already at rest, no visual change occurs

**Given** the UI test suite
**When** this story is complete
**Then** new tests cover:
  - `error` event for pair_id → indicator transitions to paused; watchdog armed
  - `reconcile_progress { phase: active }` after `error` → paused indicator resumes active (engine retried)
  - `reconcile_progress { phase: "idle" }` after `error` → indicator fully cleared (clean cycle completed)
  - `token_expired` → all pair indicators enter paused state; no watchdog set
  - `reconcile_progress { phase: "scanning" }` after `token_expired` → paused indicator transitions
    back to active (no special session_ready handler — the normal event flow covers it)
  - Watchdog fires after 30s without update → indicator fully cleared (not paused)
  - `reconcile_progress` event received → watchdog timer reset for that pair
  - `idle` → indicator cleared (the only true clean-finish terminal state)
```

---

### Story 8-3 Spinner AC Update

**Change to `epic-8-sdk-compliance-incremental-sync.md` Story 8.3:**

```
SECTION: Acceptance Criteria — spinner behavior

OLD:
Given a `reconcile_progress` event arrives with `phase: "scanning" | "uploading" | "downloading"`
When the engine is actively working
Then a spinner or subtle progress indicator appears at the top of the feed
And it disappears when `phase` transitions to `"idle"`

NEW:
Given a `reconcile_progress` event arrives with `phase: "scanning" | "uploading" | "downloading"`
When the engine is actively working
Then a spinner or subtle progress indicator appears at the top of the feed
And it disappears when any of the following occur:
  - `phase` transitions to `"idle"` for that pair
  - An `error` event is received for that pair (handled by Story 8-2a)
  - The watchdog timer fires (30s without update, handled by Story 8-2a)
```

Rationale: Story 8-3 implements the spinner display; Story 8-2a defines the clearing rules. 8-3 must reference the contract without re-implementing it.

---

## Section 5: Implementation Handoff

**Scope: Minor** — routed directly to dev team.

| Step | Who | Action |
|------|-----|--------|
| 1 | SM (Bob) | Add Story 8-2a to epic-8.md; update Sprint 8-3 spinner AC; update sprint-status.yaml |
| 2 | Dev (Amelia) | Implement 8-2a (UI-only: error handler + watchdog timer + tests) before or alongside 8-3 |
| 3 | Jeremy | Verify spinner clears correctly after triggering a DISK_FULL condition in dev |

**Success criteria:**
- After a `DISK_FULL` error, the affected pair's indicator shows paused state within 1 second
- After re-triggering the error condition is resolved and engine retries, the paused indicator resumes active
- After `token_expired`, all pair indicators show paused; re-auth modal takes over
- After re-auth the engine emits `scanning` → normal event handler transitions paused → active
- Watchdog: a pair with no update for 30s (and not paused by token_expired) is fully cleared
- W4/W5 in `deferred-work.md` closed when story is done
