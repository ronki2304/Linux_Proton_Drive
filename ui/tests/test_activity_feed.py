"""Unit tests for ActivityFeed widget (Story 8-3)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from protondrive.widgets.activity_feed import ActivityFeed, ActivityFeedRow, _fmt_activity_time


def _make_feed() -> ActivityFeed:
    feed = object.__new__(ActivityFeed)
    feed._events = []
    feed.activity_spinner = MagicMock()
    feed.activity_stack = MagicMock()
    feed.activity_list = MagicMock()
    feed.activity_list.get_row_at_index = MagicMock(return_value=MagicMock())
    feed.activity_list.get_first_child = MagicMock(return_value=None)
    return feed


def _ts_ago(seconds: int) -> str:
    """Return ISO 8601 UTC timestamp for N seconds ago."""
    dt = datetime.now(timezone.utc) - timedelta(seconds=seconds)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# _fmt_activity_time
# ---------------------------------------------------------------------------

class TestFmtActivityTime:
    def test_under_60s_returns_just_now(self):
        assert _fmt_activity_time(_ts_ago(30)) == "just now"

    def test_2_min_returns_2_min_ago(self):
        assert _fmt_activity_time(_ts_ago(120)) == "2 min ago"

    def test_90_min_returns_1_hr_ago(self):
        assert _fmt_activity_time(_ts_ago(5400)) == "1 hr ago"

    def test_invalid_timestamp_returns_empty_string(self):
        assert _fmt_activity_time("not-a-timestamp") == ""


# ---------------------------------------------------------------------------
# ActivityFeed.add_event
# ---------------------------------------------------------------------------

class TestAddEvent:
    def _event(self, name: str = "a.txt") -> dict:
        return {
            "file_name": name,
            "direction": "upload",
            "timestamp": _ts_ago(10),
            "pair_name": "Docs",
        }

    def test_prepends_row_to_activity_list(self):
        feed = _make_feed()
        feed.activity_stack.get_visible_child_name.return_value = "empty"
        with patch("protondrive.widgets.activity_feed.ActivityFeedRow") as MockRow:
            MockRow.return_value = MagicMock()
            feed.add_event(self._event())
        assert feed.activity_list.prepend.called
        assert len(feed._events) == 1

    def test_switches_stack_to_feed_on_first_item(self):
        feed = _make_feed()
        feed.activity_stack.get_visible_child_name.return_value = "empty"
        with patch("protondrive.widgets.activity_feed.ActivityFeedRow"):
            feed.add_event(self._event())
        feed.activity_stack.set_visible_child_name.assert_called_with("feed")

    def test_100_item_cap_removes_tail(self):
        feed = _make_feed()
        feed._events = [self._event(f"f{i}.txt") for i in range(100)]
        feed.activity_stack.get_visible_child_name.return_value = "feed"
        with patch("protondrive.widgets.activity_feed.ActivityFeedRow"):
            feed.add_event(self._event("new.txt"))
        assert len(feed._events) == 100
        assert feed.activity_list.remove.called

    def test_99_items_does_not_remove_tail(self):
        feed = _make_feed()
        feed._events = [self._event(f"f{i}.txt") for i in range(99)]
        feed.activity_stack.get_visible_child_name.return_value = "feed"
        with patch("protondrive.widgets.activity_feed.ActivityFeedRow"):
            feed.add_event(self._event("new.txt"))
        assert len(feed._events) == 100
        feed.activity_list.remove.assert_not_called()

    def test_multi_pair_interleaving(self):
        feed = _make_feed()
        feed.activity_stack.get_visible_child_name.return_value = "empty"
        events = [
            {"file_name": "a.txt", "direction": "upload", "timestamp": _ts_ago(10), "pair_name": "Docs"},
            {"file_name": "b.txt", "direction": "download", "timestamp": _ts_ago(5), "pair_name": "Photos"},
            {"file_name": "c.txt", "direction": "upload", "timestamp": _ts_ago(2), "pair_name": "Docs"},
        ]
        with patch("protondrive.widgets.activity_feed.ActivityFeedRow"):
            for ev in events:
                feed.add_event(ev)
        assert len(feed._events) == 3
        # Newest at front (prepend order)
        assert feed._events[0]["file_name"] == "c.txt"
        assert feed._events[1]["file_name"] == "b.txt"
        assert feed._events[2]["file_name"] == "a.txt"
        # All three distinct pair names preserved
        pair_names = {e["pair_name"] for e in feed._events}
        assert pair_names == {"Docs", "Photos"}


# ---------------------------------------------------------------------------
# ActivityFeed.set_syncing
# ---------------------------------------------------------------------------

class TestSetSyncing:
    def test_set_syncing_true_shows_spinner(self):
        feed = _make_feed()
        feed.set_syncing(True)
        feed.activity_spinner.set_spinning.assert_called_with(True)
        feed.activity_spinner.set_visible.assert_called_with(True)

    def test_set_syncing_false_hides_spinner(self):
        feed = _make_feed()
        feed.set_syncing(False)
        feed.activity_spinner.set_spinning.assert_called_with(False)
        feed.activity_spinner.set_visible.assert_called_with(False)


# ---------------------------------------------------------------------------
# ActivityFeed.clear
# ---------------------------------------------------------------------------

class TestClear:
    def test_clear_resets_state(self):
        feed = _make_feed()
        feed._events = [{"file_name": "a.txt"}, {"file_name": "b.txt"}]
        feed.clear()
        assert feed._events == []
        feed.activity_stack.set_visible_child_name.assert_called_with("empty")
        feed.activity_spinner.set_spinning.assert_called_with(False)
        feed.activity_spinner.set_visible.assert_called_with(False)


# ---------------------------------------------------------------------------
# PairDetailPanel integration
# ---------------------------------------------------------------------------

class TestPairDetailPanelIntegration:
    def _make_panel(self):
        from protondrive.widgets.pair_detail_panel import PairDetailPanel
        panel = object.__new__(PairDetailPanel)
        panel._current_pair_id = None
        panel._sync_complete_timer = None
        panel._progress_card = None
        panel.detail_stack = MagicMock()
        panel.conflict_banner = MagicMock()
        panel.error_banner = MagicMock()
        panel.setup_btn = MagicMock()
        panel.pair_name_heading = MagicMock()
        panel.local_path_row = MagicMock()
        panel.remote_path_row = MagicMock()
        panel.last_synced_row = MagicMock()
        panel.file_count_row = MagicMock()
        panel.total_size_row = MagicMock()
        panel.progress_slot = MagicMock()
        panel.activity_slot = MagicMock()
        panel.view_conflict_log_btn = MagicMock()
        panel.conflict_log_slot = MagicMock()
        panel.conflict_log_back_btn = MagicMock()
        panel.remove_pair_button = MagicMock()
        panel.folder_missing_status = MagicMock()
        panel.folder_missing_update_btn = MagicMock()
        panel.folder_missing_remove_btn = MagicMock()
        panel._conflict_log = None
        panel._activity_feed = None
        return panel

    def test_on_file_synced_lazy_creates_feed_and_delegates(self):
        panel = self._make_panel()
        mock_feed = MagicMock()
        with patch("protondrive.widgets.pair_detail_panel.ActivityFeed", return_value=mock_feed):
            panel.on_file_synced({
                "pair_id": "p1",
                "file_name": "x.txt",
                "direction": "download",
                "timestamp": _ts_ago(5),
                "pair_name": "Docs",
            })
        assert panel._activity_feed is mock_feed
        assert panel.activity_slot.append.called
        mock_feed.add_event.assert_called_once()

    def test_set_activity_syncing_delegates_to_feed_if_exists(self):
        panel = self._make_panel()
        mock_feed = MagicMock()
        panel._activity_feed = mock_feed
        panel.set_activity_syncing(True)
        mock_feed.set_syncing.assert_called_with(True)

    def test_set_activity_syncing_noop_if_no_feed(self):
        panel = self._make_panel()
        panel._activity_feed = None
        panel.set_activity_syncing(True)  # must not raise
