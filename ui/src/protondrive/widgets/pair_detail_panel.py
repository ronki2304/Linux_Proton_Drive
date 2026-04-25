"""PairDetailPanel widget — shows details and sync progress for the selected pair."""

from __future__ import annotations

import os
from datetime import datetime, timezone

from gi.repository import Adw, GLib, GObject, Gtk

from protondrive.widgets.activity_feed import ActivityFeed
from protondrive.widgets.conflict_log import ConflictLog
from protondrive.widgets.sync_progress_card import SyncProgressCard


def _pair_name(local_path: str) -> str:
    return os.path.basename(local_path.rstrip("/")) or local_path


def _fmt_relative_time(iso_timestamp: str) -> str:
    try:
        dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        secs = max(0, int(delta.total_seconds()))
        if secs < 60:
            return f"{secs} seconds ago"
        if secs < 3600:
            return f"{secs // 60} minutes ago"
        return f"{secs // 3600} hours ago"
    except Exception:
        return "Never"


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/pair-detail-panel.ui")
class PairDetailPanel(Adw.Bin):
    """Detail panel showing metadata and sync progress for the selected pair."""

    __gtype_name__ = "ProtonDrivePairDetailPanel"

    __gsignals__ = {
        "setup-requested": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "view-conflict-log": (GObject.SignalFlags.RUN_FIRST, None, ()),  # Story 4-6
        "remove-pair-requested": (GObject.SignalFlags.RUN_FIRST, None, (str,)),
        "update-path-requested": (GObject.SignalFlags.RUN_FIRST, None, (str,)),  # Story 6-4: emits pair_id
    }

    detail_stack: Gtk.Stack = Gtk.Template.Child()
    conflict_banner: Adw.Banner = Gtk.Template.Child()
    error_banner: Adw.Banner = Gtk.Template.Child()
    setup_btn: Gtk.Button = Gtk.Template.Child()
    pair_name_heading: Gtk.Label = Gtk.Template.Child()
    local_path_row: Adw.ActionRow = Gtk.Template.Child()
    remote_path_row: Adw.ActionRow = Gtk.Template.Child()
    last_synced_row: Adw.ActionRow = Gtk.Template.Child()
    file_count_row: Adw.ActionRow = Gtk.Template.Child()
    total_size_row: Adw.ActionRow = Gtk.Template.Child()
    progress_slot: Gtk.Box = Gtk.Template.Child()
    activity_slot: Gtk.Box = Gtk.Template.Child()
    # Story 4-6:
    view_conflict_log_btn: Gtk.Button = Gtk.Template.Child()
    conflict_log_slot: Gtk.Box = Gtk.Template.Child()
    conflict_log_back_btn: Gtk.Button = Gtk.Template.Child()
    remove_pair_button: Gtk.Button = Gtk.Template.Child()
    # Story 6-4:
    folder_missing_status: Adw.StatusPage = Gtk.Template.Child()
    folder_missing_update_btn: Gtk.Button = Gtk.Template.Child()
    folder_missing_remove_btn: Gtk.Button = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._current_pair_id: str | None = None
        self._sync_complete_timer: int | None = None
        self._rate_limited_timer: int | None = None
        self._progress_card: SyncProgressCard | None = None
        self._conflict_log: ConflictLog | None = None  # lazy-created on first use
        self._activity_feed: ActivityFeed = ActivityFeed()
        self.activity_slot.append(self._activity_feed)
        self.setup_btn.connect("clicked", lambda _: self.emit("setup-requested"))
        self.conflict_banner.connect("button-clicked", self._on_conflict_banner_dismissed)
        self.error_banner.connect("button-clicked", self._on_error_banner_dismissed)
        self.view_conflict_log_btn.connect(
            "clicked", lambda _: self.emit("view-conflict-log")
        )
        self.conflict_log_back_btn.connect("clicked", self._on_conflict_log_back)
        self.remove_pair_button.connect("clicked", self._on_remove_pair_clicked)
        self.folder_missing_update_btn.connect(
            "clicked", self._on_folder_missing_update_clicked
        )
        self.folder_missing_remove_btn.connect(
            "clicked", self._on_folder_missing_remove_clicked
        )

    def _on_conflict_banner_dismissed(self, _banner: Adw.Banner) -> None:
        """Hide the conflict banner when user clicks Dismiss."""
        self.conflict_banner.set_revealed(False)

    def _on_error_banner_dismissed(self, _banner: Adw.Banner) -> None:
        """Hide the error banner when user clicks Dismiss."""
        self.error_banner.set_revealed(False)

    def _on_conflict_log_back(self, _btn: Gtk.Button) -> None:
        """Return to the detail view from the conflict log panel."""
        self.detail_stack.set_visible_child_name("detail")

    def _on_remove_pair_clicked(self, _button: Gtk.Button) -> None:
        if self._current_pair_id is not None:
            self.emit("remove-pair-requested", self._current_pair_id)

    def clear_activity(self) -> None:
        """Clear the activity feed (called before replaying cached events for the new pair)."""
        self._activity_feed.clear()

    def on_file_synced(self, payload: dict) -> None:
        """Prepend a file_synced event row to the activity feed."""
        self._activity_feed.add_event(payload)

    def set_activity_syncing(self, active: bool) -> None:
        """Show or hide the reconcile-progress spinner in the activity feed."""
        self._activity_feed.set_syncing(active)

    def show_conflict_log_page(self, entries: list[dict]) -> None:
        """Populate and show the conflict log page.

        Lazy-creates ConflictLog widget on first call and appends it to
        conflict_log_slot. Subsequent calls repopulate the existing widget.
        Called from window.py's _on_view_conflict_log handler.
        """
        if self._conflict_log is None:
            self._conflict_log = ConflictLog()
            self.conflict_log_slot.append(self._conflict_log)
        self._conflict_log.set_entries(entries)
        self.detail_stack.set_visible_child_name("conflict-log")

    def set_conflict_state(self, pair_id: str, count: int, pair_name: str) -> None:
        """Update conflict banner — only if pair_id matches what is currently shown.

        Called from window.py on conflict_detected, sync_complete, and row_activated.
        The pair_id guard prevents a conflict on pair B from updating the banner
        while pair A is displayed in the detail pane.
        """
        if self._current_pair_id != pair_id:
            return
        if count > 0:
            text = (
                f"1 conflict in {pair_name}"
                if count == 1
                else f"{count} conflicts in {pair_name}"
            )
            self.conflict_banner.set_title(text)
            self.conflict_banner.set_revealed(True)
            self.view_conflict_log_btn.set_visible(True)
        else:
            self.conflict_banner.set_revealed(False)
            self.view_conflict_log_btn.set_visible(False)

    def set_error_state(self, pair_id: str, has_error: bool, message: str = "") -> None:
        """Update error banner — only if pair_id matches what is currently shown.

        Called from window.py on pair_error, sync_complete, and row_activated.
        Pair_id guard prevents a non-selected pair's error from updating the banner.
        """
        if self._current_pair_id != pair_id:
            return
        if has_error:
            self.error_banner.set_title(message)
            self.error_banner.set_revealed(True)
        else:
            self.error_banner.set_revealed(False)

    def show_rate_limited(self, resume_in: int) -> None:
        """Show a transient rate-limited notice in the conflict banner, auto-clearing after resume_in seconds."""
        if self._rate_limited_timer is not None:
            GLib.source_remove(self._rate_limited_timer)
            self._rate_limited_timer = None
        self.conflict_banner.set_title(f"ProtonDrive rate limit — retrying in ~{resume_in}s")
        self.conflict_banner.set_revealed(True)
        self._rate_limited_timer = GLib.timeout_add(
            resume_in * 1000, self._on_rate_limited_timeout
        )

    def _on_rate_limited_timeout(self) -> bool:
        self._rate_limited_timer = None
        self.conflict_banner.set_revealed(False)
        return GLib.SOURCE_REMOVE

    def show_no_pairs(self) -> None:
        """Show the 'no pairs' empty state."""
        self._cancel_sync_timer()
        self._hide_progress_card()
        self._current_pair_id = None
        self._activity_feed.clear()
        self.detail_stack.set_visible_child_name("no-pairs")

    def show_select_prompt(self) -> None:
        """Show the 'select a pair' prompt."""
        self._cancel_sync_timer()
        self._hide_progress_card()
        self._current_pair_id = None
        self.detail_stack.set_visible_child_name("no-selection")

    def show_pair(self, pair_data: dict) -> None:
        """Populate and show detail view for the given pair."""
        self._cancel_sync_timer()
        self._hide_progress_card()
        self._current_pair_id = pair_data.get("pair_id", "")
        self.pair_name_heading.set_text(_pair_name(pair_data.get("local_path", "")))
        self.local_path_row.set_subtitle(pair_data.get("local_path", ""))
        self.remote_path_row.set_subtitle(pair_data.get("remote_path", ""))
        self.last_synced_row.set_subtitle(pair_data.get("last_synced_text", "Never"))
        self.file_count_row.set_subtitle(pair_data.get("file_count_text", "--"))
        self.total_size_row.set_subtitle(pair_data.get("total_size_text", "--"))
        self.conflict_banner.set_revealed(False)
        self.error_banner.set_revealed(False)   # Story 6-0d
        self.view_conflict_log_btn.set_visible(False)
        self.detail_stack.set_visible_child_name("detail")

    def _on_folder_missing_update_clicked(self, _button: Gtk.Button) -> None:
        if self._current_pair_id is not None:
            self.emit("update-path-requested", self._current_pair_id)

    def _on_folder_missing_remove_clicked(self, _button: Gtk.Button) -> None:
        if self._current_pair_id is not None:
            self.emit("remove-pair-requested", self._current_pair_id)

    def show_folder_missing(self, pair_id: str, local_path: str) -> None:
        if self._current_pair_id != pair_id:
            return
        self._cancel_sync_timer()
        self._hide_progress_card()
        self.folder_missing_status.set_description(
            f'Local folder not found at "{local_path}". Was it moved?'
        )
        self.conflict_banner.set_revealed(False)
        self.error_banner.set_revealed(False)
        self.detail_stack.set_visible_child_name("folder-missing")

    def update_file_stats(self, pair_id: str, file_count_text: str, total_size_text: str) -> None:
        """Update file count and total size rows if this pair is currently displayed."""
        if self._current_pair_id != pair_id:
            return
        self.file_count_row.set_subtitle(file_count_text)
        self.total_size_row.set_subtitle(total_size_text)

    def on_sync_progress(self, payload: dict) -> None:
        """Handle a sync_progress event — only updates if pair_id matches."""
        if not self._current_pair_id or payload.get("pair_id") != self._current_pair_id:
            return
        if self._progress_card is None:
            self._show_progress_card()
        fd = payload.get("files_done", 0)
        ft = payload.get("files_total", 0)
        bd = payload.get("bytes_done", 0)
        bt = payload.get("bytes_total", 0)
        if ft == 0:
            self._progress_card.set_counting()
        else:
            self._progress_card.set_progress(fd, ft, bd, bt)

    def on_sync_complete(self, payload: dict) -> None:
        """Handle a sync_complete event — update last-synced label and schedule hide."""
        if not self._current_pair_id or payload.get("pair_id") != self._current_pair_id:
            return
        ts = payload.get("timestamp", "")
        self.last_synced_row.set_subtitle(_fmt_relative_time(ts))
        self._cancel_sync_timer()
        self._sync_complete_timer = GLib.timeout_add(2000, self._on_sync_complete_timeout)

    def _on_sync_complete_timeout(self) -> bool:
        self._sync_complete_timer = None
        self._hide_progress_card()
        return GLib.SOURCE_REMOVE

    def _show_progress_card(self) -> None:
        self._progress_card = SyncProgressCard()
        self.progress_slot.append(self._progress_card)

    def _hide_progress_card(self) -> None:
        if self._progress_card is not None:
            self._progress_card._cancel_pulse()
            self.progress_slot.remove(self._progress_card)
            self._progress_card = None

    @property
    def current_pair_id(self) -> str | None:
        return self._current_pair_id

    def set_last_synced(self, pair_id: str, text: str) -> None:
        if self._current_pair_id == pair_id:
            self.last_synced_row.set_subtitle(text)

    def _cancel_sync_timer(self) -> None:
        if self._sync_complete_timer is not None:
            GLib.source_remove(self._sync_complete_timer)
            self._sync_complete_timer = None
