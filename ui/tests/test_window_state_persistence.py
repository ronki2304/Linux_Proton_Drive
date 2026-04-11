"""Unit tests for window state persistence (Story 2.9).

MainWindow GTK init is bypassed via object.__new__; settings and GTK methods
are mocked so tests run without a display.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from gi.repository import Adw

from protondrive.window import MainWindow


def _make_window(width: int = 900, height: int = 600, maximized: bool = False) -> MainWindow:
    """Build a MainWindow bypassing GTK init with controllable geometry."""
    win = object.__new__(MainWindow)
    win._settings = MagicMock()
    win.get_width = MagicMock(return_value=width)
    win.get_height = MagicMock(return_value=height)
    win.is_maximized = MagicMock(return_value=maximized)
    return win


class TestOnCloseRequest:
    def test_saves_width_height_when_not_maximized(self):
        win = _make_window(width=900, height=600, maximized=False)
        win._on_close_request(win)
        win._settings.set_int.assert_any_call("window-width", 900)
        win._settings.set_int.assert_any_call("window-height", 600)

    def test_saves_maximized_false_when_not_maximized(self):
        win = _make_window(maximized=False)
        win._on_close_request(win)
        win._settings.set_boolean.assert_called_with("window-maximized", False)

    def test_saves_maximized_true_when_maximized(self):
        win = _make_window(maximized=True)
        win._on_close_request(win)
        win._settings.set_boolean.assert_called_with("window-maximized", True)

    def test_does_not_save_size_when_maximized(self):
        win = _make_window(width=1920, height=1080, maximized=True)
        win._on_close_request(win)
        win._settings.set_int.assert_not_called()

    def test_returns_false_to_allow_close(self):
        win = _make_window()
        result = win._on_close_request(win)
        assert result is False


class TestGeometryRestore:
    def _make_settings(self, width: int, height: int, maximized: bool) -> MagicMock:
        s = MagicMock()
        s.get_int.side_effect = lambda k: {"window-width": width, "window-height": height}[k]
        s.get_boolean.return_value = maximized
        return s

    def _call_init(self, settings: MagicMock) -> MainWindow:
        """Call MainWindow.__init__ with GTK parent no-oped and GTK methods stubbed.

        Uses object.__new__ to skip GObject allocation, patches
        Adw.ApplicationWindow.__init__ to a no-op, and stubs all GTK instance
        methods called in __init__ so tests run without a display.
        """
        win = object.__new__(MainWindow)
        win.set_default_size = MagicMock()
        win.maximize = MagicMock()
        win.connect = MagicMock()
        win.set_size_request = MagicMock()
        win.pair_detail_panel = MagicMock()
        with patch.object(Adw.ApplicationWindow, "__init__", return_value=None):
            MainWindow.__init__(win, settings=settings)
        return win

    def test_restores_saved_size(self):
        settings = self._make_settings(1024, 768, False)
        win = self._call_init(settings)
        win.set_default_size.assert_called_once_with(1024, 768)
        win.maximize.assert_not_called()

    def test_maximizes_when_flag_set(self):
        settings = self._make_settings(780, 520, True)
        win = self._call_init(settings)
        win.maximize.assert_called_once()

    def test_default_dimensions_from_schema_defaults(self):
        settings = self._make_settings(780, 520, False)
        win = self._call_init(settings)
        win.set_default_size.assert_called_once_with(780, 520)
        win.maximize.assert_not_called()


class TestSchemaKeys:
    """Guard against accidental removal of GSettings keys."""

    def test_window_maximized_key_in_schema(self):
        from pathlib import Path
        schema = (
            Path(__file__).parent.parent
            / "data"
            / "io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml"
        ).read_text()
        assert "window-maximized" in schema
        assert "window-width" in schema
        assert "window-height" in schema
