from __future__ import annotations

import sys
from typing import Any

import gi

gi.require_version("Adw", "1")
gi.require_version("Gtk", "4.0")

from gi.repository import Adw, Gio, GLib

from protondrive.credential_store import CredentialManager
from protondrive.engine import EngineClient
from protondrive.window import MainWindow

APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"


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
        style_manager.set_accent_color(Adw.AccentColor.TEAL)

        self._credential_manager = CredentialManager()
        self._engine = EngineClient()
        self._engine.on_event("ready", self._on_engine_ready)
        self._engine.on_session_ready(self._on_session_ready)
        self._engine.on_token_expired(self._on_token_expired)
        self._engine.on_error(self._on_engine_error)

    def do_activate(self) -> None:
        win = self.props.active_window
        if not win:
            self._window = MainWindow(application=self)
            win = self._window
        win.present()

        if self._engine is not None:
            self._engine.start()

    def start_auth_flow(self) -> None:
        """Called by window when user clicks sign-in."""
        if self._window is not None:
            self._window.show_auth_browser()

    def on_auth_completed(self, token: str) -> None:
        """Called by window after auth browser receives token."""
        if self._credential_manager is not None:
            self._credential_manager.store_token(token)

        self.settings.set_boolean("wizard-auth-complete", True)

        if self._engine is not None:
            self._engine.send_token_refresh(token)

    def _on_engine_ready(self, message: dict[str, Any]) -> None:
        """Engine connected and protocol validated — check for stored token."""
        token = self._get_stored_token()

        if token is not None:
            if self._engine is not None:
                self._engine.send_token_refresh(token)
        else:
            if self._window is not None:
                self._window.show_pre_auth()

    def _on_session_ready(self, payload: dict[str, Any]) -> None:
        """Token validated — show main window with account info."""
        if self._window is not None:
            self._window.show_main()
            self._window.on_session_ready(payload)

    def _on_token_expired(self, payload: dict[str, Any]) -> None:
        """Token expired at launch — route to pre-auth silently (no error)."""
        if self._credential_manager is not None:
            self._credential_manager.delete_token()

        if self._window is not None:
            self._window.show_pre_auth()

    def logout(self) -> None:
        """Execute logout: clear credentials, shutdown engine, show pre-auth."""
        if self._credential_manager is not None:
            try:
                self._credential_manager.delete_token()
            except Exception:
                pass

        if self._engine is not None:
            self._engine.send_shutdown()

        self.settings.set_boolean("wizard-auth-complete", False)

        if self._window is not None:
            self._window.show_pre_auth()

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
