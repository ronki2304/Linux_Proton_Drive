"""Tests for KeyUnlockDialog — password collection dialog for key unlock flow."""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, call

import pytest

# GI mocks installed by conftest.py at import time.
import protondrive.widgets.key_unlock_dialog as _mod

_gtk = sys.modules["gi.repository.Gtk"]
_adw = sys.modules["gi.repository.Adw"]


def _make_dialog() -> _mod.KeyUnlockDialog:
    """Build a KeyUnlockDialog bypassing GTK init; wire child widgets as mocks."""
    dlg = object.__new__(_mod.KeyUnlockDialog)
    dlg.password_entry = MagicMock()
    dlg.unlock_button = MagicMock()
    dlg.cancel_button = MagicMock()
    dlg.error_label = MagicMock()
    return dlg


class TestKeyUnlockDialogMetadata:

    def test_gtype_name(self) -> None:
        assert _mod.KeyUnlockDialog.__gtype_name__ == "ProtonDriveKeyUnlockDialog"

    def test_has_unlock_confirmed_signal(self) -> None:
        assert "unlock-confirmed" in _mod.KeyUnlockDialog.__gsignals__

    def test_has_unlock_cancelled_signal(self) -> None:
        assert "unlock-cancelled" in _mod.KeyUnlockDialog.__gsignals__


class TestUnlockConfirmed:

    def test_emit_unlock_confirmed_on_button_click(self) -> None:
        """Clicking Unlock emits unlock-confirmed with the entered password."""
        dlg = _make_dialog()
        dlg.password_entry.get_text.return_value = "my-secret-password"
        emitted: list[str] = []
        dlg.emit = lambda sig, *args: emitted.append((sig, *args))  # type: ignore[assignment]

        dlg._on_unlock_clicked(None)

        assert len(emitted) == 1
        assert emitted[0][0] == "unlock-confirmed"
        assert emitted[0][1] == "my-secret-password"

    def test_no_emit_when_password_empty(self) -> None:
        """Clicking Unlock with empty input does nothing."""
        dlg = _make_dialog()
        dlg.password_entry.get_text.return_value = ""
        emitted: list = []
        dlg.emit = lambda sig, *args: emitted.append((sig, *args))  # type: ignore[assignment]

        dlg._on_unlock_clicked(None)

        assert emitted == []

    def test_error_label_hidden_on_valid_submit(self) -> None:
        """Successful submit hides the error label."""
        dlg = _make_dialog()
        dlg.password_entry.get_text.return_value = "password"
        dlg.emit = MagicMock()

        dlg._on_unlock_clicked(None)

        dlg.error_label.set_visible.assert_called_with(False)

    def test_enter_key_submits(self) -> None:
        """Pressing Enter in the password field triggers the same path as clicking Unlock."""
        dlg = _make_dialog()
        dlg.password_entry.get_text.return_value = "enter-key-password"
        emitted: list = []
        dlg.emit = lambda sig, *args: emitted.append((sig, *args))  # type: ignore[assignment]

        dlg._on_entry_activate(dlg.password_entry)

        assert len(emitted) == 1
        assert emitted[0][0] == "unlock-confirmed"
        assert emitted[0][1] == "enter-key-password"


class TestUnlockCancelled:

    def test_emit_unlock_cancelled_on_cancel(self) -> None:
        """Clicking Cancel emits unlock-cancelled."""
        dlg = _make_dialog()
        emitted: list = []
        dlg.emit = lambda sig, *args: emitted.append((sig, *args))  # type: ignore[assignment]

        dlg._on_cancel_clicked(MagicMock())

        assert len(emitted) == 1
        assert emitted[0][0] == "unlock-cancelled"


class TestShowError:

    def test_show_error_sets_label_and_makes_visible(self) -> None:
        """show_error() sets the error label text and makes it visible."""
        dlg = _make_dialog()

        dlg.show_error("Incorrect password — please try again")

        dlg.error_label.set_label.assert_called_once_with("Incorrect password — please try again")
        dlg.error_label.set_visible.assert_called_with(True)

    def test_show_error_clears_password_field(self) -> None:
        """show_error() clears the password entry so the user can retype."""
        dlg = _make_dialog()

        dlg.show_error("Incorrect password — please try again")

        dlg.password_entry.set_text.assert_called_once_with("")
