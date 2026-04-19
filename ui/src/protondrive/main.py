from __future__ import annotations

import os
import sys
from typing import Any

import gi
import yaml

gi.require_version("Adw", "1")
gi.require_version("Gtk", "4.0")

from gi.repository import Adw, Gdk, Gio, GLib, Gtk

from protondrive.credential_store import CredentialManager
from protondrive.engine import EngineClient
from protondrive.errors import AuthError
from protondrive.window import MainWindow

APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"

TOKEN_VALIDATION_TIMEOUT_MS = 10000


class Application(Adw.Application):
    """Main application class holding global state."""

    def __init__(self) -> None:
        super().__init__(
            application_id=APP_ID,
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS,
        )
        self._settings: Gio.Settings | None = None
        self._engine: EngineClient | None = None
        self._credential_manager: CredentialManager | None = None
        self._window: MainWindow | None = None
        self._token_validation_timer_id: int | None = None
        self._cached_session_data: dict[str, Any] | None = None
        self._watcher_status: str = "unknown"
        self._pending_key_unlock_dialog: Any | None = None
        # True once the user has started a browser auth session in this process
        # lifetime.  Used to decide whether to show the key-unlock dialog or to
        # route back to pre-auth (if the stored token is insufficient on startup).
        self._had_browser_session: bool = False

    @property
    def settings(self) -> Gio.Settings:
        """Single GSettings instance for the entire app."""
        if self._settings is None:
            self._settings = Gio.Settings.new(APP_ID)
        return self._settings

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)

        # Load application CSS (amber dot animation, conflict banner styling).
        css_provider = Gtk.CssProvider()
        css_provider.load_from_resource(
            "/io/github/ronki2304/ProtonDriveLinuxClient/style.css"
        )
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            css_provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

        # Action invoked when user clicks the desktop conflict notification (Story 4-5).
        show_conflict_pair_action = Gio.SimpleAction.new(
            "show-conflict-pair", GLib.VariantType.new("s")
        )
        show_conflict_pair_action.connect(
            "activate", self._on_show_conflict_pair
        )
        self.add_action(show_conflict_pair_action)

        style_manager = Adw.StyleManager.get_default()
        style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        if hasattr(style_manager, "set_accent_color") and hasattr(Adw, "AccentColor"):
            style_manager.set_accent_color(Adw.AccentColor.TEAL)

        try:
            self._credential_manager = CredentialManager()
        except AuthError:
            self._credential_manager = None
        self._engine = EngineClient()
        self._engine.on_event("ready", self._on_engine_ready)
        self._engine.on_event("watcher_status", self._on_watcher_status)
        self._engine.on_event("sync_progress", self._on_sync_progress)
        self._engine.on_event("sync_complete", self._on_sync_complete)
        self._engine.on_event("key_unlock_required", self._on_key_unlock_required)
        self._engine.on_event("offline", self._on_offline)
        self._engine.on_event("online", self._on_online)
        self._engine.on_event("queue_replay_complete", self._on_queue_replay_complete)
        self._engine.on_event("rate_limited", self._on_rate_limited)
        self._engine.on_event("conflict_detected", self._on_conflict_detected)
        self._engine.on_session_ready(self._on_session_ready)
        self._engine.on_token_expired(self._on_token_expired)
        self._engine.on_error(self._on_engine_error)

    def do_activate(self) -> None:
        win = self.props.active_window
        if not win:
            self._window = MainWindow(settings=self.settings, application=self)
            win = self._window
            # New window: always start at pre-auth as the safe default.  If the
            # engine is already live (window closed and re-opened without killing
            # the process), _on_engine_ready won't fire again, so we re-probe
            # session state here to route the window correctly.
            self._window.show_pre_auth()
            if self._engine is not None and self._engine.is_running:
                token = self._get_stored_token()
                if token is not None:
                    key_password = self._get_stored_key_password()
                    self._engine.send_token_refresh(token, key_password)
                    self._start_validation_timeout()
        win.present()

        if self._engine is not None and not self._engine.is_running:
            self._engine.start()

    def start_auth_flow(self) -> None:
        """Called by window when user clicks sign-in."""
        self._had_browser_session = True
        if self._window is not None:
            self._window.show_auth_browser()

    def on_auth_completed(
        self,
        token: str,
        login_password: str | None = None,
        captured_salts: list | None = None,
    ) -> bool:
        """Persist auth token and refresh the engine session.

        login_password and captured_salts, when provided, are captured from
        Proton's browser login form via JS injection.  The engine uses them to
        derive keyPassword silently without showing the key-unlock dialog.

        Returns:
            True on success — caller may transition to the main UI.
            False if credential storage failed — caller MUST keep the auth
            screen visible so the user can retry.
        """
        if self._credential_manager is not None:
            try:
                self._credential_manager.store_token(token)
            except AuthError:
                return False

        try:
            self.settings.set_boolean("wizard-auth-complete", True)
        except Exception:
            pass

        if self._engine is not None:
            import sys
            print(
                f"[APP] send_token_refresh: login_password={'yes' if login_password else 'no'} "
                f"captured_salts={len(captured_salts) if captured_salts else 0}",
                file=sys.stderr,
            )
            self._engine.send_token_refresh(
                token,
                login_password=login_password,
                captured_salts=captured_salts,
            )
        return True

    def _on_engine_ready(self, message: dict[str, Any]) -> None:
        """Engine connected and protocol validated — check for stored token."""
        print("[APP] engine ready", file=sys.stderr)
        token = self._get_stored_token()

        if token is not None:
            if self._engine is not None:
                key_password = self._get_stored_key_password()
                self._engine.send_token_refresh(token, key_password)
            self._start_validation_timeout()
        else:
            if self._window is not None:
                self._window.show_pre_auth()

    def _on_watcher_status(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        self._watcher_status = payload.get("status", "unknown")
        if self._window is not None:
            self._window.on_watcher_status(self._watcher_status)

    def _on_sync_progress(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if self._window is not None:
            self._window.on_sync_progress(payload)

    def _on_sync_complete(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if self._window is not None:
            self._window.on_sync_complete(payload)

    def _on_offline(self, message: dict[str, Any]) -> None:
        if self._window is not None:
            self._window.on_offline()

    def _on_online(self, message: dict[str, Any]) -> None:
        if self._window is not None:
            self._window.on_online()

    def _on_queue_replay_complete(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        if self._window is not None:
            self._window.on_queue_replay_complete(payload)

    def _on_rate_limited(self, payload: dict[str, Any]) -> None:
        if self._window is not None:
            self._window.on_rate_limited(payload)

    def _on_conflict_detected(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        if self._window is not None:
            self._window.on_conflict_detected(payload)
        self._send_conflict_notification(payload)

    def _send_conflict_notification(self, payload: dict[str, Any]) -> None:
        """Send a desktop notification for a detected conflict (Story 4-5).

        Uses Gio.Notification via send_notification() — the GApplication
        integration routes through the GNOME notification system automatically.
        Notification ID is stable per pair so repeated conflicts replace the
        previous notification rather than stacking.
        """
        pair_id = payload.get("pair_id", "")
        if not pair_id:
            return

        local_path = payload.get("local_path", "")
        pair_name = self._get_pair_name_for_notification(pair_id)
        filename = os.path.basename(local_path) if local_path else ""

        notification = Gio.Notification.new("Sync Conflict Detected")
        if filename:
            body = f"Conflict in {pair_name}: {filename}"
        else:
            body = f"Conflict in {pair_name}"
        notification.set_body(body)

        # Default action: activate the app and select the affected pair.
        # "app.show-conflict-pair" action is registered in do_startup (Task 2).
        notification.set_default_action_and_target(
            "app.show-conflict-pair", GLib.Variant("s", pair_id)
        )

        # Stable ID per pair: replaces previous conflict notification for same pair.
        self.send_notification(f"conflict-{pair_id}", notification)

    def _get_pair_name_for_notification(self, pair_id: str) -> str:
        """Return display name for pair_id from window state, falling back to pair_id.

        Used only for notification body text — window may not yet exist on
        startup edge cases, so always falls back gracefully.
        """
        if self._window is not None:
            row = self._window._sync_pair_rows.get(pair_id)
            if row is not None:
                return row.pair_name
            data = self._window._pairs_data.get(pair_id, {})
            local_path = data.get("local_path", "")
            if local_path:
                return os.path.basename(local_path.rstrip("/")) or pair_id
        return pair_id

    def _on_show_conflict_pair(
        self, _action: Gio.SimpleAction, parameter: GLib.Variant
    ) -> None:
        """Bring window to focus and select the affected pair (Story 4-5 AC2).

        Called when user clicks the desktop conflict notification.
        parameter is a GLib.Variant("s", pair_id).
        """
        pair_id = parameter.get_string()

        # Ensure window exists and is visible.
        if self._window is None:
            self.activate()
        if self._window is not None:
            self._window.present()
            self._window.select_pair(pair_id)

    def _start_validation_timeout(self) -> None:
        """Start timeout for token validation response (NFR1)."""
        self._cancel_validation_timeout()
        self._token_validation_timer_id = GLib.timeout_add(
            TOKEN_VALIDATION_TIMEOUT_MS, self._on_validation_timeout
        )

    def _cancel_validation_timeout(self) -> None:
        """Cancel pending token validation timeout."""
        if self._token_validation_timer_id is not None:
            GLib.source_remove(self._token_validation_timer_id)
            self._token_validation_timer_id = None

    def _on_validation_timeout(self) -> bool:
        """Token validation timed out — route to pre-auth (unless auth browser is active)."""
        import sys
        print("[APP] validation timeout fired — routing to pre-auth", file=sys.stderr)
        self._token_validation_timer_id = None
        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
            except Exception:
                pass
        if self._window is not None and not self._window.is_auth_browser_active():
            self._window.show_pre_auth()
        return False

    def _on_session_ready(self, payload: dict[str, Any]) -> None:
        """Token validated — close auth browser then route to wizard or main window."""
        import sys
        print(f"[APP] session_ready received: {list(payload.keys())}", file=sys.stderr)
        self._cancel_validation_timeout()
        self._cached_session_data = payload

        # Persist key_password when the engine derived it in-session (AC4).
        key_password = payload.get("key_password")
        if key_password and self._credential_manager is not None:
            try:
                self._credential_manager.store_key_password(key_password)
            except Exception:
                pass

        if self._window is None:
            print("[APP] session_ready: _window is None, skipping", file=sys.stderr)
            return
        # Close key unlock dialog if it is still open (unlock succeeded).
        if self._pending_key_unlock_dialog is not None:
            try:
                self._pending_key_unlock_dialog.close()
            except Exception:
                pass
            self._pending_key_unlock_dialog = None
        # Tear down WebView (stop cookie poller) now that we have a valid token.
        self._window.close_auth_browser()
        has_pairs = self._has_configured_pairs()
        print(f"[APP] has_configured_pairs={has_pairs}", file=sys.stderr)
        if has_pairs:
            self._window.show_main()
            self._window.on_session_ready(payload)
            if self._engine is not None:
                self._engine.send_command_with_response(
                    {"type": "get_status"}, self._on_get_status_result
                )
        else:
            print("[APP] calling show_setup_wizard", file=sys.stderr)
            self._window.show_setup_wizard(self._engine)

    def _has_configured_pairs(self) -> bool:
        """Return True if config.yaml contains at least one sync pair."""
        return len(self._read_config_pairs()) > 0

    def _read_config_pairs(self) -> list[dict[str, Any]]:
        """Read and parse $XDG_CONFIG_HOME/protondrive/config.yaml, return pairs list.

        Returns [] on any failure (missing file, parse error, wrong schema).
        """
        try:
            xdg_config = os.environ.get(
                "XDG_CONFIG_HOME", os.path.expanduser("~/.config")
            )
            config_path = os.path.join(xdg_config, "protondrive", "config.yaml")
            with open(config_path, "r") as f:
                data = yaml.safe_load(f)
            if not isinstance(data, dict):
                return []
            pairs = data.get("pairs", [])
            if not isinstance(pairs, list):
                return []
            return pairs
        except Exception:
            return []

    def _on_get_status_result(self, payload: dict[str, Any]) -> None:
        """Handle get_status response — populate pair rows in sidebar."""
        if payload.get("error"):
            import sys
            print(f"[APP] get_status failed: {payload['error']}", file=sys.stderr)
            return
        pairs = payload.get("pairs", [])
        if self._window is not None:
            self._window.populate_pairs(pairs)  # must run first so _pairs_data is populated
            if not payload.get("online", True):
                self._window.on_offline()

    def _on_wizard_complete(self, pair_id: str) -> None:
        """Called by window after wizard creates a pair — transition to main view."""
        if self._window is not None:
            self._window.show_main()
            self._window.on_session_ready(self._cached_session_data or {})
            if self._engine is not None:
                self._engine.send_command_with_response(
                    {"type": "get_status"}, self._on_get_status_result
                )

    def _on_token_expired(self, payload: dict[str, Any]) -> None:
        """Token expired mid-sync — show warning banner; keep credentials for re-auth.

        Story 5-1: UI shifts to warning state; credentials are preserved so
        Story 5-2 can pre-fill re-auth without requiring a fresh login.
        Do NOT route to pre-auth — user stays on main view and can queue changes.
        Banner is always shown regardless of auth browser state — if re-auth
        succeeds, on_session_ready clears it; if it fails, the user sees feedback.
        """
        import sys
        print(f"[APP] token_expired received: {payload}", file=sys.stderr)
        self._cancel_validation_timeout()
        self._watcher_status = "unknown"

        if self._window is not None:
            self._window.show_token_expired_warning()

    def logout(self) -> None:
        """Execute logout: clear credentials, shutdown engine, show pre-auth."""
        self._watcher_status = "unknown"
        self._had_browser_session = False

        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
            except Exception:
                pass
            try:
                self._credential_manager.delete_key_password()
            except Exception:
                pass

        if self._engine is not None:
            self._engine.send_shutdown()

        self.settings.set_boolean("wizard-auth-complete", False)

        if self._window is not None:
            self._window.clear_session()
            self._window.show_pre_auth()

        # Restart engine so re-login flow has a live connection
        if self._engine is not None:
            GLib.timeout_add(1000, self._restart_engine_after_logout)

    def _restart_engine_after_logout(self) -> bool:
        """Restart engine after logout shutdown completes."""
        if self._engine is not None:
            self._engine.restart()
        return False

    def _on_engine_error(self, message: str, fatal: bool, pair_id: str | None = None) -> None:
        """Handle engine errors."""
        pass  # TODO: Story 5.x error display

    def _on_key_unlock_required(self, message: dict[str, Any]) -> None:
        """Engine needs a password to unlock sync keys.

        If the user has not yet opened the browser in this session (e.g., the
        stored token triggered this on startup), route them back to pre-auth so
        they can do a fresh browser login — the JS injection will capture the
        login password and salts, enabling silent unlock.

        Only show the key-unlock dialog when the user has already gone through
        the browser: they know what password to expect.
        """
        self._cancel_validation_timeout()

        payload = message.get("payload", {})
        error = payload.get("error") if isinstance(payload, dict) else None

        if not self._had_browser_session:
            # Startup case: stored token can't unlock keys. Clear it so the
            # user is routed to fresh browser login where we capture the password.
            if self._credential_manager is not None:
                try:
                    self._credential_manager.delete_token()
                except Exception:
                    pass
                try:
                    self._credential_manager.delete_key_password()
                except Exception:
                    pass
            self.settings.set_boolean("wizard-auth-complete", False)
            if self._window is not None:
                self._window.show_pre_auth()
            return

        from protondrive.widgets.key_unlock_dialog import KeyUnlockDialog

        if self._pending_key_unlock_dialog is not None:
            # Dialog already showing — surface the error inline so the user
            # can retry without a second popup appearing.
            if error:
                self._pending_key_unlock_dialog.show_error(
                    "Wrong password. Please try again."
                )
            return

        dialog = KeyUnlockDialog()
        self._pending_key_unlock_dialog = dialog
        dialog.connect("unlock-confirmed", self._on_unlock_confirmed)
        dialog.connect("unlock-cancelled", self._on_unlock_cancelled)

        if self._window is not None:
            dialog.present(self._window)

    def _on_unlock_confirmed(self, _dialog: Any, password: str) -> None:
        """User submitted password — send unlock_keys to engine.

        Do NOT clear _pending_key_unlock_dialog here: the engine will respond
        asynchronously with either session_ready (success) or key_unlock_required
        (failure). Clearing the reference early causes a second dialog to open
        when the failure event arrives.
        """
        if self._engine is not None:
            self._engine.send_unlock_keys(password)

    def _on_unlock_cancelled(self, _dialog: Any) -> None:
        """User cancelled key unlock — discard token, route to pre-auth."""
        self._pending_key_unlock_dialog = None
        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
            except Exception:
                pass
        self.settings.set_boolean("wizard-auth-complete", False)
        if self._window is not None:
            self._window.show_pre_auth()

    def _get_stored_token(self) -> str | None:
        """Retrieve stored token from credential store. Returns None if absent."""
        if self._credential_manager is None:
            return None
        try:
            return self._credential_manager.retrieve_token()
        except Exception:
            return None

    def _get_stored_key_password(self) -> str | None:
        """Retrieve stored keyPassword from credential store. Returns None if absent."""
        if self._credential_manager is None:
            return None
        try:
            return self._credential_manager.retrieve_key_password()
        except Exception:
            return None

    def do_shutdown(self) -> None:
        if self._engine is not None:
            self._engine.cleanup()
        Adw.Application.do_shutdown(self)


def main() -> int:
    app = Application()
    return app.run(sys.argv)
