"""Tests for settings page — account info, storage, logout."""

from __future__ import annotations

import inspect
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# GI mocks installed by ui/tests/conftest.py at import time.
import protondrive.widgets.settings as _mod

_gtk = sys.modules["gi.repository.Gtk"]
_adw = sys.modules["gi.repository.Adw"]


@pytest.fixture(autouse=True)
def _stub_alert_dialog():
    """Replace ``Adw.AlertDialog`` for the duration of each test in this file.

    AlertDialog must return a fresh per-call MagicMock so dialog method
    assertions (add_response, set_response_appearance, etc.) target a single
    instance. Scoping this to a fixture (instead of a module-level mutation)
    keeps the patch from leaking into other test modules that import Adw.
    """
    original = _adw.AlertDialog
    _adw.AlertDialog = MagicMock(return_value=MagicMock())
    try:
        yield
    finally:
        _adw.AlertDialog = original


def _make_settings():
    page = object.__new__(_mod.SettingsPage)
    page._logout_callback = None
    page.display_name_row = MagicMock()
    page.email_row = MagicMock()
    page.plan_row = MagicMock()
    page.storage_row = MagicMock()
    page.storage_bar = MagicMock()
    page.storage_label = MagicMock()
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

    def test_warning_at_90_percent(self) -> None:
        p = _make_settings()
        p.update_account("U", "u@p.me", 9 * 1024**3, 10 * 1024**3, "P")
        p.storage_bar.add_css_class.assert_called_with("warning")

    def test_warning_at_91_percent(self) -> None:
        p = _make_settings()
        p.update_account("U", "u@p.me", int(9.1 * 1024**3), 10 * 1024**3, "P")
        p.storage_bar.add_css_class.assert_called_with("warning")

    def test_critical_at_99_percent(self) -> None:
        p = _make_settings()
        # Use exact integer math: 99% of 100 GB = 99 GB
        p.update_account("U", "u@p.me", 99 * 1024**3, 100 * 1024**3, "P")
        p.storage_bar.add_css_class.assert_called_with("error")

    def test_critical_at_995_percent(self) -> None:
        p = _make_settings()
        p.update_account("U", "u@p.me", int(9.95 * 1024**3), 10 * 1024**3, "P")
        p.storage_bar.add_css_class.assert_called_with("error")

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

    def test_logout_disables_button_during_dialog(self) -> None:
        p = _make_settings()
        p.get_root = MagicMock(return_value=MagicMock())
        p._on_logout_clicked(MagicMock())
        p.logout_button.set_sensitive.assert_called_with(False)

    def test_cancel_response_re_enables_button(self) -> None:
        p = _make_settings()
        p._on_logout_response(MagicMock(), "cancel")
        p.logout_button.set_sensitive.assert_called_with(True)

    def test_cancel_response_does_not_logout(self) -> None:
        p = _make_settings()
        called = []

        def on_logout():
            called.append(True)

        p.set_logout_callback(on_logout)
        p._on_logout_response(MagicMock(), "cancel")
        assert len(called) == 0

    def test_sign_out_response_triggers_callback(self) -> None:
        p = _make_settings()
        called = []

        def on_logout():
            called.append(True)

        p.set_logout_callback(on_logout)
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
