"""Tests for RemoteFolderPicker widget (Story 2-3)."""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

# GI mocks installed by ui/tests/conftest.py at import time.
import protondrive.widgets.remote_folder_picker as _mod

_gtk = sys.modules["gi.repository.Gtk"]
_gdk = sys.modules["gi.repository.Gdk"]


def _make_picker(local_path: str | None = "/home/user/Documents") -> _mod.RemoteFolderPicker:
    """Build a RemoteFolderPicker bypassing __init__ + GTK template wiring.

    Mirrors test_widgets.py's instantiation pattern: GI mocks make full
    instantiation impossible, so we attach MagicMock children for the
    Template.Child slots and re-run only the parts of __init__ that don't
    require a real GTK widget tree.
    """
    picker = object.__new__(_mod.RemoteFolderPicker)
    picker.path_entry = MagicMock()
    # Default to "/" so methods that read get_text (e.g. _on_row_activated's
    # rpartition) get a real string instead of a MagicMock. Tests that need
    # a different value override per-test.
    picker.path_entry.get_text = MagicMock(return_value="/")
    picker.path_hint_label = MagicMock()
    picker.header_label = MagicMock()
    picker.browse_link = MagicMock()
    picker._engine_client = MagicMock()
    picker._cached_folders = None
    picker._popover = None
    picker._popover_listbox = None
    picker._changed_handler_id = None  # set by __init__ in production
    if local_path is not None:
        _mod.RemoteFolderPicker._set_default_text(picker, local_path)
    return picker


# --- AC1: default text + sanitization ---


class TestDefaultText:

    def test_basename_extracted_from_local_path(self) -> None:
        picker = _make_picker(local_path="/home/user/Documents")
        picker.path_entry.set_text.assert_called_with("/Documents")

    def test_trailing_slash_stripped_from_local_path(self) -> None:
        picker = _make_picker(local_path="/home/user/Photos/")
        picker.path_entry.set_text.assert_called_with("/Photos")

    def test_none_local_path_falls_back_to_root(self) -> None:
        picker = _make_picker(local_path=None)
        # No call expected because _set_default_text was skipped — call directly.
        _mod.RemoteFolderPicker._set_default_text(picker, None)
        picker.path_entry.set_text.assert_called_with("/")

    def test_empty_local_path_falls_back_to_root(self) -> None:
        picker = _make_picker(local_path=None)
        _mod.RemoteFolderPicker._set_default_text(picker, "")
        picker.path_entry.set_text.assert_called_with("/")

    def test_root_only_local_path_falls_back_to_root(self) -> None:
        picker = _make_picker(local_path=None)
        _mod.RemoteFolderPicker._set_default_text(picker, "/")
        picker.path_entry.set_text.assert_called_with("/")

    def test_disallowed_characters_sanitized(self) -> None:
        picker = _make_picker(local_path=None)
        _mod.RemoteFolderPicker._set_default_text(picker, "/home/user/Foo:Bar")
        picker.path_entry.set_text.assert_called_with("/Foo_Bar")

    def test_hint_label_visible_when_sanitization_occurred(self) -> None:
        picker = _make_picker(local_path=None)
        _mod.RemoteFolderPicker._set_default_text(picker, "/home/user/Foo*Bar")
        picker.path_hint_label.set_text.assert_called_with("Some characters were replaced")
        picker.path_hint_label.set_visible.assert_called_with(True)

    def test_hint_label_not_shown_when_no_sanitization(self) -> None:
        picker = _make_picker(local_path=None)
        # Reset any earlier hint mutation from a previous _make_picker call
        picker.path_hint_label.reset_mock()
        _mod.RemoteFolderPicker._set_default_text(picker, "/home/user/Documents")
        picker.path_hint_label.set_visible.assert_not_called()


# --- AC3: get_remote_path normalization ---


