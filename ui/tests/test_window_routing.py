"""Unit tests for window.py event routing.

Verifies that on_sync_progress, on_sync_complete, and on_watcher_status
correctly dispatch to SyncPairRow instances and StatusFooterBar.
Window GTK init is bypassed via object.__new__.
"""

from __future__ import annotations

from unittest.mock import MagicMock, call, patch

from protondrive.window import MainWindow


def _make_window() -> MainWindow:
    """Construct a MainWindow without GTK init."""
    win = object.__new__(MainWindow)
    win.status_footer_bar = MagicMock()
    win.pair_detail_panel = MagicMock()
    win.nav_split_view = MagicMock()
    win.pairs_list = MagicMock()
    win.toast_overlay = MagicMock()
    win._sync_pair_rows = {}
    win._pairs_data = {}
    win._conflict_pending_count = 0
    win._conflict_copies_by_pair = {}
    win._conflict_log_entries = []
    win._error_pair_ids = set()
    win._error_pending_cycle = set()
    win._error_messages = {}
    win._row_activated_connected = False
    win._settings = MagicMock()
    return win


def _make_row(state: str = "synced", pair_name: str = "Documents") -> MagicMock:
    row = MagicMock()
    row.state = state
    row.pair_name = pair_name
    return row


# ---------------------------------------------------------------------------
# on_sync_progress
# ---------------------------------------------------------------------------

