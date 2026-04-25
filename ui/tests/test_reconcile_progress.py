"""Tests for the per-pair reconcile progress phase state machine (Story 8-2a)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from protondrive.window import MainWindow


@pytest.fixture()
def mock_glib():
    """Patch window.GLib with a fresh mock for each test."""
    with patch("protondrive.window.GLib") as glib_mock:
        glib_mock.SOURCE_REMOVE = False
        glib_mock.timeout_add_seconds.return_value = MagicMock()
        yield glib_mock


def _make_window_with_pair(pair_id: str = "p1") -> tuple[MainWindow, MagicMock]:
    win = object.__new__(MainWindow)
    row = MagicMock()
    row.state = "syncing"
    row.pair_id = pair_id
    row.pair_name = "Docs"
    win._sync_pair_rows = {pair_id: row}
    win._pairs_data = {pair_id: {}}
    win._pair_phase = {}
    win._phase_watchdog_timers = {}
    win._error_pair_ids = set()
    win._error_pending_cycle = set()
    win._error_messages = {}
    win._conflict_copies_by_pair = {}
    win._folder_missing_pair_ids = set()
    win.pair_detail_panel = MagicMock()
    win.status_footer_bar = MagicMock()
    return win, row


def test_error_event_pair_in_active_phase_transitions_to_paused(mock_glib):
    """AC 1: error event → row 'paused', phase = 'paused', watchdog stays armed."""
    win, row = _make_window_with_pair("p1")
    win._pair_phase["p1"] = "active"
    win._phase_watchdog_timers["p1"] = 99

    win.on_pair_error("p1", "Disk full")

    assert win._pair_phase["p1"] == "paused"
    row.set_state.assert_called_with("paused")
    win.pair_detail_panel.set_error_state.assert_called_with("p1", True, "Disk full")
    # Watchdog was NOT cancelled — still present
    assert "p1" in win._phase_watchdog_timers
    # Spinner off — error-paused pair is not "active"
    win.pair_detail_panel.set_activity_syncing.assert_called_with(False)


def test_error_event_no_prior_phase_keeps_error_state(mock_glib):
    """AC 1: error with no prior active phase → row 'error' (existing behavior)."""
    win, row = _make_window_with_pair("p1")
    # p1 NOT in _pair_phase

    win.on_pair_error("p1", "API error")

    assert "p1" not in win._pair_phase
    row.set_state.assert_called_with("error")


def test_reconcile_progress_active_phase_after_error_resumes(mock_glib):
    """AC 2: reconcile_progress active phase after paused → transitions back to active."""
    win, row = _make_window_with_pair("p1")
    win._pair_phase["p1"] = "paused"

    win.on_reconcile_progress({"pair_id": "p1", "phase": "scanning"})

    assert win._pair_phase["p1"] == "active"
    row.set_state.assert_called_with("syncing")
    mock_glib.timeout_add_seconds.assert_called()
    # Spinner on — pair is now active
    win.pair_detail_panel.set_activity_syncing.assert_called_with(True)


def test_reconcile_progress_idle_after_error_fully_clears(mock_glib):
    """AC 3: reconcile_progress { phase: 'idle' } after error → fully cleared."""
    win, row = _make_window_with_pair("p1")
    win._pair_phase["p1"] = "paused"
    row.state = "paused"
    # Register a watchdog timer that should be cancelled
    win._phase_watchdog_timers["p1"] = 42

    win.on_reconcile_progress({"pair_id": "p1", "phase": "idle"})

    assert "p1" not in win._pair_phase
    mock_glib.source_remove.assert_called_with(42)
    # Row is not in error/conflict so should be set to synced
    row.set_state.assert_called_with("synced")
    # Spinner off — no active pairs remain
    win.pair_detail_panel.set_activity_syncing.assert_called_with(False)


def test_token_expired_pauses_all_active_and_paused_pairs(mock_glib):
    """AC 4: token_expired → all active/paused pairs enter paused_token; watchdogs cancelled."""
    win, _ = _make_window_with_pair("p1")
    # Add extra pairs
    row2 = MagicMock()
    row2.state = "syncing"
    row2.pair_id = "p2"
    row3 = MagicMock()
    row3.state = "syncing"
    row3.pair_id = "p3"
    win._sync_pair_rows["p2"] = row2
    win._sync_pair_rows["p3"] = row3
    win._pairs_data["p2"] = {}
    win._pairs_data["p3"] = {}

    win._pair_phase = {"p1": "active", "p2": "paused", "p3": "paused_token"}
    win._phase_watchdog_timers = {"p1": 11, "p2": 22}

    win.on_token_expired_phase_pause()

    assert win._pair_phase["p1"] == "paused_token"
    assert win._pair_phase["p2"] == "paused_token"
    assert win._pair_phase["p3"] == "paused_token"

    row_p1 = win._sync_pair_rows["p1"]
    row_p1.set_state.assert_called_with("paused")
    row2.set_state.assert_called_with("paused")

    # Watchdog timers 11 and 22 must have been cancelled
    source_remove_calls = [c.args[0] for c in mock_glib.source_remove.call_args_list]
    assert 11 in source_remove_calls
    assert 22 in source_remove_calls
    # Spinner explicitly off after token-expired pause
    win.pair_detail_panel.set_activity_syncing.assert_called_with(False)


def test_reconcile_progress_scanning_after_token_expired_resumes(mock_glib):
    """AC 5: reconcile_progress scanning after token_expired → paused_token → active."""
    win, row = _make_window_with_pair("p1")
    win._pair_phase["p1"] = "paused_token"

    win.on_reconcile_progress({"pair_id": "p1", "phase": "scanning"})

    assert win._pair_phase["p1"] == "active"
    row.set_state.assert_called_with("syncing")
    mock_glib.timeout_add_seconds.assert_called()


def test_watchdog_fires_clears_indicator_silently(mock_glib):
    """AC 6: watchdog fires → indicator cleared, no paused/error shown."""
    win, row = _make_window_with_pair("p1")
    win._pair_phase["p1"] = "active"
    win._phase_watchdog_timers["p1"] = 55
    row.state = "syncing"

    win._on_watchdog_fired("p1")

    assert "p1" not in win._pair_phase
    assert "p1" not in win._phase_watchdog_timers
    # Row should be set to synced (no error, no conflicts)
    row.set_state.assert_called_with("synced")
    # Must NOT have been called with paused or syncing after firing
    calls = [c.args[0] for c in row.set_state.call_args_list]
    assert "paused" not in calls
    # Spinner off — no active pairs remain after watchdog clears
    win.pair_detail_panel.set_activity_syncing.assert_called_with(False)


def test_reconcile_progress_resets_watchdog(mock_glib):
    """AC 7: any reconcile_progress event resets the 30s watchdog for that pair."""
    win, row = _make_window_with_pair("p1")
    win._pair_phase["p1"] = "active"
    win._phase_watchdog_timers["p1"] = 99

    win.on_reconcile_progress({"pair_id": "p1", "phase": "downloading"})

    # Old timer must have been cancelled
    mock_glib.source_remove.assert_called_with(99)
    # New timer must have been created
    mock_glib.timeout_add_seconds.assert_called()


def test_idle_when_already_cleared_is_noop(mock_glib):
    """AC 8: reconcile_progress idle when pair not in _pair_phase → no-op."""
    win, row = _make_window_with_pair("p1")
    # p1 NOT in _pair_phase (already cleared)

    win.on_reconcile_progress({"pair_id": "p1", "phase": "idle"})

    row.set_state.assert_not_called()
    mock_glib.source_remove.assert_not_called()
