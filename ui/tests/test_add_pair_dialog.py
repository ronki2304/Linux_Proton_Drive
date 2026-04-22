"""Tests for AddPairDialog widget (Story 6-1)."""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

# GI mocks installed by ui/tests/conftest.py at import time.
import protondrive.widgets.add_pair_dialog as _mod

_glib = sys.modules["gi.repository.GLib"]


def _make_dialog() -> _mod.AddPairDialog:
    """Build an AddPairDialog bypassing __init__ + GTK template wiring.

    Follows the object.__new__ pattern established in test_setup_wizard.py.
    """
    dialog = object.__new__(_mod.AddPairDialog)
    dialog._engine_client = MagicMock()
    dialog._local_path = None
    dialog._remote_picker = MagicMock()
    dialog.choose_local_button = MagicMock()
    dialog.local_path_label = MagicMock()
    dialog.remote_picker_box = MagicMock()
    dialog.error_label = MagicMock()
    dialog.spinner = MagicMock()
    dialog.cancel_button = MagicMock()
    dialog.add_pair_button = MagicMock()
    dialog.emit = MagicMock()
    dialog.close = MagicMock()
    return dialog


# --- 8.2: Instantiation ---


class TestInstantiation:

    def test_instantiates_without_errors(self) -> None:
        mock_engine = MagicMock()
        dialog = _mod.AddPairDialog(engine_client=mock_engine)
        assert dialog._engine_client is mock_engine
        assert dialog._local_path is None
        assert dialog._remote_picker is None

    def test_gtype_name_matches_blueprint(self) -> None:
        assert _mod.AddPairDialog.__gtype_name__ == "ProtonDriveAddPairDialog"


# --- 8.3: Add Pair button initial state ---


