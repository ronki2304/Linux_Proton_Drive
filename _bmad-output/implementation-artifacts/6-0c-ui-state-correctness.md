# Story 6.0c: UI State Correctness

Status: done

## Story

As a developer,
I want two latent UI state bugs fixed before Epic 6 feature work begins,
so that the error-state machine clears in one cycle after offline/replay boundaries and the session-expired banner conveys urgency by showing the queued-change count.

## Acceptance Criteria

### AC1 — `_error_pending_cycle` cleared on `on_offline()` and `on_queue_replay_complete()`

**Given** an error event has been received for a pair (adding it to `_error_pending_cycle` and `_error_pair_ids`) and the device then goes offline
**When** `on_offline()` is called
**Then** `_error_pending_cycle` is cleared (`.clear()`)
**And** `_error_pair_ids` is NOT modified (error visual state preserved)
**And** a subsequent single clean `on_sync_complete` for that pair clears the error from `_error_pair_ids`

**Given** an error event has been received for a pair and a queue replay completes cleanly (no new error for that pair in the replay)
**When** `on_queue_replay_complete()` is called
**Then** `_error_pending_cycle` is cleared (`.clear()`)
**And** `_error_pair_ids` is NOT modified
**And** a subsequent single clean `on_sync_complete` for that pair clears the error

### AC2 — Banner title shows queued-change count when nonzero

**Given** `token_expired` is received with `queued_changes = N` where N > 0
**When** `show_token_expired_warning(N)` is called on `MainWindow`
**Then** `session_expired_banner.set_title(f"Session expired — N change(s) queued")` is called
**And** the singular form "1 change" is used when N = 1
**And** the plural form "N changes" is used when N > 1
**And** `session_expired_banner.set_revealed(True)` is called

**Given** `token_expired` is received with `queued_changes = 0`
**When** `show_token_expired_warning(0)` (or no arg) is called
**Then** `session_expired_banner.set_title("Session expired — sign in to resume sync")` is called (default text)

**Given** the call site in `Application._on_token_expired()`
**When** `show_token_expired_warning()` is called
**Then** the `queued_changes` integer extracted from the payload is passed as the argument

### AC3 — Tests cover both fixes; existing test assertions updated

**Given** AC1 changes
**When** story 6-0c ships
**Then** new tests in `ui/tests/test_window_routing.py` cover:
- `on_offline()` clears `_error_pending_cycle`
- `on_queue_replay_complete()` clears stale `_error_pending_cycle` flag
- After `on_offline()` clears the flag, one clean `on_sync_complete` removes the error
- After `on_queue_replay_complete()` clears the flag, one clean `on_sync_complete` removes the error

**And** new tests in `ui/tests/test_window_routing.py` cover:
- `show_token_expired_warning(3)` → title "Session expired — 3 changes queued"
- `show_token_expired_warning(1)` → title "Session expired — 1 change queued" (singular)
- `show_token_expired_warning(0)` → title "Session expired — sign in to resume sync"
- `show_token_expired_warning()` (no arg) → same default title

**And** two existing tests in `ui/tests/test_main.py` are updated:
- `TestTokenExpiredCallsWarning.test_calls_show_token_expired_warning`: `assert_called_once_with()` → `assert_called_once_with(3)` (payload has `queued_changes: 3`)
- `TestTokenExpiredCallsWarning.test_shows_banner_even_when_auth_browser_active`: `assert_called_once_with()` → `assert_called_once_with(1)` (payload has `queued_changes: 1`)

**And** `meson compile -C builddir` (for Blueprint/GSettings compilation) passes with zero errors
**And** `.venv/bin/pytest ui/tests/` passes with zero failures and zero regressions against prior 572 UI tests

### AC4 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit. **Commit directly to `main`** — do not create a feature branch.

---

## Tasks / Subtasks

