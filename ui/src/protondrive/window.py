from __future__ import annotations

import os
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
        self._row_activated_connected: bool = False
        self.pair_detail_panel.connect("setup-requested", self._on_setup_requested)

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
        self._row_activated_connected = False
        self.pair_detail_panel.show_no_pairs()

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

        self._pairs_data = {p.get("pair_id", ""): dict(p) for p in pairs}

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
        self.pair_detail_panel.show_pair(pair_data)
        self.nav_split_view.set_show_content(True)

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
        self.status_footer_bar.set_syncing(pair_name, files_done, files_total)
        if pair_id in self._pairs_data and files_total > 0:
            self._pairs_data[pair_id]["file_count_text"] = f"{files_total} files"
            self._pairs_data[pair_id]["total_size_text"] = _fmt_bytes(payload.get("bytes_total", 0))
        self.pair_detail_panel.on_sync_progress(payload)

    def on_sync_complete(self, payload: dict[str, Any]) -> None:
        """Update pair row and footer bar when sync completes."""
        pair_id = payload.get("pair_id", "")
        row = self._sync_pair_rows.get(pair_id)
        if row is not None:
            row.set_state("synced")
        if self._sync_pair_rows and all(r.state == "synced" for r in self._sync_pair_rows.values()):
            self.status_footer_bar.update_all_synced()
        self.pair_detail_panel.on_sync_complete(payload)
        if pair_id in self._pairs_data:
            self._pairs_data[pair_id]["last_synced_text"] = _fmt_relative_time(
                payload.get("timestamp", "")
            )

    def on_watcher_status(self, status: str) -> None:
        """React to watcher_status events forwarded by Application."""
        if status == "initializing":
            self.status_footer_bar.set_initialising()
        elif status == "ready":
            any_syncing = any(
                r.state == "syncing" for r in self._sync_pair_rows.values()
            )
            if not any_syncing:
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
