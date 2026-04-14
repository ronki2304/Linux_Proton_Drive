"""Tests for engine spawn, connection, IPC client, handshake, and lifecycle."""

from __future__ import annotations

import json
import struct
import uuid
from unittest.mock import MagicMock, patch

import pytest

# GI mocks installed by ui/tests/conftest.py at import time.
from protondrive.engine import (
    AppError,
    EngineClient,
    EngineNotFoundError,
    IpcError,
    SUPPORTED_PROTOCOL_VERSION,
    get_engine_path,
)


class TestGetEnginePath:
    """Test ENGINE_PATH resolution."""

    def test_flatpak_path(self) -> None:
        with patch.dict("os.environ", {"FLATPAK_ID": "io.github.ronki2304.ProtonDriveLinuxClient"}):
            argv = get_engine_path()
        assert argv == ("/app/lib/protondrive-engine/dist/engine",)

    def test_dev_path_with_bun(self) -> None:
        with (
            patch.dict("os.environ", {}, clear=False),
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            import os
            os.environ.pop("FLATPAK_ID", None)
            mock_glib.find_program_in_path.return_value = "/usr/bin/bun"
            bun, script = get_engine_path()
        assert bun == "/usr/bin/bun"
        assert script.endswith("engine/src/main.ts")

    def test_dev_path_bun_missing(self) -> None:
        with (
            patch.dict("os.environ", {}, clear=False),
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            import os
            os.environ.pop("FLATPAK_ID", None)
            mock_glib.find_program_in_path.return_value = None
            with pytest.raises(EngineNotFoundError, match="Bun runtime not found"):
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
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))

        GLibError = type("GLibError", (Exception,), {"message": "spawn failed"})

        with (
            patch("protondrive.engine.get_engine_path", return_value=("/usr/bin/bun", "/tmp/fake.ts")),
            patch("os.path.isfile", return_value=True),
            patch("protondrive.engine.Gio") as mock_gio,
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            mock_glib.Error = GLibError
            mock_gio.SubprocessFlags.NONE = 0
            launcher = MagicMock()
            launcher.spawnv.side_effect = GLibError("spawn failed")
            mock_gio.SubprocessLauncher.new.return_value = launcher
            client.start()

        assert len(errors) == 1
        assert "failed to start" in errors[0][0]
        assert errors[0][1] is True  # fatal

    def test_engine_not_found_error(self) -> None:
        client = EngineClient()
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))

        with patch(
            "protondrive.engine.get_engine_path",
            side_effect=EngineNotFoundError("Bun runtime not found on PATH"),
        ):
            client.start()

        assert len(errors) == 1
        assert "Bun runtime not found" in errors[0][0]

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
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))

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
        client._engine_pid = 999

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 42
            client.send_shutdown()

        assert client._shutdown_initiated
        assert mock_output.write_bytes.call_count == 1
        assert client._kill_timer_id == 42

    def test_expected_exit_no_error(self) -> None:
        """If shutdown was initiated, engine exit is expected — no error."""
        client = EngineClient()
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))
        client._shutdown_initiated = True
        client._engine_ready = True

        with patch("protondrive.engine.GLib") as mock_glib:
            client._on_engine_exit(pid=123, status=0)

        assert len(errors) == 0

    def test_unexpected_crash_shows_fatal_error(self) -> None:
        """If engine exits without shutdown, show fatal error banner."""
        client = EngineClient()
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))
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
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))

        client._dispatch_event({
            "type": "error",
            "payload": {"code": "SYNC_FAILED", "message": "File locked", "pair_id": "abc"},
        })

        assert len(errors) == 1
        assert errors[0][1] is False  # non-fatal
        assert errors[0][2] == "abc"  # pair_id forwarded

    def test_nonfatal_error_without_pair_id(self) -> None:
        """Error push event without pair_id is still non-fatal."""
        client = EngineClient()
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))

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


