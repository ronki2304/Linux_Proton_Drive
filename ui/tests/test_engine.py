"""Tests for engine spawn, connection, IPC client, handshake, and lifecycle."""

from __future__ import annotations

import json
import struct
from unittest.mock import MagicMock, patch

import pytest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# Create mock gi modules before importing engine
_gi_mock = MagicMock()
_gio_mock = MagicMock()
_glib_mock = MagicMock()

sys.modules["gi"] = _gi_mock
sys.modules["gi.repository"] = MagicMock()
sys.modules["gi.repository.Gio"] = _gio_mock
sys.modules["gi.repository.GLib"] = _glib_mock

_gi_mock.repository.Gio = _gio_mock
_gi_mock.repository.GLib = _glib_mock

from protondrive.engine import (
    EngineClient,
    EngineNotFoundError,
    SUPPORTED_PROTOCOL_VERSION,
    get_engine_path,
)


class TestGetEnginePath:
    """Test ENGINE_PATH resolution."""

    def test_flatpak_path(self) -> None:
        with patch.dict("os.environ", {"FLATPAK_ID": "io.github.ronki2304.ProtonDriveLinuxClient"}):
            node, script = get_engine_path()
        assert node == "/usr/lib/sdk/node22/bin/node"
        assert script == "/app/lib/protondrive/engine.js"

    def test_dev_path_with_node(self) -> None:
        with (
            patch.dict("os.environ", {}, clear=False),
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            import os
            os.environ.pop("FLATPAK_ID", None)
            mock_glib.find_program_in_path.return_value = "/usr/bin/node"
            node, script = get_engine_path()
        assert node == "/usr/bin/node"
        assert script.endswith("engine/dist/engine.js")

    def test_dev_path_node_missing(self) -> None:
        with (
            patch.dict("os.environ", {}, clear=False),
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            import os
            os.environ.pop("FLATPAK_ID", None)
            mock_glib.find_program_in_path.return_value = None
            with pytest.raises(EngineNotFoundError, match="Node.js not found"):
                get_engine_path()


def _make_client_with_conn() -> tuple[EngineClient, MagicMock]:
    """Create an EngineClient with a mocked connection."""
    client = EngineClient()
    mock_conn = MagicMock()
    mock_output = MagicMock()
    mock_conn.get_output_stream.return_value = mock_output
    client._connection = mock_conn
    return client, mock_output


class TestEngineClient:
    """Test EngineClient IPC behavior."""

    def test_commands_queued_before_ready(self) -> None:
        client = EngineClient()
        client.send_command({"type": "get_status"})
        client.send_command({"type": "list_pairs"})
        assert len(client._pending_commands) == 2
        assert not client._engine_ready

    def test_ready_flushes_pending_commands(self) -> None:
        client, mock_output = _make_client_with_conn()
        client.send_command({"type": "list_pairs"})
        assert len(client._pending_commands) == 1

        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})
        assert client._engine_ready
        assert len(client._pending_commands) == 0
        # queued list_pairs + auto get_status
        assert mock_output.write_bytes.call_count == 2

    def test_ready_sends_get_status(self) -> None:
        client, mock_output = _make_client_with_conn()
        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})
        assert mock_output.write_bytes.call_count == 1

    def test_message_framing(self) -> None:
        msg = {"type": "test", "id": "abc-123"}
        payload = json.dumps(msg).encode("utf-8")
        header = struct.pack(">I", len(payload))
        frame = header + payload
        length = struct.unpack(">I", frame[:4])[0]
        decoded = json.loads(frame[4 : 4 + length].decode("utf-8"))
        assert decoded["type"] == "test"
        assert decoded["id"] == "abc-123"

    def test_spawn_failure_emits_error(self) -> None:
        client = EngineClient()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))

        with (
            patch("protondrive.engine.get_engine_path", return_value=("/usr/bin/node", "/tmp/fake.js")),
            patch("os.path.isfile", return_value=True),
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            mock_glib.spawn_async.return_value = (False, 0)
            mock_glib.SpawnFlags.DO_NOT_REAP_CHILD = 0
            mock_glib.SpawnFlags.SEARCH_PATH = 0
            client.start()

        assert len(errors) == 1
        assert "failed to start" in errors[0][0]
        assert errors[0][1] is True  # fatal

    def test_engine_not_found_error(self) -> None:
        client = EngineClient()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))

        with patch(
            "protondrive.engine.get_engine_path",
            side_effect=EngineNotFoundError("Node.js not found on PATH"),
        ):
            client.start()

        assert len(errors) == 1
        assert "Node.js not found" in errors[0][0]

    def test_protocol_version_stored(self) -> None:
        client, _ = _make_client_with_conn()
        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})
        assert client._protocol_version == 1


