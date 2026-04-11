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

    bar.footer_dot = MagicMock()
    bar.footer_label = MagicMock()
    bar.footer_label.get_text = MagicMock(return_value="")
    bar._accessible_label_args = None

    def fake_update_property(props, values):
        bar._accessible_label_args = (props, values)

    bar.update_property = fake_update_property
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
        bar.footer_dot.remove_css_class.assert_called_with("sync-dot-syncing")

    def test_accessible_label_is_all_synced(self):
        bar = _make_bar()
        bar.update_all_synced()
        _, values = bar._accessible_label_args
        assert values == ["All synced"]


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