class TestOnSyncProgress:
    def test_known_pair_sets_state_syncing(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_sync_progress({"pair_id": "p1", "pair_name": "Docs", "files_done": 1, "files_total": 5})
        row.set_state.assert_called_once_with("syncing")

    def test_footer_set_syncing_called_with_correct_args(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row()
        win.on_sync_progress({"pair_id": "p1", "pair_name": "Photos", "files_done": 3, "files_total": 10})
        win.status_footer_bar.set_syncing.assert_called_once_with("Photos", 3, 10)

    def test_unknown_pair_does_not_crash(self):
        win = _make_window()
        win.on_sync_progress({"pair_id": "unknown", "pair_name": "Docs", "files_done": 0, "files_total": 1})
        win.status_footer_bar.set_syncing.assert_called_once()

    def test_fallback_to_row_pair_name_when_payload_name_empty(self):
        win = _make_window()
        row = _make_row(pair_name="Music")
        win._sync_pair_rows["p1"] = row
        win.on_sync_progress({"pair_id": "p1", "pair_name": "", "files_done": 2, "files_total": 4})
        win.status_footer_bar.set_syncing.assert_called_once_with("Music", 2, 4)

    def test_files_done_defaults_to_zero_when_missing(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row()
        win.on_sync_progress({"pair_id": "p1", "pair_name": "Docs"})
        win.status_footer_bar.set_syncing.assert_called_once_with("Docs", 0, 0)


# ---------------------------------------------------------------------------
# on_sync_complete
# ---------------------------------------------------------------------------

class TestOnSyncComplete:
    def test_known_pair_sets_state_synced(self):
        win = _make_window()
        row = _make_row(state="syncing")
        win._sync_pair_rows["p1"] = row
        win.on_sync_complete({"pair_id": "p1"})
        row.set_state.assert_called_once_with("synced")

    def test_all_synced_calls_update_all_synced(self):
        win = _make_window()
        row = _make_row(state="syncing")
        win._sync_pair_rows["p1"] = row
        # Simulate row.set_state updating the mock's state attribute
        def _set_state(s):
            row.state = s
        row.set_state.side_effect = _set_state
        win.on_sync_complete({"pair_id": "p1"})
        win.status_footer_bar.update_all_synced.assert_called_once()

    def test_not_all_synced_does_not_call_update_all_synced(self):
        win = _make_window()
        row1 = _make_row(state="syncing")
        row2 = _make_row(state="syncing")
        win._sync_pair_rows["p1"] = row1
        win._sync_pair_rows["p2"] = row2
        # Only p1 completes; p2 still syncing
        def _set_state_p1(s):
            row1.state = s
        row1.set_state.side_effect = _set_state_p1
        win.on_sync_complete({"pair_id": "p1"})
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_empty_sync_pair_rows_does_not_call_update_all_synced(self):
        """Vacuous all() on empty dict must not trigger footer update (P1 fix)."""
        win = _make_window()
        win.on_sync_complete({"pair_id": "p1"})
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_unknown_pair_id_does_not_crash(self):
        win = _make_window()
        row = _make_row(state="synced")
        win._sync_pair_rows["p1"] = row
        win.on_sync_complete({"pair_id": "unknown"})
        row.set_state.assert_not_called()


# ---------------------------------------------------------------------------
# on_watcher_status
# ---------------------------------------------------------------------------

class TestOnWatcherStatus:
    def test_initializing_calls_set_initialising(self):
        win = _make_window()
        win.on_watcher_status("initializing")
        win.status_footer_bar.set_initialising.assert_called_once()

    def test_ready_with_no_rows_calls_update_all_synced(self):
        win = _make_window()
        win.on_watcher_status("ready")
        win.status_footer_bar.update_all_synced.assert_called_once()

    def test_ready_with_all_synced_rows_calls_update_all_synced(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row(state="synced")
        win.on_watcher_status("ready")
        win.status_footer_bar.update_all_synced.assert_called_once()

    def test_ready_with_syncing_row_does_not_call_update_all_synced(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row(state="syncing")
        win.on_watcher_status("ready")
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_unknown_status_does_nothing(self):
        win = _make_window()
        win.on_watcher_status("unknown")
        win.status_footer_bar.set_initialising.assert_not_called()
        win.status_footer_bar.update_all_synced.assert_not_called()


# ---------------------------------------------------------------------------
# Story 2-8: populate_pairs routing
# ---------------------------------------------------------------------------

class TestPopulatePairs:
    def _make_window_for_populate(self) -> MainWindow:
        win = _make_window()
        # Make get_row_at_index return None immediately so while loop exits
        win.pairs_list.get_row_at_index.return_value = None
        return win

    def test_empty_pairs_calls_show_no_pairs(self):
        win = self._make_window_for_populate()
        win.populate_pairs([])
        win.pair_detail_panel.show_no_pairs.assert_called_once()

    def test_empty_pairs_clears_pairs_data(self):
        win = self._make_window_for_populate()
        win._pairs_data = {"old": {}}
        win.populate_pairs([])
        assert win._pairs_data == {}

    def test_nonempty_pairs_calls_show_select_prompt(self):
        win = self._make_window_for_populate()
        mock_row = MagicMock()
        with patch("protondrive.window.SyncPairRow", return_value=mock_row):
            win.populate_pairs([{"pair_id": "p1", "local_path": "/home/u/Docs"}])
        win.pair_detail_panel.show_select_prompt.assert_called_once()

    def test_nonempty_pairs_no_show_no_pairs(self):
        win = self._make_window_for_populate()
        mock_row = MagicMock()
        with patch("protondrive.window.SyncPairRow", return_value=mock_row):
            win.populate_pairs([{"pair_id": "p1", "local_path": "/home/u/Docs"}])
        win.pair_detail_panel.show_no_pairs.assert_not_called()

    def test_pairs_data_populated_correctly(self):
        win = self._make_window_for_populate()
        mock_row = MagicMock()
        with patch("protondrive.window.SyncPairRow", return_value=mock_row):
            win.populate_pairs([{"pair_id": "p1", "local_path": "/home/u/Docs"}])
        assert "p1" in win._pairs_data
        assert win._pairs_data["p1"]["local_path"] == "/home/u/Docs"


# ---------------------------------------------------------------------------
# Story 2-8: _on_row_activated routing
# ---------------------------------------------------------------------------

class TestOnRowActivated:
    def test_known_pair_calls_show_pair(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1", "local_path": "/home/u/Docs"}}
        row = MagicMock()
        row.pair_id = "p1"
        win._on_row_activated(MagicMock(), row)
        win.pair_detail_panel.show_pair.assert_called_once_with(
            {"pair_id": "p1", "local_path": "/home/u/Docs"}
        )

    def test_known_pair_sets_show_content(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1", "local_path": "/home/u/Docs"}}
        row = MagicMock()
        row.pair_id = "p1"
        win._on_row_activated(MagicMock(), row)
        win.nav_split_view.set_show_content.assert_called_once_with(True)

    def test_unknown_pair_calls_show_pair_with_empty_dict(self):
        win = _make_window()
        win._pairs_data = {}
        row = MagicMock()
        row.pair_id = "unknown"
        win._on_row_activated(MagicMock(), row)
        win.pair_detail_panel.show_pair.assert_called_once_with({})


# ---------------------------------------------------------------------------
# Story 2-8: on_sync_progress / on_sync_complete panel delegation
# ---------------------------------------------------------------------------

class TestPanelDelegation:
    def test_on_sync_progress_delegates_to_panel(self):
        win = _make_window()
        payload = {"pair_id": "p1", "pair_name": "Docs", "files_done": 1, "files_total": 5}
        win.on_sync_progress(payload)
        win.pair_detail_panel.on_sync_progress.assert_called_once_with(payload)

    def test_on_sync_complete_delegates_to_panel(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row()
        payload = {"pair_id": "p1", "timestamp": "2026-04-11T12:00:00Z"}

        def _set_state(s):
            win._sync_pair_rows["p1"].state = s
        win._sync_pair_rows["p1"].set_state.side_effect = _set_state

        win.on_sync_complete(payload)
        win.pair_detail_panel.on_sync_complete.assert_called_once_with(payload)

    def test_on_sync_complete_updates_pairs_data_last_synced_text(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1"}}
        payload = {"pair_id": "p1", "timestamp": "2026-04-11T12:00:00Z"}
        win.on_sync_complete(payload)
        assert "last_synced_text" in win._pairs_data["p1"]
        assert "ago" in win._pairs_data["p1"]["last_synced_text"]

    def test_on_sync_complete_unknown_pair_does_not_update_pairs_data(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1"}}
        win.on_sync_complete({"pair_id": "unknown", "timestamp": "2026-04-11T12:00:00Z"})
        assert "last_synced_text" not in win._pairs_data.get("p1", {})

    def test_on_sync_progress_populates_file_count_and_size_when_total_nonzero(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1"}}
        payload = {"pair_id": "p1", "pair_name": "Docs", "files_done": 3, "files_total": 10, "bytes_total": 1048576}
        win.on_sync_progress(payload)
        assert win._pairs_data["p1"]["file_count_text"] == "10 files"
        assert win._pairs_data["p1"]["total_size_text"] == "1.0 MB"

    def test_on_sync_progress_does_not_populate_when_files_total_zero(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1"}}
        win.on_sync_progress({"pair_id": "p1", "pair_name": "Docs", "files_done": 0, "files_total": 0})
        assert "file_count_text" not in win._pairs_data["p1"]


# ---------------------------------------------------------------------------
# Story 2-8: clear_session
# ---------------------------------------------------------------------------

class TestClearSession:
    def test_clears_pairs_data(self):
        win = _make_window()
        win._pairs_data = {"p1": {}}
        win._session_data = {}
        win.clear_session()
        assert win._pairs_data == {}

    def test_calls_show_no_pairs(self):
        win = _make_window()
        win._session_data = {}
        win.clear_session()
        win.pair_detail_panel.show_no_pairs.assert_called_once()


# ---------------------------------------------------------------------------
# Story 3-3 — on_queue_replay_complete
# ---------------------------------------------------------------------------

class TestOnQueueReplayComplete:
    """on_queue_replay_complete toast + conflict-pending routing (AC7)."""

    def test_synced_only_shows_toast_with_plural_text(self):
        win = _make_window()
        with patch("protondrive.window.Adw") as mock_adw:
            mock_toast = MagicMock()
            mock_adw.Toast.new.return_value = mock_toast
            win.on_queue_replay_complete({"synced": 2, "skipped_conflicts": 0})
            mock_adw.Toast.new.assert_called_once_with("2 files synced")
            mock_toast.set_timeout.assert_called_once_with(3)
            win.toast_overlay.add_toast.assert_called_once_with(mock_toast)
        # conflict pending stays at 0 → no set_conflict_pending call
        win.status_footer_bar.set_conflict_pending.assert_not_called()
        assert win._conflict_pending_count == 0

    def test_synced_one_uses_singular_text(self):
        win = _make_window()
        with patch("protondrive.window.Adw") as mock_adw:
            mock_adw.Toast.new.return_value = MagicMock()
            win.on_queue_replay_complete({"synced": 1, "skipped_conflicts": 0})
            mock_adw.Toast.new.assert_called_once_with("1 file synced")

    def test_zero_synced_zero_skipped_is_noop(self):
        win = _make_window()
        with patch("protondrive.window.Adw") as mock_adw:
            win.on_queue_replay_complete({"synced": 0, "skipped_conflicts": 0})
            mock_adw.Toast.new.assert_not_called()
        win.status_footer_bar.set_conflict_pending.assert_not_called()
        assert win._conflict_pending_count == 0

    def test_zero_synced_with_conflicts_calls_set_conflict_pending(self):
        win = _make_window()
        with patch("protondrive.window.Adw") as mock_adw:
            win.on_queue_replay_complete({"synced": 0, "skipped_conflicts": 2})
            mock_adw.Toast.new.assert_not_called()
        win.status_footer_bar.set_conflict_pending.assert_called_once_with(2)
        assert win._conflict_pending_count == 2

    def test_synced_and_conflicts_shows_both_toast_and_set_conflict_pending(self):
        win = _make_window()
        with patch("protondrive.window.Adw") as mock_adw:
            mock_adw.Toast.new.return_value = MagicMock()
            win.on_queue_replay_complete({"synced": 3, "skipped_conflicts": 1})
            mock_adw.Toast.new.assert_called_once_with("3 files synced")
        win.status_footer_bar.set_conflict_pending.assert_called_once_with(1)
        assert win._conflict_pending_count == 1


class TestConflictPendingRegressionGuards:
    """Regression guards: _conflict_pending_count > 0 preserves footer state."""

    def test_on_sync_complete_preserves_footer_when_conflict_pending(self):
        win = _make_window()
        win._conflict_pending_count = 2
        row = _make_row(state="synced")
        win._sync_pair_rows["p1"] = row
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-15T00:00:00.000Z"})
        # Footer must NOT be reset to update_all_synced while conflict_pending is set
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_on_sync_complete_still_updates_when_conflict_pending_is_zero(self):
        win = _make_window()
        win._conflict_pending_count = 0
        row = _make_row(state="syncing")
        win._sync_pair_rows["p1"] = row

        def _set_state(s):
            row.state = s
        row.set_state.side_effect = _set_state
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-15T00:00:00.000Z"})
        win.status_footer_bar.update_all_synced.assert_called_once()

    def test_on_watcher_status_ready_preserves_footer_when_conflict_pending(self):
        win = _make_window()
        win._conflict_pending_count = 2
        win._sync_pair_rows["p1"] = _make_row(state="synced")
        win.on_watcher_status("ready")
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_on_online_preserves_footer_when_conflict_pending(self):
        win = _make_window()
        win._conflict_pending_count = 2
        win._sync_pair_rows["p1"] = _make_row(state="offline")
        win.on_online()
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_on_online_still_updates_when_conflict_pending_is_zero(self):
        win = _make_window()
        win._conflict_pending_count = 0
        row = _make_row(state="offline")
        win._sync_pair_rows["p1"] = row

        def _set_state(s):
            row.state = s
        row.set_state.side_effect = _set_state
        win.on_online()
        win.status_footer_bar.update_all_synced.assert_called_once()


# ---------------------------------------------------------------------------
# Story 3-4 — on_rate_limited
# ---------------------------------------------------------------------------

class TestOnRateLimited:
    """on_rate_limited routes to status_footer_bar.set_rate_limited (AC4)."""

    def test_normal_payload_calls_set_rate_limited(self):
        win = _make_window()
        win.on_rate_limited({"resume_in_seconds": 5})
        win.status_footer_bar.set_rate_limited.assert_called_once_with(5)

    def test_none_resume_in_uses_safe_default(self):
        win = _make_window()
        win.on_rate_limited({"resume_in_seconds": None})
        win.status_footer_bar.set_rate_limited.assert_called_once_with(5)

    def test_zero_resume_in_uses_safe_default(self):
        win = _make_window()
        win.on_rate_limited({"resume_in_seconds": 0})
        win.status_footer_bar.set_rate_limited.assert_called_once_with(5)


# ---------------------------------------------------------------------------
# Story 4-4 — on_conflict_detected, on_sync_complete resolution, clear_session
# ---------------------------------------------------------------------------

class TestOnConflictDetected:
    """Story 4-4 AC1–3: conflict tracking, row/panel/footer updates."""

    def test_valid_path_adds_to_tracking(self):
        win = _make_window()
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        assert win._conflict_copies_by_pair == {"p1": ["/tmp/a.conflict"]}

    def test_empty_path_returns_early(self):
        win = _make_window()
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": ""})
        assert win._conflict_copies_by_pair == {}
        win.status_footer_bar.set_conflicts.assert_not_called()

    def test_duplicate_path_not_added_twice(self):
        win = _make_window()
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        assert len(win._conflict_copies_by_pair["p1"]) == 1

    def test_two_conflicts_same_pair_increments_count(self):
        win = _make_window()
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/b.conflict"})
        win.status_footer_bar.set_conflicts.assert_called_with(2)

    def test_footer_set_conflicts_called(self):
        win = _make_window()
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        win.status_footer_bar.set_conflicts.assert_called_once_with(1)

    def test_row_set_state_conflict_called(self):
        win = _make_window()
        row = _make_row(state="synced")
        win._sync_pair_rows["p1"] = row
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        row.set_state.assert_called_once_with("conflict", conflict_count=1)

    def test_offline_row_not_overridden(self):
        win = _make_window()
        row = _make_row(state="offline")
        win._sync_pair_rows["p1"] = row
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        row.set_state.assert_not_called()

    def test_panel_set_conflict_state_called(self):
        win = _make_window()
        win._pairs_data = {"p1": {"pair_id": "p1", "local_path": "/home/u/Docs"}}
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        win.pair_detail_panel.set_conflict_state.assert_called_once_with("p1", 1, "Docs")

    def test_error_state_active_suppresses_footer_conflict_update(self):
        """Error > conflict priority: footer must not be overwritten by conflict event when a pair has an error."""
        win = _make_window()
        row = _make_row(state="error")
        win._sync_pair_rows["p1"] = row
        win._error_pair_ids.add("p1")
        win.on_conflict_detected({"pair_id": "p2", "conflict_copy_path": "/tmp/a.conflict"})
        win.status_footer_bar.set_conflicts.assert_not_called()

    def test_no_error_state_allows_footer_conflict_update(self):
        """Without active errors, conflict events update the footer normally."""
        win = _make_window()
        win.on_conflict_detected({"pair_id": "p1", "conflict_copy_path": "/tmp/a.conflict"})
        win.status_footer_bar.set_conflicts.assert_called_once_with(1)


class TestOnSyncProgressConflictPriority:
    """Story 4-4 AC4: Conflict > Syncing footer priority."""

    def test_footer_not_updated_to_syncing_when_conflicts_active(self):
        win = _make_window()
        win._conflict_copies_by_pair = {"p1": ["/tmp/a.conflict"]}
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_sync_progress({"pair_id": "p1", "pair_name": "Docs", "files_done": 1, "files_total": 5})
        win.status_footer_bar.set_syncing.assert_not_called()

    def test_row_still_set_to_syncing_even_when_conflicts_active(self):
        win = _make_window()
        win._conflict_copies_by_pair = {"p1": ["/tmp/a.conflict"]}
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_sync_progress({"pair_id": "p1", "pair_name": "Docs", "files_done": 1, "files_total": 5})
        row.set_state.assert_called_once_with("syncing")


class TestOnSyncCompleteResolution:
    """Story 4-4 AC5: conflict resolution detection on sync_complete."""

    def test_missing_conflict_copy_clears_tracking(self):
        win = _make_window()
        win._conflict_copies_by_pair = {"p1": ["/tmp/gone.conflict"]}
        with patch("protondrive.window.os.path.exists", return_value=False):
            win.on_sync_complete({"pair_id": "p1"})
        assert "p1" not in win._conflict_copies_by_pair

    def test_present_conflict_copy_stays_tracked(self):
        win = _make_window()
        win._conflict_copies_by_pair = {"p1": ["/tmp/still_here.conflict"]}
        with patch("protondrive.window.os.path.exists", return_value=True):
            win.on_sync_complete({"pair_id": "p1"})
        assert win._conflict_copies_by_pair == {"p1": ["/tmp/still_here.conflict"]}

    def test_row_reverts_to_synced_after_resolution(self):
        win = _make_window()
        row = _make_row(state="conflict")
        win._sync_pair_rows["p1"] = row
        win._conflict_copies_by_pair = {"p1": ["/tmp/gone.conflict"]}
        with patch("protondrive.window.os.path.exists", return_value=False):
            win.on_sync_complete({"pair_id": "p1"})
        row.set_state.assert_called_with("synced")

    def test_row_stays_conflict_if_copies_remain(self):
        win = _make_window()
        row = _make_row(state="conflict")
        win._sync_pair_rows["p1"] = row
        win._conflict_copies_by_pair = {"p1": ["/tmp/still.conflict"]}
        with patch("protondrive.window.os.path.exists", return_value=True):
            win.on_sync_complete({"pair_id": "p1"})
        row.set_state.assert_called_with("conflict", conflict_count=1)

    def test_footer_calls_update_all_synced_after_full_resolution(self):
        win = _make_window()
        row = _make_row(state="conflict")
        win._sync_pair_rows["p1"] = row

        def _set_state(*args, **kwargs):
            row.state = args[0] if args else kwargs.get("state", "synced")
        row.set_state.side_effect = _set_state

        win._conflict_copies_by_pair = {"p1": ["/tmp/gone.conflict"]}
        with patch("protondrive.window.os.path.exists", return_value=False):
            win.on_sync_complete({"pair_id": "p1"})
        win.status_footer_bar.update_all_synced.assert_called_once()

    def test_footer_calls_set_conflicts_when_copies_remain(self):
        win = _make_window()
        win._conflict_copies_by_pair = {"p1": ["/tmp/still.conflict"]}
        with patch("protondrive.window.os.path.exists", return_value=True):
            win.on_sync_complete({"pair_id": "p1"})
        win.status_footer_bar.set_conflicts.assert_called_with(1)


class TestClearSessionResetsConflicts:
    """Story 4-4 AC6: clear_session resets conflict state."""

    def test_clear_session_resets_conflict_copies_by_pair(self):
        win = _make_window()
        win._conflict_copies_by_pair = {"p1": ["/tmp/a.conflict"]}
        win._session_data = {}
        win.clear_session()
        assert win._conflict_copies_by_pair == {}


# ---------------------------------------------------------------------------
# Story 4-5 — select_pair
# ---------------------------------------------------------------------------

class TestSelectPair:
    """Story 4-5 AC2 — MainWindow.select_pair programmatic navigation."""

    def test_select_pair_selects_row_in_listbox(self):
        win = _make_window()
        row = _make_row(pair_name="Docs")
        win._sync_pair_rows["p1"] = row
        win._pairs_data["p1"] = {"pair_id": "p1", "local_path": "/home/user/Docs"}
        win.select_pair("p1")
        win.pairs_list.select_row.assert_called_once_with(row)

    def test_select_pair_shows_pair_in_detail_panel(self):
        win = _make_window()
        row = _make_row(pair_name="Docs")
        win._sync_pair_rows["p1"] = row
        win._pairs_data["p1"] = {"pair_id": "p1"}
        win.select_pair("p1")
        win.pair_detail_panel.show_pair.assert_called_once_with({"pair_id": "p1"})

    def test_select_pair_shows_content_pane(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.select_pair("p1")
        win.nav_split_view.set_show_content.assert_called_once_with(True)

    def test_select_pair_restores_conflict_banner(self):
        win = _make_window()
        row = _make_row(pair_name="Docs")
        win._sync_pair_rows["p1"] = row
        win._conflict_copies_by_pair["p1"] = ["/tmp/notes.md.conflict-2026-04-17"]
        win.select_pair("p1")
        win.pair_detail_panel.set_conflict_state.assert_called_once_with("p1", 1, "Docs")

    def test_select_pair_unknown_pair_id_does_nothing(self):
        win = _make_window()
        win.select_pair("unknown")
        win.pairs_list.select_row.assert_not_called()


class TestOnlineWatcherGuardsWithConflicts:
    """Story 4-4: on_online / on_watcher_status guards also check active conflicts."""

    def test_on_online_preserves_footer_when_active_conflicts(self):
        win = _make_window()
        win._conflict_pending_count = 0
        win._conflict_copies_by_pair = {"p1": ["/tmp/a.conflict"]}
        win._sync_pair_rows["p1"] = _make_row(state="offline")
        win.on_online()
        win.status_footer_bar.update_all_synced.assert_not_called()

    def test_on_watcher_status_ready_preserves_footer_when_active_conflicts(self):
        win = _make_window()
        win._conflict_pending_count = 0
        win._conflict_copies_by_pair = {"p1": ["/tmp/a.conflict"]}
        win._sync_pair_rows["p1"] = _make_row(state="synced")
        win.on_watcher_status("ready")
        win.status_footer_bar.update_all_synced.assert_not_called()


# ---------------------------------------------------------------------------
# Story 4-6 — _conflict_log_entries management
# ---------------------------------------------------------------------------

class TestConflictLogEntries:
    def test_on_conflict_detected_appends_to_conflict_log_entries(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row(pair_name="Docs")
        win._pairs_data["p1"] = {"local_path": "/home/user/Docs"}
        win.on_conflict_detected({
            "pair_id": "p1",
            "conflict_copy_path": "/home/user/Docs/notes.md.conflict-2026-04-18",
            "local_path": "/home/user/Docs/notes.md",
        })
        assert len(win._conflict_log_entries) == 1
        entry = win._conflict_log_entries[0]
        assert entry["pair_id"] == "p1"
        assert entry["local_path"] == "/home/user/Docs/notes.md"
        assert entry["date"] == "2026-04-18"
        assert entry["resolved"] is False

    def test_on_conflict_detected_deduplicates_by_conflict_copy_path(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row(pair_name="Docs")
        payload = {
            "pair_id": "p1",
            "conflict_copy_path": "/tmp/notes.md.conflict-2026-04-18",
            "local_path": "/tmp/notes.md",
        }
        win.on_conflict_detected(payload)
        win.on_conflict_detected(payload)  # duplicate
        assert len(win._conflict_log_entries) == 1

    def test_on_sync_complete_marks_resolved_when_file_gone(self):
        win = _make_window()
        win._conflict_log_entries = [{
            "pair_id": "p1",
            "local_path": "/tmp/notes.md",
            "conflict_copy_path": "/tmp/notes.md.conflict-2026-04-18",
            "pair_name": "Docs",
            "date": "2026-04-18",
            "resolved": False,
        }]
        win._sync_pair_rows["p1"] = _make_row()
        win._conflict_copies_by_pair = {}  # already resolved in copies tracking
        with patch("protondrive.window.os.path.exists", return_value=False):
            win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-18T10:00:00Z"})
        assert win._conflict_log_entries[0]["resolved"] is True

    def test_on_sync_complete_does_not_mark_resolved_when_file_present(self):
        win = _make_window()
        win._conflict_log_entries = [{
            "pair_id": "p1",
            "local_path": "/tmp/notes.md",
            "conflict_copy_path": "/tmp/notes.md.conflict-2026-04-18",
            "pair_name": "Docs",
            "date": "2026-04-18",
            "resolved": False,
        }]
        win._sync_pair_rows["p1"] = _make_row()
        win._conflict_copies_by_pair = {"p1": ["/tmp/notes.md.conflict-2026-04-18"]}
        with patch("protondrive.window.os.path.exists", return_value=True):
            win.on_sync_complete({"pair_id": "p1", "timestamp": ""})
        assert win._conflict_log_entries[0]["resolved"] is False

    def test_clear_session_clears_conflict_log_entries(self):
        win = _make_window()
        win._conflict_log_entries = [{"pair_id": "p1", "resolved": False}]
        win.clear_session()
        assert win._conflict_log_entries == []

    def test_on_view_conflict_log_calls_show_conflict_log_page(self):
        win = _make_window()
        win._conflict_log_entries = [{"pair_id": "p1"}]
        win._on_view_conflict_log(MagicMock())
        win.pair_detail_panel.show_conflict_log_page.assert_called_once_with(
            [{"pair_id": "p1"}]
        )

    def test_on_conflict_detected_date_empty_when_no_suffix(self):
        win = _make_window()
        win._sync_pair_rows["p1"] = _make_row(pair_name="Docs")
        win._pairs_data["p1"] = {"local_path": "/tmp"}
        win.on_conflict_detected({
            "pair_id": "p1",
            "conflict_copy_path": "/tmp/notes.md",  # no .conflict-YYYY-MM-DD suffix
            "local_path": "/tmp/notes.md",
        })
        assert win._conflict_log_entries[0]["date"] == ""

    def test_on_sync_complete_does_not_mark_different_pair_entries_resolved(self):
        win = _make_window()
        win._conflict_log_entries = [
            {
                "pair_id": "p2",  # different pair
                "local_path": "/tmp/other.md",
                "conflict_copy_path": "/tmp/other.md.conflict-2026-04-18",
                "pair_name": "Other",
                "date": "2026-04-18",
                "resolved": False,
            }
        ]
        win._sync_pair_rows["p1"] = _make_row()
        win._conflict_copies_by_pair = {}
        with patch("protondrive.window.os.path.exists", return_value=False):
            win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-18T10:00:00Z"})
        assert win._conflict_log_entries[0]["resolved"] is False


# ---------------------------------------------------------------------------
# Story 5-4 — on_crash_recovery_complete
# ---------------------------------------------------------------------------

class TestOnPairError:
    """on_pair_error() routes DISK_FULL errors to row + footer (Story 5-5 AC3, AC4)."""

    def test_known_pair_sets_row_state_error(self):
        win = _make_window()
        row = _make_row()
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /home/user/docs to continue syncing")
        row.set_state.assert_called_once_with("error")

    def test_known_pair_sets_footer_error(self):
        win = _make_window()
        row = _make_row(pair_name="Documents")
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "some message")
        win.status_footer_bar.set_error.assert_called_once_with("Documents")

    def test_unknown_pair_id_does_not_crash(self):
        win = _make_window()
        win.on_pair_error("nonexistent", "msg")
        win.status_footer_bar.set_error.assert_not_called()

    def test_message_is_not_forwarded_to_status_label(self):
        """Raw message (contains path) must not appear in footer label directly."""
        win = _make_window()
        row = _make_row(pair_name="Docs")
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Free up space on /secret/path")
        # set_error is called with pair_name only — not the raw message
        win.status_footer_bar.set_error.assert_called_once_with("Docs")


class TestOnCrashRecoveryComplete:
    """on_crash_recovery_complete shows AdwToast with correct text and timeout (AC4)."""

    def test_crash_recovery_complete_shows_toast(self):
        win = _make_window()
        with patch("protondrive.window.Adw") as mock_adw:
            mock_toast = MagicMock()
            mock_adw.Toast.new.return_value = mock_toast
            win.on_crash_recovery_complete()
            mock_adw.Toast.new.assert_called_once_with(
                "Recovered from unexpected shutdown — sync resuming"
            )
            mock_toast.set_timeout.assert_called_once_with(5)
            win.toast_overlay.add_toast.assert_called_once_with(mock_toast)


class TestErrorStatePersistence:
    """Error state tracking and priority logic (Story 5-9 AC3, AC5)."""

    def test_on_pair_error_then_on_online_row_stays_error(self):
        """on_online must NOT reset a row that is in error state (AC3)."""
        win = _make_window()
        row = _make_row(pair_name="Docs")
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Sync error ETIMEDOUT — try again or check ProtonDrive status")
        row.set_state.reset_mock()
        # Simulate coming back online
        win.on_online()
        # Row should NOT be reset to "synced" — error state preserved
        row.set_state.assert_not_called()

    def test_on_pair_error_then_on_sync_complete_no_new_errors_clears_error(self):
        """Clean sync cycle (no new error for that pair) clears error state (AC3)."""
        win = _make_window()
        row = _make_row(pair_name="Docs")
        row.state = "error"
        win._sync_pair_rows["p1"] = row
        win.on_pair_error("p1", "Sync error ETIMEDOUT — try again or check ProtonDrive status")
        # Drain the pending flag (simulating on_sync_complete called AFTER the
        # error was added but NOT re-fired in the same cycle).
        # First call to on_sync_complete: pending flag is set → discards it, keeps error.
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-19T00:00:00.000Z"})
        assert "p1" in win._error_pair_ids  # still in error after first cycle

        # Second call: no new error → _error_pending_cycle is empty for p1 → cleared.
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-19T00:00:01.000Z"})
        assert "p1" not in win._error_pair_ids

    def test_on_pair_error_twice_same_cycle_then_sync_complete_keeps_error(self):
        """Two errors in same cycle: on_sync_complete should keep error (pending flag reset but pair stays)."""
        win = _make_window()
        row = _make_row(pair_name="Docs")
        row.state = "error"
        win._sync_pair_rows["p1"] = row
        # Error fires twice in the same sync cycle
        win.on_pair_error("p1", "Sync error ETIMEDOUT — try again")
        win.on_pair_error("p1", "Sync error ETIMEDOUT — try again")
        # on_sync_complete: pending flag is set → discards flag, keeps error
        win.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-19T00:00:00.000Z"})
        assert "p1" in win._error_pair_ids
        assert "p1" not in win._error_pending_cycle

    def test_two_pair_errors_footer_shows_n_pairs(self):
        """Two pairs in error → footer set_error called with '2 pairs' label (AC3)."""
        win = _make_window()
        row1 = _make_row(pair_name="Docs")
        row2 = _make_row(pair_name="Photos")
        win._sync_pair_rows["p1"] = row1
        win._sync_pair_rows["p2"] = row2
        win.on_pair_error("p1", "Sync error EIO — try again")
        win.on_pair_error("p2", "Sync error EIO — try again")
        # Last call to set_error should use "2 pairs"
        last_call_args = win.status_footer_bar.set_error.call_args
        assert last_call_args is not None
        assert "2 pairs" in last_call_args[0][0]


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
            "Session expired — 3 changes queued"
        )
        win.session_expired_banner.set_revealed.assert_called_once_with(True)

    def test_one_count_shows_singular(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning(1)
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired — 1 change queued"
        )

    def test_zero_count_shows_default_text(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning(0)
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired — sign in to resume sync"
        )

    def test_no_arg_shows_default_text(self):
        win = _make_window()
        win.session_expired_banner = MagicMock()
        win.show_token_expired_warning()
        win.session_expired_banner.set_title.assert_called_once_with(
            "Session expired — sign in to resume sync"
        )


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

