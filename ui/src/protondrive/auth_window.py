"""Embedded WebKitGTK auth browser for Proton sign-in flow."""

from __future__ import annotations

import sys
import time
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
        self._ucm: WebKit.UserContentManager | None = None
        self._auth_start_url: str | None = None
        self._completed: bool = False
        self._cookie_poll_id: int | None = None
        # Data captured from Proton's web app via JS injection during login.
        # login_password: the exact bytes the user typed in Proton's login form.
        # captured_salts: per-key bcrypt salts from GET /core/v4/keys/salts
        #   (Proton's browser calls this with a locked-scope token we can't reuse).
        self._captured_login_password: str | None = None
        self._captured_salts: list | None = None

        self.error_banner.connect("button-clicked", self._on_retry_clicked)
        # AdwBanner is a GtkOverlay child — GTK4 does not zero out its input
        # region when revealed=False, so it intercepts all pointer events even
        # while invisible.  Disable event targeting until the banner is shown.
        self.error_banner.set_can_target(False)
        # Token dedup: resend if value changed OR if same value but N seconds elapsed.
        # After 2FA, Proton upgrades scope server-side without changing the cookie value,
        # so we must periodically retry the same token to catch the scope upgrade.
        self._last_token_sent: str | None = None
        self._last_send_time: float = 0.0
        self._RESEND_INTERVAL_S: float = 8.0

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

    # JavaScript injected at document-start into Proton's login page.
    # Captures the login password from input events and intercepts the
    # GET /core/v4/keys/salts response (called with a locked-scope token
    # that we cannot reuse after scope upgrade).  Both values are sent back
    # via the "protonCapture" WebKit script message handler.
    _CAPTURE_JS = r"""
(function() {
  'use strict';
  var _pw = '';

  // Capture password as the user types in Proton's login form.
  document.addEventListener('input', function(e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'password') { _pw = t.value; }
  }, true);
  document.addEventListener('change', function(e) {
    var t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'password') { _pw = t.value; }
  }, true);

  function _post(obj) {
    try { window.webkit.messageHandlers.protonCapture.postMessage(JSON.stringify(obj)); }
    catch(e) { /* handler not registered (non-WebKit env) */ }
  }

  function _handleResponse(url, method, body, pw) {
    if (method === 'GET' && url.indexOf('/core/v4/keys/salts') >= 0) {
      try {
        var j = JSON.parse(body);
        if (j && Array.isArray(j.KeySalts)) {
          _post({ type: 'key_salts', keySalts: j.KeySalts });
        }
      } catch(e) {}
    }
    if (method === 'POST' && url.indexOf('/core/v4/auth') >= 0 &&
        url.indexOf('refresh') < 0 && url.indexOf('2fa') < 0 && url.indexOf('unlock') < 0) {
      try {
        var j = JSON.parse(body);
        if (j && (j.UID || j.AccessToken)) {
          if (pw) { _post({ type: 'auth_success', loginPassword: pw }); }
          if (j.KeySalt) { _post({ type: 'auth_key_salt', keySalt: j.KeySalt }); }
        }
      } catch(e) {}
    }
  }

  // Override fetch
  var _origFetch = window.fetch;
  window.fetch = function() {
    var resource = arguments[0];
    var init = arguments[1];
    var url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
    var method = ((init && init.method) || (resource && resource.method) || 'GET').toUpperCase();
    var pw = _pw;
    var promise = _origFetch.apply(this, arguments);
    promise.then(function(r) {
      return r.clone().text();
    }).then(function(body) {
      _handleResponse(url, method, body, pw);
    }).catch(function() {});
    return promise;
  };

  // Override XMLHttpRequest (Proton may use XHR instead of fetch)
  var _origXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    var xhr = new _origXHR();
    var _method = 'GET', _url = '';
    var _origOpen = xhr.open.bind(xhr);
    var _origSend = xhr.send.bind(xhr);
    xhr.open = function(method, url) {
      _method = (method || 'GET').toUpperCase();
      _url = url || '';
      return _origOpen.apply(this, arguments);
    };
    xhr.send = function() {
      var pw = _pw;
      xhr.addEventListener('load', function() {
        try { _handleResponse(_url, _method, xhr.responseText, pw); } catch(e) {}
      });
      return _origSend.apply(this, arguments);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = _origXHR.prototype;
})();
"""

    def _create_webview(self) -> None:
        """Create WebView with JS injection for key-capture, then configure it."""
        # UserContentManager lets us inject scripts and receive postMessage calls.
        self._ucm = WebKit.UserContentManager()
        try:
            self._ucm.register_script_message_handler("protonCapture")
            self._ucm.connect(
                "script-message-received::protonCapture", self._on_capture_message
            )
            script = WebKit.UserScript(
                self._CAPTURE_JS,
                WebKit.UserContentInjectedFrames.ALL_FRAMES,
                WebKit.UserScriptInjectionTime.START,
                None,
                None,
            )
            self._ucm.add_script(script)
        except Exception as e:
            print(f"[AUTH] JS injection setup failed: {e}", file=sys.stderr)

        # Use the default (persistent) WebKit network session so Proton's auth
        # cookies persist between app launches.  This means the user is not
        # prompted for 2FA on every restart once they have completed a full login.
        self._webview = WebKit.WebView(user_content_manager=self._ucm)

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

    def _on_capture_message(
        self, ucm: WebKit.UserContentManager, js_value: object
    ) -> None:
        """Handle postMessage from the injected JS capture script.

        WebKit 6.0: the signal passes a JavaScriptCore.Value directly (not a
        ScriptMessage wrapper).  Call .to_string() on it to get the JSON.
        """
        import json as _json
        try:
            text = js_value.to_string()  # type: ignore[union-attr]
            data = _json.loads(text)
            msg_type = data.get("type")
            if msg_type == "key_salts":
                salts = data.get("keySalts", [])
                self._captured_salts = salts
                print(f"[AUTH] captured {len(salts)} key salt(s) from browser", file=sys.stderr)
            elif msg_type == "auth_success":
                pw = data.get("loginPassword", "")
                if pw:
                    self._captured_login_password = pw
                    print(f"[AUTH] captured login password from browser (len={len(pw)})", file=sys.stderr)
            elif msg_type == "auth_key_salt":
                # KeySalt from POST /auth response — single global salt (legacy accounts)
                salt = data.get("keySalt", "")
                if salt:
                    print(f"[AUTH] captured auth KeySalt from browser: {salt[:8]}...", file=sys.stderr)
                    # Store as a synthetic single-salt entry (no key ID, used as fallback)
                    if self._captured_salts is None:
                        self._captured_salts = []
                    # Add as a special entry with ID "__auth__" for the engine to use
                    self._captured_salts.append({"ID": "__auth__", "KeySalt": salt})
        except Exception as e:
            print(f"[AUTH] capture message error: {e}", file=sys.stderr)

    @property
    def captured_login_password(self) -> str | None:
        """Login password captured from Proton's browser login form, or None."""
        return self._captured_login_password

    @property
    def captured_salts(self) -> list | None:
        """Per-key bcrypt salts captured from browser, or None."""
        return self._captured_salts

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
                    uid = cookie.get_name()[len("AUTH-"):]
                    raw = cookie.get_value() or ""
                    access_token = unquote(raw)
                    if uid and access_token:
                        # Encode as "uid:accesstoken" — engine splits on first colon
                        print("[AUTH] AUTH cookie found — completing auth", file=sys.stderr)
                        GLib.idle_add(self._on_token_received, f"{uid}:{access_token}")
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
        """Emit auth-completed signal with the candidate token.

        The WebView is NOT torn down here — Proton sets an AUTH-{UID} cookie
        before the user enters credentials (pre-auth visitor session).  We keep
        the browser open and keep polling so the cookie poller can capture the
        real post-login token once the user completes authentication.

        mark_auth_complete() is called by the application after the engine
        confirms session_ready, at which point the WebView is torn down.
        """
        if self._completed:
            return
        now = time.monotonic()
        if (token == self._last_token_sent and
                now - self._last_send_time < self._RESEND_INTERVAL_S):
            return  # Same token, too soon to retry scope upgrade
        self._last_token_sent = token
        self._last_send_time = now
        print(f"[AUTH] token candidate (len={len(token)}) — sending to engine", file=sys.stderr)
        self.emit("auth-completed", token)

    def mark_auth_complete(self) -> None:
        """Tear down the WebView and stop polling.

        Called by the application after the engine emits session_ready,
        confirming the token has sufficient scope.
        """
        if self._completed:
            return
        print("[AUTH] mark_auth_complete — tearing down WebView", file=sys.stderr)
        self._completed = True
        self._teardown_webview()

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
            # Do NOT clear cookies — we want the Proton session to persist so the
            # user doesn't need to enter credentials + 2FA on every app launch.
            # The cookie poller will reuse the existing session on next launch.
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
