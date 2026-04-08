from __future__ import annotations

from typing import Any

from gi.repository import Adw, Gtk

from protondrive.auth_window import AuthWindow
from protondrive.errors import AuthError
from protondrive.pre_auth import PreAuthScreen
from protondrive.widgets.account_header_bar import AccountHeaderBar
from protondrive.widgets.settings import SettingsPage

APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/window.ui")
class MainWindow(Adw.ApplicationWindow):
    """Main application window with split-view layout."""

    __gtype_name__ = "ProtonDriveMainWindow"

    nav_split_view: Adw.NavigationSplitView = Gtk.Template.Child()
    toast_overlay: Adw.ToastOverlay = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.set_default_size(780, 520)
        self.set_size_request(360, 480)

        self._pre_auth_screen: PreAuthScreen | None = None
        self._auth_window: AuthWindow | None = None
        self._account_header_bar: AccountHeaderBar | None = None
        self._settings_page: SettingsPage | None = None
        self._session_data: dict[str, Any] | None = None

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
        if self._auth_window is None:
            self._auth_window = AuthWindow()
            self._auth_window.connect(
                "auth-completed", self._on_auth_completed
            )
        self.set_content(self._auth_window)
        try:
            self._auth_window.start_auth()
        except AuthError:
            self._cleanup_auth_window()
            self.show_pre_auth()

    def show_main(self) -> None:
        """Switch to the main split-view layout."""
        self.set_content(self.toast_overlay)
        self._pre_auth_screen = None
        self._cleanup_auth_window()

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

        self.set_content(self._settings_page)

    def show_about(self) -> None:
        """Show the About dialog."""
        about = Adw.AboutWindow(
            application_name="ProtonDrive Linux Client",
            application_icon=APP_ID,
            version="0.1.0",
            license_type=Gtk.License.MIT_X11,
            issue_url="https://github.com/ronki2304/ProtonDrive-LinuxClient/issues",
            website="https://github.com/ronki2304/ProtonDrive-LinuxClient",
            transient_for=self,
        )
        about.add_link(
            "Flatpak Manifest",
            f"https://github.com/ronki2304/ProtonDrive-LinuxClient/blob/main/flatpak/{APP_ID}.yml",
        )
        about.present()

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

    def _on_sign_in_requested(self, screen: PreAuthScreen) -> None:
        """Handle sign-in button click — start auth flow."""
        app = self.get_application()
        if app is not None and hasattr(app, "start_auth_flow"):
            app.start_auth_flow()

    def _on_auth_completed(self, auth_window: AuthWindow, token: str) -> None:
        """Handle auth completion — store token and transition to main UI."""
        app = self.get_application()
        if app is not None and hasattr(app, "on_auth_completed"):
            app.on_auth_completed(token)
        self.show_main()

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
