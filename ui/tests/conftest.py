"""Shared fixtures for UI tests.

GI mocks are installed at conftest module-import time so that test files can
``from protondrive.X import Y`` at their own module top without each test file
having to mutate ``sys.modules`` directly. ``conftest.py`` is loaded by pytest
before any test file is collected, so the mocks are present in ``sys.modules``
by the time ``protondrive`` modules are imported.

This replaces the per-file ``sys.modules`` pollution pattern that was leaking
state across test files as the suite grew past 100 tests (Story 2.0, AC9).

Tests that need direct access to a mock can either:

* Read it via ``sys.modules["gi.repository.X"]`` (read-only — do NOT reassign).
* Request the ``mock_gi`` fixture parameter, which yields the shared root mock.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add source to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


# --- GI mock installation -----------------------------------------------------


def _template_decorator(**kwargs):
    """No-op stand-in for ``@Gtk.Template`` — preserves the decorated class."""

    def wrap(cls):
        return cls

    return wrap


class _FakeWidget:
    """Subclassable stand-in for Adw.Bin / Adw.ApplicationWindow / Gtk.Box.

    The protondrive widgets inherit from these at module-load time, so they
    must be real classes rather than ``MagicMock`` instances. Tests that need
    fully-isolated instances continue to bypass ``__init__`` via
    ``object.__new__(...)`` as before.
    """

    def __init__(self, **kwargs):
        pass

    def emit(self, *args, **kwargs):
        pass

    def get_root(self):
        return MagicMock()


def _build_gi_mocks() -> dict[str, MagicMock]:
    """Build the gi mock graph and return modules ready for ``sys.modules``."""
    gi = MagicMock()
    gi.require_version = MagicMock()

    repo = MagicMock()
    gtk = MagicMock()
    adw = MagicMock()
    gio = MagicMock()
    glib = MagicMock()
    # Real exception class so ``except GLib.Error`` works in protondrive code.
    glib.Error = type("GLibError", (Exception,), {})
    gobject = MagicMock()
    webkit = MagicMock()
    secret = MagicMock()
    gdk = MagicMock()

    gtk.Template = _template_decorator
    gtk.Template.Child = MagicMock(return_value=MagicMock())

    adw.Bin = _FakeWidget
    adw.Application = _FakeWidget
    adw.ApplicationWindow = _FakeWidget
    adw.Dialog = _FakeWidget
    gtk.Box = _FakeWidget
    gtk.ListBoxRow = _FakeWidget

    # Enum-ish constants accessed at protondrive class-body or test-method time.
    webkit.LoadEvent = MagicMock()
    webkit.LoadEvent.COMMITTED = "COMMITTED"
    webkit.LoadEvent.FINISHED = "FINISHED"
    webkit.LoadEvent.STARTED = "STARTED"

    gtk.License = MagicMock()
    gtk.License.MIT_X11 = "MIT_X11"
    gtk.AccessibleProperty = MagicMock()
    gtk.AccessibleProperty.LABEL = "LABEL"
    gtk.AccessibleRole = MagicMock()
    gtk.AccessibleRole.GROUP = "GROUP"
    adw.ResponseAppearance = MagicMock()
    adw.ResponseAppearance.DESTRUCTIVE = "DESTRUCTIVE"
    adw.ResponseAppearance.SUGGESTED = "SUGGESTED"
    gdk.CURRENT_TIME = 0

    # Real X11 keysym values — stable ints, used by RemoteFolderPicker key
    # controller. Without these, key-handler tests would silently compare
    # MagicMock() == MagicMock() (always False) and pass without testing
    # anything.
    gdk.KEY_Escape = 65307
    gdk.KEY_Tab = 65289
    gdk.KEY_Return = 65293

    # Used by RemoteFolderPicker._show_popover for set_position() call.
    gtk.PositionType = MagicMock()
    gtk.PositionType.BOTTOM = "BOTTOM"
    gtk.SelectionMode = MagicMock()
    gtk.SelectionMode.SINGLE = "SINGLE"

    repo.Gio = gio
    repo.GLib = glib
    repo.Gtk = gtk
    repo.Adw = adw
    repo.GObject = gobject
    repo.WebKit = webkit
    repo.Secret = secret
    repo.Gdk = gdk
    gi.repository = repo

    return {
        "gi": gi,
        "gi.repository": repo,
        "gi.repository.Gio": gio,
        "gi.repository.GLib": glib,
        "gi.repository.Gtk": gtk,
        "gi.repository.Adw": adw,
        "gi.repository.GObject": gobject,
        "gi.repository.WebKit": webkit,
        "gi.repository.Secret": secret,
        "gi.repository.Gdk": gdk,
    }


_GI_MOCKS = _build_gi_mocks()
sys.modules.update(_GI_MOCKS)


@pytest.fixture()
def mock_gi():
    """Yield the shared gi mock for tests that want assertion access."""
    return _GI_MOCKS["gi"]
