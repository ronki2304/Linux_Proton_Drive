"""Embedded WebKitGTK auth browser for Proton sign-in flow."""

from __future__ import annotations

from urllib.parse import urlparse

import gi

gi.require_version("WebKit", "6.0")

from gi.repository import Adw, GLib, GObject, Gtk, WebKit

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
        self._completed: bool = False

        self.error_banner.connect("button-clicked", self._on_retry_clicked)

    def start_auth(self) -> None:
        """Start the auth flow: bind server socket, then navigate WebView.

        Auth server must bind BEFORE WebView navigates — ordering is load-bearing.
        """
        self.cleanup()
        self._completed = False

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
        """Retry auth by reloading the WebView, or restarting the flow.

        After a credential-storage failure the WebView and auth server have
        already been torn down by ``_on_token_received``. In that case the
        retry button must restart the entire auth flow rather than reload a
        dead WebView.
        """
        if self._completed:
            return
        if self._webview is not None and self._auth_start_url is not None:
            self._webview.load_uri(self._auth_start_url)
        else:
            self.start_auth()

    def show_credential_error(self) -> None:
        """Display an inline credential-storage error and arm the retry path.

        Called when ``Application.on_auth_completed`` could not persist the
        token (e.g. libsecret unavailable). The auth window stays visible
        with an actionable error banner so the user can retry the flow.
        """
        self.error_banner.set_title(
            "Could not save credentials. Check your keyring and try again."
        )
        self.error_banner.set_revealed(True)
        # Allow _on_retry_clicked to fire — _on_token_received already set
        # _completed = True before tearing the WebView down.
        self._completed = False

    def _on_token_received(self, token: str) -> None:
        """Clean up WebView and auth server, emit auth-completed signal."""
        if self._completed:
            return
        self._completed = True

        self._teardown_webview()

        self.emit("auth-completed", token)

    def cleanup(self) -> None:
        """Force cleanup if auth window is destroyed before completion."""
        self._teardown_webview()

    def _teardown_webview(self) -> None:
        """Stop the auth server and tear down the WebView.

        Network session state (cookies, cache, credentials) is flushed
        BEFORE ``try_close()`` so that the next setup-wizard auth attempt
        cannot reuse the previous Proton session.
        """
        if self._auth_server is not None:
            self._auth_server.stop()
            self._auth_server = None

        if self._webview is not None:
            self._clear_webview_session(self._webview)
            self._webview.try_close()
            self.webview_container.remove(self._webview)
            self._webview = None

    @staticmethod
    def _clear_webview_session(webview: "WebKit.WebView") -> None:
        """Flush cookies, cache, and credentials for ``webview``.

        WebKit 6.0 (GNOME 50) exposes the website data manager via
        ``NetworkSession``. Older bindings expose it directly on the WebView,
        so we fall back if the modern API is unavailable. The clear call is
        fire-and-forget — the WebView is destroyed immediately after, so the
        underlying flush only needs to be initiated, not awaited.
        """
        # Resolve the type-set enum first; if even this fails (binding does
        # not expose ``WebsiteDataTypes``) we have no way to call ``clear``,
        # so bail out silently rather than aborting the entire teardown.
        try:
            all_types = WebKit.WebsiteDataTypes.ALL
        except AttributeError:
            return

        data_manager = None
        try:
            network_session = webview.get_network_session()
            data_manager = network_session.get_website_data_manager()
        except (AttributeError, GLib.Error):
            try:
                data_manager = webview.get_website_data_manager()
            except (AttributeError, GLib.Error):
                data_manager = None

        if data_manager is None:
            return
        try:
            data_manager.clear(all_types, 0, None, None, None)
        except GLib.Error:
            pass
