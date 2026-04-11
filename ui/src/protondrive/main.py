from __future__ import annotations

import os
import sys
from typing import Any

import gi
import yaml

gi.require_version("Adw", "1")
gi.require_version("Gtk", "4.0")

from gi.repository import Adw, Gio, GLib

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

    @property
    def settings(self) -> Gio.Settings:
        """Single GSettings instance for the entire app."""
        if self._settings is None:
            self._settings = Gio.Settings.new(APP_ID)
        return self._settings

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)

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
                    self._engine.send_token_refresh(token)
                    self._start_validation_timeout()
        win.present()

        if self._engine is not None and not self._engine.is_running:
            self._engine.start()

    def start_auth_flow(self) -> None:
        """Called by window when user clicks sign-in."""
        if self._window is not None:
            self._window.show_auth_browser()

    def on_auth_completed(self, token: str) -> bool:
        """Persist auth token and refresh the engine session.

        Returns:
            True on success — caller may transition to the main UI.
            False if credential storage failed — caller MUST keep the auth
            screen visible so the user can retry. ``wizard-auth-complete`` is
            NOT set and ``send_token_refresh`` is NOT called on failure.
        """
        import sys
        print("[DEBUG] on_auth_completed called", file=sys.stderr)
        if self._credential_manager is not None:
            try:
                self._credential_manager.store_token(token)
                print("[DEBUG] token stored ok", file=sys.stderr)
            except AuthError as e:
                print(f"[DEBUG] store_token failed: {e}", file=sys.stderr)
                return False
        else:
            print("[DEBUG] no credential_manager", file=sys.stderr)

        try:
            self.settings.set_boolean("wizard-auth-complete", True)
            print("[DEBUG] settings ok", file=sys.stderr)
        except Exception as e:
            print(f"[DEBUG] settings error: {e}", file=sys.stderr)

        if self._engine is not None:
            self._engine.send_token_refresh(token)
            print("[DEBUG] token_refresh sent", file=sys.stderr)
        return True

    def _on_engine_ready(self, message: dict[str, Any]) -> None:
        """Engine connected and protocol validated — check for stored token."""
        print("[APP] engine ready", file=sys.stderr)
        token = self._get_stored_token()

        if token is not None:
            if self._engine is not None:
                self._engine.send_token_refresh(token)
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
        """Token validation timed out — route to pre-auth."""
        self._token_validation_timer_id = None
        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
            except Exception:
                pass
        if self._window is not None:
            self._window.show_pre_auth()
        return False

    def _on_session_ready(self, payload: dict[str, Any]) -> None:
        """Token validated — route to wizard or main window based on pair config."""
        self._cancel_validation_timeout()
        self._cached_session_data = payload
        if self._window is None:
            return
        if self._has_configured_pairs():
            self._window.show_main()
            self._window.on_session_ready(payload)
            if self._engine is not None:
                self._engine.send_command_with_response(
                    {"type": "get_status"}, self._on_get_status_result
                )
        else:
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
            self._window.populate_pairs(pairs)

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
        """Token expired at launch — route to pre-auth silently (no error)."""
        self._cancel_validation_timeout()
        self._watcher_status = "unknown"

        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
            except Exception:
                pass

        self.settings.set_boolean("wizard-auth-complete", False)

        if self._window is not None:
            self._window.show_pre_auth()

    def logout(self) -> None:
        """Execute logout: clear credentials, shutdown engine, show pre-auth."""
        self._watcher_status = "unknown"

        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
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

    def _get_stored_token(self) -> str | None:
        """Retrieve stored token from credential store. Returns None if absent."""
        if self._credential_manager is None:
            return None
        try:
            return self._credential_manager.retrieve_token()
        except Exception:
            return None

    def do_shutdown(self) -> None:
        if self._engine is not None:
            self._engine.cleanup()
        Adw.Application.do_shutdown(self)


def main() -> int:
    app = Application()
    return app.run(sys.argv)
