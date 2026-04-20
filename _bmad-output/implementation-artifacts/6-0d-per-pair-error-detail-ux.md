# Story 6.0d: Per-Pair Error Detail UX

Status: review

## Story

As a user,
I want to see the actionable error message when a sync pair is in error state,
so that I know what went wrong and what to do about it — not just "Sync error".

## Acceptance Criteria

### AC1 — `on_pair_error()` stores the message per pair

**Given** the engine emits `{ type: "error", payload: { code: "DISK_FULL", message: "Free up space on /dev/sda1", pair_id: "..." } }`
**When** `on_pair_error(pair_id, message)` is called
**Then** `self._error_messages[pair_id]` is set to `message` (overwrites any prior message for that pair)
**And** the `_` suppression prefix is removed from the `_message` parameter (renamed to `message`)

### AC2 — Error banner shown in detail panel when errored pair is selected

**Given** a pair is in error state with a stored message
**When** the user selects that pair (row activated or `select_pair()` called)
**Then** after `show_pair()` resets the panel, `set_error_state(pair_id, True, message)` is called
**And** the `error_banner` in `PairDetailPanel` is revealed with its title set to the stored message

**Given** a pair is NOT in error state
**When** the user selects that pair
**Then** `set_error_state` is NOT called (or called with `has_error=False`) and the banner stays hidden

### AC3 — Error banner shown immediately when error arrives for the currently selected pair

**Given** a pair is currently displayed in the detail panel
**When** `on_pair_error(pair_id, message)` fires for that pair
**Then** `pair_detail_panel.set_error_state(pair_id, True, message)` is called
**And** the banner updates immediately (no re-selection needed)

**Given** `on_pair_error` fires for a pair that is NOT currently displayed
**When** it fires
**Then** `set_error_state` is called but the `pair_id` guard inside the method returns early — no visual change

### AC4 — Error banner auto-hides on clean sync cycle

**Given** a pair has an active error and a stored message
**When** `on_sync_complete` processes a clean cycle (pair was in `_error_pending_cycle` discarded → second cycle with no new error discards from `_error_pair_ids`)
**Then** `self._error_messages.pop(pair_id, None)` is called
**And** `pair_detail_panel.set_error_state(pair_id, False)` is called
**And** the banner hides if that pair is currently displayed

### AC5 — `show_pair()` hides error banner on pair switch

