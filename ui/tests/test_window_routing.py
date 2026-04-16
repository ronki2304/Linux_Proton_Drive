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
