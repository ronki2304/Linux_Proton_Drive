"""Unit tests for PairDetailPanel widget.

Widget GTK init is bypassed via object.__new__; mock template children are
attached manually.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

from protondrive.widgets.pair_detail_panel import PairDetailPanel, _fmt_relative_time, _pair_name


def _make_panel() -> PairDetailPanel:
    """Construct a PairDetailPanel without GTK init."""
    panel = object.__new__(PairDetailPanel)
    panel._current_pair_id = None
    panel._sync_complete_timer = None
    panel._progress_card = None
    panel.detail_stack = MagicMock()
    panel.conflict_banner = MagicMock()
    panel.setup_btn = MagicMock()
    panel.pair_name_heading = MagicMock()
    panel.local_path_row = MagicMock()
    panel.remote_path_row = MagicMock()
    panel.last_synced_row = MagicMock()
    panel.file_count_row = MagicMock()
    panel.total_size_row = MagicMock()
    panel.progress_slot = MagicMock()
    panel.view_conflict_log_btn = MagicMock()
    panel.conflict_log_slot = MagicMock()
    panel.conflict_log_back_btn = MagicMock()
    panel._conflict_log = None
    return panel


# ---------------------------------------------------------------------------
# _pair_name helper
# ---------------------------------------------------------------------------

class TestPairName:
    def test_basename_of_path(self):
        assert _pair_name("/home/user/Documents") == "Documents"

    def test_trailing_slash_stripped(self):
        assert _pair_name("/home/user/Documents/") == "Documents"

    def test_empty_path_returns_empty(self):
        assert _pair_name("") == ""

    def test_root_path(self):
        assert _pair_name("/") == "/"


# ---------------------------------------------------------------------------
# _fmt_relative_time helper
# ---------------------------------------------------------------------------

class TestFmtRelativeTime:
    def test_invalid_timestamp_returns_never(self):
        assert _fmt_relative_time("invalid-ts") == "Never"

    def test_empty_string_returns_never(self):
        assert _fmt_relative_time("") == "Never"

    def test_recent_timestamp_contains_ago(self):
        result = _fmt_relative_time("2026-04-11T12:00:00Z")
        assert "ago" in result

    def test_z_suffix_handled(self):
        # Should not raise; Python < 3.11 doesn't accept bare Z
        result = _fmt_relative_time("2026-04-11T00:00:00Z")
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# show_no_pairs
# ---------------------------------------------------------------------------

class TestShowNoPairs:
    def test_switches_stack_to_no_pairs(self):
        panel = _make_panel()
        panel.show_no_pairs()
        panel.detail_stack.set_visible_child_name.assert_called_once_with("no-pairs")

    def test_clears_current_pair_id(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.show_no_pairs()
        assert panel._current_pair_id is None


# ---------------------------------------------------------------------------
# show_select_prompt
# ---------------------------------------------------------------------------

class TestShowSelectPrompt:
    def test_switches_stack_to_no_selection(self):
        panel = _make_panel()
        panel.show_select_prompt()
        panel.detail_stack.set_visible_child_name.assert_called_once_with("no-selection")

    def test_clears_current_pair_id(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.show_select_prompt()
        assert panel._current_pair_id is None


# ---------------------------------------------------------------------------
# show_pair
# ---------------------------------------------------------------------------

class TestShowPair:
    def test_sets_pair_name_heading_to_basename(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/home/user/Docs/"})
        panel.pair_name_heading.set_text.assert_called_once_with("Docs")

    def test_switches_stack_to_detail(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/home/user/Docs"})
        panel.detail_stack.set_visible_child_name.assert_called_once_with("detail")

    def test_stores_current_pair_id(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/home/user/Docs"})
        assert panel._current_pair_id == "p1"

    def test_populates_local_path_row(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/home/user/Docs"})
        panel.local_path_row.set_subtitle.assert_called_once_with("/home/user/Docs")

    def test_populates_remote_path_row(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/tmp", "remote_path": "/My Drive"})
        panel.remote_path_row.set_subtitle.assert_called_once_with("/My Drive")

    def test_last_synced_defaults_to_never(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/tmp"})
        panel.last_synced_row.set_subtitle.assert_called_once_with("Never")

    def test_last_synced_text_used_when_present(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/tmp", "last_synced_text": "5 minutes ago"})
        panel.last_synced_row.set_subtitle.assert_called_once_with("5 minutes ago")

    def test_cancels_active_sync_timer_before_showing_new_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel._sync_complete_timer = 99
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.source_remove.reset_mock()
        panel.show_pair({"pair_id": "p2", "local_path": "/home/u/Other/"})
        glib_mock.source_remove.assert_called_with(99)
        assert panel._sync_complete_timer is None


# ---------------------------------------------------------------------------
# on_sync_progress
# ---------------------------------------------------------------------------

class TestOnSyncProgress:
    def test_guard_fires_for_different_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.on_sync_progress({"pair_id": "p2", "files_done": 0, "files_total": 0})
        assert panel._progress_card is None

    def test_creates_progress_card_for_matching_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        mock_card = MagicMock()
        with patch(
            "protondrive.widgets.pair_detail_panel.SyncProgressCard",
            return_value=mock_card,
        ):
            panel.on_sync_progress({"pair_id": "p1", "files_done": 0, "files_total": 0})
        assert panel._progress_card is mock_card

    def test_calls_set_counting_when_files_total_zero(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        mock_card = MagicMock()
        with patch(
            "protondrive.widgets.pair_detail_panel.SyncProgressCard",
            return_value=mock_card,
        ):
            panel.on_sync_progress({"pair_id": "p1", "files_done": 0, "files_total": 0})
        mock_card.set_counting.assert_called()

    def test_calls_set_progress_when_files_total_nonzero(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        mock_card = MagicMock()
        with patch(
            "protondrive.widgets.pair_detail_panel.SyncProgressCard",
            return_value=mock_card,
        ):
            panel.on_sync_progress({
                "pair_id": "p1",
                "files_done": 5,
                "files_total": 10,
                "bytes_done": 1024,
                "bytes_total": 2048,
            })
        mock_card.set_progress.assert_called_once_with(5, 10, 1024, 2048)

    def test_reuses_existing_card_on_second_event(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        existing_card = MagicMock()
        panel._progress_card = existing_card
        panel.on_sync_progress({"pair_id": "p1", "files_done": 0, "files_total": 0})
        assert panel._progress_card is existing_card

    def test_set_counting_called_exactly_once_on_first_progress_event(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        mock_card = MagicMock()
        with patch(
            "protondrive.widgets.pair_detail_panel.SyncProgressCard",
            return_value=mock_card,
        ):
            panel.on_sync_progress({"pair_id": "p1", "files_done": 0, "files_total": 0})
        mock_card.set_counting.assert_called_once()

    def test_guard_blocks_when_current_pair_id_is_none(self):
        panel = _make_panel()
        panel._current_pair_id = None
        panel.on_sync_progress({"pair_id": None, "files_done": 0, "files_total": 0})
        assert panel._progress_card is None


# ---------------------------------------------------------------------------
# on_sync_complete
# ---------------------------------------------------------------------------

class TestOnSyncComplete:
    def test_guard_fires_for_different_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.on_sync_complete({"pair_id": "p2", "timestamp": "2026-04-11T12:00:00Z"})
        panel.last_synced_row.set_subtitle.assert_not_called()

    def test_updates_last_synced_label_for_matching_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-11T12:00:00Z"})
        call_args = panel.last_synced_row.set_subtitle.call_args[0][0]
        assert "ago" in call_args

    def test_schedules_timer_for_matching_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.timeout_add.reset_mock()
        panel.on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-11T12:00:00Z"})
        glib_mock.timeout_add.assert_called_with(2000, panel._on_sync_complete_timeout)

    def test_no_timer_for_different_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.timeout_add.reset_mock()
        panel.on_sync_complete({"pair_id": "p2", "timestamp": "2026-04-11T12:00:00Z"})
        glib_mock.timeout_add.assert_not_called()

    def test_guard_blocks_when_current_pair_id_is_none(self):
        panel = _make_panel()
        panel._current_pair_id = None
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.timeout_add.reset_mock()
        panel.on_sync_complete({"pair_id": None, "timestamp": "2026-04-11T12:00:00Z"})
        glib_mock.timeout_add.assert_not_called()
        panel.last_synced_row.set_subtitle.assert_not_called()


# ---------------------------------------------------------------------------
# _on_sync_complete_timeout
# ---------------------------------------------------------------------------

class TestOnSyncCompleteTimeout:
    def test_clears_timer_id(self):
        panel = _make_panel()
        panel._sync_complete_timer = 42
        glib_mock = sys.modules["gi.repository.GLib"]
        panel._on_sync_complete_timeout()
        assert panel._sync_complete_timer is None

    def test_returns_source_remove(self):
        panel = _make_panel()
        glib_mock = sys.modules["gi.repository.GLib"]
        result = panel._on_sync_complete_timeout()
        assert result == glib_mock.SOURCE_REMOVE

    def test_hides_progress_card(self):
        panel = _make_panel()
        mock_card = MagicMock()
        panel._progress_card = mock_card
        panel._on_sync_complete_timeout()
        assert panel._progress_card is None
        panel.progress_slot.remove.assert_called_once_with(mock_card)


# ---------------------------------------------------------------------------
# PairDetailPanel conflict banner (Story 4-4)
# ---------------------------------------------------------------------------

class TestPairDetailPanelConflictBanner:
    def test_set_conflict_state_reveals_banner_for_current_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p1", 1, "Documents")
        panel.conflict_banner.set_revealed.assert_called_with(True)

    def test_set_conflict_state_ignored_for_other_pair(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p2", 1, "Photos")  # different pair
        panel.conflict_banner.set_revealed.assert_not_called()

    def test_set_conflict_state_title_singular(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p1", 1, "Documents")
        panel.conflict_banner.set_title.assert_called_with("1 conflict in Documents")

    def test_set_conflict_state_title_plural(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p1", 3, "Photos")
        panel.conflict_banner.set_title.assert_called_with("3 conflicts in Photos")

    def test_set_conflict_state_zero_hides_banner(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p1", 0, "Documents")
        panel.conflict_banner.set_revealed.assert_called_with(False)

    def test_on_conflict_banner_dismissed_hides_banner(self):
        panel = _make_panel()
        panel._on_conflict_banner_dismissed(panel.conflict_banner)
        panel.conflict_banner.set_revealed.assert_called_with(False)

    def test_show_pair_resets_banner(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.show_pair({"pair_id": "p2", "local_path": "/home/u/Photos"})
        panel.conflict_banner.set_revealed.assert_called_with(False)


# ---------------------------------------------------------------------------
# _cancel_sync_timer
# ---------------------------------------------------------------------------

class TestCancelSyncTimer:
    def test_cancels_active_timer(self):
        panel = _make_panel()
        panel._sync_complete_timer = 55
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.source_remove.reset_mock()
        panel._cancel_sync_timer()
        glib_mock.source_remove.assert_called_once_with(55)
        assert panel._sync_complete_timer is None

    def test_no_op_when_no_timer(self):
        panel = _make_panel()
        panel._sync_complete_timer = None
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.source_remove.reset_mock()
        panel._cancel_sync_timer()
        glib_mock.source_remove.assert_not_called()


# ---------------------------------------------------------------------------
# Story 4-6 — ConflictLog integration in PairDetailPanel
# ---------------------------------------------------------------------------

class TestConflictLogIntegration:
    def test_set_conflict_state_shows_view_log_btn_when_count_gt_0(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p1", 1, "Docs")
        panel.view_conflict_log_btn.set_visible.assert_called_with(True)

    def test_set_conflict_state_hides_view_log_btn_when_count_0(self):
        panel = _make_panel()
        panel._current_pair_id = "p1"
        panel.set_conflict_state("p1", 0, "Docs")
        panel.view_conflict_log_btn.set_visible.assert_called_with(False)

    def test_show_conflict_log_page_lazy_creates_conflict_log(self):
        panel = _make_panel()
        with patch("protondrive.widgets.pair_detail_panel.ConflictLog") as mock_cls:
            mock_log = MagicMock()
            mock_cls.return_value = mock_log
            panel.show_conflict_log_page([])
            mock_cls.assert_called_once()
            panel.conflict_log_slot.append.assert_called_once_with(mock_log)

    def test_show_conflict_log_page_reuses_existing_log(self):
        panel = _make_panel()
        existing_log = MagicMock()
        panel._conflict_log = existing_log
        panel.show_conflict_log_page([{"pair_id": "p1"}])
        existing_log.set_entries.assert_called_once_with([{"pair_id": "p1"}])
        panel.conflict_log_slot.append.assert_not_called()

    def test_show_conflict_log_page_switches_stack_to_conflict_log(self):
        panel = _make_panel()
        panel._conflict_log = MagicMock()
        panel.show_conflict_log_page([])
        panel.detail_stack.set_visible_child_name.assert_called_with("conflict-log")

    def test_on_conflict_log_back_switches_stack_to_detail(self):
        panel = _make_panel()
        panel._on_conflict_log_back(MagicMock())
        panel.detail_stack.set_visible_child_name.assert_called_with("detail")

    def test_show_pair_hides_view_log_btn(self):
        panel = _make_panel()
        panel.show_pair({"pair_id": "p1", "local_path": "/tmp/Docs"})
        panel.view_conflict_log_btn.set_visible.assert_called_with(False)
