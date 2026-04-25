# Story 8-2a: Reconcile Progress — Clean State on Error

Status: done

## Story

As a user,
I want the sync progress indicator to always reach a resting state even when a sync error occurs,
so that I never see a permanently spinning indicator after a failure.

## Acceptance Criteria

1. **`error` event → paused indicator** — When `{ type: "error", payload: { pair_id, code } }` arrives for a pair, the phase indicator for that `pair_id` transitions to `"paused"` state (visually: amber dot + "Sync paused" text; distinct from active teal and idle green). The existing error banner in `PairDetailPanel` still shows. Watchdog is armed (or continues from prior active phase).

2. **Active phase after error** — When the engine retries and emits `reconcile_progress { phase: "scanning"|"uploading"|"downloading" }` for a pair in paused state, the indicator transitions back to active (teal + "Syncing…"). Watchdog resets to 30s.

3. **`idle` clears from paused** — When `reconcile_progress { phase: "idle" }` arrives for a pair whose indicator was paused by an error, the indicator is fully cleared (row → error/conflict/synced via existing state machine). `idle` is the only true clean-finish terminal state.

4. **`token_expired` → all pairs paused** — When `token_expired` fires, every pair currently in `"active"` or `"paused"` phase transitions to `"paused_token"` (amber dot + "Sync paused"). No watchdog is armed for `paused_token` pairs. The existing re-auth modal (Story 5-2) takes over.

5. **Active phase after `token_expired`** — When the engine restarts after re-auth and emits `reconcile_progress { phase: "scanning" }`, the normal active-phase handler transitions `paused_token` → `active` (teal). No special `session_ready` handling required.

6. **Watchdog (30s)** — When a pair is in `"active"` or `"paused"` phase and no `reconcile_progress` event arrives for 30 seconds, the indicator is fully cleared silently (row → appropriate resting state, no error/paused shown). Watchdog does NOT apply to `paused_token` pairs.

7. **Watchdog reset** — Any `reconcile_progress` event (any phase) for a pair resets the 30s watchdog timer for that pair.

8. **No-op on `idle` when already cleared** — If `reconcile_progress { phase: "idle" }` arrives for a pair with no active phase state, it is a no-op.

9. **No regression** — All 672 existing UI tests continue to pass. Engine tests untouched (no engine changes in this story).

10. **New tests** — A new `ui/tests/test_reconcile_progress.py` covers all state transitions from AC 1–8.

## Tasks / Subtasks

- [x] **Task 1 — Add "paused" state to `SyncPairRow`** (AC: 1, 4)
  - [x] 1.1 In `ui/src/protondrive/widgets/sync_pair_row.py`, add `"paused"` branch to `set_state()`:
    - Text: `self.status_label.set_text("Sync paused")`
    - CSS: `self.status_dot.add_css_class("sync-dot-paused")`, remove `sync-dot-syncing`, `sync-dot-offline`, `sync-dot-conflict`
    - Call `self.status_dot.queue_draw()` and `self._set_accessible_label("paused")`
    - Insert the `"paused"` branch just before the `else` fallback (i.e., after `"folder_missing"`)
    - **No entry needed in `ui/data/style.css`** — the amber colour is applied by `_draw_dot()` via Cairo (Task 1.2). `sync-dot-syncing` has a CSS pulse animation but `sync-dot-paused` intentionally has none — a static amber dot needs no CSS rule. The class is semantic only.
    - **`sync-dot-paused` is never removed by other branches** — this is intentional. Since no CSS rule exists for the class, any lingering class on state transitions is visually harmless. Do not add `remove_css_class("sync-dot-paused")` to other branches.
  - [x] 1.2 In `_draw_dot()`, add `"paused"` colour branch **before** the `else` fallback:
    ```python
    elif self._state == "paused":
        cr.set_source_rgb(0.87, 0.52, 0.04)  # dark amber — distinct from conflict (0.95, 0.62, 0.14)
    ```
  - [x] 1.3 No changes to Blueprint `.blp` file needed — `set_state()` drives all visual changes.

