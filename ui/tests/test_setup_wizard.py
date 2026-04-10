"""Tests for SetupWizard widget (Story 2-4)."""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, call

import pytest

# GI mocks installed by ui/tests/conftest.py at import time.
import protondrive.widgets.setup_wizard as _mod

_glib = sys.modules["gi.repository.GLib"]


def _make_wizard() -> _mod.SetupWizard:
    """Build a SetupWizard bypassing __init__ + GTK template wiring.

    Follows the object.__new__ pattern from test_remote_folder_picker.py.
    """
    wizard = object.__new__(_mod.SetupWizard)
    wizard._engine_client = MagicMock()
    wizard._on_pair_created_cb = MagicMock()
    wizard._on_back_cb = MagicMock()
    wizard._local_path = None
    wizard._remote_picker = MagicMock()
    wizard._pair_id = None
    wizard.back_button = MagicMock()
    wizard.spinner = MagicMock()
    wizard.create_pair_button = MagicMock()
    wizard.error_label = MagicMock()
    wizard.wizard_stack = MagicMock()
    wizard.local_path_label = MagicMock()
    wizard.remote_picker_box = MagicMock()
    wizard.sync_summary_label = MagicMock()
    wizard.done_button = MagicMock()
    return wizard


# --- AC9: Back button ---


class TestBackButton:

    def test_back_button_calls_on_back_cb(self) -> None:
        wizard = _make_wizard()
        _mod.SetupWizard._on_back_clicked(wizard, MagicMock())
        wizard._on_back_cb.assert_called_once()


# --- AC2 / AC3: Create Pair button sensitivity ---


class TestCreatePairButtonSensitivity:

    def test_disabled_when_local_path_none(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = None
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/Documents")
        _mod.SetupWizard._update_create_button(wizard)
        wizard.create_pair_button.set_sensitive.assert_called_with(False)

    def test_disabled_when_remote_path_is_root_only(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = "/home/user/Docs"
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/")
        _mod.SetupWizard._update_create_button(wizard)
        wizard.create_pair_button.set_sensitive.assert_called_with(False)

    def test_enabled_when_both_paths_set(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = "/home/user/Docs"
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/Documents")
        _mod.SetupWizard._update_create_button(wizard)
        wizard.create_pair_button.set_sensitive.assert_called_with(True)


# --- AC3: _on_folder_chosen ---


class TestFolderChosen:

    def test_success_path_updates_local_label_and_rebuilds_picker(self) -> None:
        wizard = _make_wizard()
        wizard._rebuild_remote_picker = MagicMock()  # type: ignore[method-assign]
        wizard._update_create_button = MagicMock()  # type: ignore[method-assign]

        mock_dialog = MagicMock()
        mock_gio_file = MagicMock()
        mock_gio_file.get_path = MagicMock(return_value="/home/user/Sync")
        mock_dialog.select_folder_finish = MagicMock(return_value=mock_gio_file)

        _mod.SetupWizard._on_folder_chosen(wizard, mock_dialog, MagicMock())

        assert wizard._local_path == "/home/user/Sync"
        wizard.local_path_label.set_text.assert_called_with("/home/user/Sync")
        wizard._rebuild_remote_picker.assert_called_once()
        wizard._update_create_button.assert_called_once()

    def test_cancel_path_no_state_change_no_crash(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = "/original"

        mock_dialog = MagicMock()
        mock_dialog.select_folder_finish = MagicMock(
            side_effect=_glib.Error("cancelled")
        )

        # Must not raise
        _mod.SetupWizard._on_folder_chosen(wizard, mock_dialog, MagicMock())

        assert wizard._local_path == "/original"
        wizard.local_path_label.set_text.assert_not_called()


# --- AC4: _on_pair_created ---


class TestOnPairCreated:

    def test_success_transitions_stack_to_syncing_confirmation(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = "/home/user/Docs"
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/Documents")

        _mod.SetupWizard._on_pair_created(wizard, {"pair_id": "uuid-123"})

        assert wizard._pair_id == "uuid-123"
        wizard.wizard_stack.set_visible_child_name.assert_called_with("syncing_confirmation")

    def test_error_shows_inline_label_and_reenables_button(self) -> None:
        wizard = _make_wizard()

        _mod.SetupWizard._on_pair_created(wizard, {"error": "db_write_failed"})

        wizard.error_label.set_visible.assert_called_with(True)
        wizard.create_pair_button.set_sensitive.assert_called_with(True)
        wizard.create_pair_button.set_label.assert_called_with("Create Pair")
        # Stack must NOT navigate away
        wizard.wizard_stack.set_visible_child_name.assert_not_called()

    def test_timeout_error_same_as_error_path(self) -> None:
        wizard = _make_wizard()

        _mod.SetupWizard._on_pair_created(wizard, {"error": "timeout"})

        wizard.error_label.set_visible.assert_called_with(True)
        wizard.create_pair_button.set_sensitive.assert_called_with(True)
        wizard.wizard_stack.set_visible_child_name.assert_not_called()

    def test_success_button_reenabled_not_called(self) -> None:
        """On success we navigate away — button re-enable must NOT be called."""
        wizard = _make_wizard()
        wizard._local_path = "/home/user/Docs"
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/Documents")

        _mod.SetupWizard._on_pair_created(wizard, {"pair_id": "uuid-456"})

        # set_sensitive(True) is NOT called on success path
        for c in wizard.create_pair_button.set_sensitive.call_args_list:
            assert c != call(True), "create_pair_button must not be re-enabled on success"


# --- AC4: _on_done_clicked ---


class TestDoneButton:

    def test_done_button_calls_on_pair_created_cb_with_pair_id(self) -> None:
        wizard = _make_wizard()
        wizard._pair_id = "uuid-done-test"

        _mod.SetupWizard._on_done_clicked(wizard, MagicMock())

        wizard._on_pair_created_cb.assert_called_once_with("uuid-done-test")

    def test_done_button_does_nothing_when_pair_id_is_none(self) -> None:
        wizard = _make_wizard()
        wizard._pair_id = None

        _mod.SetupWizard._on_done_clicked(wizard, MagicMock())

        wizard._on_pair_created_cb.assert_not_called()


# --- AC2: gtype name ---


class TestGtypeName:

    def test_gtype_name_matches_blueprint_template(self) -> None:
        assert _mod.SetupWizard.__gtype_name__ == "ProtonDriveSetupWizard"


# --- Patch: spinner + back_button visibility during creation ---


class TestCreatePairInFlight:

    def test_create_pair_hides_back_button_and_shows_spinner(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = "/home/user/Docs"
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/Documents")

        _mod.SetupWizard._on_create_pair_clicked(wizard, MagicMock())

        wizard.back_button.set_visible.assert_called_with(False)
        wizard.spinner.set_visible.assert_called_with(True)
        wizard.spinner.start.assert_called_once()

    def test_pair_created_success_hides_spinner(self) -> None:
        wizard = _make_wizard()
        wizard._local_path = "/home/user/Docs"
        wizard._remote_picker.get_remote_path = MagicMock(return_value="/Documents")

        _mod.SetupWizard._on_pair_created(wizard, {"pair_id": "uuid-spin"})

        wizard.spinner.stop.assert_called_once()
        wizard.spinner.set_visible.assert_called_with(False)

    def test_pair_created_error_restores_back_button_and_hides_spinner(self) -> None:
        wizard = _make_wizard()

        _mod.SetupWizard._on_pair_created(wizard, {"error": "db_write_failed"})

        wizard.spinner.stop.assert_called_once()
        wizard.spinner.set_visible.assert_called_with(False)
        wizard.back_button.set_visible.assert_called_with(True)
