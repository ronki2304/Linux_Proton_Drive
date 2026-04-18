"""ConflictLog and ConflictLogRow widgets — conflict log panel (Story 4-6)."""

from __future__ import annotations

import os
from typing import Any

from gi.repository import Adw, Gio, GLib, GObject, Gtk


class ConflictLogRow(Adw.ActionRow):
    """One entry in the global conflict log.

    AdwActionRow subclass with programmatic prefix/suffix widgets.
    Rows are created dynamically from _conflict_log_entries dicts.
    """

    __gtype_name__ = "ProtonDriveConflictLogRow"

    def __init__(self, entry: dict[str, Any], **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._conflict_copy_path = entry.get("conflict_copy_path", "")
        local_path = entry.get("local_path", "") or self._conflict_copy_path
        filename = os.path.basename(local_path)
        pair_name = entry.get("pair_name", "")
        date_str = entry.get("date", "")

        subtitle_parts = [p for p in [pair_name, date_str] if p]
        self.set_subtitle("  ·  ".join(subtitle_parts))

        # Warning icon prefix (amber).
        warning_icon = Gtk.Image.new_from_icon_name("dialog-warning-symbolic")
        warning_icon.set_valign(Gtk.Align.CENTER)
        warning_icon.add_css_class("conflict-warning-icon")
        self.add_prefix(warning_icon)

        # "Reveal in Files" button suffix.
        reveal_btn = Gtk.Button.new_with_label(_("Reveal in Files"))
        reveal_btn.add_css_class("flat")
        reveal_btn.set_valign(Gtk.Align.CENTER)
        reveal_btn.connect("clicked", self._on_reveal_clicked)
        self.add_suffix(reveal_btn)

        # Apply resolved or unresolved title style.
        # Pango markup: bold amber for unresolved, strikethrough+dim for resolved.
        if entry.get("resolved", False):
            self._apply_resolved_style(filename)
        else:
            self.set_use_markup(True)
            escaped = GLib.markup_escape_text(filename)
            self.set_title(f'<span color="#f0a020" font_weight="bold">{escaped}</span>')

    def _on_reveal_clicked(self, _btn: Gtk.Button) -> None:
        """Open parent folder in file manager via org.freedesktop.portal.OpenURI."""
        if not self._conflict_copy_path:
            return
        parent_dir = os.path.dirname(self._conflict_copy_path) or os.sep
        try:
            uri = GLib.filename_to_uri(parent_dir, None)
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except GLib.Error:
            pass  # Portal unavailable or user denied — silent failure is acceptable

    def _apply_resolved_style(self, filename: str) -> None:
        """Show strikethrough title and dim the row for resolved conflicts."""
        self.set_use_markup(True)
        escaped = GLib.markup_escape_text(filename)
        self.set_title(f"<s>{escaped}</s>")
        self.add_css_class("dim-label")


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/conflict-log.ui")
class ConflictLog(Adw.Bin):
    """Conflict log panel widget — shows all conflict entries across all pairs."""

    __gtype_name__ = "ProtonDriveConflictLog"

    conflict_log_stack: Gtk.Stack = Gtk.Template.Child()
    conflict_list: Gtk.ListBox = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)

    def set_entries(self, entries: list[dict[str, Any]]) -> None:
        """Populate the conflict list from entries.

        Clears and rebuilds the list on every call. entries is a list of
        dicts with keys: local_path, conflict_copy_path, pair_name, date, resolved.
        """
        # Remove all existing rows.
        self.conflict_list.remove_all()

        if not entries:
            self.conflict_log_stack.set_visible_child_name("empty")
            return

        for entry in entries:
            row = ConflictLogRow(entry)
            self.conflict_list.append(row)

        self.conflict_log_stack.set_visible_child_name("list")