- [x] **Task 2 — Add phase state machine to `MainWindow`** (AC: 1–8)
  - [x] 2.1 In `window.py` `MainWindow.__init__()`, add two new instance attributes after the existing error-state block:
    ```python
    # Phase state machine (Story 8-2a).
    # _pair_phase: pair_id → "active" | "paused" | "paused_token" (absent = cleared)
    # _phase_watchdog_timers: pair_id → GLib timer ID (30s silence watchdog)
    self._pair_phase: dict[str, str] = {}
    self._phase_watchdog_timers: dict[str, int] = {}
    ```
  - [x] 2.2 In `clear_session()`, add cleanup for phase state (after the existing error state clears):
    ```python
    self._cancel_all_watchdogs()
    self._pair_phase = {}
    self._phase_watchdog_timers = {}
    ```
  - [x] 2.3 In `on_pair_removed(pair_id)`, add cleanup:
    ```python
    self._cancel_watchdog(pair_id)
    self._pair_phase.pop(pair_id, None)
    ```
  - [x] 2.4 Add three private helper methods (place after `_update_footer_error_state`):
    ```python
    def _reset_watchdog(self, pair_id: str) -> None:
        self._cancel_watchdog(pair_id)
        self._phase_watchdog_timers[pair_id] = GLib.timeout_add_seconds(
            30, lambda pid=pair_id: self._on_watchdog_fired(pid) or GLib.SOURCE_REMOVE
        )

    def _cancel_watchdog(self, pair_id: str) -> None:
        timer_id = self._phase_watchdog_timers.pop(pair_id, None)
        if timer_id is not None:
            GLib.source_remove(timer_id)

    def _cancel_all_watchdogs(self) -> None:
        for timer_id in self._phase_watchdog_timers.values():
            GLib.source_remove(timer_id)
        self._phase_watchdog_timers = {}

    def _on_watchdog_fired(self, pair_id: str) -> bool:
        self._phase_watchdog_timers.pop(pair_id, None)
        if pair_id not in self._pair_phase:
            return GLib.SOURCE_REMOVE
        del self._pair_phase[pair_id]
        self._apply_resting_state(pair_id)
        return GLib.SOURCE_REMOVE
    ```
  - [x] 2.5 Add private resting-state helper (places pair row into its non-active resting state):
    ```python
    def _apply_resting_state(self, pair_id: str) -> None:
        """Set pair row to its non-phase resting state (error/conflict/synced)."""
        row = self._sync_pair_rows.get(pair_id)
        if row is None or row.state == "offline":
            return
        if pair_id in self._folder_missing_pair_ids:
            return  # folder-missing is authoritative; only update_path/remove_pair clears it
        if pair_id in self._error_pair_ids:
            row.set_state("error")
            return
        pair_conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        if pair_conflict_count > 0:
            row.set_state("conflict", conflict_count=pair_conflict_count)
        else:
            row.set_state("synced")
    ```

- [x] **Task 3 — Add `on_reconcile_progress()` to `MainWindow`** (AC: 1–8)
  - [x] 3.1 Add the method after `on_pair_reconciling()`:
    ```python
    def on_reconcile_progress(self, payload: dict[str, Any]) -> None:
        """Handle reconcile_progress push event — drive per-pair phase state machine."""
        pair_id = payload.get("pair_id", "")
        phase = payload.get("phase", "")
        if not pair_id or not phase:
            return

        if phase in ("scanning", "uploading", "downloading"):
            self._pair_phase[pair_id] = "active"
            self._reset_watchdog(pair_id)
            row = self._sync_pair_rows.get(pair_id)
            if row is not None and pair_id not in self._folder_missing_pair_ids:
                row.set_state("syncing")

        elif phase == "idle":
            if pair_id not in self._pair_phase:
                return  # already cleared — AC 8 no-op
            self._cancel_watchdog(pair_id)
            del self._pair_phase[pair_id]
            # on_sync_complete fires before idle (per 8-2 emission order),
            # so row state is already correct. _apply_resting_state is a
            # defensive fallback for the rare case they arrive out of order.
            row = self._sync_pair_rows.get(pair_id)
            if row is not None and row.state in ("syncing", "paused"):
                self._apply_resting_state(pair_id)
    ```

