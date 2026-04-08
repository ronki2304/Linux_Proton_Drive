"""Tests for UI widgets — AccountHeaderBar and related components."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def _setup_mocks():
    gi_mock = MagicMock()
    gtk_mock = MagicMock()
    adw_mock = MagicMock()

    def template_decorator(**kwargs):
        def wrapper(cls):
            return cls
        return wrapper

    gtk_mock.Template = template_decorator
    gtk_mock.Template.Child = MagicMock(return_value=MagicMock())
    gtk_mock.AccessibleProperty = MagicMock()
    gtk_mock.AccessibleProperty.LABEL = "LABEL"

    class FakeBox:
        def __init__(self, **kwargs):
            pass
        def get_style_context(self):
            return MagicMock()
        def update_property(self, props, vals):
            self._accessible_props = props
            self._accessible_vals = vals

    gtk_mock.Box = FakeBox
    gtk_mock.Label = MagicMock
    gtk_mock.LevelBar = MagicMock

    modules = {
        "gi": gi_mock,
        "gi.repository": MagicMock(Gtk=gtk_mock, Adw=adw_mock),
        "gi.repository.Gtk": gtk_mock,
        "gi.repository.Adw": adw_mock,
    }

    for mod in list(sys.modules):
        if "account_header_bar" in mod:
            del sys.modules[mod]

    saved = {}
    for key, val in modules.items():
        saved[key] = sys.modules.get(key)
        sys.modules[key] = val

    import protondrive.widgets.account_header_bar as mod
    mod.Gtk = gtk_mock
    return mod, gtk_mock


_mod, _gtk = _setup_mocks()


def _make_bar():
    bar = object.__new__(_mod.AccountHeaderBar)
    bar.avatar_label = MagicMock()
    bar.account_name_label = MagicMock()
    bar.storage_bar = MagicMock()
    bar.storage_label = MagicMock()
    bar.storage_bar.get_style_context = MagicMock(return_value=MagicMock())
    bar.storage_label.get_style_context = MagicMock(return_value=MagicMock())
    bar.update_property = MagicMock()
    return bar


class TestAccountHeaderBar:

    def test_gtype_name(self) -> None:
        assert _mod.AccountHeaderBar.__gtype_name__ == "ProtonDriveAccountHeaderBar"

    def test_update_sets_initials(self) -> None:
        bar = _make_bar()
        bar.update_account("John Doe", "john@proton.me", 5 * 1024**3, 15 * 1024**3, "Plus")
        bar.avatar_label.set_text.assert_called_with("JD")

    def test_update_sets_display_name(self) -> None:
        bar = _make_bar()
        bar.update_account("Jane Smith", "jane@proton.me", 1024**3, 15 * 1024**3, "Free")
        bar.account_name_label.set_text.assert_called_with("Jane Smith")

    def test_update_sets_storage_bar_value(self) -> None:
        bar = _make_bar()
        bar.update_account("User", "u@p.me", 5 * 1024**3, 10 * 1024**3, "Plus")
        bar.storage_bar.set_value.assert_called_with(0.5)

    def test_storage_label_normal(self) -> None:
        bar = _make_bar()
        bar.update_account("User", "u@p.me", 5 * 1024**3, 15 * 1024**3, "Plus")
        label_text = bar.storage_label.set_text.call_args[0][0]
        assert "5.0 GB" in label_text
        assert "15 GB" in label_text

    def test_storage_label_large_values(self) -> None:
        bar = _make_bar()
        bar.update_account("User", "u@p.me", 50 * 1024**3, 500 * 1024**3, "Visionary")
        label_text = bar.storage_label.set_text.call_args[0][0]
        assert "50 GB" in label_text
        assert "500 GB" in label_text

    def test_accessible_label_set(self) -> None:
        bar = _make_bar()
        bar.update_account("Alice Bob", "a@p.me", 3 * 1024**3, 15 * 1024**3, "Plus")
        bar.update_property.assert_called_once()
        label = bar.update_property.call_args[0][1][0]
        assert "Signed in as Alice Bob" in label
        assert "storage used" in label


class TestStorageThresholds:

    def test_normal_no_warning_class(self) -> None:
        bar = _make_bar()
        bar_ctx = bar.storage_bar.get_style_context()
        bar.update_account("User", "u@p.me", 5 * 1024**3, 10 * 1024**3, "P")
        bar_ctx.add_class.assert_not_called()

    def test_warning_at_91_percent(self) -> None:
        bar = _make_bar()
        bar_ctx = bar.storage_bar.get_style_context()
        bar.update_account("User", "u@p.me", int(9.1 * 1024**3), 10 * 1024**3, "P")
        bar_ctx.add_class.assert_called_with("warning")

    def test_critical_at_995_percent(self) -> None:
        bar = _make_bar()
        bar_ctx = bar.storage_bar.get_style_context()
        bar.update_account("User", "u@p.me", int(9.95 * 1024**3), 10 * 1024**3, "P")
        bar_ctx.add_class.assert_called_with("error")

    def test_storage_full_label(self) -> None:
        bar = _make_bar()
        bar.update_account("User", "u@p.me", int(9.95 * 1024**3), 10 * 1024**3, "P")
        bar.storage_label.set_text.assert_called_with("Storage full")


class TestExtractInitials:

    def test_two_names(self) -> None:
        assert _mod._extract_initials("John Doe") == "JD"

    def test_single_name(self) -> None:
        assert _mod._extract_initials("Alice") == "A"

    def test_three_names(self) -> None:
        assert _mod._extract_initials("John Michael Doe") == "JD"

    def test_empty(self) -> None:
        assert _mod._extract_initials("") == "?"

    def test_lowercase(self) -> None:
        assert _mod._extract_initials("bob smith") == "BS"


class TestFormatBytes:

    def test_small_gb(self) -> None:
        assert _mod._format_bytes(int(1.5 * 1024**3)) == "1.5 GB"

    def test_large_gb(self) -> None:
        assert _mod._format_bytes(50 * 1024**3) == "50 GB"

    def test_zero(self) -> None:
        assert _mod._format_bytes(0) == "0.0 GB"