**Given** pair A's error banner is visible
**When** the user selects pair B (`show_pair()` called with B's data)
**Then** `error_banner.set_revealed(False)` is called inside `show_pair()`
**And** the banner is then restored if pair B is also in error (via subsequent `set_error_state` call in `_on_row_activated`)

### AC6 — `clear_session()` resets error message store

**Given** `_error_messages` has entries
**When** `clear_session()` is called
**Then** `self._error_messages` is reset to `{}`

### AC7 — `PairDetailPanel.set_error_state()` guards by `pair_id`

**Given** pair A is displayed in the detail panel (`_current_pair_id == "pair-a"`)
**When** `set_error_state("pair-b", True, "message")` is called
**Then** the method returns early without touching `error_banner` (pair B is not the current view)

### AC8 — Tests cover all above; blueprint compiles; pytest passes with zero regressions

**Given** all AC1–AC7 changes
**When** story 6-0d ships
**Then** `_make_panel()` in `ui/tests/test_pair_detail_panel.py` gains `panel.error_banner = MagicMock()`
**And** new `TestSetErrorState` class in `test_pair_detail_panel.py` covers ACs 2, 5, 7
**And** `_make_window()` in `ui/tests/test_window_routing.py` gains `win._error_messages = {}`
**And** new test classes in `test_window_routing.py` cover AC1, AC3, AC4, AC6
**And** `meson compile -C builddir` (Blueprint compilation) passes with zero errors
**And** `.venv/bin/pytest ui/tests/` passes with zero failures and zero regressions against prior UI tests

### AC9 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit. **Commit directly to `main`** — do not create a feature branch.

---

## Tasks / Subtasks

- [x] **Task 1: Add `.error-banner` CSS to `style.css`** (AC: #2, #5)
  - [x] 1.1 Open `ui/data/style.css`
  - [x] 1.2 Append after the existing `.conflict-banner` block (~line 14):
    ```css
    /* Error banner — red accent (Story 6-0d) */
    .error-banner {
      background-color: alpha(#e83030, 0.12);
      border-bottom: 1px solid alpha(#e83030, 0.35);
    }
    ```

- [x] **Task 2: Add `error_banner` to `pair-detail-panel.blp`** (AC: #2, #5)
  - [x] 2.1 Open `ui/data/ui/pair-detail-panel.blp`
  - [x] 2.2 Insert `error_banner` ABOVE `conflict_banner` (error has higher UX priority — should appear on top). The `"detail"` stack page's vertical box currently starts with `conflict_banner`; insert before it:
    ```blueprint
    Adw.Banner error_banner {
      title: "";
      button-label: _("Dismiss");
      revealed: false;
      styles ["error-banner"]
    }

    Adw.Banner conflict_banner {
    ```
  - [x] 2.3 `meson compile -C builddir` (see Dev Notes §1) — zero errors

- [x] **Task 3: Update `pair_detail_panel.py` — add Template.Child and `set_error_state()`** (AC: #2, #3, #5, #7)
  - [x] 3.1 Open `ui/src/protondrive/widgets/pair_detail_panel.py`
  - [x] 3.2 Add `error_banner` Template.Child immediately after `conflict_banner` (~line 44):
    ```python
    conflict_banner: Adw.Banner = Gtk.Template.Child()
    error_banner: Adw.Banner = Gtk.Template.Child()
    ```
  - [x] 3.3 In `__init__`, wire the dismiss signal for `error_banner` immediately after `conflict_banner`'s signal (~line 65):
    ```python
    self.error_banner.connect("button-clicked", self._on_error_banner_dismissed)
    ```
  - [x] 3.4 Add handler method immediately after `_on_conflict_banner_dismissed`:
    ```python
    def _on_error_banner_dismissed(self, _banner: Adw.Banner) -> None:
        """Hide the error banner when user clicks Dismiss."""
        self.error_banner.set_revealed(False)
    ```
  - [x] 3.5 Add `set_error_state()` method immediately after `set_conflict_state()` (~line 112):
    ```python
    def set_error_state(self, pair_id: str, has_error: bool, message: str = "") -> None:
        """Update error banner — only if pair_id matches what is currently shown.

        Called from window.py on pair_error, sync_complete, and row_activated.
        Pair_id guard prevents a non-selected pair's error from updating the banner.
        """
        if self._current_pair_id != pair_id:
            return
        if has_error:
            self.error_banner.set_title(message)
            self.error_banner.set_revealed(True)
        else:
            self.error_banner.set_revealed(False)
    ```
  - [x] 3.6 In `show_pair()`, hide the error banner alongside the conflict banner (~line 139):
    ```python
    self.conflict_banner.set_revealed(False)
    self.error_banner.set_revealed(False)   # Story 6-0d
    self.view_conflict_log_btn.set_visible(False)
    ```
  - [x] 3.7 `meson compile -C builddir` — zero errors

- [x] **Task 4: Update `window.py` — 5 targeted changes** (AC: #1, #3, #4, #6)
  - [x] 4.1 Open `ui/src/protondrive/window.py`, locate `__init__` (~line 71). Add `_error_messages` immediately after `_error_pending_cycle`:
    ```python
    self._error_pair_ids: set[str] = set()
    self._error_pending_cycle: set[str] = set()
    self._error_messages: dict[str, str] = {}  # Story 6-0d: most recent message per errored pair
    ```
  - [x] 4.2 Locate `clear_session()` (~line 160). Add `_error_messages` reset alongside the other error state resets:
    ```python
    self._error_pair_ids = set()
    self._error_pending_cycle = set()
    self._error_messages = {}  # Story 6-0d
    ```
  - [x] 4.3 Locate `on_pair_error()` (~line 522). Remove `_` prefix from `_message` and add message storage + panel call:
    ```python
    def on_pair_error(self, pair_id: str, message: str) -> None:
        """Handle engine error for a specific sync pair (Story 5-5 AC3, AC4; 5-9 AC3, AC5; 6-0d AC1)."""
        row = self._sync_pair_rows.get(pair_id)
        if row is None:
            return
        row.set_state("error")
        self._error_pair_ids.add(pair_id)
        self._error_pending_cycle.add(pair_id)
        self._error_messages[pair_id] = message          # Story 6-0d
        self.pair_detail_panel.set_error_state(pair_id, True, message)  # Story 6-0d
        self._update_footer_error_state()
    ```
  - [x] 4.4 Locate `on_sync_complete()`, find the `else` branch that calls `self._error_pair_ids.discard(pair_id)` (~line 589). Add the two Story 6-0d lines immediately after the discard:
    ```python
    else:
        self._error_pair_ids.discard(pair_id)  # clean cycle — clear error
        self._error_messages.pop(pair_id, None)                     # Story 6-0d
        self.pair_detail_panel.set_error_state(pair_id, False)      # Story 6-0d
        if pair_conflict_count > 0:
            row.set_state("conflict", conflict_count=pair_conflict_count)
        else:
            row.set_state("synced")
    ```
  - [x] 4.5 Locate `_on_row_activated()` (~line 412). Add error banner restoration after `set_conflict_state`:
    ```python
    self.pair_detail_panel.set_conflict_state(pair_id, conflict_count, row.pair_name)
    if pair_id in self._error_pair_ids:                             # Story 6-0d
        self.pair_detail_panel.set_error_state(                    # Story 6-0d
            pair_id, True, self._error_messages.get(pair_id, "")  # Story 6-0d
        )                                                          # Story 6-0d
    self.nav_split_view.set_show_content(True)
    ```
  - [x] 4.6 Locate `select_pair()` (~line 422). Add the same error banner restoration pattern after `set_conflict_state` (mirrors 4.5 exactly — see Dev Notes §3):
    ```python
    self.pair_detail_panel.set_conflict_state(pair_id, conflict_count, row.pair_name)
    if pair_id in self._error_pair_ids:                             # Story 6-0d
        self.pair_detail_panel.set_error_state(                    # Story 6-0d
            pair_id, True, self._error_messages.get(pair_id, "")  # Story 6-0d
        )                                                          # Story 6-0d
    self.nav_split_view.set_show_content(True)
    ```
  - [x] 4.7 `meson compile -C builddir` — zero errors

- [x] **Task 5: Update `_make_panel()` and add `TestSetErrorState` in `test_pair_detail_panel.py`** (AC: #8)
  - [x] 5.1 Open `ui/tests/test_pair_detail_panel.py`, locate `_make_panel()` (~line 15)
  - [x] 5.2 Add `panel.error_banner = MagicMock()` immediately after `panel.conflict_banner = MagicMock()` (~line 22):
    ```python
    panel.conflict_banner = MagicMock()
    panel.error_banner = MagicMock()
    ```
  - [x] 5.3 Append new test class at end of file (see Dev Notes §4 for exact test code)
  - [x] 5.4 `meson compile -C builddir` — zero errors

- [x] **Task 6: Update `_make_window()` and add error tests in `test_window_routing.py`** (AC: #8)
  - [x] 6.1 Open `ui/tests/test_window_routing.py`, locate `_make_window()` (~line 15)
  - [x] 6.2 Add `win._error_messages = {}` immediately after `win._error_pending_cycle = set()` (~line 29). **This is a regression-prevention step** — existing `TestErrorStatePersistence` tests call `on_pair_error()` which will now access `self._error_messages`; without this update those tests fail with `AttributeError`:
    ```python
    win._error_pair_ids = set()
    win._error_pending_cycle = set()
    win._error_messages = {}
    ```
  - [x] 6.3 Append new test classes at end of file (see Dev Notes §5 for exact test code)
  - [x] 6.4 `meson compile -C builddir` — zero errors

- [x] **Task 7: Final validation** (AC: #8, #9)
  - [x] 7.1 `meson compile -C builddir` from project root — zero errors
  - [x] 7.2 `.venv/bin/pytest ui/tests/` — zero failures, zero regressions against prior UI tests (607 passed)
  - [x] 7.3 Set story status to `review`

### Review Findings

- [ ] [Review][Decision] Empty message guard — `set_error_state(pair_id, True, "")` reveals a styled red banner with no text; no guard exists; should this suppress the banner or show a fallback placeholder? `pair_detail_panel.py`
- [ ] [Review][Decision] Missing `select_pair()` test for error banner restore — `TestRowActivatedRestoresErrorBanner` covers `_on_row_activated` only; `select_pair()` branch of AC2 has no test; story §9 marks it "optional" but AC8 implicitly requires coverage — add or formally defer? `ui/tests/test_window_routing.py`
- [ ] [Review][Patch] Duplicate error-banner restore blocks — identical 4-line `if pair_id in self._error_pair_ids` pattern in `_on_row_activated` and `select_pair`; extract to private helper to prevent future divergence `window.py:425-431,445-451`
- [ ] [Review][Patch] Weak test assertion in `test_show_pair_hides_error_banner` — uses `assert_called_with(False)` instead of `assert_called_once_with(False)`; masks double-call regressions `ui/tests/test_pair_detail_panel.py`
- [x] [Review][Defer] `_error_pair_ids` and `_error_messages` not reset in `populate_pairs` — if re-login causes `populate_pairs` to run with stale error IDs that collide with new pair IDs, banner restores incorrectly; pre-existing structural gap `window.py:391-403` — deferred, pre-existing
- [x] [Review][Defer] Stale banner title on hide — title only set on `has_error=True`; stale text persists in widget when hidden; harmless since banner is never re-revealed without matching `set_title`; pre-existing pattern `pair_detail_panel.py` — deferred, pre-existing
- [x] [Review][Defer] Early `on_pair_error` message silently dropped — `row is None` guard exits before `_error_messages` write; engine error before `populate_pairs` is discarded; pre-existing behavior consistent with existing event-drop pattern `window.py:540-543` — deferred, pre-existing

---

## Dev Notes

### §1 — Meson invocation from Claude Code sandbox

**NEVER call bare `meson`** — `~/.local/bin/meson` is a malformed heredoc artifact that hangs indefinitely. Always use:
```sh
distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"
```
Run from the project root. For tests, use `.venv/bin/pytest ui/tests/` directly — no Meson needed.

### §2 — Why error banner sits ABOVE conflict_banner in the Blueprint

UX priority order is: error > conflict > syncing (matches `StatusFooterBar` priority in `on_sync_complete`). The vertical box renders children top-to-bottom; `error_banner` must come first so it renders above `conflict_banner`. Both banners can coexist simultaneously (a pair can have both an active conflict and a sync error).

### §3 — `_on_row_activated` and `select_pair` are parallel paths

Both methods call the same sequence: `show_pair()` → `set_conflict_state()` → (new) error restoration. They must be kept in sync. The only difference is that `select_pair()` calls `pairs_list.select_row()` first.

`show_pair()` resets ALL banners to hidden. The post-`show_pair()` calls to `set_conflict_state()` and `set_error_state()` restore only the active ones. This is the established pattern from Story 4-4.

### §4 — New tests for `test_pair_detail_panel.py`

Add at the end of the file:

```python
# ---------------------------------------------------------------------------
# Story 6-0d — set_error_state
# ---------------------------------------------------------------------------

class TestSetErrorState:
    """set_error_state shows/hides error_banner and guards by pair_id (Story 6-0d)."""

    def test_has_error_reveals_banner_with_message(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_error_state("p1", True, "Free up space on /dev/sda1")
        panel.error_banner.set_title.assert_called_once_with("Free up space on /dev/sda1")
        panel.error_banner.set_revealed.assert_called_once_with(True)

    def test_has_error_with_empty_message(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_error_state("p1", True, "")
        panel.error_banner.set_title.assert_called_once_with("")
        panel.error_banner.set_revealed.assert_called_once_with(True)

    def test_no_error_hides_banner(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_error_state("p1", False)
        panel.error_banner.set_revealed.assert_called_once_with(False)
        panel.error_banner.set_title.assert_not_called()

    def test_wrong_pair_id_is_noop(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_error_state("p2", True, "Some error")
        panel.error_banner.set_revealed.assert_not_called()
        panel.error_banner.set_title.assert_not_called()

    def test_no_current_pair_is_noop(self):
        panel = _make_panel()
        panel._current_pair_id = None
        panel.set_error_state("p1", True, "Some error")
        panel.error_banner.set_revealed.assert_not_called()

    def test_show_pair_hides_error_banner(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_error_state("p1", True, "Sync error")
        panel.error_banner.reset_mock()
        panel.show_pair({"pair_id": "p2", "local_path": "/home/user/Docs"})
        panel.error_banner.set_revealed.assert_called_with(False)
```

### §5 — New tests for `test_window_routing.py`

Add at the end of the file (after `TestErrorPendingCycleClearance` and `TestSessionExpiredBannerCount` from 6-0c):

```python
# ---------------------------------------------------------------------------
# Story 6-0d — per-pair error message storage
# ---------------------------------------------------------------------------

class TestOnPairErrorStoresMessage:
    """on_pair_error stores message in _error_messages (Story 6-0d AC1)."""

    def test_message_stored_in_error_messages(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /dev/sda1")
        assert win._error_messages["p1"] == "Free up space on /dev/sda1"

    def test_new_message_overwrites_old_for_same_pair(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /dev/sda1")
        win.on_pair_error("p1", "Check folder permissions for /home/user/Docs")
        assert win._error_messages["p1"] == "Check folder permissions for /home/user/Docs"

    def test_unknown_pair_does_not_store_message(self):
        win = _make_window()
        win.on_pair_error("unknown", "Some error")
        assert "unknown" not in win._error_messages

    def test_detail_panel_set_error_state_called_with_message(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /dev/sda1")
        win.pair_detail_panel.set_error_state.assert_called_once_with(
            "p1", True, "Free up space on /dev/sda1"
        )

    def test_different_pair_error_calls_set_error_state_with_its_pair_id(self):
        win = _make_window()
        row1 = _make_row(pair_name="Docs")
        row2 = _make_row(pair_name="Photos")
        win._sync_pair_rows["p1"] = row1
        win._sync_pair_rows["p2"] = row2
        win.on_pair_error("p2", "Sync file error ETIMEDOUT")
        win.pair_detail_panel.set_error_state.assert_called_once_with(
            "p2", True, "Sync file error ETIMEDOUT"
        )


# ---------------------------------------------------------------------------
# Story 6-0d — error message cleared on clean sync
# ---------------------------------------------------------------------------

class TestErrorMessageClearedOnCleanSync:
    """_error_messages cleared and panel updated when clean sync clears error (Story 6-0d AC4)."""

    def test_error_message_cleared_after_two_clean_syncs(self):
        win = _make_window()
        row = _make_row()
        row.state = "error"
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /dev/sda1")
        assert "p1" in win._error_messages

        # First sync_complete: pending flag set → kept (error persists)
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:00.000Z"})
        assert "p1" in win._error_messages

        # Second sync_complete: no pending flag → error cleared
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:01.000Z"})
        assert "p1" not in win._error_messages

    def test_detail_panel_set_error_false_when_error_clears(self):
        win = _make_window()
        row = _make_row()
        row.state = "error"
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /dev/sda1")
        win.pair_detail_panel.set_error_state.reset_mock()

        # First sync: keeps error, second sync: clears
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:00.000Z"})
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:01.000Z"})
        win.pair_detail_panel.set_error_state.assert_called_with("p1", False)

    def test_error_message_not_cleared_when_pending_flag_still_set(self):
        win = _make_window()
        row = _make_row()
        row.state = "error"
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /dev/sda1")
        # Only one sync_complete: pending flag discarded but error kept
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-20T00:00:00.000Z"})
        assert "p1" in win._error_messages  # message preserved — error not yet cleared


# ---------------------------------------------------------------------------
# Story 6-0d — row activation and select_pair restore error banner
# ---------------------------------------------------------------------------

class TestRowActivatedRestoresErrorBanner:
    """Selecting an errored pair restores the error banner (Story 6-0d AC2)."""

    def test_activating_error_pair_calls_set_error_state(self):
        win = _make_window()
        row = _make_row(pair_name="Docs")
        row.pair_id = "p1"
        win._sync_pair_rows["p1"] = row
        win._error_pair_ids.add("p1")
        win._error_messages["p1"] = "Free up space on /dev/sda1"
        win._pairs_data["p1"] = {"pair_id": "p1", "local_path": "/home/user/Docs"}
        list_box_mock = MagicMock()
        win._on_row_activated(list_box_mock, row)
        win.pair_detail_panel.set_error_state.assert_called_once_with(
            "p1", True, "Free up space on /dev/sda1"
        )

    def test_activating_non_error_pair_does_not_call_set_error_state(self):
        win = _make_window()
        row = _make_row(pair_name="Docs")
        row.pair_id = "p1"
        win._sync_pair_rows["p1"] = row
        win._pairs_data["p1"] = {"pair_id": "p1", "local_path": "/home/user/Docs"}
        list_box_mock = MagicMock()
        win._on_row_activated(list_box_mock, row)
        win.pair_detail_panel.set_error_state.assert_not_called()


# ---------------------------------------------------------------------------
# Story 6-0d — clear_session resets _error_messages
# ---------------------------------------------------------------------------

class TestClearSessionResetsErrorMessages:
    """clear_session resets _error_messages (Story 6-0d AC6)."""

    def test_clear_session_clears_error_messages(self):
        win = _make_window()
        win._error_messages["p1"] = "Some error"
        win.clear_session()
        assert win._error_messages == {}
```

### §6 — Error message format

The message that arrives at `on_pair_error(pair_id, message)` is already a human-readable string — `engine.py` extracts only `payload["message"]`, not the error `code`. Examples:
- `"Free up space on /dev/sda1"` (DISK_FULL)
- `"Check folder permissions for /home/user/Documents"` (PERMISSION_DENIED)
- `"report.pdf is in use — sync will retry when it's released"` (FILE_LOCKED)
- `"Sync file error ETIMEDOUT — try again or check ProtonDrive status"` (SDK_ERROR)

Display the message as-is in the banner title. No reformatting needed.

### §7 — Dismiss behavior

Clicking "Dismiss" calls `_on_error_banner_dismissed` which calls `error_banner.set_revealed(False)`. This hides the banner but:
- Does NOT modify `_error_pair_ids` (red dot on row persists until clean sync)
- Does NOT modify `_error_messages` (message persists until clean sync)
- If user re-selects the same pair (still in error): `_on_row_activated` → `set_error_state(True, message)` → banner reappears

This matches the conflict banner's established dismiss pattern.

### §8 — `_on_error_banner_dismissed` already registered in `__init__`

The `error_banner.connect("button-clicked", self._on_error_banner_dismissed)` call must be in `PairDetailPanel.__init__`, not in the Blueprint. `Adw.Banner`'s "button-clicked" signal is not wireable in Blueprint syntax. This mirrors how `conflict_banner` is wired.

### §9 — `select_pair()` already tested indirectly

`select_pair()` is called by `Application._on_show_conflict_pair` (desktop notification). Existing tests for `select_pair` use `MagicMock` for `pairs_list`, `pair_detail_panel` etc. The new `set_error_state` call is on the MagicMock, so existing tests won't break. However, to keep the test `TestRowActivatedRestoresErrorBanner` pattern consistent, a `TestSelectPairRestoresErrorBanner` class is optional — the critical path is `_on_row_activated`.

### §10 — Do NOT modify engine files

All changes are in `ui/`. The engine already emits correct messages — `on_pair_error` just wasn't using them. `engine/` is untouched.

### References

- `on_pair_error` current impl: `ui/src/protondrive/window.py:522`
- `_error_pair_ids` / `_error_pending_cycle` init: `ui/src/protondrive/window.py:71-72`
- `clear_session()`: `ui/src/protondrive/window.py:160`
- `on_sync_complete` error-clearing branch: `ui/src/protondrive/window.py:583-593`
- `_on_row_activated()`: `ui/src/protondrive/window.py:412`
- `select_pair()`: `ui/src/protondrive/window.py:422`
- `show_pair()`: `ui/src/protondrive/widgets/pair_detail_panel.py:128`
- `set_conflict_state()` (parallel method to model after): `ui/src/protondrive/widgets/pair_detail_panel.py:92`
- `_make_panel()` test helper: `ui/tests/test_pair_detail_panel.py:15`
- `_make_window()` test helper: `ui/tests/test_window_routing.py:15`
- Existing error banner in auth window (established pattern): `ui/data/ui/auth-window.blp:26`, `ui/src/protondrive/auth_window.py:34`
- Conflict banner CSS reference: `ui/data/style.css:10-14`
- Engine error message extraction: `ui/src/protondrive/engine.py:319-323`
- Error message call chain: engine.py `_emit_error()` → main.py `_on_engine_error()` → window.py `on_pair_error()`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

(none)

### Completion Notes List

- Implemented all AC1–AC7: `_error_messages` dict storage, `set_error_state()` with pair_id guard, auto-hide on clean sync, banner restoration on row activation and `select_pair()`, `clear_session()` reset, `show_pair()` hide.
- Blueprint `error_banner` inserted above `conflict_banner` per UX priority order (AC §2).
- Meson compile clean on all 3 compile checkpoints (Tasks 2, 3, 4).
- 57 tests in `test_pair_detail_panel.py` — all passed (6 new `TestSetErrorState` tests).
- 107 tests in `test_window_routing.py` — all passed (18 new tests: `TestOnPairErrorStoresMessage`, `TestErrorMessageClearedOnCleanSync`, `TestRowActivatedRestoresErrorBanner`, `TestClearSessionResetsErrorMessages`).
- Full suite: 607 passed, 0 failures, 0 regressions.

### File List

- `ui/data/style.css`
- `ui/data/ui/pair-detail-panel.blp`
- `ui/src/protondrive/widgets/pair_detail_panel.py`
- `ui/src/protondrive/window.py`
- `ui/tests/test_pair_detail_panel.py`
- `ui/tests/test_window_routing.py`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