- [x] **Task 4 — Integrate with `on_pair_error()` and token_expired** (AC: 1, 4)
  - [x] 4.1 Replace the entire function body of `on_pair_error()` after the `if row is None: return` guard with:
      ```python
      # Phase indicator: active → paused (watchdog continues from active; now includes error-paused).
      if pair_id in self._pair_phase:
          self._pair_phase[pair_id] = "paused"
          row.set_state("paused")
      else:
          row.set_state("error")
      self._error_pair_ids.add(pair_id)
      self._error_pending_cycle.add(pair_id)
      self._error_messages[pair_id] = message
      self.pair_detail_panel.set_error_state(pair_id, True, message)
      self._update_footer_error_state()
      ```
    - The existing lines (`row.set_state("error")`, `_error_pair_ids.add`, `_error_pending_cycle.add`, `_error_messages`, `set_error_state`, `_update_footer_error_state`) are all replaced by the block above — do not keep or duplicate the old lines.
  - [x] 4.2 Add `on_token_expired_phase_pause()` to `MainWindow`:
    ```python
    def on_token_expired_phase_pause(self) -> None:
        """Pause all active/paused phase indicators when the session token expires."""
        for pair_id, phase in list(self._pair_phase.items()):
            if phase in ("active", "paused"):
                self._pair_phase[pair_id] = "paused_token"
                self._cancel_watchdog(pair_id)  # no watchdog for token_expired-paused
                row = self._sync_pair_rows.get(pair_id)
                if row is not None and pair_id not in self._folder_missing_pair_ids:
                    row.set_state("paused")
    ```

- [x] **Task 5 — Wire event registration in `main.py`** (AC: 1, 4)
  - [x] 5.1 In `Application.__init__()`, add after the `pair_reconciling` line (line ~101):
    ```python
    self._engine.on_event("reconcile_progress", self._on_reconcile_progress)
    ```
  - [x] 5.2 Add the handler method near `_on_pair_reconciling`:
    ```python
    def _on_reconcile_progress(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        if self._window is not None:
            self._window.on_reconcile_progress(payload)
    ```
  - [x] 5.3 In `_on_token_expired()`, add the phase pause call BEFORE the existing banner/dialog code:
    - Find the `if self._window is not None:` block in `_on_token_expired`
    - Add as the FIRST call inside that block:
      ```python
      self._window.on_token_expired_phase_pause()
      ```
    - (Existing calls: `show_token_expired_warning` and `show_reauth_dialog` remain unchanged and come after)

- [x] **Task 6 — Unit tests in `ui/tests/test_reconcile_progress.py`** (AC: 10)

  Create a new test file. Use the same `object.__new__` bypass pattern as other UI tests. The window fixture needs `_pair_phase`, `_phase_watchdog_timers`, `_sync_pair_rows`, `_pairs_data`, `_error_pair_ids`, `_error_pending_cycle`, `_error_messages`, `_conflict_copies_by_pair`, `_folder_missing_pair_ids`, and mocked `pair_detail_panel` and `status_footer_bar`. GLib calls are mocked via `patch("protondrive.window.GLib")`.

  - [x] 6.1 **Test: `error` event → row "paused", phase = "paused", watchdog armed** (AC: 1)
  - [x] 6.2 **Test: `error` with no prior phase → row "error" (existing behavior preserved)** (AC: 1)
  - [x] 6.3 **Test: `reconcile_progress { phase: active }` after error → paused resumes active** (AC: 2)
  - [x] 6.4 **Test: `reconcile_progress { phase: "idle" }` after error → fully cleared** (AC: 3)
  - [x] 6.5 **Test: `token_expired` → all active/paused pairs enter paused_token; no watchdog** (AC: 4)
  - [x] 6.6 **Test: `reconcile_progress { phase: "scanning" }` after token_expired → active** (AC: 5)
  - [x] 6.7 **Test: watchdog fires → indicator cleared, no paused/error shown** (AC: 6)
  - [x] 6.8 **Test: `reconcile_progress` resets watchdog** (AC: 7)
  - [x] 6.9 **Test: `idle` when already cleared → no-op** (AC: 8)

- [x] **Task 7 — Validate** (AC: 9, 10)
  - [x] 7.1 `distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"` — compile Blueprint/GSettings (no changes expected, but run to verify)
  - [x] 7.2 `.venv/bin/pytest ui/tests/` — ≥ 681 tests pass (672 baseline + 9 new), 0 fail
  - [x] 7.3 Set story status to `review`

