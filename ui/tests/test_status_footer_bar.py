"""Unit tests for StatusFooterBar widget.

Widget GTK init is bypassed via object.__new__ so these tests run without
a display. Label text, dot state, and accessible label are verified directly.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from protondrive.widgets.status_footer_bar import StatusFooterBar


def _make_bar() -> StatusFooterBar:
    """Construct a StatusFooterBar without invoking GTK __init__."""
    bar = object.__new__(StatusFooterBar)
    bar._dot_state = "synced"
    bar._rate_limit_remaining = 0
    bar._rate_limit_source_id = None

    bar.footer_dot = MagicMock()
    bar.footer_label = MagicMock()
    bar.footer_label.get_text = MagicMock(return_value="")
    bar._accessible_label_args = None

    def fake_update_property(props, values):
        bar._accessible_label_args = (props, values)

    bar.update_property = fake_update_property
    bar.announce = MagicMock()
    return bar


class TestStatusFooterBarSetSyncing:
    def test_label_text_shows_progress(self):
        bar = _make_bar()
        bar.set_syncing("Documents", 3, 10)
        bar.footer_label.set_text.assert_called_with(
            "Syncing 3/10 in Documents\u2026"
        )

    def test_dot_state_becomes_syncing(self):
        bar = _make_bar()
        bar.set_syncing("Documents", 3, 10)
        assert bar._dot_state == "syncing"

    def test_css_class_added(self):
        bar = _make_bar()
        bar.set_syncing("Photos", 1, 5)
        bar.footer_dot.add_css_class.assert_called_with("sync-dot-syncing")

    def test_accessible_label_reflects_text(self):
        bar = _make_bar()
        bar.footer_label.get_text = MagicMock(return_value="Syncing 1/5 in Photos\u2026")
        bar.set_syncing("Photos", 1, 5)
        _, values = bar._accessible_label_args
        assert "Syncing" in values[0]

    def test_zero_progress_label(self):
        bar = _make_bar()
        bar.set_syncing("Music", 0, 0)
        bar.footer_label.set_text.assert_called_with("Syncing 0/0 in Music\u2026")


class TestStatusFooterBarUpdateAllSynced:
    def test_label_text_is_all_synced(self):
        bar = _make_bar()
        bar.update_all_synced()
        bar.footer_label.set_text.assert_called_with("All synced")

    def test_dot_state_becomes_synced(self):
        bar = _make_bar()
        bar._dot_state = "syncing"
        bar.update_all_synced()
        assert bar._dot_state == "synced"

    def test_css_class_removed(self):
        bar = _make_bar()
        bar.update_all_synced()
        bar.footer_dot.remove_css_class.assert_any_call("sync-dot-syncing")

    def test_accessible_label_is_all_synced(self):
        bar = _make_bar()
        bar.update_all_synced()
        _, values = bar._accessible_label_args
        assert values == ["All synced"]


class TestStatusFooterBarSetOffline:
    def test_label_text_is_offline(self):
        bar = _make_bar()
        bar.set_offline()
        bar.footer_label.set_text.assert_called_with("Offline \u2014 changes queued")

    def test_dot_state_becomes_offline(self):
        bar = _make_bar()
        bar.set_offline()
        assert bar._dot_state == "offline"

    def test_css_class_added(self):
        bar = _make_bar()
        bar.set_offline()
        bar.footer_dot.add_css_class.assert_called_with("sync-dot-offline")

    def test_accessible_label_reflects_offline(self):
        bar = _make_bar()
        bar.set_offline()
        _, values = bar._accessible_label_args
        assert values == ["Offline \u2014 changes queued"]

    def test_syncing_css_class_removed_on_offline(self):
        bar = _make_bar()
        bar._dot_state = "syncing"
        bar.set_offline()
        calls = [call.args[0] for call in bar.footer_dot.remove_css_class.call_args_list]
        assert "sync-dot-syncing" in calls

    def test_announce_called_on_offline(self):
        bar = _make_bar()
        bar.set_offline()
        bar.announce.assert_called_once()
        args = bar.announce.call_args[0]
        assert args[0] == "Offline \u2014 changes queued"


class TestStatusFooterBarSetConflictPending:
    """Story 3-3 — set_conflict_pending() + _set_dot_state() remove-all pattern."""

    def test_singular_label_when_count_is_one(self):
        bar = _make_bar()
        bar.set_conflict_pending(1)
        bar.footer_label.set_text.assert_called_with("1 file needs conflict resolution")

    def test_plural_label_when_count_is_three(self):
        bar = _make_bar()
        bar.set_conflict_pending(3)
        bar.footer_label.set_text.assert_called_with("3 files need conflict resolution")

    def test_conflict_css_class_added(self):
        bar = _make_bar()
        bar.set_conflict_pending(2)
        bar.footer_dot.add_css_class.assert_called_with("sync-dot-conflict")

    def test_dot_state_becomes_conflict(self):
        bar = _make_bar()
        bar.set_conflict_pending(2)
        assert bar._dot_state == "conflict"

    def test_offline_class_removed_when_transitioning_to_conflict(self):
        bar = _make_bar()
        bar._dot_state = "offline"
        bar.set_conflict_pending(2)
        calls = [call.args[0] for call in bar.footer_dot.remove_css_class.call_args_list]
        assert "sync-dot-offline" in calls

    def test_syncing_class_removed_when_transitioning_to_conflict(self):
        bar = _make_bar()
        bar._dot_state = "syncing"
        bar.set_conflict_pending(2)
        calls = [call.args[0] for call in bar.footer_dot.remove_css_class.call_args_list]
        assert "sync-dot-syncing" in calls

    def test_dot_draw_renders_amber_in_conflict_state(self):
        bar = _make_bar()
        bar._dot_state = "conflict"
        cr = MagicMock()
        bar._on_dot_draw(MagicMock(), cr, 20, 20)
        cr.set_source_rgb.assert_called_with(0.95, 0.62, 0.14)

    def test_announce_called_with_polite_priority(self):
        bar = _make_bar()
        bar.set_conflict_pending(2)
        bar.announce.assert_called_once()
        args = bar.announce.call_args[0]
        assert args[0] == "2 files need conflict resolution"

    def test_accessible_label_reflects_conflict(self):
        bar = _make_bar()
        bar.set_conflict_pending(4)
        _, values = bar._accessible_label_args
        assert values == ["4 files need conflict resolution"]


class TestStatusFooterBarSetRateLimited:
    """Story 3-4 — set_rate_limited(), countdown timer, and dot color."""

    def test_label_text_shows_resume_in_5s(self):
        bar = _make_bar()
        bar.set_rate_limited(5)
        bar.footer_label.set_text.assert_called_with("Sync paused \u2014 resuming in 5s")

    def test_label_text_shows_resume_in_1s(self):
        bar = _make_bar()
        bar.set_rate_limited(1)
        bar.footer_label.set_text.assert_called_with("Sync paused \u2014 resuming in 1s")

    def test_dot_state_becomes_rate_limited(self):
        bar = _make_bar()
        bar.set_rate_limited(5)
        assert bar._dot_state == "rate_limited"

    def test_glib_timeout_add_called_with_1000ms(self):
        from gi.repository import GLib
        orig_timeout_add = GLib.timeout_add
        try:
            GLib.timeout_add = MagicMock(return_value=42)
            bar = _make_bar()
            bar.set_rate_limited(5)
            GLib.timeout_add.assert_called_once_with(1000, bar._on_rate_limit_tick)
        finally:
            GLib.timeout_add = orig_timeout_add

    def test_announce_called_with_rate_limited_text(self):
        from gi.repository import Gtk
        bar = _make_bar()
        bar.announce = MagicMock()
        bar.set_rate_limited(5)
        bar.announce.assert_called_once_with(
            "Sync paused \u2014 resuming in 5s",
            Gtk.AccessibleAnnouncementPriority.LOW,
        )

    def test_second_call_cancels_first_timer(self):
        from gi.repository import GLib
        orig_timeout_add = GLib.timeout_add
        orig_source_remove = GLib.source_remove
        try:
            GLib.timeout_add = MagicMock(side_effect=[42, 99])
            GLib.source_remove = MagicMock()
            bar = _make_bar()
            bar.set_rate_limited(5)
            bar.set_rate_limited(3)
            GLib.source_remove.assert_called_once_with(42)
        finally:
            GLib.timeout_add = orig_timeout_add
            GLib.source_remove = orig_source_remove

    def test_dot_draw_renders_teal_in_rate_limited_state(self):
        bar = _make_bar()
        bar._dot_state = "rate_limited"
        cr = MagicMock()
        bar._on_dot_draw(MagicMock(), cr, 10, 10)
        cr.set_source_rgb.assert_called_with(0.11, 0.63, 0.63)

    def test_tick_when_state_not_rate_limited_returns_source_remove(self):
        from gi.repository import GLib
        bar = _make_bar()
        bar._dot_state = "synced"
        result = bar._on_rate_limit_tick()
        assert result == GLib.SOURCE_REMOVE

    def test_tick_with_2s_remaining_returns_source_continue_and_updates_label(self):
        from gi.repository import GLib
        bar = _make_bar()
        bar._dot_state = "rate_limited"
        bar._rate_limit_remaining = 2
        result = bar._on_rate_limit_tick()
        assert result == GLib.SOURCE_CONTINUE
        bar.footer_label.set_text.assert_called_with("Sync paused \u2014 resuming in 1s")

    def test_tick_with_0s_remaining_returns_source_remove_and_shows_resuming_shortly(self):
        from gi.repository import GLib
        bar = _make_bar()
        bar._dot_state = "rate_limited"
        bar._rate_limit_remaining = 1  # will be decremented to 0
        result = bar._on_rate_limit_tick()
        assert result == GLib.SOURCE_REMOVE
        bar.footer_label.set_text.assert_called_with("Sync paused \u2014 resuming shortly")


class TestStatusFooterBarSetConflicts:
    """Story 4-4 — set_conflicts() real-time conflict indicator."""

    def test_label_singular(self):
        bar = _make_bar()
        bar.set_conflicts(1)
        bar.footer_label.set_text.assert_called_with("1 conflict needs attention")

    def test_label_plural(self):
        bar = _make_bar()
        bar.set_conflicts(3)
        bar.footer_label.set_text.assert_called_with("3 conflicts need attention")

    def test_dot_state_becomes_conflict(self):
        bar = _make_bar()
        bar.set_conflicts(2)
        assert bar._dot_state == "conflict"

    def test_zero_count_is_no_op(self):
        bar = _make_bar()
        bar.set_conflicts(0)
        bar.footer_label.set_text.assert_not_called()

    def test_accessible_label_set(self):
        bar = _make_bar()
        bar.set_conflicts(2)
        _, values = bar._accessible_label_args
        assert "conflicts need attention" in values[0]

    def test_announce_called(self):
        bar = _make_bar()
        bar.set_conflicts(1)
        bar.announce.assert_called_once()


class TestStatusFooterBarSetInitialising:
    def test_label_text_shows_initialising(self):
        bar = _make_bar()
        bar.set_initialising()
        bar.footer_label.set_text.assert_called_with("Initialising file watcher\u2026")

    def test_dot_state_is_syncing(self):
        bar = _make_bar()
        bar.set_initialising()
        assert bar._dot_state == "syncing"

    def test_css_class_added(self):
        bar = _make_bar()
        bar.set_initialising()
        bar.footer_dot.add_css_class.assert_called_with("sync-dot-syncing")

    def test_accessible_label_reflects_initialising(self):
        bar = _make_bar()
        bar.set_initialising()
        _, values = bar._accessible_label_args
        assert values == ["Initialising file watcher\u2026"]
