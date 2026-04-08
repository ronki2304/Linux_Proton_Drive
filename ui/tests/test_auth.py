"""Tests for localhost auth callback server."""

from __future__ import annotations

import http.client
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Mock GLib before importing auth module
_glib_mock = MagicMock()
sys.modules.setdefault("gi", MagicMock())
sys.modules.setdefault("gi.repository", MagicMock())
sys.modules.setdefault("gi.repository.GLib", _glib_mock)

import protondrive.auth as auth_module

# Ensure GLib.idle_add is a callable mock
auth_module.GLib = _glib_mock


def _make_request(port: int, path: str) -> http.client.HTTPResponse:
    """Make an HTTP request to the auth server."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path)
    return conn.getresponse()


class TestAuthCallbackServer:
    """Test auth callback server behavior."""

    def setup_method(self) -> None:
        _glib_mock.reset_mock()
        _glib_mock.idle_add.side_effect = None

    def test_binds_to_localhost_only(self) -> None:
        server = auth_module.AuthCallbackServer()
        assert server.server_address[0] == "127.0.0.1"
        server.server_close()

    def test_ephemeral_port_nonzero(self) -> None:
        server = auth_module.AuthCallbackServer()
        assert server.get_port() > 0
        server.server_close()

    def test_auth_start_returns_302(self) -> None:
        server = auth_module.AuthCallbackServer()
        server.start_async(lambda t: None)
        port = server.get_port()

        try:
            resp = _make_request(port, "/auth-start")
            assert resp.status == 302
            location = resp.getheader("Location")
            assert location is not None
            assert "account.proton.me" in location
            assert f"127.0.0.1%3A{port}%2Fcallback" in location
        finally:
            server.stop()

    def test_callback_captures_token(self) -> None:
        tokens: list[str] = []

        def on_token(token: str) -> None:
            tokens.append(token)

        _glib_mock.idle_add.side_effect = lambda fn, arg: fn(arg)

        server = auth_module.AuthCallbackServer()
        server.start_async(on_token)
        port = server.get_port()

        try:
            resp = _make_request(port, "/callback?token=test-session-abc")
            assert resp.status == 200
            body = resp.read().decode("utf-8")
            assert "Authentication complete" in body
            time.sleep(0.2)  # Let shutdown propagate
        finally:
            server.stop()

        assert len(tokens) == 1
        assert tokens[0] == "test-session-abc"

    def test_server_stops_after_callback(self) -> None:
        _glib_mock.idle_add.side_effect = lambda fn, arg: fn(arg)

        server = auth_module.AuthCallbackServer()
        server.start_async(lambda t: None)
        port = server.get_port()

        try:
            _make_request(port, "/callback?token=once")
            time.sleep(0.5)  # Let server shut down

            # Second request should fail
            with pytest.raises((ConnectionRefusedError, OSError)):
                _make_request(port, "/callback?token=twice")
        finally:
            try:
                server.stop()
            except Exception:
                pass

    def test_unknown_path_returns_404(self) -> None:
        server = auth_module.AuthCallbackServer()
        server.start_async(lambda t: None)
        port = server.get_port()

        try:
            resp = _make_request(port, "/unknown")
            assert resp.status == 404
        finally:
            server.stop()

    def test_missing_token_returns_400(self) -> None:
        server = auth_module.AuthCallbackServer()
        server.start_async(lambda t: None)
        port = server.get_port()

        try:
            resp = _make_request(port, "/callback")
            assert resp.status == 400
        finally:
            server.stop()

    def test_token_not_in_stderr(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Token must never appear in stdout/stderr."""
        _glib_mock.idle_add.side_effect = lambda fn, arg: fn(arg)

        server = auth_module.AuthCallbackServer()
        server.start_async(lambda t: None)
        port = server.get_port()

        secret_token = "super-secret-token-xyz"
        try:
            _make_request(port, f"/callback?token={secret_token}")
            time.sleep(0.2)
        finally:
            server.stop()

        captured = capsys.readouterr()
        assert secret_token not in captured.out
        assert secret_token not in captured.err

    def test_bind_failure_raises_auth_error(self) -> None:
        """AuthError raised when server cannot bind."""
        from protondrive.errors import AuthError

        with patch.object(auth_module.http.server.HTTPServer, "__init__", side_effect=OSError("Address in use")):
            with pytest.raises(AuthError, match="Failed to bind"):
                auth_module.AuthCallbackServer()