class TestReviewPatches:
    """Tests for code review patch fixes."""

    def test_ready_handler_dispatched_after_protocol_validation(self) -> None:
        """P1: on_event('ready') handler fires after protocol validation."""
        client, _ = _make_client_with_conn()
        received: list[dict] = []
        client.on_event("ready", lambda msg: received.append(msg))

        client._on_engine_ready({"version": "0.1.0", "protocol_version": 1})

        assert len(received) == 1
        assert received[0]["type"] == "ready"
        assert received[0]["payload"]["version"] == "0.1.0"

    def test_ready_handler_not_called_on_mismatch(self) -> None:
        """P1: on_event('ready') handler does NOT fire on protocol mismatch."""
        client, _ = _make_client_with_conn()
        received: list[dict] = []
        client.on_event("ready", lambda msg: received.append(msg))
        client.on_error(lambda msg, fatal, pair_id=None: None)

        client._on_engine_ready({"version": "0.1.0", "protocol_version": 999})

        assert len(received) == 0

    def test_crash_before_ready_emits_fatal_error(self) -> None:
        """P2: Engine crash before ready still emits fatal error."""
        client = EngineClient()
        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))
        client._engine_ready = False
        client._shutdown_initiated = False

        with patch("protondrive.engine.GLib"):
            client._on_engine_exit(pid=123, status=1)

        assert len(errors) == 1
        assert errors[0][1] is True  # fatal

    def test_start_resets_shutdown_initiated(self) -> None:
        """P3: start() resets _shutdown_initiated flag."""
        client = EngineClient()
        client._shutdown_initiated = True

        GLibError = type("GLibError", (Exception,), {"message": ""})

        with (
            patch("protondrive.engine.get_engine_path", return_value=("/usr/bin/bun", "/tmp/fake.ts")),
            patch("os.path.isfile", return_value=True),
            patch("protondrive.engine.Gio") as mock_gio,
            patch("protondrive.engine.GLib") as mock_glib,
        ):
            mock_glib.Error = GLibError
            mock_gio.SubprocessFlags.NONE = 0
            proc = MagicMock()
            proc.get_identifier.return_value = "999"
            launcher = MagicMock()
            launcher.spawnv.return_value = proc
            mock_gio.SubprocessLauncher.new.return_value = launcher
            client.start()

        assert not client._shutdown_initiated

    def test_is_running_property(self) -> None:
        """P4: is_running reflects engine process or retry state."""
        client = EngineClient()
        assert not client.is_running

        client._engine_pid = 123
        assert client.is_running

        client._engine_pid = None
        client._retry_timer_id = 42
        assert client.is_running

        client._retry_timer_id = None
        assert not client.is_running

    def test_send_shutdown_cancels_retry_timer(self) -> None:
        """P5: send_shutdown cancels pending retry timer."""
        client = EngineClient()
        client._retry_timer_id = 42
        client._engine_pid = 999

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 10
            client.send_shutdown()

        mock_glib.source_remove.assert_called_once_with(42)
        assert client._retry_timer_id is None