class TestProtocolHandshake:
    """Test Story 1-5: protocol version validation."""

    def test_matching_protocol_version_transitions_to_ready(self) -> None:
        client, mock_output = _make_client_with_conn()
        client._on_engine_ready({"version": "0.1.0", "protocol_version": SUPPORTED_PROTOCOL_VERSION})
        assert client._engine_ready
        assert not client._protocol_mismatch

    def test_mismatched_protocol_version_blocks_commands(self) -> None:
        client, mock_output = _make_client_with_conn()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))

        client._on_engine_ready({"version": "0.1.0", "protocol_version": 999})

        assert not client._engine_ready
        assert client._protocol_mismatch
        assert len(errors) == 1
        assert "mismatch" in errors[0][0]
        assert errors[0][1] is True  # fatal

        # Commands should be rejected
        client.send_command({"type": "get_status"})
        assert len(client._pending_commands) == 0  # not queued
        assert mock_output.write_bytes.call_count == 0  # not sent

    def test_get_status_on_every_ready(self) -> None:
        """Simulate two ready events, verify get_status sent each time."""
        client, mock_output = _make_client_with_conn()

        # First ready
        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})
        first_count = mock_output.write_bytes.call_count
        assert first_count == 1

        # Simulate engine restart — reset ready state
        client._engine_ready = False

        # Second ready
        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})
        assert mock_output.write_bytes.call_count == first_count + 1

    def test_pending_commands_flushed_in_order(self) -> None:
        client, mock_output = _make_client_with_conn()
        client.send_command({"type": "cmd_a"})
        client.send_command({"type": "cmd_b"})

        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})

        # 2 queued + 1 get_status = 3 writes
        assert mock_output.write_bytes.call_count == 3


class TestShutdownLifecycle:
    """Test Story 1-5: shutdown and crash handling."""

    def test_shutdown_sends_command_and_starts_timer(self) -> None:
        client, mock_output = _make_client_with_conn()
        client._engine_ready = True

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 42
            client.send_shutdown()

        assert client._shutdown_initiated
        assert mock_output.write_bytes.call_count == 1
        assert client._kill_timer_id == 42

    def test_expected_exit_no_error(self) -> None:
        """If shutdown was initiated, engine exit is expected — no error."""
        client = EngineClient()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))
        client._shutdown_initiated = True
        client._engine_ready = True

        with patch("protondrive.engine.GLib") as mock_glib:
            client._on_engine_exit(pid=123, status=0)

        assert len(errors) == 0

    def test_unexpected_crash_shows_fatal_error(self) -> None:
        """If engine exits without shutdown, show fatal error banner."""
        client = EngineClient()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))
        client._engine_ready = True
        client._shutdown_initiated = False

        with patch("protondrive.engine.GLib") as mock_glib:
            client._on_engine_exit(pid=123, status=1)

        assert len(errors) == 1
        assert "unexpectedly" in errors[0][0]
        assert errors[0][1] is True  # fatal

    def test_nonfatal_error_event_not_fatal(self) -> None:
        """Error push event with pair_id is non-fatal."""
        client = EngineClient()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))

        client._dispatch_event({
            "type": "error",
            "payload": {"code": "SYNC_FAILED", "message": "File locked", "pair_id": "abc"},
        })

        assert len(errors) == 1
        assert errors[0][1] is False  # non-fatal

    def test_nonfatal_error_without_pair_id(self) -> None:
        """Error push event without pair_id is still non-fatal."""
        client = EngineClient()
        errors: list[tuple[str, bool]] = []
        client.on_error(lambda msg, fatal: errors.append((msg, fatal)))

        client._dispatch_event({
            "type": "error",
            "payload": {"code": "RATE_LIMITED", "message": "Too many requests"},
        })

        assert len(errors) == 1
        assert errors[0][1] is False

    def test_restart_resets_state_and_starts(self) -> None:
        """Restart clears state and re-invokes start."""
        client = EngineClient()
        client._engine_ready = True
        client._protocol_mismatch = True
        client._pending_commands = [{"type": "old"}]

        with patch.object(client, "start") as mock_start:
            with patch("protondrive.engine.GLib"):
                client.restart()

        assert not client._engine_ready
        assert not client._protocol_mismatch
        assert len(client._pending_commands) == 0
        mock_start.assert_called_once()


class TestSessionReadyEvent:
    """Test session_ready event dispatch."""

    def test_session_ready_callback_invoked(self) -> None:
        client = EngineClient()
        received: list[dict] = []
        client.on_session_ready(lambda payload: received.append(payload))

        payload = {
            "display_name": "John Doe",
            "email": "john@proton.me",
            "storage_used": 5368709120,
            "storage_total": 16106127360,
            "plan": "Plus",
        }
        client._dispatch_event({"type": "session_ready", "payload": payload})

        assert len(received) == 1
        assert received[0]["display_name"] == "John Doe"
        assert received[0]["storage_used"] == 5368709120

    def test_session_ready_no_callback_no_crash(self) -> None:
        client = EngineClient()
        client._dispatch_event({
            "type": "session_ready",
            "payload": {"display_name": "Test"},
        })

    def test_session_ready_same_handler_for_reauth(self) -> None:
        """Same callback fires on both initial auth and re-auth."""
        client = EngineClient()
        received: list[dict] = []
        client.on_session_ready(lambda p: received.append(p))

        client._dispatch_event({
            "type": "session_ready",
            "payload": {"display_name": "Initial"},
        })
        client._dispatch_event({
            "type": "session_ready",
            "payload": {"display_name": "ReAuth"},
        })

        assert len(received) == 2
        assert received[0]["display_name"] == "Initial"
        assert received[1]["display_name"] == "ReAuth"