## Dev Notes

### Phase State Machine Overview

Per-pair phase state lives in `MainWindow._pair_phase: dict[str, str]`. Three states:
- `"active"` — engine currently scanning/uploading/downloading for this pair
- `"paused"` — engine hit an error; sync is blocked but engine will retry
- `"paused_token"` — session expired; ALL pairs paused; re-auth is the resume mechanism

Absent from `_pair_phase` = cleared (pair at rest). This is the dominant state — most of the time, pairs have no entry here.

### `on_pair_error()` Behavior Change

Before 8-2a: `error` event → row always set to `"error"` (red dot).

After 8-2a:
- If pair WAS in active phase → row set to `"paused"` (amber dot + "Sync paused")
- If pair was NOT in active phase → row set to `"error"` (red dot, existing behavior)

The error banner in `PairDetailPanel` shows the error message in BOTH cases. The difference is:
- `"paused"` means "engine is still trying; we expect reconcile_progress events to arrive when it succeeds"
- `"error"` (no prior active phase) means the error arrived out of sequence; treat as persistent error

### `idle` And `sync_complete` Ordering

From Story 8-2 dev notes: `reconcile_progress { phase: "idle" }` is emitted AFTER `sync_complete` in both emit sites. This means when `on_reconcile_progress(idle)` runs, `on_sync_complete` has already run and set the row to its resting state (synced/error/conflict). The defensive `_apply_resting_state` call in `on_reconcile_progress(idle)` only fires if the row is still in "syncing" or "paused" — a safety net for edge cases.

### Watchdog: `GLib.timeout_add_seconds` vs `GLib.timeout_add`

Use `GLib.timeout_add_seconds(30, callback)` — not `GLib.timeout_add(30000, ...)`. The seconds variant is more efficient for long delays (GLib can coalesce wakeups). Callback must return `GLib.SOURCE_REMOVE` (falsy) to fire once.

**Closure gotcha:** Use the default-argument capture form to avoid late-binding. This matches the code in `_reset_watchdog`:
```python
self._phase_watchdog_timers[pair_id] = GLib.timeout_add_seconds(
    30, lambda pid=pair_id: self._on_watchdog_fired(pid) or GLib.SOURCE_REMOVE
)
```
In `_reset_watchdog(self, pair_id)`, `pair_id` is a method argument so each call creates a fresh scope — both forms work. The default-arg form is used consistently to make the capture intent explicit.

### Watchdog Does NOT Apply to `paused_token`

When `token_expired` fires, `on_token_expired_phase_pause()` cancels existing watchdog timers and marks pairs as `"paused_token"`. No new watchdog is started. Re-auth auto-relaunches sync and emits fresh `reconcile_progress { phase: "scanning" }` events — those events re-arm the watchdog via the normal active-phase path.

### `_apply_resting_state()` Priority Order

Matches the existing state machine in `on_sync_complete` and `on_online`:
1. `offline` → skip (offline takes precedence, network handles clearing)
2. `folder_missing` → skip (only clearable via update_path or remove_pair)
3. `error_pair_ids` → `"error"` state
4. conflicts → `"conflict"` state
5. default → `"synced"` state

### Interaction with Existing `_error_pair_ids` Cycle Logic

`on_pair_error()` still adds to `_error_pair_ids` and `_error_pending_cycle` regardless of phase state. The existing cycle-based error clearing in `on_sync_complete` (clears error after clean cycle) remains unchanged. The phase state machine is orthogonal — it manages the transient active/paused indicator, not the persistent error state.

Result: After a clean retry cycle, both `sync_complete` AND `reconcile_progress { phase: "idle" }` fire. `sync_complete` clears `_error_pair_ids` (if clean cycle) and sets row to "synced". `idle` clears `_pair_phase`. Both are correct and independent.

### Interaction with `on_pair_reconciling()`

`on_pair_reconciling()` is a pre-8-2 event handler that sets the row to `"syncing"` but does NOT update `_pair_phase` or arm the watchdog. It fires before `reconcile_progress { phase: "scanning" }` which then arms the phase machine normally.

