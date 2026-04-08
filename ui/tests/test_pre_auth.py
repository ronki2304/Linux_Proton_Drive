"""Tests for pre-auth screen signal wiring and behavior."""

from __future__ import annotations

import importlib
import inspect
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Build mock GI that preserves decorated classes
_gobject_mock = MagicMock()
_gtk_mock = MagicMock()
_adw_mock = MagicMock()


def _template_decorator(**kwargs):
    """Return the class unmodified, like @Gtk.Template does at import time."""
    def wrapper(cls):
        return cls
    return wrapper


_gtk_mock.Template = _template_decorator
_gtk_mock.Template.Child = MagicMock(return_value=MagicMock())
_gtk_mock.Button = type("Button", (), {})

# Adw.Bin base class
class _FakeBin:
    def __init__(self, **kwargs):
        pass

    def emit(self, signal_name):
        pass

_adw_mock.Bin = _FakeBin

_gi_mock = MagicMock()
_gi_mock.require_version = MagicMock()

sys.modules["gi"] = _gi_mock
sys.modules["gi.repository"] = MagicMock(
    Adw=_adw_mock, Gtk=_gtk_mock, GObject=_gobject_mock
)
sys.modules["gi.repository.Adw"] = _adw_mock
sys.modules["gi.repository.Gtk"] = _gtk_mock
sys.modules["gi.repository.GObject"] = _gobject_mock

# Force reimport
if "protondrive.pre_auth" in sys.modules:
    del sys.modules["protondrive.pre_auth"]
if "protondrive.window" in sys.modules:
    del sys.modules["protondrive.window"]

import protondrive.pre_auth as pre_auth_module


class TestPreAuthScreen:
    """Test PreAuthScreen signal wiring."""

    def test_class_has_correct_gtype_name(self) -> None:
        assert pre_auth_module.PreAuthScreen.__gtype_name__ == "ProtonDrivePreAuthScreen"

    def test_class_defines_sign_in_requested_signal(self) -> None:
        signals = pre_auth_module.PreAuthScreen.__gsignals__
        assert "sign-in-requested" in signals

    def test_sign_in_button_click_emits_signal(self) -> None:
        """Clicking the sign-in button should emit sign-in-requested."""
        screen = object.__new__(pre_auth_module.PreAuthScreen)
        screen.sign_in_button = MagicMock()
        screen.emit = MagicMock()

        # Simulate button click
        screen._on_sign_in_clicked(screen.sign_in_button)

        screen.emit.assert_called_once_with("sign-in-requested")

    def test_no_lambda_in_signal_connection(self) -> None:
        """Signal must be connected with method ref, not lambda (GObject leak)."""
        source = inspect.getsource(pre_auth_module.PreAuthScreen.__init__)
        assert "lambda" not in source

    def test_signal_connection_uses_clicked(self) -> None:
        """Button must connect to 'clicked' signal."""
        source = inspect.getsource(pre_auth_module.PreAuthScreen.__init__)
        assert "'clicked'" in source or '"clicked"' in source


class TestPreAuthWindowIntegration:
    """Test window.py integration with PreAuthScreen."""

    def test_window_module_has_show_pre_auth(self) -> None:
        """MainWindow must expose show_pre_auth for app navigation."""
        # Read the source directly to verify method existence without import issues
        window_path = Path(__file__).parent.parent / "src" / "protondrive" / "window.py"
        source = window_path.read_text()
        assert "def show_pre_auth(" in source
        assert "def show_main(" in source
        assert "def show_auth_browser(" in source