- [x] **Task 1: Clear `_error_pending_cycle` in `on_offline()`** (AC: #1, #3)
  - [x] 1.1 Open `ui/src/protondrive/window.py`, locate `on_offline()` at ~line 438
  - [x] 1.2 Add `self._error_pending_cycle.clear()` as the first statement inside the method body, before the `for` loop:
    ```python
    def on_offline(self) -> None:
        """Shift all pair rows and footer bar to offline state."""
        self._error_pending_cycle.clear()  # offline ends any in-progress sync cycle
        for pair_id, row in self._sync_pair_rows.items():
            ...
    ```
  - [x] 1.3 `meson compile -C builddir` from project root (use distrobox invocation — see Dev Notes §1) — zero errors

- [x] **Task 2: Clear `_error_pending_cycle` in `on_queue_replay_complete()`** (AC: #1, #3)
  - [x] 2.1 Open `ui/src/protondrive/window.py`, locate `on_queue_replay_complete()` at ~line 467
  - [x] 2.2 The method ends with a comment about `sync_complete`. Add `self._error_pending_cycle.clear()` as the last statement before the method ends (after the `elif had_pending_before:` block). The method currently has no explicit return; just append at end:
    ```python
        # Green "All synced" for the fresh-replay case ... AC7 row 1 resolves there.
        self._error_pending_cycle.clear()  # replay is a complete sync cycle; stale flags clear
    ```
  - [x] 2.3 `meson compile -C builddir` — zero errors

- [x] **Task 3: Update `show_token_expired_warning()` to accept count and update title** (AC: #2, #3)
  - [x] 3.1 Open `ui/src/protondrive/window.py`, locate `show_token_expired_warning()` at ~line 308
  - [x] 3.2 Replace with:
    ```python
    def show_token_expired_warning(self, queued_changes: int = 0) -> None:
        """Show the session-expired banner with optional queued-change count."""
        if queued_changes > 0:
            noun = "change" if queued_changes == 1 else "changes"
            title = f"Session expired — {queued_changes} {noun} queued"
        else:
            title = "Session expired — sign in to resume sync"
        self.session_expired_banner.set_title(title)
        self.session_expired_banner.set_revealed(True)
    ```
  - [x] 3.3 `meson compile -C builddir` — zero errors

- [x] **Task 4: Update call site in `main.py` to pass `queued_changes`** (AC: #2, #3)
  - [x] 4.1 Open `ui/src/protondrive/main.py`, locate `_on_token_expired()` at ~line 426
  - [x] 4.2 Change line ~441 from:
    ```python
    self._window.show_token_expired_warning()
    ```
    to:
    ```python
    self._window.show_token_expired_warning(queued_changes)
    ```
    `queued_changes` is already extracted at line ~437: `queued_changes: int = payload.get("queued_changes", 0) if isinstance(payload, dict) else 0`
  - [x] 4.3 `meson compile -C builddir` — zero errors

- [x] **Task 5: Add tests to `test_window_routing.py`** (AC: #3)
  - [x] 5.1 Open `ui/tests/test_window_routing.py`, go to the end of the file (~line 882, after `TestErrorStatePersistence`)
  - [x] 5.2 Add new test class for AC1 error-pending-cycle clearance (see Dev Notes §5 for exact test code)
  - [x] 5.3 Add new test class for AC2 banner title (see Dev Notes §5 for exact test code)
  - [x] 5.4 `meson compile -C builddir` — zero errors

- [x] **Task 6: Update existing test assertions in `test_main.py`** (AC: #3)
  - [x] 6.1 Open `ui/tests/test_main.py`, locate `TestTokenExpiredCallsWarning` at ~line 286
  - [x] 6.2 In `test_calls_show_token_expired_warning` (~line 289): updated assertion to `assert_called_once_with(3)`
  - [x] 6.3 In `test_shows_banner_even_when_auth_browser_active` (~line 311): updated assertion to `assert_called_once_with(1)`
  - [x] 6.4 `meson compile -C builddir` — zero errors

- [x] **Task 7: Final validation** (AC: #3, #4)
  - [x] 7.1 `meson compile -C builddir` from project root — zero errors
  - [x] 7.2 `.venv/bin/pytest ui/tests/` — 590 passed, zero failures, zero regressions (572 baseline + 18 new)
  - [x] 7.3 Set story status to `review`

---

## Dev Notes

### §1 — Meson invocation from Claude Code sandbox

**NEVER call bare `meson`** — the `~/.local/bin/meson` wrapper hangs indefinitely due to a malformed heredoc artifact. Always use:
```sh
distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"
```
This is needed to compile Blueprint files (`.blp` → `.ui`). Run from the project root directory. For tests, use `.venv/bin/pytest ui/tests/` directly — no Meson needed.

### §2 — `_error_pending_cycle` semantics (window.py context)

The flag is in `ui/src/protondrive/window.py`. It's a `set[str]` initialized to `set()` at line 72. State machine:
- `on_pair_error(pair_id)` → adds to both `_error_pair_ids` AND `_error_pending_cycle`
- `on_sync_complete(pair_id)`:
  - If `pair_id in _error_pending_cycle` → discard from `_error_pending_cycle`, keep in `_error_pair_ids` (error persists one more cycle)
  - If `pair_id NOT in _error_pending_cycle` → discard from `_error_pair_ids` (error cleared, clean cycle confirmed)

**The bug:** When an error sets the flag, then offline→online happens (or queue_replay fires) without a `sync_complete`, the flag persists. The next `sync_complete` consumes the flag but keeps the error. Only the SECOND `sync_complete` clears it. Fix: both `on_offline()` and `on_queue_replay_complete()` represent a "cycle boundary" — clear the flag so the NEXT `sync_complete` can immediately clear the error.

**Why `on_offline()` is safe:** Going offline stops all sync. The pending-cycle flag is stale at that point — no sync cycle is completing. Clearing it doesn't lose information we need.

**Why `on_queue_replay_complete()` is safe:** By the time this handler runs, ALL `on_pair_error` calls for this replay have already been processed (IPC events are sequential). Any pair that errored in this replay was re-added to `_error_pending_cycle` by those calls. Clearing the set at `queue_replay_complete` leaves only: an empty set (no errors in replay) OR — if a pair errored in this replay, it was re-added before we cleared. Wait: the `.clear()` happens AFTER all the replay's error events, so pairs that errored during the replay were added, then cleared. This means the next `sync_complete` for those pairs won't see the flag and will attempt to clear the error after one clean cycle — which is the correct behavior (the error was in the replay, a subsequent clean sync means it's resolved). This is an acceptable behavior: the flag served its race-guard purpose (the replay events and cleanup events are sequentially processed), so clearing here is correct.

### §3 — `show_token_expired_warning()` in window.py

**File:** `ui/src/protondrive/window.py:308`
**Widget:** `session_expired_banner` is an `Adw.Banner` Template.Child (line 34). `Adw.Banner.set_title()` overrides the static Blueprint title at runtime.

**Blueprint title (fallback, in `ui/data/ui/window.blp:21`):**
```
title: _("Session expired — sign in to resume sync");
```
Do NOT modify the `.blp` file — the default is fine as a fallback; the Python method always calls `set_title()` before `set_revealed()`.

**Title formatting rules:**
- N = 0: `"Session expired — sign in to resume sync"` (default)
- N = 1: `"Session expired — 1 change queued"` (singular "change")
- N > 1: `"Session expired — N changes queued"` (plural "changes")

The em dash `—` must be a real em dash character, matching the static Blueprint string.

### §4 — Call site in `main.py`

**File:** `ui/src/protondrive/main.py:426–442` (`_on_token_expired`)

`queued_changes` is extracted at line 437 from the payload. The only change is passing it to `show_token_expired_warning`. No other changes in `main.py`.

The variable `self._last_token_expired_queued_count` (stored at line 438) is still needed — `show_reauth_dialog()` uses it to set the modal count. Don't remove it.

### §5 — New tests for `test_window_routing.py`

Add at the end of the file (after `TestErrorStatePersistence` which ends ~line 881):

```python
# ---------------------------------------------------------------------------
# Story 6-0c — error_pending_cycle clearance on offline / queue replay
# ---------------------------------------------------------------------------

class TestErrorPendingCycleClearance:
    """_error_pending_cycle is cleared on offline and queue_replay_complete (Story 6-0c AC1)."""

    def test_on_offline_clears_error_pending_cycle(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win._error_pending_cycle.add("p1")
        win.on_offline()
        assert win._error_pending_cycle == set()

    def test_on_offline_preserves_error_pair_ids(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win._error_pair_ids.add("p1")
        win._error_pending_cycle.add("p1")
        win.on_offline()
        assert "p1" in win._error_pair_ids  # error visual state preserved

    def test_on_queue_replay_complete_clears_stale_flag(self):
        win = _make_window()
        win._error_pending_cycle.add("p1")  # stale flag from before replay
        win.on_queue_replay_complete({"synced": 0, "skipped_conflicts": 0})
        assert win._error_pending_cycle == set()

    def test_error_clears_after_one_sync_complete_following_offline(self):
        """Offline clears flag → one clean sync_complete removes the error (not two)."""
        win = _make_window()
        row = _make_row()
        row.state = "error"
        win._sync_pair_rows["p1"] = row

        win.on_pair_error("p1", "Sync error ETIMEDOUT")
        assert "p1" in win._error_pending_cycle

        win.on_offline()
        assert "p1" not in win._error_pending_cycle
        assert "p1" in win._error_pair_ids

        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:00.000Z"})
        assert "p1" not in win._error_pair_ids  # cleared after ONE cycle

    def test_error_clears_after_one_sync_complete_following_clean_replay(self):
        """Clean replay clears flag → one clean sync_complete removes the error (not two)."""
        win = _make_window()
        row = _make_row()
        row.state = "error"
        win._sync_pair_rows["p1"] = row

        win.on_pair_error("p1", "Sync error ETIMEDOUT")
        assert "p1" in win._error_pending_cycle

        win.on_queue_replay_complete({"synced": 0, "skipped_conflicts": 0})
        assert "p1" not in win._error_pending_cycle
        assert "p1" in win._error_pair_ids

        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:00.000Z"})
        assert "p1" not in win._error_pair_ids  # cleared after ONE cycle


# ---------------------------------------------------------------------------
# Story 6-0c — session-expired banner queued-change count
# ---------------------------------------------------------------------------

class TestSessionExpiredBannerCount:
    """show_token_expired_warning updates banner title with queued-change count (Story 6-0c AC2)."""

    def test_nonzero_count_shows_plural(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning(3)
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired \u2014 3 changes queued"
        )
        win.session_expired_banner.set_revealed.assert_called_once_with(True)

    def test_one_count_shows_singular(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning(1)
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired \u2014 1 change queued"
        )

    def test_zero_count_shows_default_text(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning(0)
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired \u2014 sign in to resume sync"
        )

    def test_no_arg_shows_default_text(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning()
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired \u2014 sign in to resume sync"
        )
```

**Note on the em dash:** The `—` in the Blueprint title is U+2014 (EM DASH). In the test string literals above it's written as `\u2014` to avoid any copy-paste encoding issues. When writing the Python source for `window.py`, use the literal `—` character (copy from the Blueprint file), which is what the tests assert against.

Actually, **use the literal em dash** (`—`) in both `window.py` and `test_window_routing.py` for consistency with the Blueprint. The `\u2014` in the test above is just for documentation clarity — the actual test file should use the literal `—` character.

### §6 — Updated `test_main.py` assertions

**File:** `ui/tests/test_main.py`

Two tests in `TestTokenExpiredCallsWarning` use `.assert_called_once_with()` (no args). After the change, `show_token_expired_warning` is called with a positional integer arg. Update both:

```python
# Line ~292 — test_calls_show_token_expired_warning
# Before:
app._window.show_token_expired_warning.assert_called_once_with()
# After:
app._window.show_token_expired_warning.assert_called_once_with(3)

# Line ~315 — test_shows_banner_even_when_auth_browser_active  
# Before:
app._window.show_token_expired_warning.assert_called_once_with()
# After:
app._window.show_token_expired_warning.assert_called_once_with(1)
```

Verify the payload in each test:
- `test_calls_show_token_expired_warning`: uses `{"queued_changes": 3}` → `assert_called_once_with(3)`
- `test_shows_banner_even_when_auth_browser_active`: uses `{"queued_changes": 1}` → `assert_called_once_with(1)`

The other three tests in `TestTokenExpiredCallsWarning` (`test_does_not_call_show_pre_auth`, `test_does_not_delete_credentials`, `test_no_window_is_noop`) do not assert on the args to `show_token_expired_warning` — no change needed.

### Project Structure Notes

**Files to modify:**
- `ui/src/protondrive/window.py` — 3 changes: `on_offline()` (Task 1), `on_queue_replay_complete()` (Task 2), `show_token_expired_warning()` (Task 3)
- `ui/src/protondrive/main.py` — 1 change: `_on_token_expired()` call site (Task 4)
- `ui/tests/test_window_routing.py` — 2 new test classes appended at end (Task 5)
- `ui/tests/test_main.py` — 2 assertion updates (Task 6)

**Do NOT modify:**
- `ui/data/ui/window.blp` — Blueprint static title is the correct fallback; dynamic override via `set_title()` in Python is sufficient
- Any engine source files (`engine/`)
- `sprint-status.yaml` (updated by this workflow step)
- Any other UI files not listed above

### References

- `[5-9 CR W1]` deferred-work source: `_bmad-output/implementation-artifacts/deferred-work.md`
- `[5-1]` banner count source: Epic 5 retrospective §Challenges #1: `_bmad-output/implementation-artifacts/epic-5-retro-2026-04-20.md`
- `_error_pending_cycle` semantics: `ui/src/protondrive/window.py:62–72` (comments) + `on_pair_error` at ~line 522 + `on_sync_complete` at ~line 557
- `show_token_expired_warning` current impl: `ui/src/protondrive/window.py:308`
- `_on_token_expired` call site: `ui/src/protondrive/main.py:426–442`
- Existing error-state tests: `ui/tests/test_window_routing.py:822–881`
- Existing token-expired tests: `ui/tests/test_main.py:286–315`
- Session expired banner Blueprint definition: `ui/data/ui/window.blp:20–25`
- `session_expired_banner` Template.Child: `ui/src/protondrive/window.py:34`
- 6-0a (prerequisite — must ship first): `_bmad-output/implementation-artifacts/6-0a-unbounded-loop-recursion-safety.md`
- 6-0b (parallel — can run after 6-0a): `_bmad-output/implementation-artifacts/6-0b-error-code-routing-correctness.md`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None.

### Completion Notes List

- Task 1: Added `self._error_pending_cycle.clear()` as first statement in `on_offline()` (window.py:439). Offline ends the sync cycle; stale pending flags cleared so next `on_sync_complete` resolves error in one pass.
- Task 2: Added `self._error_pending_cycle.clear()` at end of `on_queue_replay_complete()` (after the `elif had_pending_before` block). Replay is a complete cycle boundary; stale flags cleared identically.
- Task 3: Replaced `show_token_expired_warning()` signature with `queued_changes: int = 0`. Now calls `set_title()` before `set_revealed(True)`. Singular "change" / plural "changes" logic with em dash matching Blueprint string.
- Task 4: Updated `_on_token_expired()` call site: `show_token_expired_warning()` → `show_token_expired_warning(queued_changes)`. `queued_changes` already extracted at line 437.
- Task 5: Appended `TestErrorPendingCycleClearance` (5 tests) and `TestSessionExpiredBannerCount` (4 tests) to `test_window_routing.py`.
- Task 6: Updated two assertions in `TestTokenExpiredCallsWarning` (`test_main.py`): `assert_called_once_with()` → `assert_called_once_with(3)` and `assert_called_once_with(1)` respectively.
- Task 7: `meson compile` — zero errors. `pytest ui/tests/` — **590 passed** (572 baseline + 18 new), zero regressions.

### File List

- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/tests/test_window_routing.py`
- `ui/tests/test_main.py`
- `_bmad-output/implementation-artifacts/6-0c-ui-state-correctness.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Review Findings

- [x] [Review][Defer] Test gap: error arriving after `on_queue_replay_complete` `.clear()` but before `on_sync_complete` — logic correct by design; specific timing untested [window.py:522] — deferred, pre-existing
- [x] [Review][Defer] Missing test: multiple pairs in mixed error/conflict/synced states — footer priority logic untested for all-three-at-once scenario [test_window_routing.py] — deferred, pre-existing
- [x] [Review][Defer] Missing test: rapid session-ready → token-expired sequence [test_window_routing.py] — deferred, pre-existing
