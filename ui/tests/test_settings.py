"""Tests for settings page — account info, storage, logout."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def _setup_mocks():
    gi_mock = MagicMock()
    gtk_mock = MagicMock()
    adw_mock = MagicMock()
    gdk_mock = MagicMock()

    def template_decorator(**kwargs):
        def wrapper(cls):
            return cls
        return wrapper

    gtk_mock.Template = template_decorator
    gtk_mock.Template.Child = MagicMock(return_value=MagicMock())
    gtk_mock.License = MagicMock()
    gtk_mock.License.MIT_X11 = "MIT_X11"
    gtk_mock.show_uri = MagicMock()

    class FakeBin:
        def __init__(self, **kwargs):
            pass
        def get_root(self):
            return MagicMock()

    adw_mock.Bin = FakeBin
    adw_mock.ActionRow = MagicMock
    adw_mock.AlertDialog = MagicMock(return_value=MagicMock())
    adw_mock.ResponseAppearance = MagicMock()
    adw_mock.ResponseAppearance.DESTRUCTIVE = "DESTRUCTIVE"
    adw_mock.ResponseAppearance.SUGGESTED = "SUGGESTED"

    gdk_mock.CURRENT_TIME = 0

    modules = {
        "gi": gi_mock,
        "gi.repository": MagicMock(Gtk=gtk_mock, Adw=adw_mock, Gdk=gdk_mock),
        "gi.repository.Gtk": gtk_mock,
        "gi.repository.Adw": adw_mock,
        "gi.repository.Gdk": gdk_mock,
    }

    for mod in list(sys.modules):
        if "protondrive.widgets.settings" in mod:
            del sys.modules[mod]

    saved = {}
    for key, val in modules.items():
        saved[key] = sys.modules.get(key)
        sys.modules[key] = val

    import protondrive.widgets.settings as mod
    mod.Gtk = gtk_mock
    mod.Adw = adw_mock
    mod.Gdk = gdk_mock

    return mod, gtk_mock, adw_mock


_mod, _gtk, _adw = _setup_mocks()


def _make_settings():
    page = object.__new__(_mod.SettingsPage)
    page._logout_callback = None
    page.display_name_row = MagicMock()
    page.email_row = MagicMock()
    page.plan_row = MagicMock()
    page.storage_row = MagicMock()
    page.storage_bar = MagicMock()
    page.storage_bar.get_style_context = MagicMock(return_value=MagicMock())
    page.storage_label = MagicMock()
    page.storage_label.get_style_context = MagicMock(return_value=MagicMock())
    page.manage_account_row = MagicMock()
    page.logout_button = MagicMock()
    return page


class TestSettingsPageMetadata:

    def test_gtype_name(self) -> None:
        assert _mod.SettingsPage.__gtype_name__ == "ProtonDriveSettingsPage"


class TestAccountPopulation:

    def test_populates_display_name(self) -> None:
        p = _make_settings()
        p.update_account("Alice Bob", "alice@proton.me", 1024**3, 15 * 1024**3, "Plus")
        p.display_name_row.set_subtitle.assert_called_with("Alice Bob")

    def test_populates_email(self) -> None:
        p = _make_settings()
        p.update_account("Alice", "alice@proton.me", 1024**3, 15 * 1024**3, "Plus")
        p.email_row.set_subtitle.assert_called_with("alice@proton.me")

    def test_populates_plan(self) -> None:
        p = _make_settings()
        p.update_account("Alice", "a@p.me", 1024**3, 15 * 1024**3, "Visionary")
        p.plan_row.set_subtitle.assert_called_with("Visionary")

    def test_sets_storage_bar_value(self) -> None:
        p = _make_settings()
        p.update_account("U", "u@p.me", 5 * 1024**3, 10 * 1024**3, "P")
        p.storage_bar.set_value.assert_called_with(0.5)


class TestStorageThresholds:

    def test_warning_at_91_percent(self) -> None:
        p = _make_settings()
        bar_ctx = p.storage_bar.get_style_context()
        p.update_account("U", "u@p.me", int(9.1 * 1024**3), 10 * 1024**3, "P")
        bar_ctx.add_class.assert_called_with("warning")

    def test_critical_at_995_percent(self) -> None:
        p = _make_settings()
        bar_ctx = p.storage_bar.get_style_context()
        p.update_account("U", "u@p.me", int(9.95 * 1024**3), 10 * 1024**3, "P")
        bar_ctx.add_class.assert_called_with("error")

    def test_storage_full_label(self) -> None:
        p = _make_settings()
        p.update_account("U", "u@p.me", int(9.95 * 1024**3), 10 * 1024**3, "P")
        p.storage_label.set_text.assert_called_with("Storage full")


class TestLogoutDialog:

    def test_logout_creates_alert_dialog(self) -> None:
        p = _make_settings()
        p.get_root = MagicMock(return_value=MagicMock())
        p._on_logout_clicked(MagicMock())
        _adw.AlertDialog.assert_called_once()
        kwargs = _adw.AlertDialog.call_args[1]
        assert kwargs["heading"] == "Sign out?"
        assert "will not be deleted" in kwargs["body"]

    def test_cancel_response_does_not_logout(self) -> None:
        p = _make_settings()
        called = []
        p.set_logout_callback(lambda: called.append(True))
        p._on_logout_response(MagicMock(), "cancel")
        assert len(called) == 0

    def test_sign_out_response_triggers_callback(self) -> None:
        p = _make_settings()
        called = []
        p.set_logout_callback(lambda: called.append(True))
        p._on_logout_response(MagicMock(), "sign-out")
        assert len(called) == 1


class TestManageAccount:

    def test_opens_proton_account_url(self) -> None:
        p = _make_settings()
        p.get_root = MagicMock(return_value=MagicMock())
        p._on_manage_account(MagicMock())
        _gtk.show_uri.assert_called_once()
        url = _gtk.show_uri.call_args[0][1]
        assert url == "https://account.proton.me"


class TestNoLambda:

    def test_no_lambda_in_init(self) -> None:
        source = inspect.getsource(_mod.SettingsPage.__init__)
        assert "lambda" not in source


class TestWindowIntegration:

    def test_window_has_settings_methods(self) -> None:
        source = (
            Path(__file__).parent.parent / "src" / "protondrive" / "window.py"
        ).read_text()
        assert "def show_settings(" in source
        assert "def show_about(" in source

    def test_main_has_logout(self) -> None:
        source = (
            Path(__file__).parent.parent / "src" / "protondrive" / "main.py"
        ).read_text()
        assert "def logout(" in source
        assert "delete_token" in source
        assert "send_shutdown" in source
        assert "show_pre_auth" in source
