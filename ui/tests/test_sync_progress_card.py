"""Unit tests for SyncProgressCard widget.

Widget GTK init is bypassed via object.__new__; mock template children are
attached manually to avoid any GLib/GTK runtime dependency.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

from protondrive.widgets.sync_progress_card import SyncProgressCard, _fmt_bytes


def _make_card() -> SyncProgressCard:
    """Construct a SyncProgressCard without GTK init."""
    card = object.__new__(SyncProgressCard)
    card._pulsing = False
    card._pulse_timer_id = None
    card.progress_bar = MagicMock()
    card.count_label = MagicMock()
    card.bytes_label = MagicMock()
    card.eta_label = MagicMock()
    return card


# ---------------------------------------------------------------------------
# _fmt_bytes
# ---------------------------------------------------------------------------

class TestFmtBytes:
    def test_zero_bytes(self):
        assert _fmt_bytes(0) == "0 B"

    def test_bytes_under_1k(self):
        assert _fmt_bytes(512) == "512 B"

    def test_exact_1_kb(self):
        assert _fmt_bytes(1024) == "1.0 KB"

    def test_kb_range(self):
        assert _fmt_bytes(2048) == "2.0 KB"

    def test_exact_1_mb(self):
        assert _fmt_bytes(1048576) == "1.0 MB"

    def test_mb_range(self):
        assert _fmt_bytes(1572864) == "1.5 MB"

    def test_gb_range(self):
        result = _fmt_bytes(1024**3)
        assert result == "1.0 GB"


# ---------------------------------------------------------------------------
# set_counting
# ---------------------------------------------------------------------------

class TestSetCounting:
    def test_sets_fraction_zero(self):
        card = _make_card()
        card.set_counting()
        card.progress_bar.set_fraction.assert_called_once_with(0.0)

    def test_count_label_text(self):
        card = _make_card()
        card.set_counting()
        card.count_label.set_text.assert_called_once_with("Counting files...")

    def test_bytes_label_cleared(self):
        card = _make_card()
        card.set_counting()
        card.bytes_label.set_text.assert_called_once_with("")

    def test_eta_label_cleared(self):
        card = _make_card()
        card.set_counting()
        card.eta_label.set_text.assert_called_once_with("")

    def test_pulse_timer_scheduled(self):
        card = _make_card()
        card.set_counting()
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.timeout_add.assert_called_with(200, card._pulse)
        assert card._pulsing is True


# ---------------------------------------------------------------------------
# set_progress
# ---------------------------------------------------------------------------

class TestSetProgress:
    def test_fraction_calculation(self):
        card = _make_card()
        card.set_progress(3, 10, 0, 0)
        card.progress_bar.set_fraction.assert_called_once_with(0.3)

    def test_count_label(self):
        card = _make_card()
        card.set_progress(3, 10, 0, 0)
        card.count_label.set_text.assert_called_once_with("3 / 10 files")

    def test_bytes_label(self):
        card = _make_card()
        card.set_progress(3, 10, 2_000_000, 8_000_000)
        # 2_000_000 / 1024**2 ≈ 1.9 MB; 8_000_000 / 1024**2 ≈ 7.6 MB
        card.bytes_label.set_text.assert_called_once_with("1.9 MB / 7.6 MB")

    def test_eta_label(self):
        card = _make_card()
        card.set_progress(3, 10, 0, 0)
        card.eta_label.set_text.assert_called_once_with("--")

    def test_full_fraction(self):
        card = _make_card()
        card.set_progress(10, 10, 0, 0)
        card.progress_bar.set_fraction.assert_called_once_with(1.0)

    def test_zero_total_no_division_error(self):
        card = _make_card()
        card.set_progress(0, 0, 0, 0)
        card.progress_bar.set_fraction.assert_called_once_with(0.0)

    def test_cancels_pulse_before_setting_fraction(self):
        card = _make_card()
        card._pulsing = True
        card._pulse_timer_id = 42
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.source_remove.reset_mock()
        card.set_progress(1, 5, 0, 0)
        glib_mock.source_remove.assert_called_once_with(42)
        assert card._pulsing is False
        assert card._pulse_timer_id is None


# ---------------------------------------------------------------------------
# _pulse
# ---------------------------------------------------------------------------

class TestPulse:
    def test_returns_source_continue_while_pulsing(self):
        card = _make_card()
        card._pulsing = True
        glib_mock = sys.modules["gi.repository.GLib"]
        result = card._pulse()
        card.progress_bar.pulse.assert_called_once()
        assert result == glib_mock.SOURCE_CONTINUE

    def test_returns_source_remove_when_not_pulsing(self):
        card = _make_card()
        card._pulsing = False
        glib_mock = sys.modules["gi.repository.GLib"]
        result = card._pulse()
        card.progress_bar.pulse.assert_not_called()
        assert result == glib_mock.SOURCE_REMOVE

    def test_clears_timer_id_when_not_pulsing(self):
        card = _make_card()
        card._pulsing = False
        card._pulse_timer_id = 99
        card._pulse()
        assert card._pulse_timer_id is None


# ---------------------------------------------------------------------------
# _cancel_pulse
# ---------------------------------------------------------------------------

class TestCancelPulse:
    def test_sets_pulsing_false(self):
        card = _make_card()
        card._pulsing = True
        card._cancel_pulse()
        assert card._pulsing is False

    def test_removes_timer_when_set(self):
        card = _make_card()
        card._pulse_timer_id = 77
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.source_remove.reset_mock()
        card._cancel_pulse()
        glib_mock.source_remove.assert_called_once_with(77)
        assert card._pulse_timer_id is None

    def test_no_remove_when_timer_is_none(self):
        card = _make_card()
        card._pulse_timer_id = None
        glib_mock = sys.modules["gi.repository.GLib"]
        glib_mock.source_remove.reset_mock()
        card._cancel_pulse()
        glib_mock.source_remove.assert_not_called()
