"""RemoteFolderPicker — text input + autocomplete for selecting a ProtonDrive folder."""

from __future__ import annotations

import os
import re
import sys
from typing import Any

from gi.repository import Gdk, Gtk

# Characters disallowed in ProtonDrive folder names per Proton Drive limits.
# Includes ASCII control chars (\x00-\x1f) which are technically valid in
# Linux filenames but rejected by ProtonDrive.
_DISALLOWED_NAME_CHARS = re.compile(r'[\x00-\x1f\\:*?"<>|]')
_MAX_AUTOCOMPLETE_ROWS = 10


def _filter_folders(
    cache: list[dict[str, Any]],
    substring: str,
    max_rows: int = _MAX_AUTOCOMPLETE_ROWS,
) -> list[dict[str, Any]]:
    """Filter cached folders by case-insensitive substring.

    Empty substring returns the first ``max_rows`` folders sorted alphabetically
    by name. Non-empty substring returns folders whose name contains the
    substring (case-insensitive). Returns an empty list when no folders match.

    Pure function — no GTK, no I/O. The single source of truth for AC2 filter
    semantics, called by ``RemoteFolderPicker._refresh_popover`` and tested
    directly without instantiating any widget.
    """
    if substring:
        needle = substring.lower()
        return [
            f for f in cache if needle in (f.get("name", "") or "").lower()
        ][:max_rows]
    return sorted(
        cache,
        key=lambda f: (f.get("name", "") or "").lower(),
    )[:max_rows]


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/remote-folder-picker.ui")
class RemoteFolderPicker(Gtk.Box):
    """Embeddable picker for choosing a ProtonDrive folder path."""

    __gtype_name__ = "ProtonDriveRemoteFolderPicker"

    header_label: Gtk.Label = Gtk.Template.Child()
    path_entry: Gtk.Entry = Gtk.Template.Child()
    path_hint_label: Gtk.Label = Gtk.Template.Child()
    browse_link: Gtk.Button = Gtk.Template.Child()

    def __init__(
        self,
        engine_client: Any,
        local_folder_path: str | None = None,
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)
        self._engine_client = engine_client
        # None = never fetched. Empty list = fetched, no folders (or fetch
        # failed — silently treated as empty per AC2). Populated list =
        # cached. The single gate is ``_cached_folders is None`` — there is
        # NO ``_fetch_inflight`` flag (see story Dev Notes "Why no
        # _fetch_inflight" for the deadlock rationale).
        self._cached_folders: list[dict[str, Any]] | None = None
        self._popover: Gtk.Popover | None = None
        self._popover_listbox: Gtk.ListBox | None = None
        # Stored so _on_row_activated can block re-entry through the
        # ``changed`` signal when it programmatically updates the entry text.
        self._changed_handler_id: int | None = None

        self._set_default_text(local_folder_path)
        self._changed_handler_id = self.path_entry.connect(
            "changed", self._on_text_changed
        )
        self._install_key_controller()
        self.set_accessible_role(Gtk.AccessibleRole.GROUP)
        # GTK4: popovers attached via set_parent() require explicit unparent()
        # cleanup or they leak. Tie cleanup to widget unrealize.
        self.connect("unrealize", self._on_unrealize)

    # ---- Default text + sanitization ----

    def _set_default_text(self, local_folder_path: str | None) -> None:
        if not local_folder_path:
            self.path_entry.set_text("/")
            return
        basename = os.path.basename(local_folder_path.rstrip("/"))
        if not basename:
            self.path_entry.set_text("/")
            return
        sanitized = _DISALLOWED_NAME_CHARS.sub("_", basename)
        self.path_entry.set_text(f"/{sanitized}")
        if sanitized != basename:
            self.path_hint_label.set_text("Some characters were replaced")
            self.path_hint_label.set_visible(True)

    # ---- Public API ----

    def get_remote_path(self) -> str:
        text = (self.path_entry.get_text() or "").strip()
        if not text:
            return "/"
        if not text.startswith("/"):
            text = "/" + text
        text = re.sub(r"/+", "/", text)
        text = text.rstrip("/") or "/"
        return text

    # ---- Autocomplete ----

    def _on_text_changed(self, _entry: Gtk.Entry) -> None:
        if self._cached_folders is None:
            self._fetch_folders()
        self._refresh_popover()

    def _fetch_folders(self) -> None:
        # No in-flight flag. Two racing fetches register independent
        # callbacks (each with its own UUID); whichever lands first
        # populates the cache, the second is a harmless overwrite. This
        # avoids the deadlock where a silent IPC timeout would otherwise
        # leave an in-flight flag set forever.
        self._engine_client.send_command_with_response(
            {"type": "list_remote_folders", "payload": {"parent_id": None}},
            self._on_folders_received,
        )

    def _on_folders_received(self, payload: dict[str, Any]) -> None:
        if "error" in payload:
            print(
                f"RemoteFolderPicker IPC error: {payload['error']}",
                file=sys.stderr,
            )
            self._cached_folders = []  # one-shot — never retry in this story
            return
        folders = payload.get("folders", [])
        if not isinstance(folders, list):
            self._cached_folders = []
            return
        # Defensive: a malformed engine response could include non-dict
        # entries; downstream _filter_folders calls .get on each item.
        self._cached_folders = [f for f in folders if isinstance(f, dict)]
        self._refresh_popover()

    def _refresh_popover(self) -> None:
        if self._cached_folders is None:
            return  # not loaded yet
        text = self.path_entry.get_text() or ""
        substring = text.rsplit("/", 1)[-1]
        matches = _filter_folders(self._cached_folders, substring)
        if not matches:
            self._hide_popover()
            return
        self._show_popover(matches)

    def _show_popover(self, matches: list[dict[str, Any]]) -> None:
        if self._popover is None:
            self._popover = Gtk.Popover()
            self._popover.set_parent(self.path_entry)
            self._popover.set_autohide(False)
            self._popover.set_has_arrow(False)
            # Anchor below the entry. Without this, GTK auto-positions and
            # may render the popover above the entry near a window edge,
            # covering the wizard header.
            self._popover.set_position(Gtk.PositionType.BOTTOM)
            self._popover_listbox = Gtk.ListBox()
            self._popover_listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
            self._popover_listbox.connect("row-activated", self._on_row_activated)
            self._popover.set_child(self._popover_listbox)
        assert self._popover_listbox is not None
        # Replace rows
        child = self._popover_listbox.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self._popover_listbox.remove(child)
            child = next_child
        for folder in matches:
            row = Gtk.ListBoxRow()
            row.set_child(Gtk.Label(label=folder.get("name", ""), xalign=0))
            row.folder_data = folder  # type: ignore[attr-defined]
            self._popover_listbox.append(row)
        self._popover.popup()

    def _hide_popover(self) -> None:
        if self._popover is not None:
            self._popover.popdown()

    def _on_unrealize(self, _widget: Gtk.Widget) -> None:
        """Release the popover that was attached via Gtk.Popover.set_parent.

        GTK4 popovers parented this way are not part of the normal widget
        tree and require explicit ``unparent()`` to release the reference;
        otherwise the popover leaks and emits critical warnings on next show.
        """
        if self._popover is not None:
            try:
                self._popover.unparent()
            except Exception:
                pass  # parent may already be torn down
            self._popover = None
            self._popover_listbox = None

    def _on_row_activated(self, _listbox: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
        folder = getattr(row, "folder_data", None)
        if folder is None:
            return
        # Defensive: ProtonDrive folder names cannot contain '/', but the
        # engine does not enforce. Replace to avoid injecting extra path
        # segments via the f-string below.
        name = (folder.get("name") or "").replace("/", "_")
        # Preserve any parent path the user has typed: turn the entry text
        # into "<parent>/<name>" rather than overwriting with "/<name>".
        # `rpartition` on the last '/' splits "/Work/Pro" into
        # ("/Work", "/", "Pro") so we replace just the trailing segment.
        current = self.path_entry.get_text() or ""
        parent, sep, _trailing = current.rpartition("/")
        if sep:
            new_text = f"{parent}/{name}"
            if not new_text.startswith("/"):
                new_text = f"/{new_text}"
        else:
            new_text = f"/{name}"
        # Block the changed handler so set_text does not re-enter
        # _on_text_changed → _refresh_popover and immediately re-show the
        # popover we just hid.
        if self._changed_handler_id is not None:
            self.path_entry.handler_block(self._changed_handler_id)
        try:
            self.path_entry.set_text(new_text)
        finally:
            if self._changed_handler_id is not None:
                self.path_entry.handler_unblock(self._changed_handler_id)
        self.path_entry.set_position(-1)
        self._hide_popover()
        self.path_entry.grab_focus()

    # ---- Keyboard navigation ----

    def _install_key_controller(self) -> None:
        controller = Gtk.EventControllerKey()
        controller.connect("key-pressed", self._on_key_pressed)
        self.path_entry.add_controller(controller)

    def _on_key_pressed(
        self,
        _controller: Gtk.EventControllerKey,
        keyval: int,
        _keycode: int,
        _state: Gdk.ModifierType,
    ) -> bool:
        if (
            keyval == Gdk.KEY_Escape
            and self._popover is not None
            and self._popover.get_visible()
        ):
            self._hide_popover()
            return True  # do not propagate — wizard should not also close
        if (
            keyval == Gdk.KEY_Tab
            and self._popover is not None
            and self._popover.get_visible()
        ):
            if self._popover_listbox is not None:
                first = self._popover_listbox.get_row_at_index(0)
                if first is not None:
                    first.grab_focus()
                    return True
        if keyval == Gdk.KEY_Return:
            # Enter on entry with popover open: select highlighted row if any
            if self._popover is not None and self._popover.get_visible():
                if self._popover_listbox is not None:
                    selected = self._popover_listbox.get_selected_row()
                    if selected is not None:
                        self._on_row_activated(self._popover_listbox, selected)
                        return True
        return False
