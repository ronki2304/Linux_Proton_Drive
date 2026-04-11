"""Unit tests for SyncPairRow widget.

Widget GTK init is bypassed via object.__new__ so these tests run without
a display. State, accessible label, and CSS class behaviour are validated
through the widget's internal fields.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from protondrive.widgets.sync_pair_row import SyncPairRow


def _make_row(pair_id: str = "p1", pair_name: str = "Documents") -> SyncPairRow:
    """Construct a SyncPairRow without invoking GTK __init__."""
    row = object.__new__(SyncPairRow)
    row._pair_id = pair_id
    row._pair_name = pair_name
    row._state = "synced"

    row.status_dot = MagicMock()
    row.pair_name_label = MagicMock()
    row.status_label = MagicMock()
    row._accessible_label_args = None

    def fake_update_property(props, values):
        row._accessible_label_args = (props, values)

    row.update_property = fake_update_property
    return row


class TestSyncPairRowInit:
    def test_pair_id(self):
        row = _make_row(pair_id="abc-123")
        assert row._pair_id == "abc-123"

    def test_pair_name(self):
        row = _make_row(pair_name="Music")
        assert row._pair_name == "Music"

    def test_initial_state_is_synced(self):
        row = _make_row()
        assert row._state == "synced"


class TestSyncPairRowSetState:
    def test_set_state_syncing_sets_internal_state(self):
        row = _make_row()
        row.set_state("syncing")
        assert row._state == "syncing"

    def test_set_state_synced_sets_internal_state(self):
        row = _make_row()
        row._state = "syncing"
        row.set_state("synced")
        assert row._state == "synced"

    def test_set_state_syncing_adds_css_class(self):
        row = _make_row()
        row.set_state("syncing")
        row.status_dot.add_css_class.assert_called_with("sync-dot-syncing")

    def test_set_state_synced_removes_css_class(self):
        row = _make_row()
        row._state = "syncing"
        row.set_state("synced")
        row.status_dot.remove_css_class.assert_called_with("sync-dot-syncing")

    def test_set_state_syncing_queues_draw(self):
        row = _make_row()
        row.set_state("syncing")
        row.status_dot.queue_draw.assert_called()

    def test_set_state_synced_queues_draw(self):
        row = _make_row()
        row.set_state("synced")
        row.status_dot.queue_draw.assert_called()

    def test_set_state_syncing_updates_status_label(self):
        row = _make_row()
        row.set_state("syncing")
        row.status_label.set_text.assert_called_with("Syncing\u2026")

    def test_set_state_synced_clears_status_label(self):
        row = _make_row()
        row.set_state("synced")
        row.status_label.set_text.assert_called_with("")


class TestSyncPairRowAccessibleLabel:
    def test_syncing_accessible_label(self):
        row = _make_row(pair_name="Photos")
        row.set_state("syncing")
        _, values = row._accessible_label_args
        assert values == ["Photos \u2014 syncing"]

    def test_synced_accessible_label(self):
        row = _make_row(pair_name="Photos")
        row.set_state("synced")
        _, values = row._accessible_label_args
        assert values == ["Photos \u2014 synced"]


class TestSyncPairRowProperty:
    def test_pair_id_property(self):
        row = _make_row(pair_id="xyz")
        assert row.pair_id == "xyz"

    def test_state_property_synced(self):
        row = _make_row()
        assert row.state == "synced"

    def test_state_property_syncing(self):
        row = _make_row()
        row.set_state("syncing")
        assert row.state == "syncing"