class TestPathNormalization:

    def _picker_with_text(self, text: str) -> _mod.RemoteFolderPicker:
        picker = _make_picker(local_path=None)
        picker.path_entry.get_text = MagicMock(return_value=text)
        return picker

    def test_leading_slash_added_when_missing(self) -> None:
        picker = self._picker_with_text("Documents")
        assert picker.get_remote_path() == "/Documents"

    def test_trailing_slash_stripped(self) -> None:
        picker = self._picker_with_text("/Documents/")
        assert picker.get_remote_path() == "/Documents"

    def test_double_slashes_collapsed(self) -> None:
        picker = self._picker_with_text("/Work//2026")
        assert picker.get_remote_path() == "/Work/2026"

    def test_empty_returns_root(self) -> None:
        picker = self._picker_with_text("")
        assert picker.get_remote_path() == "/"

    def test_whitespace_returns_root(self) -> None:
        picker = self._picker_with_text("   ")
        assert picker.get_remote_path() == "/"

    def test_nested_path_passed_through(self) -> None:
        picker = self._picker_with_text("/Work/Projects/2026")
        assert picker.get_remote_path() == "/Work/Projects/2026"

    def test_root_only_returns_root(self) -> None:
        picker = self._picker_with_text("/")
        assert picker.get_remote_path() == "/"


# --- AC2: _filter_folders pure function ---


_SAMPLE_FOLDERS: list[dict] = [
    {"id": "1", "name": "Documents", "parent_id": None},
    {"id": "2", "name": "Docs", "parent_id": None},
    {"id": "3", "name": "Music", "parent_id": None},
    {"id": "4", "name": "Photos", "parent_id": None},
    {"id": "5", "name": "Archive", "parent_id": None},
]


class TestFilterFolders:

    def test_substring_match_case_insensitive(self) -> None:
        result = _mod._filter_folders(_SAMPLE_FOLDERS, "doc")
        names = [f["name"] for f in result]
        assert set(names) == {"Documents", "Docs"}

    def test_substring_match_uppercase(self) -> None:
        result = _mod._filter_folders(_SAMPLE_FOLDERS, "DOC")
        assert len(result) == 2

    def test_empty_substring_returns_first_n_alphabetical(self) -> None:
        result = _mod._filter_folders(_SAMPLE_FOLDERS, "")
        names = [f["name"] for f in result]
        # Sorted alphabetically (case-insensitive)
        assert names == ["Archive", "Docs", "Documents", "Music", "Photos"]

    def test_max_rows_override(self) -> None:
        result = _mod._filter_folders(_SAMPLE_FOLDERS, "", max_rows=2)
        assert len(result) == 2
        # First two alphabetically
        assert [f["name"] for f in result] == ["Archive", "Docs"]

    def test_default_max_rows_caps_empty_query(self) -> None:
        big_cache = [{"id": str(i), "name": f"f{i:02}"} for i in range(50)]
        result = _mod._filter_folders(big_cache, "")
        assert len(result) == _mod._MAX_AUTOCOMPLETE_ROWS

    def test_empty_cache(self) -> None:
        assert _mod._filter_folders([], "doc") == []
        assert _mod._filter_folders([], "") == []

    def test_no_matches_returns_empty(self) -> None:
        assert _mod._filter_folders(_SAMPLE_FOLDERS, "xyz") == []

    def test_folder_with_missing_name_field_does_not_crash(self) -> None:
        cache = [{"id": "1"}, {"id": "2", "name": "Documents"}]
        result = _mod._filter_folders(cache, "doc")
        assert len(result) == 1
        assert result[0]["name"] == "Documents"

    def test_folder_with_none_name_field_does_not_crash(self) -> None:
        cache = [{"id": "1", "name": None}, {"id": "2", "name": "Documents"}]
        result = _mod._filter_folders(cache, "doc")
        assert len(result) == 1


# --- AC2: autocomplete fetch + cache ---


