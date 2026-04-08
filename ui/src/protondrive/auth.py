"""Localhost auth callback server for Proton authentication flow."""

from __future__ import annotations

import http.server
import threading
from typing import Callable
from urllib.parse import parse_qs, urlparse

from gi.repository import GLib

PROTON_AUTH_URL = "https://account.proton.me"


class AuthError(Exception):
    """Authentication-related failures."""


class _AuthRequestHandler(http.server.BaseHTTPRequestHandler):
    """Handles /auth-start and /callback endpoints."""

    server: AuthCallbackServer  # type: ignore[assignment]

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/auth-start":
            self._handle_auth_start()
        elif parsed.path == "/callback":
            self._handle_callback(parsed.query)
        else:
            self.send_error(404)

    def _handle_auth_start(self) -> None:
        """Redirect to Proton auth with callback URL."""
        port = self.server.server_address[1]
        callback_url = f"http://127.0.0.1:{port}/callback"
        redirect_url = f"{PROTON_AUTH_URL}?redirect_uri={callback_url}"

        self.send_response(302)
        self.send_header("Location", redirect_url)
        self.end_headers()

    def _handle_callback(self, query: str) -> None:
        """Capture token from callback and trigger shutdown."""
        if self.server._token_received:
            self.send_error(410, "Already processed")
            return

        params = parse_qs(query)
        token_list = params.get("token")

        if not token_list:
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><body>Missing token parameter.</body></html>")
            return

        token = token_list[0]
        self.server._token_received = True
        self.server._token = token

        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(
            b"<html><body>Authentication complete. You may close this tab.</body></html>"
        )

        # Marshal callback to GTK main thread and schedule shutdown
        if self.server._callback is not None:
            GLib.idle_add(self.server._callback, token)

        # Schedule server shutdown from a separate thread to avoid deadlock
        threading.Thread(
            target=self.server.shutdown, daemon=True
        ).start()

    def log_message(self, format: str, *args: object) -> None:
        # Suppress all logging — token could leak via query string
        pass


class AuthCallbackServer(http.server.HTTPServer):
    """One-shot HTTP server for receiving auth callback on localhost."""

    def __init__(self) -> None:
        try:
            super().__init__(("127.0.0.1", 0), _AuthRequestHandler)
        except OSError as e:
            raise AuthError(f"Failed to bind auth callback server: {e}") from e

        self._callback: Callable[[str], None] | None = None
        self._token: str | None = None
        self._token_received: bool = False
        self._thread: threading.Thread | None = None

    def get_port(self) -> int:
        """Return the ephemeral port assigned by the OS."""
        return self.server_address[1]

    def start_async(self, callback: Callable[[str], None]) -> None:
        """Start serving on a background thread."""
        self._callback = callback
        self._thread = threading.Thread(
            target=self.serve_forever, daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """Shut down the server and wait for the thread to exit."""
        self.shutdown()
        self.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
