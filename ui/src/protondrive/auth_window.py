"""Embedded WebKitGTK auth browser for Proton sign-in flow."""

from __future__ import annotations

import sys
from urllib.parse import unquote, urlparse

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
        self._cookie_poll_id: int | None = None

        self.error_banner.connect("button-clicked", self._on_retry_clicked)
        # AdwBanner is a GtkOverlay child — GTK4 does not zero out its input
        # region when revealed=False, so it intercepts all pointer events even
        # while invisible.  Disable event targeting until the banner is shown.
        self.error_banner.set_can_target(False)

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

        # On Wayland the DMA-BUF renderer creates a separate EGL surface whose
        # input region isn't registered with the compositor, causing pointer
        # events to be swallowed while keyboard events still arrive via the IME
        # path.  Disabling hardware acceleration forces the WebView to paint as
        # a plain GTK texture and receive all events through the normal GTK chain.
        try:
            settings = self._webview.get_settings()
            settings.set_hardware_acceleration_policy(
                WebKit.HardwareAccelerationPolicy.NEVER
            )
            print("[AUTH] HW accel disabled (NEVER)", file=sys.stderr)
        except Exception as e:
            print(f"[AUTH] HW accel policy failed: {e}", file=sys.stderr)

        self._webview.set_hexpand(True)
        self._webview.set_vexpand(True)
        self._webview.connect("load-changed", self._on_load_changed)
        self._webview.connect("load-failed", self._on_load_failed)
        self._webview.connect("decide-policy", self._on_decide_policy)
        self.webview_container.append(self._webview)
        # grab_focus() is a no-op before the widget is realized; fire it on the
        # first map event instead so it runs after the widget tree is on-screen.
        self._webview.connect("map", lambda w: w.grab_focus())

    def _on_load_changed(self, webview: WebKit.WebView, event: WebKit.LoadEvent) -> None:
        """Update URL label with current domain on navigation."""
        if event in (WebKit.LoadEvent.COMMITTED, WebKit.LoadEvent.FINISHED):
            uri = webview.get_uri()
            print(f"[AUTH] load-changed event={event.value_nick} uri={uri}", file=sys.stderr)
            if uri:
                parsed = urlparse(uri)
                domain = parsed.hostname or ""
                if domain == "127.0.0.1":
                    domain = "Connecting..."
                self.url_label.set_text(domain)

                # Proton's login page is a SPA — no second load-changed fires
                # after the user authenticates.  Poll the WebKit cookie store
                # instead: AUTH-{UID} appears once the session is established.
                if (
                    event == WebKit.LoadEvent.FINISHED
                    and parsed.hostname == "account.proton.me"
                    and not self._completed
                    and self._cookie_poll_id is None
                ):
                    self._cookie_poll_id = GLib.timeout_add_seconds(
                        2, self._poll_for_auth_cookie
                    )

            if self.error_banner.get_revealed():
                self.error_banner.set_revealed(False)
                self.error_banner.set_can_target(False)

    def _poll_for_auth_cookie(self) -> bool:
        """Poll the WebKit cookie store for the Proton AUTH-{UID} session cookie.

        Proton's login page is a React SPA — it never triggers a second
        load-changed event after the user signs in.  Instead we poll the
        native CookieManager (which sees HttpOnly cookies too) every 2 s.
        When the AUTH-{UID} cookie appears we extract the AccessToken and
        hand it to _on_token_received exactly as the localhost callback would.
        """
        if self._completed or self._webview is None:
            self._cookie_poll_id = None
            return False

        try:
            network_session = self._webview.get_network_session()
            cookie_manager = network_session.get_cookie_manager()
        except Exception:
            return True  # network session not ready yet — keep trying

        def _on_cookies(manager: WebKit.CookieManager, result: object) -> None:
            if self._completed:
                return
            try:
                cookies = manager.get_all_cookies_finish(result)  # type: ignore[attr-defined]
            except Exception as e:
                print(f"[AUTH] cookie poll error: {e}", file=sys.stderr)
                return
            for cookie in cookies:
                if cookie.get_name().startswith("AUTH-"):
                    raw = cookie.get_value() or ""
                    token = unquote(raw)
                    if token:
                        print("[AUTH] AUTH cookie found — completing auth", file=sys.stderr)
                        GLib.idle_add(self._on_token_received, token)
                    return

        cookie_manager.get_all_cookies(None, _on_cookies)
        return True  # keep polling until token found or auth completes

    def _on_decide_policy(
        self,
        webview: WebKit.WebView,
        decision: object,
        decision_type: WebKit.PolicyDecisionType,
    ) -> bool:
        """Log all navigation decisions for auth flow debugging."""
        if decision_type == WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            try:
                action = decision.get_navigation_action()  # type: ignore[union-attr]
                request = action.get_request()
                uri = request.get_uri()
                print(f"[AUTH] navigate → {uri}", file=sys.stderr)
            except Exception:
                pass
        return False  # use default policy

    def _on_load_failed(
        self,
        webview: WebKit.WebView,
        event: WebKit.LoadEvent,
        uri: str,
        error: object,
    ) -> bool:
        """Show error banner with retry option on load failure."""
        print(f"[AUTH] load-failed uri={uri}", file=sys.stderr)
        self.error_banner.set_can_target(True)
        self.error_banner.set_revealed(True)
        return True  # Stop default error handler

    def _on_retry_clicked(self, banner: Adw.Banner) -> None:
        """Retry auth by reloading the WebView, or restarting the flow."""
        if self._completed:
            return
        if self._webview is not None and self._auth_start_url is not None:
            self._webview.load_uri(self._auth_start_url)
        else:
            self.start_auth()

    def show_credential_error(self) -> None:
        """Display an inline credential-storage error and arm the retry path."""
        self.error_banner.set_title(
            "Could not save credentials. Check your keyring and try again."
        )
        self.error_banner.set_can_target(True)
        self.error_banner.set_revealed(True)
        self._completed = False

    def _on_token_received(self, token: str) -> None:
        """Clean up WebView and auth server, emit auth-completed signal."""
        print(f"[AUTH] token received (len={len(token)})", file=sys.stderr)
        if self._completed:
            return
        self._completed = True

        self._teardown_webview()

        self.emit("auth-completed", token)

    def cleanup(self) -> None:
        """Force cleanup if auth window is destroyed before completion."""
        self._teardown_webview()

    def _teardown_webview(self) -> None:
        """Stop the auth server and tear down the WebView."""
        if self._cookie_poll_id is not None:
            GLib.source_remove(self._cookie_poll_id)
            self._cookie_poll_id = None

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
        """Flush cookies, cache, and credentials for ``webview``."""
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