class TestAutocompleteFetch:

    def _picker(self) -> _mod.RemoteFolderPicker:
        picker = _make_picker(local_path=None)
        picker.path_entry.set_text.reset_mock()
        # _refresh_popover needs get_text + the popover dance — stub them out
        # so this class can focus on the cache + fetch behavior.
        picker.path_entry.get_text = MagicMock(return_value="/Doc")
        picker._refresh_popover = MagicMock()  # type: ignore[method-assign]
        return picker

    def test_first_keystroke_triggers_fetch(self) -> None:
        picker = self._picker()
        _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        assert picker._engine_client.send_command_with_response.call_count == 1
        # Verify the command shape locks the IPC contract.
        call_args = picker._engine_client.send_command_with_response.call_args
        cmd = call_args.args[0]
        assert cmd["type"] == "list_remote_folders"
        assert cmd["payload"] == {"parent_id": None}

    def test_subsequent_keystrokes_do_not_refetch(self) -> None:
        picker = self._picker()
        # First fetch
        _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        # Simulate cache populated
        picker._cached_folders = [{"id": "1", "name": "Documents"}]
        # 5 more keystrokes
        for _ in range(5):
            _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        assert picker._engine_client.send_command_with_response.call_count == 1

    def test_concurrent_fetch_race_two_callbacks(self) -> None:
        """C1 coverage: two _fetch_folders calls before any response."""
        picker = self._picker()
        # Two racing fetches register independent callbacks.
        _mod.RemoteFolderPicker._fetch_folders(picker)
        _mod.RemoteFolderPicker._fetch_folders(picker)
        assert picker._engine_client.send_command_with_response.call_count == 2

        # Capture both registered callbacks (the second arg of each call).
        calls = picker._engine_client.send_command_with_response.call_args_list
        callback_a = calls[0].args[1]
        callback_b = calls[1].args[1]

        folders = [{"id": "1", "name": "Documents"}]
        # First response populates cache.
        callback_a({"folders": folders})
        assert picker._cached_folders == folders
        # Second response harmlessly overwrites with same data — no exception.
        callback_b({"folders": folders})
        assert picker._cached_folders == folders

    def test_empty_response_sets_cache_to_empty_list(self) -> None:
        picker = self._picker()
        _mod.RemoteFolderPicker._on_folders_received(picker, {"folders": []})
        assert picker._cached_folders == []

    def test_error_response_sets_cache_to_empty_list_no_raise(self) -> None:
        picker = self._picker()
        # Should NOT raise even though IPC reported an error.
        _mod.RemoteFolderPicker._on_folders_received(picker, {"error": "engine_not_ready"})
        assert picker._cached_folders == []

    def test_malformed_response_sets_cache_to_empty(self) -> None:
        picker = self._picker()
        _mod.RemoteFolderPicker._on_folders_received(picker, {"folders": "not a list"})
        assert picker._cached_folders == []


class TestAutocompleteFetchErrorLog:
    """O1 coverage — IPC error path emits to stderr."""

    def test_error_response_logged_to_stderr(self, capsys: pytest.CaptureFixture[str]) -> None:
        picker = _make_picker(local_path=None)
        _mod.RemoteFolderPicker._on_folders_received(
            picker, {"error": "engine_not_ready"}
        )
        captured = capsys.readouterr()
        assert "RemoteFolderPicker IPC error" in captured.err
        assert "engine_not_ready" in captured.err


class TestTimeoutLeakPrevention:
    """D1 coverage — after a silent IPC timeout, the picker must transition
    to a terminal state and stop refetching on every keystroke."""

    def test_timeout_error_stops_subsequent_refetches(self) -> None:
        picker = _make_picker(local_path=None)
        picker.path_entry.get_text = MagicMock(return_value="/Doc")
        picker._refresh_popover = MagicMock()  # type: ignore[method-assign]

        # First keystroke: triggers a fetch.
        _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        assert picker._engine_client.send_command_with_response.call_count == 1

        # Engine times out — D1 fix: callback fires with {"error": "timeout"}.
        _mod.RemoteFolderPicker._on_folders_received(picker, {"error": "timeout"})

        # Cache is now [] (terminal). Subsequent keystrokes must NOT
        # re-trigger send_command_with_response, even though substring is
        # still non-empty.
        for _ in range(10):
            _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        assert picker._engine_client.send_command_with_response.call_count == 1

    def test_engine_restart_error_stops_refetches(self) -> None:
        picker = _make_picker(local_path=None)
        picker.path_entry.get_text = MagicMock(return_value="/Doc")
        picker._refresh_popover = MagicMock()  # type: ignore[method-assign]

        _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        assert picker._engine_client.send_command_with_response.call_count == 1

        _mod.RemoteFolderPicker._on_folders_received(
            picker, {"error": "engine_restarted"}
        )

        for _ in range(10):
            _mod.RemoteFolderPicker._on_text_changed(picker, picker.path_entry)
        assert picker._engine_client.send_command_with_response.call_count == 1


