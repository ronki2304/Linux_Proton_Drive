"""Unit tests for SyncPairRow widget.

Widget GTK init is bypassed via object.__new__ so these tests run without
a display. State, accessible label, and CSS class behaviour are validated
through the widget's internal fields.
"""

from __future__ import annotations

from unittest.mock import MagicMock, call, patch

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
        row.status_dot.remove_css_class.assert_any_call("sync-dot-syncing")

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


class TestSyncPairRowOfflineState:
    def test_offline_sets_internal_state(self):
        row = _make_row()
        row.set_state("offline")
        assert row._state == "offline"

    def test_offline_with_last_synced_text(self):
        row = _make_row()
        row.set_state("offline", last_synced_text="5m ago")
        row.status_label.set_text.assert_called_with("Offline · 5m ago")

    def test_offline_without_last_synced_text(self):
        row = _make_row()
        row.set_state("offline")
        row.status_label.set_text.assert_called_with("Offline · never synced")

    def test_offline_adds_css_class(self):
        row = _make_row()
        row.set_state("offline")
        row.status_dot.add_css_class.assert_called_with("sync-dot-offline")

    def test_offline_removes_syncing_css_class(self):
        row = _make_row()
        row._state = "syncing"
        row.set_state("offline")
        row.status_dot.remove_css_class.assert_any_call("sync-dot-syncing")

    def test_synced_removes_offline_css_class(self):
        row = _make_row()
        row._state = "offline"
        row.set_state("synced")
        calls = [call.args[0] for call in row.status_dot.remove_css_class.call_args_list]
        assert "sync-dot-offline" in calls

    def test_offline_accessible_label(self):
        row = _make_row(pair_name="Photos")
        row.set_state("offline")
        _, values = row._accessible_label_args
        assert values == ["Photos \u2014 offline"]

    def test_offline_queues_draw(self):
        row = _make_row()
        row.set_state("offline")
        row.status_dot.queue_draw.assert_called()

    def test_state_property_offline(self):
        row = _make_row()
        row.set_state("offline")
        assert row.state == "offline"


class TestSyncPairRowConflictState:
    def test_set_state_conflict_sets_internal_state(self):
        row = _make_row()
        row.set_state("conflict")
        assert row._state == "conflict"

    def test_set_state_conflict_label_singular(self):
        row = _make_row()
        row.set_state("conflict", conflict_count=1)
        row.status_label.set_text.assert_called_with("1 conflict")

    def test_set_state_conflict_label_plural(self):
        row = _make_row()
        row.set_state("conflict", conflict_count=3)
        row.status_label.set_text.assert_called_with("3 conflicts")

    def test_set_state_conflict_adds_css_class(self):
        row = _make_row()
        row.set_state("conflict")
        row.status_dot.add_css_class.assert_called_with("sync-dot-conflict")

    def test_set_state_conflict_removes_other_css_classes(self):
        row = _make_row()
        row.set_state("conflict")
        removed = [c.args[0] for c in row.status_dot.remove_css_class.call_args_list]
        assert "sync-dot-syncing" in removed
        assert "sync-dot-offline" in removed

    def test_set_state_conflict_calls_queue_draw(self):
        row = _make_row()
        row.set_state("conflict")
        row.status_dot.queue_draw.assert_called()

    def test_set_state_conflict_accessible_label_singular(self):
        row = _make_row(pair_name="Documents")
        row.set_state("conflict", conflict_count=1)
        _, values = row._accessible_label_args
        assert values == ["Documents \u2014 1 conflict"]

    def test_set_state_conflict_accessible_label_always_singular(self):
        row = _make_row(pair_name="Documents")
        row.set_state("conflict", conflict_count=5)
        _, values = row._accessible_label_args
        # AC2: accessible label is always singular
        assert values == ["Documents \u2014 1 conflict"]


class TestSyncPairRowErrorState:
    """set_state('error') — red dot, 'Sync error' label, accessible label (Story 5-5 AC3)."""

    def test_error_sets_internal_state(self):
        row = _make_row()
        row.set_state("error")
        assert row._state == "error"

    def test_error_sets_status_label(self):
        row = _make_row()
        row.set_state("error")
        row.status_label.set_text.assert_called_with("Sync error")

    def test_error_removes_syncing_css_class(self):
        row = _make_row()
        row.set_state("error")
        removed = [c.args[0] for c in row.status_dot.remove_css_class.call_args_list]
        assert "sync-dot-syncing" in removed

    def test_error_removes_offline_css_class(self):
        row = _make_row()
        row.set_state("error")
        removed = [c.args[0] for c in row.status_dot.remove_css_class.call_args_list]
        assert "sync-dot-offline" in removed

    def test_error_removes_conflict_css_class(self):
        row = _make_row()
        row.set_state("error")
        removed = [c.args[0] for c in row.status_dot.remove_css_class.call_args_list]
        assert "sync-dot-conflict" in removed

    def test_error_does_not_add_any_css_class(self):
        row = _make_row()
        row.set_state("error")
        row.status_dot.add_css_class.assert_not_called()

    def test_error_queues_draw(self):
        row = _make_row()
        row.set_state("error")
        row.status_dot.queue_draw.assert_called()

    def test_error_accessible_label(self):
        row = _make_row(pair_name="Documents")
        row.set_state("error")
        _, values = row._accessible_label_args
        assert values == ["Documents \u2014 error"]

    def test_state_property_error(self):
        row = _make_row()
        row.set_state("error")
        assert row.state == "error"


class TestSyncPairRowDrawDot:
    def test_conflict_colour_is_amber(self):
        row = _make_row()
        row._state = "conflict"
        cr = MagicMock()
        row._draw_dot(None, cr, 8, 8)
        cr.set_source_rgb.assert_called_once_with(0.95, 0.62, 0.14)

    def test_error_colour_is_red(self):
        row = _make_row()
        row._state = "error"
        cr = MagicMock()
        row._draw_dot(None, cr, 8, 8)
        cr.set_source_rgb.assert_called_once_with(0.87, 0.19, 0.19)


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
