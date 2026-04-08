"""Embedded WebKitGTK auth browser for Proton sign-in flow."""

from __future__ import annotations

from urllib.parse import urlparse

import gi

gi.require_version("WebKit", "6.0")

from gi.repository import Adw, GObject, Gtk, WebKit

from protondrive.auth import AuthCallbackServer


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/auth-window.ui")
class AuthWindow(Adw.Bin):
    """Embedded browser for Proton authentication.

    Security boundary is the localhost callback server, not URL filtering.
    Proton redirects through multiple subdomains during auth — allow all navigation.
    """

    __gtype_name__ = "ProtonDriveAuthWindow"

    __gsignals__ = {
        "auth-completed": (GObject.SignalFlags.RUN_FIRST, None, (str,)),
    }

    url_label: Gtk.Label = Gtk.Template.Child()
    webview_container: Gtk.Box = Gtk.Template.Child()
    error_banner: Adw.Banner = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._auth_server: AuthCallbackServer | None = None
        self._webview: WebKit.WebView | None = None
        self._auth_start_url: str | None = None

        self.error_banner.connect("button-clicked", self._on_retry_clicked)

    def start_auth(self) -> None:
        """Start the auth flow: bind server socket, then navigate WebView.

        Auth server must bind BEFORE WebView navigates — ordering is load-bearing.
        """
        self._auth_server = AuthCallbackServer()
        port = self._auth_server.get_port()
        self._auth_server.start_async(self._on_token_received)
        self._auth_start_url = f"http://127.0.0.1:{port}/auth-start"

        self._create_webview()
        self._webview.load_uri(self._auth_start_url)

    def _create_webview(self) -> None:
        """Create WebView programmatically (no Blueprint representation)."""
        self._webview = WebKit.WebView()
        self._webview.set_hexpand(True)
        self._webview.set_vexpand(True)
        self._webview.connect("load-changed", self._on_load_changed)
        self._webview.connect("load-failed", self._on_load_failed)
        self.webview_container.append(self._webview)

    def _on_load_changed(self, webview: WebKit.WebView, event: WebKit.LoadEvent) -> None:
        """Update URL label with current domain on navigation."""
        if event in (WebKit.LoadEvent.COMMITTED, WebKit.LoadEvent.FINISHED):
            uri = webview.get_uri()
            if uri:
                parsed = urlparse(uri)
                domain = parsed.hostname or ""
                if domain == "127.0.0.1":
                    domain = "Connecting..."
                self.url_label.set_text(domain)

            if self.error_banner.get_revealed():
                self.error_banner.set_revealed(False)

    def _on_load_failed(
        self,
        webview: WebKit.WebView,
        event: WebKit.LoadEvent,
        uri: str,
        error: object,
    ) -> bool:
        """Show error banner with retry option on load failure."""
        self.error_banner.set_revealed(True)
        return True  # Stop default error handler

    def _on_retry_clicked(self, banner: Adw.Banner) -> None:
        """Retry auth by reloading the auth-start URL."""
        if self._webview is not None and self._auth_start_url is not None:
            self._webview.load_uri(self._auth_start_url)

    def _on_token_received(self, token: str) -> None:
        """Clean up WebView and auth server, emit auth-completed signal."""
        if self._auth_server is not None:
            self._auth_server.stop()
            self._auth_server = None

        if self._webview is not None:
            self._webview.try_close()
            self.webview_container.remove(self._webview)
            self._webview = None

        self.emit("auth-completed", token)

    def cleanup(self) -> None:
        """Force cleanup if auth window is destroyed before completion."""
        if self._auth_server is not None:
            self._auth_server.stop()
            self._auth_server = None

        if self._webview is not None:
            self._webview.try_close()
            self.webview_container.remove(self._webview)
            self._webview = None
