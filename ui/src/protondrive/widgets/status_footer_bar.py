"""StatusFooterBar widget — global sync status displayed at the bottom of the window."""

from __future__ import annotations

import math

from gi.repository import Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/status-footer-bar.ui")
class StatusFooterBar(Gtk.Box):
    """Footer bar showing global sync status across all pairs."""

    __gtype_name__ = "ProtonDriveStatusFooterBar"

    footer_dot: Gtk.DrawingArea = Gtk.Template.Child()
    footer_label: Gtk.Label = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._dot_state = "synced"
        self.footer_dot.set_draw_func(self._on_dot_draw)
        self.footer_label.set_text("All synced")

    def set_syncing(self, pair_name: str, files_done: int, files_total: int) -> None:
        """Show active sync state for a pair."""
        text = f"Syncing {files_done}/{files_total} in {pair_name}\u2026"
        self.footer_label.set_text(text)
        self._set_dot_state("syncing")
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [text],
        )

    def update_all_synced(self) -> None:
        """Show all-synced state."""
        self.footer_label.set_text("All synced")
        self._set_dot_state("synced")
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ["All synced"],
        )

    def set_initialising(self) -> None:
        """Show watcher initialisation state."""
        self.footer_label.set_text("Initialising file watcher\u2026")
        self._set_dot_state("syncing")
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ["Initialising file watcher\u2026"],
        )

    def set_offline(self) -> None:
        """Show offline state."""
        text = "Offline \u2014 changes queued"
        self.footer_label.set_text(text)
        self._set_dot_state("offline")
        self.update_property([Gtk.AccessibleProperty.LABEL], [text])
        # polite live-region announcement required for offline state change (AC5)
        self.announce(text, Gtk.AccessibleAnnouncementPriority.LOW)

    def set_conflict_pending(self, count: int) -> None:
        """Show pending-conflict indicator after queue replay (Story 3-3 AC7).

        Non-positive counts are invalid for this state — guard against
        defensive callers or a malformed engine payload so the footer never
        displays nonsense like "0 files need conflict resolution".
        """
        if count <= 0:
            self.update_all_synced()
            return
        text = (
            "1 file needs conflict resolution"
            if count == 1
            else f"{count} files need conflict resolution"
        )
        self.footer_label.set_text(text)
        self._set_dot_state("conflict")
        self.update_property([Gtk.AccessibleProperty.LABEL], [text])
        self.announce(text, Gtk.AccessibleAnnouncementPriority.LOW)

    def _set_dot_state(self, state: str) -> None:
        """Update dot colour and CSS class.

        States: "syncing" | "offline" | "conflict" | "synced" (default).
        Each state adds exactly one CSS class and explicitly removes the
        other two. Replacing the old if/elif/else with a remove-all-then-
        add-one pattern (Story 3-3 Task 7.2) makes state transitions
        unambiguous and idempotent — no risk of stale classes when moving
        syncing → conflict → offline → synced in any order.
        """
        self._dot_state = state
        # Always start from a clean slate.
        self.footer_dot.remove_css_class("sync-dot-syncing")
        self.footer_dot.remove_css_class("sync-dot-offline")
        self.footer_dot.remove_css_class("sync-dot-conflict")
        if state == "syncing":
            self.footer_dot.add_css_class("sync-dot-syncing")
        elif state == "offline":
            self.footer_dot.add_css_class("sync-dot-offline")
        elif state == "conflict":
            self.footer_dot.add_css_class("sync-dot-conflict")
        # state == "synced" (or any unknown) → no class, default green.
        self.footer_dot.queue_draw()

    def _on_dot_draw(self, area: Gtk.DrawingArea, cr: object, width: int, height: int) -> None:
        """Draw a filled circle in state-appropriate colour."""
        if self._dot_state == "syncing":
            cr.set_source_rgb(0.11, 0.63, 0.63)  # teal
        elif self._dot_state == "offline":
            cr.set_source_rgb(0.60, 0.60, 0.60)  # grey
        elif self._dot_state == "conflict":
            cr.set_source_rgb(0.95, 0.62, 0.14)  # amber (UX-DR)
        else:
            cr.set_source_rgb(0.20, 0.72, 0.29)  # green
        cx, cy, r = width / 2, height / 2, min(width, height) / 2
        cr.arc(cx, cy, r, 0, 2 * math.pi)
        cr.fill()