class TestStory20TechDebt:
    """Story 2.0 — tech-debt regression tests for AC3–AC6."""

    # --- AC3: restart() reentrancy guard ---

    def test_restart_reentrant_call_is_noop(self) -> None:
        """A reentrant restart() from inside an error callback only spawns once."""
        client = EngineClient()
        call_count = {"start": 0}

        def fake_start() -> None:
            call_count["start"] += 1
            # Simulate a failure path that triggers restart() again from within
            # the first restart() call (e.g. via an error callback chain).
            client.restart()

        with (
            patch.object(client, "start", side_effect=fake_start),
            patch("protondrive.engine.GLib"),
        ):
            client.restart()

        assert call_count["start"] == 1, (
            "reentrant restart() call must be a no-op while the first "
            "restart() is still on the stack"
        )

    def test_restart_flag_cleared_after_completion(self) -> None:
        """After restart() returns, a subsequent restart() must run normally."""
        client = EngineClient()
        with (
            patch.object(client, "start") as mock_start,
            patch("protondrive.engine.GLib"),
        ):
            client.restart()
            client.restart()

        assert mock_start.call_count == 2
        assert client._restart_in_progress is False

    # --- AC4: _write_message tears down stale connection ---

    def test_write_message_failure_tears_down_connection(self) -> None:
        """GLib.Error from output_stream.write_bytes must clean up state."""
        from gi.repository import GLib as _GLib  # mocked GLib

        client, mock_output = _make_client_with_conn()
        client._engine_ready = True
        client._input_stream = MagicMock()

        # Configure write_bytes to raise the mocked GLib.Error.
        mock_output.write_bytes.side_effect = _GLib.Error("write failed")

        errors: list[tuple[str, bool, str | None]] = []
        client.on_error(lambda msg, fatal, pair_id=None: errors.append((msg, fatal, pair_id)))

        client._write_message({"type": "test"})

        assert client._connection is None
        assert client._input_stream is None
        assert client._engine_ready is False
        assert len(errors) == 1
        assert "Failed to send message" in errors[0][0]

    def test_write_message_failure_then_send_command_re_queues(self) -> None:
        """After a write failure, send_command must re-queue rather than write."""
        from gi.repository import GLib as _GLib

        client, mock_output = _make_client_with_conn()
        client._engine_ready = True
        client._input_stream = MagicMock()
        client.on_error(lambda *a, **k: None)

        mock_output.write_bytes.side_effect = _GLib.Error("write failed")
        client._write_message({"type": "first"})
        # Connection should be torn down now.
        assert client._engine_ready is False

        client.send_command({"type": "second"})
        assert len(client._pending_commands) == 1
        assert client._pending_commands[0]["type"] == "second"

    # --- AC5: cleanup() closes connection explicitly ---

    def test_cleanup_closes_connection_explicitly(self) -> None:
        """cleanup() must call close() on the connection and nullify it."""
        client, _ = _make_client_with_conn()
        mock_conn = client._connection
        client._engine_pid = 999

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 10
            client.cleanup()

        mock_conn.close.assert_called_with(None)
        assert client._connection is None

    def test_cleanup_swallows_close_glib_error(self) -> None:
        """cleanup() must not propagate GLib.Error from connection.close()."""
        from gi.repository import GLib as _GLib

        client, _ = _make_client_with_conn()
        client._connection.close.side_effect = _GLib.Error("close failed")
        client._engine_pid = 999

        # Stub only timeout_add_seconds — leave GLib.Error intact so the
        # cleanup() except branch can catch it.
        with patch.object(
            _GLib, "timeout_add_seconds", return_value=10, create=True
        ):
            client.cleanup()

        assert client._connection is None

    # --- AC6: send_command deep-copy guard ---

    def test_send_command_deep_copies_queued_dict(self) -> None:
        """Caller mutations to a queued command must not corrupt the message."""
        client = EngineClient()
        cmd = {"type": "token_refresh", "payload": {"token": "original"}}
        client.send_command(cmd)

        # Caller mutates the original dict after queuing.
        cmd["payload"]["token"] = "tampered"
        cmd["extra"] = "added"

        queued = client._pending_commands[0]
        assert queued["payload"]["token"] == "original"
        assert "extra" not in queued

    def test_send_command_deep_copy_preserves_id(self) -> None:
        """The id assigned by send_command must survive the deep copy."""
        client = EngineClient()
        cmd = {"type": "get_status"}
        client.send_command(cmd)

        queued = client._pending_commands[0]
        assert "id" in queued
        # The original cmd also gets the id (id is assigned BEFORE deepcopy).
        assert cmd["id"] == queued["id"]

    # --- Code review patches (2026-04-09) ---

    def test_restart_cancels_pending_kill_timer(self) -> None:
        """restart() must cancel any pending shutdown kill timer.

        Otherwise the timer fires SHUTDOWN_TIMEOUT_SECONDS later and SIGKILLs
        whichever PID is currently set — by then, the new engine spawned by
        the restart's start() call.
        """
        client = EngineClient()
        client._kill_timer_id = 42  # simulate an armed kill timer

        with (
            patch("protondrive.engine.GLib") as mock_glib,
            patch.object(client, "start"),
        ):
            client.restart()

        mock_glib.source_remove.assert_any_call(42)
        assert client._kill_timer_id is None

    def test_flush_pending_commands_requeues_after_failure(self) -> None:
        """If a flush write fails mid-loop, remaining commands must re-queue.

        Silent drop would lose user-visible work (e.g. a queued token_refresh
        waiting on the first reconnect).
        """
        from gi.repository import GLib as _GLib

        client, mock_output = _make_client_with_conn()
        client._input_stream = MagicMock()
        client.on_error(lambda *a, **k: None)

        # Queue three commands, then trigger flush. The SECOND write fails.
        client._pending_commands = [
            {"type": "first", "id": "a"},
            {"type": "second", "id": "b"},
            {"type": "third", "id": "c"},
        ]

        call_count = {"n": 0}

        def write_side_effect(*_args, **_kwargs):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise _GLib.Error("write failed")

        mock_output.write_bytes.side_effect = write_side_effect

        client._flush_pending_commands()

        # First command was written successfully. Second triggered teardown.
        # Third must be re-queued so a future engine_ready will retry it.
        assert client._connection is None
        assert len(client._pending_commands) == 1
        assert client._pending_commands[0]["type"] == "third"


