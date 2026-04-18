from __future__ import annotations

import os
import re
from typing import Any

from gi.repository import Adw, Gio, Gtk

from protondrive.auth_window import AuthWindow
from protondrive.errors import AuthError
from protondrive.pre_auth import PreAuthScreen
from protondrive.widgets.account_header_bar import AccountHeaderBar
from protondrive.widgets.setup_wizard import SetupWizard
from protondrive.widgets.settings import SettingsPage
from protondrive.widgets.pair_detail_panel import PairDetailPanel, _fmt_relative_time
from protondrive.widgets.sync_progress_card import _fmt_bytes
from protondrive.widgets.status_footer_bar import StatusFooterBar
from protondrive.widgets.sync_pair_row import SyncPairRow

APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/window.ui")
class MainWindow(Adw.ApplicationWindow):
    """Main application window with split-view layout."""

    __gtype_name__ = "ProtonDriveMainWindow"

    nav_split_view: Adw.NavigationSplitView = Gtk.Template.Child()
    toast_overlay: Adw.ToastOverlay = Gtk.Template.Child()
    pairs_list: Gtk.ListBox = Gtk.Template.Child()
    status_footer_bar: StatusFooterBar = Gtk.Template.Child()
    pair_detail_panel: PairDetailPanel = Gtk.Template.Child()

    def __init__(self, settings: Gio.Settings, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._settings = settings
        w = settings.get_int("window-width")    # schema default: 780
        h = settings.get_int("window-height")   # schema default: 520
        self.set_default_size(w, h)
        if settings.get_boolean("window-maximized"):
            self.maximize()
        self.connect("close-request", self._on_close_request)
        self.set_size_request(360, 480)

        self._pre_auth_screen: PreAuthScreen | None = None
        self._auth_window: AuthWindow | None = None
        self._account_header_bar: AccountHeaderBar | None = None
        self._settings_page: SettingsPage | None = None
        self._setup_wizard: SetupWizard | None = None
        self._session_data: dict[str, Any] | None = None
        self._sync_pair_rows: dict[str, SyncPairRow] = {}
        self._pairs_data: dict[str, dict] = {}
        # Set by `on_queue_replay_complete` — non-zero means the footer is
        # showing "N files need conflict resolution" and must not be reset
        # to "All synced" by on_sync_complete / on_watcher_status / on_online.
        # Cleared only by a subsequent clean replay (Story 3-3, AC7).
        self._conflict_pending_count: int = 0
        # Maps pair_id → list of conflict copy absolute paths (Story 4-4).
        # Populated by on_conflict_detected; resolved in on_sync_complete.
        self._conflict_copies_by_pair: dict[str, list[str]] = {}
        # List of all conflict entries for the conflict log panel (Story 4-6).
        # Each entry: {pair_id, pair_name, local_path, conflict_copy_path, date, resolved}
        # date is extracted from conflict_copy_path suffix "filename.ext.conflict-YYYY-MM-DD".
        self._conflict_log_entries: list[dict] = []
        self._row_activated_connected: bool = False
        self.pair_detail_panel.connect("setup-requested", self._on_setup_requested)
        self.pair_detail_panel.connect(
            "view-conflict-log", self._on_view_conflict_log
        )

    def _on_close_request(self, window: Gtk.Window) -> bool:
        """Save window geometry to GSettings before closing."""
        self._settings.set_boolean("window-maximized", self.is_maximized())
        if not self.is_maximized():
            self._settings.set_int("window-width", self.get_width())
            self._settings.set_int("window-height", self.get_height())
        return False  # False = allow close; True would veto close entirely

    def is_auth_browser_active(self) -> bool:
        """Return True if the auth browser is the current window content."""
        return self._auth_window is not None and self.get_content() is self._auth_window

    def show_pre_auth(self) -> None:
        """Display the pre-auth screen as the window content."""
        if self._pre_auth_screen is None:
            self._pre_auth_screen = PreAuthScreen()
            self._pre_auth_screen.connect(
                "sign-in-requested", self._on_sign_in_requested
            )
        self.set_content(self._pre_auth_screen)

    def show_auth_browser(self) -> None:
        """Display the embedded auth browser."""
        import sys
        print("[WIN] show_auth_browser called", file=sys.stderr)
        try:
            if self._auth_window is None:
                print("[WIN] creating AuthWindow", file=sys.stderr)
                self._auth_window = AuthWindow()
                self._auth_window.connect(
                    "auth-completed", self._on_auth_completed
                )
                print("[WIN] AuthWindow created", file=sys.stderr)
            self.set_content(self._auth_window)
            print("[WIN] set_content done", file=sys.stderr)
            try:
                self._auth_window.start_auth()
                print("[WIN] start_auth done", file=sys.stderr)
            except AuthError as e:
                print(f"[WIN] start_auth AuthError: {e}", file=sys.stderr)
                self._cleanup_auth_window()
                self.show_pre_auth()
        except Exception as e:
            import traceback
            print(f"[WIN] show_auth_browser exception: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def show_main(self) -> None:
        """Switch to the main split-view layout."""
        self.set_content(self.toast_overlay)
        self._pre_auth_screen = None
        self._setup_wizard = None
        self._cleanup_auth_window()

    def show_setup_wizard(self, engine_client: Any) -> None:
        """Display the setup wizard as the window content."""
        self._setup_wizard = SetupWizard(
            engine_client=engine_client,
            on_pair_created=self._on_wizard_pair_created,
            on_back=self._on_wizard_back,
        )
        self.set_content(self._setup_wizard)

    def _on_wizard_pair_created(self, pair_id: str) -> None:
        """Forward pair creation event to Application."""
        app = self.get_application()
        if app is not None and hasattr(app, "_on_wizard_complete"):
            app._on_wizard_complete(pair_id)

    def _on_wizard_back(self) -> None:
        """Navigate back to pre-auth screen."""
        self._setup_wizard = None
        self.show_pre_auth()

    def clear_session(self) -> None:
        """Clear cached session data on logout."""
        self._session_data = None
        self._sync_pair_rows = {}
        self._pairs_data = {}
        self._conflict_copies_by_pair = {}
        self._conflict_log_entries = []          # Story 4-6
        self._row_activated_connected = False
        self.pair_detail_panel.show_no_pairs()
        self.status_footer_bar.update_all_synced()

    def _total_active_conflicts(self) -> int:
        """Total conflict copy count across all pairs."""
        return sum(len(v) for v in self._conflict_copies_by_pair.values())

    def _get_pair_name(self, pair_id: str) -> str:
        """Return display name for pair_id, falling back to pair_id itself."""
        row = self._sync_pair_rows.get(pair_id)
        if row is not None:
            return row.pair_name
        data = self._pairs_data.get(pair_id, {})
        local_path = data.get("local_path", "")
        return os.path.basename(local_path.rstrip("/")) or pair_id

    def on_conflict_detected(self, payload: dict[str, Any]) -> None:
        """Handle engine's conflict_detected push event (Story 4-4 AC1–3)."""
        pair_id = payload.get("pair_id", "")
        conflict_copy_path = payload.get("conflict_copy_path", "")

        # Guard: malformed payload missing pair_id or path would corrupt tracking.
        if not pair_id or not conflict_copy_path:
            return

        # Track the new conflict copy (deduplicated by path).
        copies = self._conflict_copies_by_pair.setdefault(pair_id, [])
        if conflict_copy_path not in copies:
            copies.append(conflict_copy_path)

        count = len(copies)
        pair_name = self._get_pair_name(pair_id)

        # Extract date from conflict copy path suffix "name.ext.conflict-YYYY-MM-DD".
        _m = re.search(r'\.conflict-(\d{4}-\d{2}-\d{2})$', conflict_copy_path)
        date_str = _m.group(1) if _m else ""

        # Append to global conflict log entries (deduplicated by path).
        if not any(e["conflict_copy_path"] == conflict_copy_path for e in self._conflict_log_entries):
            self._conflict_log_entries.append({
                "pair_id": pair_id,
                "pair_name": pair_name,
                "local_path": payload.get("local_path", ""),
                "conflict_copy_path": conflict_copy_path,
                "date": date_str,
                "resolved": False,
            })

        # Update sidebar row.
        row = self._sync_pair_rows.get(pair_id)
        if row is not None and row.state != "offline":
            row.set_state("conflict", conflict_count=count)

        # Update detail panel banner — only if this pair is currently shown
        # (set_conflict_state guards internally via _current_pair_id).
        self.pair_detail_panel.set_conflict_state(pair_id, count, pair_name)

        # Update footer: conflict > syncing priority (AC4).
        self.status_footer_bar.set_conflicts(self._total_active_conflicts())

    def _on_view_conflict_log(self, _panel: object) -> None:
        """Handle view-conflict-log signal — populate and show conflict log page."""
        self.pair_detail_panel.show_conflict_log_page(self._conflict_log_entries)

    def _on_setup_requested(self, widget: object) -> None:
        """Handle setup-requested signal from PairDetailPanel."""
        app = self.get_application()
        if app is not None and hasattr(app, "_engine"):
            self.show_setup_wizard(app._engine)

    def show_settings(self) -> None:
        """Open the settings page."""
        if self._settings_page is None:
            self._settings_page = SettingsPage()
            self._settings_page.set_logout_callback(self._on_logout_confirmed)

        if self._session_data is not None:
            self._settings_page.update_account(
                display_name=self._session_data.get("display_name", ""),
                email=self._session_data.get("email", ""),
                storage_used=self._session_data.get("storage_used", 0),
                storage_total=self._session_data.get("storage_total", 1),
                plan=self._session_data.get("plan", ""),
            )

        self._previous_content = self.get_content()
        self.set_content(self._settings_page)

        # Escape key closes settings
        key_controller = Gtk.EventControllerKey.new()
        key_controller.connect("key-pressed", self._on_settings_key_pressed)
        self._settings_page.add_controller(key_controller)

    def _on_settings_key_pressed(
        self,
        controller: Gtk.EventControllerKey,
        keyval: int,
        keycode: int,
        state: object,
    ) -> bool:
        """Handle Escape key to close settings page."""
        from gi.repository import Gdk

        if keyval == Gdk.KEY_Escape:
            self._close_settings()
            return True
        return False

    def _close_settings(self) -> None:
        """Return to previous content from settings."""
        if hasattr(self, "_previous_content") and self._previous_content is not None:
            self.set_content(self._previous_content)
            self._previous_content = None

    def show_about(self) -> None:
        """Show the About dialog."""
        about = Adw.AboutDialog(
            application_name="ProtonDrive Linux Client",
            application_icon=APP_ID,
            version="0.1.0",
            license_type=Gtk.License.MIT_X11,
            issue_url="https://github.com/ronki2304/ProtonDrive-LinuxClient/issues",
            website="https://github.com/ronki2304/ProtonDrive-LinuxClient",
            debug_info=(
                f"Flatpak App ID: {APP_ID}\n"
                f"SDK: @protontech/drive-sdk 0.14.3\n"
            ),
            debug_info_filename="protondrive-debug-info.txt",
        )
        about.add_link(
            "Flatpak Manifest",
            f"https://github.com/ronki2304/ProtonDrive-LinuxClient/blob/main/flatpak/{APP_ID}.yml",
        )
        about.present(self)

    def on_session_ready(self, payload: dict[str, Any]) -> None:
        """Handle session_ready from engine — same for initial auth and re-auth."""
        self._session_data = payload

        if self._account_header_bar is None:
            self._account_header_bar = AccountHeaderBar()

        self._account_header_bar.update_account(
            display_name=payload.get("display_name", ""),
            email=payload.get("email", ""),
            storage_used=payload.get("storage_used", 0),
            storage_total=payload.get("storage_total", 1),
            plan=payload.get("plan", ""),
        )

        # Post-auth confirmation toast (UX-DR3)
        name = payload.get("display_name", "your account")
        toast = Adw.Toast.new(
            f"Signed in as {name} \u2014 your password was never stored by this app"
        )
        toast.set_timeout(5)
        self.toast_overlay.add_toast(toast)

    def populate_pairs(self, pairs: list[dict[str, Any]]) -> None:
        """Populate the sidebar list with one SyncPairRow per pair.

        If pairs is empty, clears the list (empty state is the ScrolledWindow
        with no rows; placeholder shown via CSS empty state or left blank).
        """
        # Remove all existing rows
        while True:
            row = self.pairs_list.get_row_at_index(0)
            if row is None:
                break
            self.pairs_list.remove(row)
        self._sync_pair_rows = {}
        self._pairs_data = {}

        for pair in pairs:
            pair_id = pair.get("pair_id", "")
            local_path = pair.get("local_path", "")
            pair_name = os.path.basename(local_path.rstrip("/")) or local_path
            row = SyncPairRow(pair_id, pair_name)
            self.pairs_list.append(row)
            self._sync_pair_rows[pair_id] = row

        self._pairs_data = {}
        for p in pairs:
            d = dict(p)
            last_synced_at = p.get("last_synced_at")
            if last_synced_at:
                d["last_synced_text"] = _fmt_relative_time(last_synced_at)
            self._pairs_data[p.get("pair_id", "")] = d

        if not pairs:
            self.pair_detail_panel.show_no_pairs()
        else:
            self.pair_detail_panel.show_select_prompt()

        if not self._row_activated_connected:
            self.pairs_list.connect("row-activated", self._on_row_activated)
            self._row_activated_connected = True

    def _on_row_activated(self, list_box: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
        """Handle pair row selection — route to pair detail in content area."""
        pair_id = row.pair_id
        pair_data = self._pairs_data.get(pair_id, {})
        self.pair_detail_panel.show_pair(pair_data)  # resets banner to hidden
        # Immediately restore banner if this pair has active conflicts.
        conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        self.pair_detail_panel.set_conflict_state(pair_id, conflict_count, row.pair_name)
        self.nav_split_view.set_show_content(True)

    def select_pair(self, pair_id: str) -> None:
        """Programmatically select a pair row in the sidebar and show its detail panel.

        Called from Application._on_show_conflict_pair when the user clicks
        the desktop notification. Mirrors the effect of the user clicking the row.
        """
        row = self._sync_pair_rows.get(pair_id)
        if row is None:
            return
        self.pairs_list.select_row(row)
        pair_data = self._pairs_data.get(pair_id, {})
        self.pair_detail_panel.show_pair(pair_data)
        conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        self.pair_detail_panel.set_conflict_state(pair_id, conflict_count, row.pair_name)
        self.nav_split_view.set_show_content(True)

    def on_offline(self) -> None:
        """Shift all pair rows and footer bar to offline state."""
        for pair_id, row in self._sync_pair_rows.items():
            last_synced_text = self._pairs_data.get(pair_id, {}).get("last_synced_text")
            row.set_state("offline", last_synced_text=last_synced_text)
        self.status_footer_bar.set_offline()

    def on_online(self) -> None:
        """Return all pair rows and footer bar to synced state."""
        for pair_id, row in self._sync_pair_rows.items():
            pair_conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
            if pair_conflict_count > 0:
                row.set_state("conflict", conflict_count=pair_conflict_count)
            else:
                row.set_state("synced")
        # Preserve the conflict-pending footer across online transitions
        # (Story 3-3, AC7 regression guard).
        if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
            return
        any_syncing = any(r.state == "syncing" for r in self._sync_pair_rows.values())
        if not any_syncing:
            self.status_footer_bar.update_all_synced()

    def on_queue_replay_complete(self, payload: dict[str, Any]) -> None:
        """Handle engine's `queue_replay_complete` push event (Story 3-3 AC7).

        Toast + optional conflict-pending footer per the AC7 decision table:

            synced | skipped | toast           | footer                       |
            >0     | 0       | "N files synced"| update_all_synced (green)    |
            >0     | >0      | "N files synced"| set_conflict_pending (amber) |
            0      | >0      | (none)          | set_conflict_pending (amber) |
            0      | 0       | (none)          | (no change)                  |
        """
        # Defensive: payload may carry an explicit `null` for either field
        # (empty JSON, bad engine build). `.get(key, 0)` returns None for an
        # explicit null, and `None > 0` raises TypeError — guard with `or 0`.
        synced = payload.get("synced") or 0
        skipped = payload.get("skipped_conflicts") or 0

        # Detect a clean-replay transition out of conflict-pending state. If
        # we previously held a non-zero count and this replay reports zero
        # conflicts, the footer's amber "N files need conflict resolution"
        # label is stale — reset it so the user sees green immediately (AC7
        # "Flag clearing" rule in Task 6.8).
        had_pending_before = self._conflict_pending_count > 0

        # Set the state flag FIRST so any concurrent sync_complete event that
        # arrives after this handler runs respects the conflict-pending guard.
        self._conflict_pending_count = skipped

        if synced > 0:
            text = "1 file synced" if synced == 1 else f"{synced} files synced"
            toast = Adw.Toast.new(text)
            toast.set_timeout(3)
            self.toast_overlay.add_toast(toast)

        if skipped > 0:
            self.status_footer_bar.set_conflict_pending(skipped)
        elif had_pending_before:
            # Transitioning from conflict-pending to clean. The amber label
            # would otherwise linger until the next sync_complete — reset the
            # footer explicitly. (The regression guard in on_sync_complete no
            # longer blocks now that _conflict_pending_count is 0.)
            self.status_footer_bar.update_all_synced()
        # Green "All synced" for the fresh-replay case (synced>0, skipped==0,
        # no prior conflict-pending) is handled by the subsequent
        # sync_complete event via its regression guard (see on_sync_complete
        # below). AC7 row 1 resolves there — doing it here would flash before
        # sync_complete.

    def on_rate_limited(self, payload: dict[str, Any]) -> None:
        """Handle engine's `rate_limited` push event (Story 3-4 AC4)."""
        resume_in = (payload.get("resume_in_seconds") or 0)
        resume_in = int(resume_in) if resume_in > 0 else 5  # safe default
        self.status_footer_bar.set_rate_limited(resume_in)

    def on_sync_progress(self, payload: dict[str, Any]) -> None:
        """Update pair row and footer bar when sync is in progress."""
        pair_id = payload.get("pair_id", "")
        row = self._sync_pair_rows.get(pair_id)
        if row is not None:
            row.set_state("syncing")
        pair_name = payload.get("pair_name", pair_id)
        if not pair_name and row is not None:
            pair_name = row.pair_name
        files_done = payload.get("files_done", 0)
        files_total = payload.get("files_total", 0)
        # Conflict > Syncing: only update footer to "syncing" if no active conflicts.
        if self._total_active_conflicts() == 0:
            self.status_footer_bar.set_syncing(pair_name, files_done, files_total)
        if pair_id in self._pairs_data and files_total > 0:
            self._pairs_data[pair_id]["file_count_text"] = f"{files_total} files"
            self._pairs_data[pair_id]["total_size_text"] = _fmt_bytes(payload.get("bytes_total", 0))
        self.pair_detail_panel.on_sync_progress(payload)

    def on_sync_complete(self, payload: dict[str, Any]) -> None:
        """Update pair row and footer bar when sync completes."""
        pair_id = payload.get("pair_id", "")

        # ── Resolution detection (AC5): check which tracked conflict copies
        # for this pair have been deleted since the last sync cycle. ──
        if pair_id in self._conflict_copies_by_pair:
            still_present = [
                p for p in self._conflict_copies_by_pair[pair_id]
                if os.path.exists(p)
            ]
            self._conflict_copies_by_pair[pair_id] = still_present
            if not still_present:
                del self._conflict_copies_by_pair[pair_id]

        # Mark resolved entries in conflict log (Story 4-6).
        # Run this after _conflict_copies_by_pair is updated so both stay in sync.
        for entry in self._conflict_log_entries:
            if entry["pair_id"] == pair_id and not entry["resolved"]:
                if not os.path.exists(entry["conflict_copy_path"]):
                    entry["resolved"] = True

        # Determine post-sync state for this pair's row.
        pair_conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        row = self._sync_pair_rows.get(pair_id)
        if row is not None and row.state != "offline":
            if pair_conflict_count > 0:
                row.set_state("conflict", conflict_count=pair_conflict_count)
            else:
                row.set_state("synced")

        # Update detail panel banner (guards internally via pair_id).
        self.pair_detail_panel.set_conflict_state(
            pair_id, pair_conflict_count, self._get_pair_name(pair_id)
        )

        self.pair_detail_panel.on_sync_complete(payload)
        if pair_id in self._pairs_data:
            self._pairs_data[pair_id]["last_synced_text"] = _fmt_relative_time(
                payload.get("timestamp", "")
            )

        # Footer update — Conflict > _conflict_pending > all-synced.
        total_conflicts = self._total_active_conflicts()
        if total_conflicts > 0:
            self.status_footer_bar.set_conflicts(total_conflicts)
            return
        if self._conflict_pending_count > 0:
            return
        if self._sync_pair_rows and all(
            r.state == "synced" for r in self._sync_pair_rows.values()
        ):
            self.status_footer_bar.update_all_synced()

    def on_watcher_status(self, status: str) -> None:
        """React to watcher_status events forwarded by Application."""
        if status == "initializing":
            self.status_footer_bar.set_initialising()
        elif status == "ready":
            # Story 3-3 AC7 regression guard: preserve the conflict-pending
            # footer across watcher 'ready' transitions.
            if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
                return
            any_syncing = any(r.state == "syncing" for r in self._sync_pair_rows.values())
            any_offline = any(r.state == "offline" for r in self._sync_pair_rows.values())
            if not any_syncing and not any_offline:
                self.status_footer_bar.update_all_synced()

    def _on_sign_in_requested(self, screen: PreAuthScreen) -> None:
        """Handle sign-in button click — start auth flow."""
        import sys
        print("[WIN] sign-in-requested received", file=sys.stderr)
        app = self.get_application()
        if app is not None and hasattr(app, "start_auth_flow"):
            app.start_auth_flow()

    def _on_auth_completed(self, auth_window: AuthWindow, token: str) -> None:
        """Forward candidate token to application for engine validation.

        We do NOT transition to main here — the WebView stays open so the
        cookie poller can keep running in case the first candidate has
        insufficient scope (pre-auth visitor token).  The UI transition
        happens in close_auth_browser(), called after engine emits session_ready.

        On credential-storage failure, show an inline error and keep the auth
        screen visible so the user can retry.
        """
        app = self.get_application()
        if app is None or not hasattr(app, "on_auth_completed"):
            return
        login_password = auth_window.captured_login_password
        captured_salts = auth_window.captured_salts
        success = app.on_auth_completed(
            token,
            login_password=login_password,
            captured_salts=captured_salts,
        )
        if not success and self._auth_window is not None:
            self._auth_window.show_credential_error()

    def close_auth_browser(self) -> None:
        """Tear down the auth browser WebView without changing the window content.

        Called by the application after session_ready is confirmed.  The
        window content transition (show_main / show_setup_wizard) is the
        caller's responsibility.
        """
        if self._auth_window is not None:
            self._auth_window.mark_auth_complete()

    def _on_logout_confirmed(self) -> None:
        """Execute logout sequence via Application."""
        app = self.get_application()
        if app is not None and hasattr(app, "logout"):
            app.logout()

    def _cleanup_auth_window(self) -> None:
        """Release auth window resources."""
        if self._auth_window is not None:
            self._auth_window.cleanup()
            self._auth_window = None
