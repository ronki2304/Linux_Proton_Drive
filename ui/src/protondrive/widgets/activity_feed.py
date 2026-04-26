"""ActivityFeed widget — live feed of file_synced events (Story 8-3)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from gi.repository import Adw, Gtk

_MAX_FEED_ITEMS = 100


def _fmt_activity_time(iso_timestamp: str) -> str:
    """Format ISO 8601 UTC timestamp as human-relative string for the feed.

    Returns "just now" (<60s), "X min ago" (<60 min), "X hr ago" (>=60 min).
    Distinct from _fmt_relative_time in pair_detail_panel.py (which returns
    "N seconds ago" — different wording required by Story 8-3 AC1).
    """
    try:
        dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        secs = max(0, int(delta.total_seconds()))
        if secs < 60:
            return "just now"
        if secs < 3600:
            return f"{secs // 60} min ago"
        return f"{secs // 3600} hr ago"
    except Exception:
        return ""


class ActivityFeedRow(Adw.ActionRow):
    """One row in the activity feed.

    AdwActionRow with programmatic prefix arrow and no suffix.
    Created dynamically from file_synced event dicts.
    """

    __gtype_name__ = "ProtonDriveActivityFeedRow"

    def __init__(self, event: dict[str, Any], **kwargs: object) -> None:
        super().__init__(**kwargs)
        file_name = event.get("file_name", "")
        direction = event.get("direction", "")
        timestamp = event.get("timestamp", "")
        pair_name = event.get("pair_name", "")

        # Direction arrow prefix.
        arrow = Gtk.Label()
        if direction == "upload":
            arrow.set_text("↑")
            arrow.add_css_class("success")
        elif direction == "download":
            arrow.set_text("↓")
            arrow.add_css_class("accent")
        else:  # verified
            arrow.set_text("✓")
            arrow.add_css_class("dim-label")
        arrow.set_valign(Gtk.Align.CENTER)
        self.add_prefix(arrow)

        self.set_title(file_name)
        subtitle_parts = [p for p in [pair_name, _fmt_activity_time(timestamp)] if p]
        self.set_subtitle("  ·  ".join(subtitle_parts))


@Gtk.Template(
    resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/activity-feed.ui"
)
class ActivityFeed(Adw.Bin):
    """Live activity feed showing the last 100 file_synced events."""

    __gtype_name__ = "ProtonDriveActivityFeed"

    preferences_group: Adw.PreferencesGroup = Gtk.Template.Child()
    activity_spinner: Gtk.Spinner = Gtk.Template.Child()
    activity_stack: Gtk.Stack = Gtk.Template.Child()
    activity_list: Gtk.ListBox = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._events: list[dict[str, Any]] = []

    def add_event(self, event: dict[str, Any]) -> None:
        """Prepend a file_synced event row; discard oldest if over cap."""
        row = ActivityFeedRow(event)
        self.activity_list.prepend(row)
        self._events.insert(0, event)

        if len(self._events) > _MAX_FEED_ITEMS:
            # Remove oldest row (last in the ListBox after prepends).
            tail = self.activity_list.get_row_at_index(_MAX_FEED_ITEMS)
            if tail is not None:
                self.activity_list.remove(tail)
            self._events.pop()

        if self.activity_stack.get_visible_child_name() != "feed":
            self.activity_stack.set_visible_child_name("feed")

    def set_syncing(self, active: bool) -> None:
        """Show or hide the spinner at the top of the feed header."""
        self.activity_spinner.set_spinning(active)
        self.activity_spinner.set_visible(active)

    def set_sync_step(self, step: str | None) -> None:
        """Show the current engine phase below the group title, or clear it."""
        self.preferences_group.set_description(step or "")

    def clear(self) -> None:
        """Remove all rows — called on clear_session()."""
        self._events.clear()
        child = self.activity_list.get_first_child()
        while child is not None:
            nxt = child.get_next_sibling()
            self.activity_list.remove(child)
            child = nxt
        self.activity_stack.set_visible_child_name("empty")
        self.set_syncing(False)
        self.set_sync_step(None)