class TestSendCommandWithResponse:
    """Story 2-3 AC6 — request/response correlation helper."""

    def _make_client(self) -> EngineClient:
        """Build an EngineClient that swallows send_command + GLib timer state."""
        client = EngineClient()
        # send_command would otherwise queue (engine not ready) — that's fine
        # for these tests since we're verifying the helper's bookkeeping, not
        # actual wire writes. The queue is asserted separately when needed.
        return client

    def test_generates_uuid_id(self) -> None:
        client = self._make_client()
        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 1
            client.send_command_with_response({"type": "list_remote_folders"}, lambda _: None)

        # Exactly one entry registered, with a UUID4 string id.
        assert len(client._pending_responses) == 1
        request_id = next(iter(client._pending_responses))
        # Round-trip: must parse as a UUID without raising.
        parsed = uuid.UUID(request_id)
        assert parsed.version == 4

    def test_overwrites_caller_id(self) -> None:
        client = self._make_client()
        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 1
            client.send_command_with_response(
                {"type": "list_remote_folders", "id": "caller-provided"},
                lambda _: None,
            )

        request_id = next(iter(client._pending_responses))
        assert request_id != "caller-provided"

    def test_callback_fires_on_matching_result(self) -> None:
        client = self._make_client()
        received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 42
            client.send_command_with_response(
                {"type": "list_remote_folders"}, lambda payload: received.append(payload)
            )
            request_id = next(iter(client._pending_responses))

            client._dispatch_event(
                {
                    "type": "list_remote_folders_result",
                    "id": request_id,
                    "payload": {"folders": [{"id": "1", "name": "Documents"}]},
                }
            )

        assert len(received) == 1
        assert received[0]["folders"][0]["name"] == "Documents"
        # Callback popped after dispatch.
        assert request_id not in client._pending_responses
        assert request_id not in client._pending_response_timeouts

    def test_callback_not_fired_for_unknown_id(self) -> None:
        client = self._make_client()
        received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 1
            client.send_command_with_response(
                {"type": "list_remote_folders"}, lambda payload: received.append(payload)
            )
            registered_id = next(iter(client._pending_responses))

            client._dispatch_event(
                {
                    "type": "list_remote_folders_result",
                    "id": "different-id",
                    "payload": {"folders": []},
                }
            )

        assert received == []
        # Original callback still pending — not affected by mismatched id.
        assert registered_id in client._pending_responses

    def test_two_concurrent_requests(self) -> None:
        client = self._make_client()
        a_received: list[dict] = []
        b_received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            # Distinct timeout source ids per call so source_remove can match.
            mock_glib.timeout_add_seconds.side_effect = [10, 11]
            client.send_command_with_response(
                {"type": "cmd_a"}, lambda payload: a_received.append(payload)
            )
            client.send_command_with_response(
                {"type": "cmd_b"}, lambda payload: b_received.append(payload)
            )

            ids = list(client._pending_responses.keys())
            assert len(ids) == 2
            id_a, id_b = ids[0], ids[1]
            # Lock the invariant that the helper generates a fresh id per
            # request — would silently regress if anyone reused ids.
            assert id_a != id_b

            # Dispatch in reverse registration order — both must fire.
            client._dispatch_event(
                {"type": "cmd_b_result", "id": id_b, "payload": {"v": "b"}}
            )
            client._dispatch_event(
                {"type": "cmd_a_result", "id": id_a, "payload": {"v": "a"}}
            )

        assert a_received == [{"v": "a"}]
        assert b_received == [{"v": "b"}]
        assert client._pending_responses == {}

    def test_timeout_invokes_callback_with_error(self) -> None:
        """D1 fix — timeout invokes callback with {'error': 'timeout'} so
        callers can transition to a terminal state instead of leaking."""
        client = self._make_client()
        received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 42
            client.send_command_with_response(
                {"type": "list_remote_folders"}, lambda payload: received.append(payload)
            )
            request_id = next(iter(client._pending_responses))

            result = client._on_response_timeout(request_id)

        assert result is False  # one-shot — cancel the timer
        assert request_id not in client._pending_responses
        assert request_id not in client._pending_response_timeouts
        assert received == [{"error": "timeout"}]

    def test_restart_clears_pending(self) -> None:
        client = self._make_client()
        a_received: list[dict] = []
        b_received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.side_effect = [101, 102]
            client.send_command_with_response(
                {"type": "a"}, lambda payload: a_received.append(payload)
            )
            client.send_command_with_response(
                {"type": "b"}, lambda payload: b_received.append(payload)
            )
            assert len(client._pending_responses) == 2

            with patch.object(client, "start"):
                client.restart()

            # Both timeout sources removed.
            removed_ids = [c.args[0] for c in mock_glib.source_remove.call_args_list]
            assert 101 in removed_ids
            assert 102 in removed_ids

        assert client._pending_responses == {}
        assert client._pending_response_timeouts == {}
        # D1 fix — callbacks notified of restart so they can clean up.
        assert a_received == [{"error": "engine_restarted"}]
        assert b_received == [{"error": "engine_restarted"}]

    def test_cleanup_clears_pending(self) -> None:
        client, _ = _make_client_with_conn()
        client._engine_pid = 999
        a_received: list[dict] = []
        b_received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.side_effect = [201, 202, 999]
            # 201/202 are for the two pending responses; 999 is for send_shutdown's
            # kill timer (called inside cleanup()).
            client.send_command_with_response(
                {"type": "a"}, lambda payload: a_received.append(payload)
            )
            client.send_command_with_response(
                {"type": "b"}, lambda payload: b_received.append(payload)
            )
            assert len(client._pending_responses) == 2

            client.cleanup()

            removed_ids = [c.args[0] for c in mock_glib.source_remove.call_args_list]
            assert 201 in removed_ids
            assert 202 in removed_ids

        assert client._pending_responses == {}
        assert client._pending_response_timeouts == {}
        # D1 fix — callbacks notified of restart so they can clean up.
        assert a_received == [{"error": "engine_restarted"}]
        assert b_received == [{"error": "engine_restarted"}]

    def test_protocol_mismatch_fires_callback_synchronously(self) -> None:
        """D1 fix — protocol mismatch fires callback with error immediately
        via GLib.idle_add instead of registering a 10-second timeout."""
        client = self._make_client()
        client._protocol_mismatch = True
        received: list[dict] = []

        with patch("protondrive.engine.GLib") as mock_glib:
            client.send_command_with_response(
                {"type": "list_remote_folders"}, lambda payload: received.append(payload)
            )
            # Verify idle_add was called with the protocol_mismatch error and
            # invoke the scheduled callback to simulate the main loop running.
            assert mock_glib.idle_add.call_count == 1
            args = mock_glib.idle_add.call_args.args
            scheduled_cb = args[0]
            scheduled_payload = args[1]
            assert scheduled_payload == {"error": "protocol_mismatch"}
            scheduled_cb(scheduled_payload)
            # No timeout was registered.
            mock_glib.timeout_add_seconds.assert_not_called()

        # No pending response — protocol mismatch returned early.
        assert client._pending_responses == {}
        assert client._pending_response_timeouts == {}
        # No commands queued — protocol mismatch refused the underlying send.
        assert client._pending_commands == []
        assert received == [{"error": "protocol_mismatch"}]

    def test_subsecond_timeout_rejected(self) -> None:
        """timeout_seconds < 1 floors to 0 in GLib.timeout_add_seconds and
        fires immediately, discarding the callback before any reply arrives."""
        client = self._make_client()

        with pytest.raises(ValueError, match="timeout_seconds must be >= 1"):
            client.send_command_with_response(
                {"type": "list_remote_folders"}, lambda _: None, timeout_seconds=0.5
            )

    def test_negative_timeout_rejected(self) -> None:
        client = self._make_client()

        with pytest.raises(ValueError, match="timeout_seconds must be >= 1"):
            client.send_command_with_response(
                {"type": "list_remote_folders"}, lambda _: None, timeout_seconds=-1
            )

    def test_callback_exception_does_not_kill_dispatch(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A buggy callback must not propagate into Gio's async dispatcher
        and tear down the read loop. Exception is logged to stderr instead."""
        client = self._make_client()

        def bad_callback(_payload: dict) -> None:
            raise RuntimeError("kaboom")

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 42
            client.send_command_with_response({"type": "x"}, bad_callback)
            request_id = next(iter(client._pending_responses))

            # Must not raise.
            client._dispatch_event(
                {"type": "x_result", "id": request_id, "payload": {"v": 1}}
            )

        captured = capsys.readouterr()
        assert "response callback raised" in captured.err
        assert "kaboom" in captured.err

    def test_dispatch_coerces_non_dict_payload_to_empty_dict(self) -> None:
        """If a malformed engine response carries a non-dict payload (list,
        None, str), the callback receives an empty dict instead of a non-dict
        that would crash on .get attribute access."""
        client = self._make_client()
        received: list = []

        with patch("protondrive.engine.GLib") as mock_glib:
            mock_glib.timeout_add_seconds.return_value = 42
            client.send_command_with_response(
                {"type": "x"}, lambda payload: received.append(payload)
            )
            request_id = next(iter(client._pending_responses))

            client._dispatch_event(
                {"type": "x_result", "id": request_id, "payload": ["not", "a", "dict"]}
            )

        assert received == [{}]