# --- AC4: keyboard navigation ---


class TestKeyboardNav:

    def _picker_with_popover(self, *, visible: bool) -> _mod.RemoteFolderPicker:
        picker = _make_picker(local_path=None)
        picker._popover = MagicMock()
        picker._popover.get_visible = MagicMock(return_value=visible)
        picker._popover_listbox = MagicMock()
        return picker

    def test_escape_with_popover_visible_hides_and_consumes(self) -> None:
        picker = self._picker_with_popover(visible=True)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Escape, 0, MagicMock()
        )
        assert result is True
        picker._popover.popdown.assert_called_once()

    def test_escape_with_popover_hidden_propagates(self) -> None:
        picker = self._picker_with_popover(visible=False)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Escape, 0, MagicMock()
        )
        assert result is False  # propagate so wizard can handle Escape

    def test_escape_without_popover_propagates(self) -> None:
        picker = _make_picker(local_path=None)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Escape, 0, MagicMock()
        )
        assert result is False

    def test_tab_with_popover_visible_focuses_first_row(self) -> None:
        picker = self._picker_with_popover(visible=True)
        first_row = MagicMock()
        picker._popover_listbox.get_row_at_index = MagicMock(return_value=first_row)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Tab, 0, MagicMock()
        )
        assert result is True
        first_row.grab_focus.assert_called_once()

    def test_tab_with_no_rows_does_not_consume(self) -> None:
        picker = self._picker_with_popover(visible=True)
        picker._popover_listbox.get_row_at_index = MagicMock(return_value=None)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Tab, 0, MagicMock()
        )
        assert result is False  # no row to focus → propagate

    def test_return_with_selected_row_activates_it(self) -> None:
        picker = self._picker_with_popover(visible=True)
        selected = MagicMock()
        selected.folder_data = {"name": "Documents"}
        picker._popover_listbox.get_selected_row = MagicMock(return_value=selected)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Return, 0, MagicMock()
        )
        assert result is True
        # _on_row_activated set the entry text to the folder name
        picker.path_entry.set_text.assert_called_with("/Documents")

    def test_return_without_selection_propagates(self) -> None:
        picker = self._picker_with_popover(visible=True)
        picker._popover_listbox.get_selected_row = MagicMock(return_value=None)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), _gdk.KEY_Return, 0, MagicMock()
        )
        assert result is False

    def test_other_keys_propagate(self) -> None:
        picker = self._picker_with_popover(visible=True)
        result = _mod.RemoteFolderPicker._on_key_pressed(
            picker, MagicMock(), 99999, 0, MagicMock()
        )
        assert result is False


# --- AC3: browse link is inert ---


class TestBrowseLink:
    """E3 coverage — browse_link is a flat Gtk.Button, not a LinkButton."""

    def test_blueprint_uses_button_not_link_button(self) -> None:
        # Read the .blp source file to confirm Button (not LinkButton) is used.
        from pathlib import Path
        blp_path = (
            Path(__file__).parent.parent
            / "data"
            / "ui"
            / "remote-folder-picker.blp"
        )
        content = blp_path.read_text()
        assert "Gtk.Button browse_link" in content
        assert "Gtk.LinkButton" not in content
        assert "sensitive: false" in content
        assert "Tree browser coming in V1" in content


# --- AC1: gtype name ---


class TestGtypeName:

    def test_gtype_name_matches_blueprint_template(self) -> None:
        assert (
            _mod.RemoteFolderPicker.__gtype_name__
            == "ProtonDriveRemoteFolderPicker"
        )
