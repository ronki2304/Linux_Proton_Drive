"""Tests for launch routing logic — token validation on app startup."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Reuse the GI mocks from test_engine if they exist, otherwise set up
if "gi" not in sys.modules or not hasattr(sys.modules["gi"], "_is_test_mock"):
    _gi_mock = MagicMock()
    _gi_mock._is_test_mock = True
    _gio_mock = MagicMock()
    _glib_mock = MagicMock()

    sys.modules["gi"] = _gi_mock
    sys.modules["gi.repository"] = MagicMock()
    sys.modules["gi.repository.Gio"] = _gio_mock
    sys.modules["gi.repository.GLib"] = _glib_mock

from protondrive.engine import EngineClient


class TestSendTokenRefresh:
    """Test engine client send_token_refresh method."""

    def test_sends_token_refresh_command(self) -> None:
        client = EngineClient()
        client._engine_ready = True
        client._connection = MagicMock()

        with patch.object(client, "_write_message") as mock_write:
            client.send_token_refresh("my-token")

        assert mock_write.called
        cmd = mock_write.call_args[0][0]
        assert cmd["type"] == "token_refresh"
        assert cmd["payload"]["token"] == "my-token"
        assert "id" in cmd

    def test_token_refresh_queued_if_not_ready(self) -> None:
        client = EngineClient()
        client._engine_ready = False

        client.send_token_refresh("pending-token")

        assert len(client._pending_commands) == 1
        assert client._pending_commands[0]["type"] == "token_refresh"


class TestTokenExpiredDispatch:
    """Test token_expired event dispatch."""

    def test_token_expired_callback_invoked(self) -> None:
        client = EngineClient()
        received: list[dict] = []
        client.on_token_expired(lambda p: received.append(p))

        client._dispatch_event({
            "type": "token_expired",
            "payload": {"queued_changes": 0},
        })

        assert len(received) == 1
        assert received[0]["queued_changes"] == 0

    def test_token_expired_no_callback_no_crash(self) -> None:
        client = EngineClient()
        client._dispatch_event({
            "type": "token_expired",
            "payload": {"queued_changes": 5},
        })


class TestLaunchRoutingSource:
    """Verify launch routing code exists via source inspection."""

    def test_main_has_launch_routing(self) -> None:
        source = (
            Path(__file__).parent.parent / "src" / "protondrive" / "main.py"
        ).read_text()
        assert "send_token_refresh" in source
        assert "_on_engine_ready" in source
        assert "show_pre_auth" in source
        assert "_on_token_expired" in source
        assert "_on_session_ready" in source
        assert "show_main" in source

    def test_wizard_auth_complete_key_in_schema(self) -> None:
        schema = (
            Path(__file__).parent.parent
            / "data"
            / "io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml"
        ).read_text()
        assert "wizard-auth-complete" in schema
        assert 'type="b"' in schema