class TestAddPairButtonInitialState:

    def test_add_pair_button_insensitive_before_folder_chosen(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = None
        dialog._remote_picker.get_remote_path = MagicMock(return_value="/Documents")
        _mod.AddPairDialog._update_add_button(dialog)
        dialog.add_pair_button.set_sensitive.assert_called_with(False)


# --- 8.4a/8.4b: _update_add_button sensitivity ---


class TestUpdateAddButtonSensitivity:

    def test_insensitive_when_remote_is_root_only(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = "/home/user/Sync"
        dialog._remote_picker.get_remote_path = MagicMock(return_value="/")
        _mod.AddPairDialog._update_add_button(dialog)
        dialog.add_pair_button.set_sensitive.assert_called_with(False)

    def test_sensitive_when_both_paths_set(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = "/home/user/Sync"
        dialog._remote_picker.get_remote_path = MagicMock(return_value="/Documents")
        _mod.AddPairDialog._update_add_button(dialog)
        dialog.add_pair_button.set_sensitive.assert_called_with(True)


# --- 8.5: _on_add_pair_clicked sends IPC command ---


class TestOnAddPairClicked:

    def test_sends_add_pair_command(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = "/home/user/Sync"
        dialog._remote_picker.get_remote_path = MagicMock(return_value="/Documents")

        _mod.AddPairDialog._on_add_pair_clicked(dialog, MagicMock())

        dialog._engine_client.send_command_with_response.assert_called_once()
        call_args = dialog._engine_client.send_command_with_response.call_args
        cmd = call_args[0][0]
        assert cmd["type"] == "add_pair"
        assert cmd["payload"]["local_path"] == "/home/user/Sync"
        assert cmd["payload"]["remote_path"] == "/Documents"

    def test_disables_button_and_shows_spinner(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = "/home/user/Sync"
        dialog._remote_picker.get_remote_path = MagicMock(return_value="/Documents")

        _mod.AddPairDialog._on_add_pair_clicked(dialog, MagicMock())

        dialog.add_pair_button.set_sensitive.assert_called_with(False)
        dialog.spinner.set_visible.assert_called_with(True)
        dialog.spinner.start.assert_called_once()
        dialog.error_label.set_visible.assert_called_with(False)


# --- 8.6: _on_pair_created success path ---


class TestOnPairCreatedSuccess:

    def test_emits_pair_created_signal_and_closes(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_pair_created(dialog, {"pair_id": "abc"})

        dialog.emit.assert_called_once_with("pair-created", "abc")
        dialog.close.assert_called_once()

    def test_hides_spinner_on_success(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_pair_created(dialog, {"pair_id": "abc"})

        dialog.spinner.stop.assert_called_once()
        dialog.spinner.set_visible.assert_called_with(False)


# --- 8.7: _on_pair_created error path ---


class TestOnPairCreatedError:

    def test_shows_error_label_and_reenables_button(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_pair_created(dialog, {"error": "db_write_failed"})

        dialog.error_label.set_label.assert_called_with("Failed to add sync pair. Please try again.")
        dialog.error_label.set_visible.assert_called_with(True)
        dialog.add_pair_button.set_sensitive.assert_called_with(True)

    def test_does_not_emit_signal_or_close_on_error(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_pair_created(dialog, {"error": "config_write_failed"})

        dialog.emit.assert_not_called()
        dialog.close.assert_not_called()

    def test_unknown_error_key_uses_fallback(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_pair_created(dialog, {})

        dialog.error_label.set_label.assert_called_with("Failed to add sync pair. Please try again.")
        dialog.error_label.set_visible.assert_called_with(True)

    def test_hides_spinner_on_error(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_pair_created(dialog, {"error": "engine_not_ready"})

        dialog.spinner.stop.assert_called_once()
        dialog.spinner.set_visible.assert_called_with(False)


# --- 8.9: _on_cancel_clicked ---


class TestOnCancelClicked:

    def test_cancel_calls_close(self) -> None:
        dialog = _make_dialog()

        _mod.AddPairDialog._on_cancel_clicked(dialog, None)

        dialog.close.assert_called_once()


# --- 8.10: _on_folder_chosen cancellation guard ---


class TestOnFolderChosenCancellation:

    def test_glib_error_does_not_raise_and_local_path_unchanged(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = None
        dialog._rebuild_remote_picker = MagicMock()  # type: ignore[method-assign]
        dialog._update_add_button = MagicMock()  # type: ignore[method-assign]

        mock_gtk_dialog = MagicMock()
        mock_gtk_dialog.select_folder_finish.side_effect = _glib.Error("cancelled")

        # Must not raise
        _mod.AddPairDialog._on_folder_chosen(dialog, mock_gtk_dialog, MagicMock())

        assert dialog._local_path is None
        dialog.local_path_label.set_label.assert_not_called()
        dialog._rebuild_remote_picker.assert_not_called()

    def test_none_gio_file_does_not_crash(self) -> None:
        dialog = _make_dialog()
        dialog._local_path = None
        dialog._rebuild_remote_picker = MagicMock()  # type: ignore[method-assign]
        dialog._update_add_button = MagicMock()  # type: ignore[method-assign]

        mock_gtk_dialog = MagicMock()
        mock_gtk_dialog.select_folder_finish.return_value = None

        _mod.AddPairDialog._on_folder_chosen(dialog, mock_gtk_dialog, MagicMock())

        assert dialog._local_path is None

    def test_success_path_updates_local_path_and_rebuilds_picker(self) -> None:
        dialog = _make_dialog()
        dialog._rebuild_remote_picker = MagicMock()  # type: ignore[method-assign]
        dialog._update_add_button = MagicMock()  # type: ignore[method-assign]

        mock_gio_file = MagicMock()
        mock_gio_file.get_path.return_value = "/home/user/SyncDir"
        mock_gtk_dialog = MagicMock()
        mock_gtk_dialog.select_folder_finish.return_value = mock_gio_file

        _mod.AddPairDialog._on_folder_chosen(dialog, mock_gtk_dialog, MagicMock())

        assert dialog._local_path == "/home/user/SyncDir"
        dialog.local_path_label.set_label.assert_called_with("/home/user/SyncDir")
        dialog._rebuild_remote_picker.assert_called_once()
        dialog._update_add_button.assert_called_once()