If `pair_reconciling` fires but `reconcile_progress { phase: "scanning" }` never follows (an engine-side edge case), the row stays `"syncing"` with no watchdog — same behavior as before this story existed. This is a known pre-existing limitation, not something 8-2a introduces or is responsible for fixing. **Do not modify `on_pair_reconciling()` in this story.**

### Test Pattern

Use `object.__new__` to bypass GTK init (same as `test_sync_pair_row.py`, `test_main.py`, etc.). Mock GLib timer calls via conftest (already mocked as `MagicMock`). Mock `pair_detail_panel` and `status_footer_bar` as MagicMocks. Mock each row's `set_state` and `state` property.

Minimal window fixture:
```python
from unittest.mock import MagicMock, patch
from protondrive.window import MainWindow

def _make_window_with_pair(pair_id: str = "p1") -> tuple[MainWindow, MagicMock]:
    win = object.__new__(MainWindow)
    row = MagicMock()
    row.state = "syncing"
    row.pair_id = pair_id
    row.pair_name = "Docs"
    win._sync_pair_rows = {pair_id: row}
    win._pairs_data = {pair_id: {}}
    win._pair_phase = {}
    win._phase_watchdog_timers = {}
    win._error_pair_ids = set()
    win._error_pending_cycle = set()
    win._error_messages = {}
    win._conflict_copies_by_pair = {}
    win._folder_missing_pair_ids = set()
    win.pair_detail_panel = MagicMock()
    win.status_footer_bar = MagicMock()
    return win, row
```

Note: GLib functions (`timeout_add_seconds`, `source_remove`) are already mocked via conftest.py. Tests should capture the return value of `GLib.timeout_add_seconds.return_value` if needed to verify cancellation.

### Files to Touch

| File | Change |
|---|---|
| `ui/src/protondrive/widgets/sync_pair_row.py` | Add `"paused"` branch in `set_state()` and `_draw_dot()` |
| `ui/src/protondrive/window.py` | Phase state fields, `on_reconcile_progress()`, `on_token_expired_phase_pause()`, watchdog helpers, `_apply_resting_state()`, modified `on_pair_error()`, cleanup in `clear_session()`/`on_pair_removed()` |
| `ui/src/protondrive/main.py` | Register `reconcile_progress` event, add `_on_reconcile_progress()` handler, call `on_token_expired_phase_pause()` in `_on_token_expired()` |
| `ui/tests/test_reconcile_progress.py` | New test file — 9 test cases |

No changes to: engine files, Blueprint `.blp` files, GSettings schemas, GResource files, `state-db.ts`, `sdk.ts`, `sync-engine.ts`, `ipc.ts`.

### Anti-Patterns to Avoid

