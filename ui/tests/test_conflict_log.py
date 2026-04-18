"""Tests for ConflictLog and ConflictLogRow (Story 4-6)."""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

from protondrive.widgets.conflict_log import ConflictLog, ConflictLogRow


def _make_entry(
    *,
    local_path: str = "/home/user/Docs/notes.md",
    conflict_copy_path: str = "/home/user/Docs/notes.md.conflict-2026-04-18",
    pair_name: str = "Docs",
    date: str = "2026-04-18",
    resolved: bool = False,
) -> dict:
    return {
        "local_path": local_path,
        "conflict_copy_path": conflict_copy_path,
        "pair_name": pair_name,
        "date": date,
        "resolved": resolved,
    }


class TestConflictLogRow:
    def _make_row(self, **kwargs) -> ConflictLogRow:
        return ConflictLogRow(_make_entry(**kwargs))

    def test_unresolved_row_sets_markup_true_and_calls_set_title(self):
        mock_glib = sys.modules["gi.repository.GLib"]
        mock_glib.markup_escape_text.return_value = "notes.md"
        row = self._make_row(local_path="/home/user/Docs/notes.md")
        # set_use_markup(True) must be called for Pango span to render correctly.
        row.set_use_markup.assert_called_with(True)
        row.set_title.assert_called_once()
        title_arg = row.set_title.call_args[0][0]
        assert "f0a020" in title_arg, "unresolved title must contain amber hex color"
        assert "bold" in title_arg, "unresolved title must use bold weight"
        assert "notes.md" in title_arg, "unresolved title must contain filename"

    def test_subtitle_includes_pair_name_and_date(self):
        row = self._make_row(pair_name="Docs", date="2026-04-18")
        row.set_subtitle.assert_called_once()
        subtitle = row.set_subtitle.call_args[0][0]
        assert "Docs" in subtitle
        assert "2026-04-18" in subtitle

    def test_prefix_warning_icon_added(self):
        row = self._make_row()
        row.add_prefix.assert_called_once()

    def test_suffix_reveal_button_added(self):
        row = self._make_row()
        row.add_suffix.assert_called_once()

    def test_resolved_row_adds_dim_label_class(self):
        row = self._make_row(resolved=True)
        row.add_css_class.assert_any_call("dim-label")

    def test_resolved_row_title_contains_strikethrough_markup(self):
        row = self._make_row(resolved=True)
        # set_title called with <s>...</s> markup
        title_calls = [str(a) for call in row.set_title.call_args_list for a in call[0]]
        assert any("<s>" in t for t in title_calls)

    def test_reveal_clicked_calls_launch_default_for_uri(self):
        row = self._make_row(
            conflict_copy_path="/home/user/Docs/notes.md.conflict-2026-04-18"
        )
        mock_gio = sys.modules["gi.repository.Gio"]
        mock_glib = sys.modules["gi.repository.GLib"]
        mock_gio.AppInfo.launch_default_for_uri.reset_mock()
        mock_glib.filename_to_uri.reset_mock()
        mock_glib.filename_to_uri.return_value = "file:///home/user/Docs"
        row._on_reveal_clicked(MagicMock())
        mock_glib.filename_to_uri.assert_called_once_with("/home/user/Docs", None)
        mock_gio.AppInfo.launch_default_for_uri.assert_called_once_with(
            "file:///home/user/Docs", None
        )

    def test_reveal_clicked_with_empty_path_does_nothing(self):
        row = self._make_row(conflict_copy_path="")
        mock_gio = sys.modules["gi.repository.Gio"]
        mock_gio.AppInfo.launch_default_for_uri.reset_mock()
        row._on_reveal_clicked(MagicMock())
        mock_gio.AppInfo.launch_default_for_uri.assert_not_called()


class TestConflictLog:
    def _make_log(self) -> ConflictLog:
        log = object.__new__(ConflictLog)
        log.conflict_log_stack = MagicMock()
        log.conflict_list = MagicMock()
        return log

    def test_set_entries_empty_shows_empty_page(self):
        log = self._make_log()
        log.set_entries([])
        log.conflict_log_stack.set_visible_child_name.assert_called_with("empty")

    def test_set_entries_nonempty_shows_list_page(self):
        log = self._make_log()
        log.set_entries([_make_entry()])
        log.conflict_log_stack.set_visible_child_name.assert_called_with("list")

    def test_set_entries_appends_one_row_per_entry(self):
        log = self._make_log()
        entries = [_make_entry(), _make_entry(local_path="/tmp/other.txt")]
        log.set_entries(entries)
        assert log.conflict_list.append.call_count == 2

    def test_set_entries_clears_previous_rows_before_repopulating(self):
        log = self._make_log()
        log.set_entries([])
        log.conflict_list.remove_all.assert_called_once()
