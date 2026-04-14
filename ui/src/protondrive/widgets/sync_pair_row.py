"""SyncPairRow widget — one row per sync pair in the sidebar list."""

from __future__ import annotations

import math

from gi.repository import GObject, Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/sync-pair-row.ui")
class SyncPairRow(Gtk.ListBoxRow):
    """One row in the sidebar sync-pair list showing status dot + name."""

    __gtype_name__ = "ProtonDriveSyncPairRow"

    __gsignals__ = {
        "row-selected": (GObject.SignalFlags.RUN_FIRST, None, ()),
    }

    status_dot: Gtk.DrawingArea = Gtk.Template.Child()
    pair_name_label: Gtk.Label = Gtk.Template.Child()
    status_label: Gtk.Label = Gtk.Template.Child()

    def __init__(self, pair_id: str, pair_name: str, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._pair_id = pair_id
        self._pair_name = pair_name
        self._state = "synced"

        self.pair_name_label.set_text(pair_name)
        self.status_label.set_text("")

        self.status_dot.set_draw_func(self._draw_dot)

        self._set_accessible_label("synced")

    @property
    def pair_id(self) -> str:
        """Return the unique pair identifier."""
        return self._pair_id

    @property
    def pair_name(self) -> str:
        """Return the display name for this pair."""
        return self._pair_name

    @property
    def state(self) -> str:
        """Return current sync state ('synced', 'syncing', or 'offline')."""
        return self._state

    def set_state(self, state: str, last_synced_text: str | None = None) -> None:
        """Update display state: 'synced', 'syncing', or 'offline'."""
        self._state = state
        if state == "syncing":
            self.status_label.set_text("Syncing…")
            self.status_dot.add_css_class("sync-dot-syncing")
            self.status_dot.remove_css_class("sync-dot-offline")
        elif state == "offline":
            text = f"Offline · {last_synced_text}" if last_synced_text else "Offline · never synced"
            self.status_label.set_text(text)
            self.status_dot.add_css_class("sync-dot-offline")
            self.status_dot.remove_css_class("sync-dot-syncing")
        else:
            self.status_label.set_text("")
            self.status_dot.remove_css_class("sync-dot-syncing")
            self.status_dot.remove_css_class("sync-dot-offline")
        self.status_dot.queue_draw()
        self._set_accessible_label(state)

    def _draw_dot(self, area: Gtk.DrawingArea, cr: object, width: int, height: int) -> None:
        """Draw a filled circle in state-appropriate colour."""
        if self._state == "syncing":
            cr.set_source_rgb(0.11, 0.63, 0.63)  # teal
        elif self._state == "offline":
            cr.set_source_rgb(0.60, 0.60, 0.60)  # grey
        else:
            cr.set_source_rgb(0.20, 0.72, 0.29)  # green
        cx, cy, r = width / 2, height / 2, min(width, height) / 2
        cr.arc(cx, cy, r, 0, 2 * math.pi)
        cr.fill()

    def _set_accessible_label(self, state: str) -> None:
        """Announce state change via AT-SPI2 accessible label."""
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [f"{self._pair_name} \u2014 {state}"],
        )