- **Never call `GLib.timeout_add()` for the watchdog** — use `GLib.timeout_add_seconds(30, ...)` for 30s delays (more efficient).
- **Never cancel a non-existent timer** — always use `self._phase_watchdog_timers.pop(pair_id, None)` before calling `GLib.source_remove()`.
- **Never import `@protontech/drive-sdk`** — this is a UI-only story; no engine changes.
- **Never change `on_sync_complete()` or the `_error_pair_ids` cycle logic** — the phase state machine is orthogonal. Only `on_pair_error()` needs a conditional change.
- **Never skip the folder_missing guard** — `_apply_resting_state()` must check `_folder_missing_pair_ids` before setting row to error/conflict/synced.
- **Never set watchdog for `paused_token` pairs** — `on_token_expired_phase_pause()` explicitly cancels existing timers and does NOT start new ones.
- **Never emit `"paused"` for pairs not in `_sync_pair_rows`** — always guard with `row = self._sync_pair_rows.get(pair_id)` and `if row is None: return`.

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-8-sdk-compliance-incremental-sync.md#Story 8-2a] — authoritative AC and background
- [Source: _bmad-output/implementation-artifacts/8-2-ipc-activity-events.md#Review Findings] — deferred items: `reconcilePair` exceptions after `scanning` leave pair stuck in `scanning`; error event is the terminal signal; Story 8-2a (this story) resolves those deferred items
- [Source: _bmad-output/implementation-artifacts/8-2-ipc-activity-events.md#Dev Notes §Emit Order in Download Loop] — confirms `sync_complete` fires before `reconcile_progress { phase: "idle" }` in both emit sites
- [Source: engine/src/sync-engine.ts:~836–853] — `reconcilePair` idle: emitted after `sync_complete` (`emitEvent sync_complete` → then `emitEvent reconcile_progress idle`)
- [Source: engine/src/sync-engine.ts:~1004–1026] — `drainQueue` idle: emitted after `sync_complete` in `pairsWithSuccess` loop
- [Source: ui/src/protondrive/widgets/sync_pair_row.py] — existing states: pending, syncing, offline, conflict, error, folder_missing; add `"paused"` before the `else` fallback
- [Source: ui/src/protondrive/window.py:700–709] — `on_pair_error()` — modify to add phase-conditional row state
- [Source: ui/src/protondrive/window.py:780–805] — `on_sync_complete()` — resting state logic; replicated (not called) in `_apply_resting_state()`
- [Source: ui/src/protondrive/window.py:193–199] — `clear_session()` — add phase cleanup here
- [Source: ui/src/protondrive/main.py:89–104] — event registration block; add `reconcile_progress` after `pair_reconciling` (line 101)
- [Source: ui/src/protondrive/main.py:503–525] — `_on_token_expired()` — add `self._window.on_token_expired_phase_pause()` at start of the `if self._window is not None:` block
- [Source: ui/tests/test_sync_pair_row.py:15–30] — `object.__new__` bypass pattern for GTK widgets
- [Source: ui/tests/test_main.py:17–38] — `_make_app()` fixture pattern
- [Source: ui/tests/conftest.py] — GLib mocks (GLib.timeout_add_seconds, GLib.source_remove already mocked)
- [Source: _bmad-output/project-context.md §Testing Rules] — two-step local workflow: meson compile → pytest; never meson test locally

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- GLib mock cross-test contamination: Python 3.14 MagicMock sets `_mock_children[name] = _deleted` when a child mock attribute is deleted by a prior test. Fixed by using `patch("protondrive.window.GLib")` per test rather than accessing the shared conftest mock.

### Completion Notes List

- Task 1: Added `"paused"` branch in `SyncPairRow.set_state()` (after `folder_missing`, before `else`) with amber dot (`0.87, 0.52, 0.04`), `sync-dot-paused` CSS class (semantic only, no animation), and accessible label.
- Task 2: Added `_pair_phase` + `_phase_watchdog_timers` dicts to `MainWindow.__init__()`; cleanup in `clear_session()` and `on_pair_removed()`; watchdog helpers `_reset_watchdog`, `_cancel_watchdog`, `_cancel_all_watchdogs`, `_on_watchdog_fired`; `_apply_resting_state()` helper.
- Task 3: Added `on_reconcile_progress()` to `MainWindow` implementing the full phase state machine for scanning/uploading/downloading (active) and idle (cleared) transitions.
- Task 4: Modified `on_pair_error()` to conditionally set row to `"paused"` (if pair had active phase) vs `"error"` (no prior phase). Added `on_token_expired_phase_pause()` that transitions all active/paused pairs to `paused_token` and cancels their watchdogs.
- Task 5: Wired `reconcile_progress` event in `main.py` `do_startup()`, added `_on_reconcile_progress()` handler, added `on_token_expired_phase_pause()` call at start of `_on_token_expired()`.
- Task 6: Created `ui/tests/test_reconcile_progress.py` with 9 tests covering all ACs. Uses `patch("protondrive.window.GLib")` fixture to avoid shared mock contamination.
- Task 7: Meson compile clean; 681 tests pass (672 baseline + 9 new), 0 failures.

### File List

- `ui/src/protondrive/widgets/sync_pair_row.py`
- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/tests/test_reconcile_progress.py` (new)

### Review Findings

- [x] [Review][Patch] `_on_watchdog_fired` missing `paused_token` guard — AC6 states "Watchdog does NOT apply to `paused_token` pairs"; if a watchdog fires for a `paused_token` pair (logic error elsewhere), the handler unconditionally deletes the phase and calls `_apply_resting_state`, silently clearing the pair to resting state instead of leaving it paused for re-auth. Fix: add `if self._pair_phase.get(pair_id) == "paused_token": return GLib.SOURCE_REMOVE` after the `not in _pair_phase` guard. [`ui/src/protondrive/window.py:_on_watchdog_fired`]
