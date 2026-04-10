from __future__ import annotations

import copy
import json
import os
import signal
import struct
import sys
import uuid
from pathlib import Path
from typing import Any, Callable

from gi.repository import Gio, GLib

from protondrive.errors import AppError, EngineNotFoundError, IpcError

APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"
SOCKET_NAME = "sync-engine.sock"
MAX_RETRY_DELAY_MS = 2000
TOTAL_TIMEOUT_MS = 10000
INITIAL_RETRY_DELAY_MS = 100
SUPPORTED_PROTOCOL_VERSION = 1
SHUTDOWN_TIMEOUT_SECONDS = 5
MAX_MESSAGE_SIZE = 16 * 1024 * 1024  # 16 MB
DEFAULT_RESPONSE_TIMEOUT_SECONDS: float = 10.0


def get_engine_path() -> tuple[str, str]:
    """Return (node_binary, engine_script) paths for the current environment."""
    if os.environ.get("FLATPAK_ID"):
        return (
            "/usr/lib/sdk/node22/bin/node",
            "/app/lib/protondrive/engine.js",
        )

    node = GLib.find_program_in_path("node")
    if node is None:
        raise EngineNotFoundError(
            "Node.js not found on PATH. Please install Node.js 22+."
        )

    engine_script = str(
        Path(__file__).resolve().parent.parent.parent.parent
        / "engine"
        / "dist"
        / "src"
        / "main.js"
    )
    return (node, engine_script)


def _get_socket_path() -> str:
    """Resolve IPC socket path."""
    runtime_dir = os.environ.get(
        "XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"
    )
    return os.path.join(runtime_dir, APP_ID, SOCKET_NAME)


class EngineClient:
    """Manages engine process lifecycle and IPC communication."""

    def __init__(self) -> None:
        self._engine_pid: int | None = None
        self._proc: Gio.Subprocess | None = None
        self._connection: Gio.SocketConnection | None = None
        self._input_stream: Gio.DataInputStream | None = None
        self._engine_ready: bool = False
        self._protocol_mismatch: bool = False
        self._pending_commands: list[dict[str, Any]] = []
        self._retry_delay_ms: int = INITIAL_RETRY_DELAY_MS
        self._elapsed_ms: int = 0
        self._event_handlers: dict[str, Any] = {}
        self._error_callback: Callable[[str, bool, str | None], None] | None = None
        self._session_ready_callback: Callable[[dict[str, Any]], None] | None = None
        self._token_expired_callback: Callable[[dict[str, Any]], None] | None = None
        self._protocol_version: int | None = None
        self._shutdown_initiated: bool = False
        self._kill_timer_id: int | None = None
        self._retry_timer_id: int | None = None
        # Reentrancy guard: an error callback raised from inside restart()
        # (via _emit_error → user callback → restart) must not double-spawn.
        self._restart_in_progress: bool = False
        # Request/response correlation: callers register a callback against a
        # generated UUID via send_command_with_response; _dispatch_event matches
        # incoming `_result` events back to the callback. The timeout dict
        # tracks GLib source-ids so they can be cancelled when the response
        # arrives (or cleared on restart/cleanup).
        self._pending_responses: dict[str, Callable[[dict[str, Any]], None]] = {}
        self._pending_response_timeouts: dict[str, int] = {}

    @property
    def is_running(self) -> bool:
        """True if engine process is alive or connection attempts are in progress."""
        return self._engine_pid is not None or self._retry_timer_id is not None

    def on_event(self, event_type: str, handler: Any) -> None:
        """Register handler for a specific IPC event type."""
        self._event_handlers[event_type] = handler

    def on_error(self, callback: Callable[[str, bool, str | None], None]) -> None:
        """Register callback for errors. callback(message, is_fatal, pair_id)."""
        self._error_callback = callback

    def on_session_ready(self, callback: Callable[[dict[str, Any]], None]) -> None:
        """Register callback for session_ready events.

        Fires on both initial auth and re-auth — same handler for both.
        Payload: {display_name, email, storage_used, storage_total, plan}.
        """
        self._session_ready_callback = callback

    def on_token_expired(self, callback: Callable[[dict[str, Any]], None]) -> None:
        """Register callback for token_expired events.

        Payload: {queued_changes}.
        """
        self._token_expired_callback = callback

    def start(self) -> None:
        """Spawn engine and begin connection attempts."""
        self._shutdown_initiated = False
        try:
            node_path, engine_script = get_engine_path()
        except EngineNotFoundError as e:
            self._emit_error(str(e))
            return

        if not os.path.isfile(engine_script):
            self._emit_error(
                f"Sync engine script not found: {engine_script}"
            )
            return

        try:
            launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE)
            proc = launcher.spawnv([node_path, engine_script])
        except GLib.Error as e:
            self._emit_error(f"Sync engine failed to start: {e.message}")
            return

        self._engine_pid = int(proc.get_identifier() or 0)
        self._proc = proc

        self._retry_delay_ms = INITIAL_RETRY_DELAY_MS
        self._elapsed_ms = 0
        self._retry_timer_id = GLib.timeout_add(
            self._retry_delay_ms, self._attempt_connection
        )

        self._retry_delay_ms = INITIAL_RETRY_DELAY_MS
        self._elapsed_ms = 0
        self._retry_timer_id = GLib.timeout_add(
            self._retry_delay_ms, self._attempt_connection
        )

    def _attempt_connection(self) -> bool:
        """Try connecting to the engine socket. Returns False to stop GLib timer."""
        socket_path = _get_socket_path()

        if not os.path.exists(socket_path):
            return self._schedule_retry()

        client = Gio.SocketClient.new()
        addr = Gio.UnixSocketAddress.new(socket_path)

        try:
            connection = client.connect(addr, None)
        except GLib.Error:
            return self._schedule_retry()

        self._connection = connection
        self._retry_timer_id = None
        self._setup_reader()
        return False  # Stop retry timer

    def _schedule_retry(self) -> bool:
        """Schedule next connection retry with exponential backoff."""
        self._elapsed_ms += self._retry_delay_ms
        if self._elapsed_ms >= TOTAL_TIMEOUT_MS:
            self._emit_error("Could not connect to sync engine.")
            return False

        self._retry_delay_ms = min(self._retry_delay_ms * 2, MAX_RETRY_DELAY_MS)
        self._retry_timer_id = GLib.timeout_add(
            self._retry_delay_ms, self._attempt_connection
        )
        return False

    def _setup_reader(self) -> None:
        """Begin async IPC message read loop."""
        if self._connection is None:
            return
        input_stream = self._connection.get_input_stream()
        self._input_stream = Gio.DataInputStream.new(input_stream)
        self._read_length_prefix()

    def _read_length_prefix(self) -> None:
        """Read 4-byte big-endian length prefix."""
        if self._input_stream is None:
            return
        self._input_stream.read_bytes_async(
            4, GLib.PRIORITY_DEFAULT, None, self._on_length_received
        )

    def _on_length_received(
        self, stream: Gio.DataInputStream, result: Gio.AsyncResult
    ) -> None:
        """Handle received length prefix bytes."""
        if self._shutdown_initiated:
            return
        try:
            gbytes = stream.read_bytes_finish(result)
        except GLib.Error:
            self._emit_error("Lost connection to sync engine.")
            return

        if gbytes is None or gbytes.get_size() == 0:
            self._emit_error("Engine connection closed.")
            return

        data = gbytes.get_data()
        if data is None or len(data) < 4:
            self._emit_error("Incomplete length prefix from engine.")
            return

        payload_length = struct.unpack(">I", bytes(data[:4]))[0]
        if payload_length == 0 or payload_length > MAX_MESSAGE_SIZE:
            self._emit_error(
                f"Invalid message size from engine: {payload_length} bytes."
            )
            return
        self._input_stream.read_bytes_async(
            payload_length,
            GLib.PRIORITY_DEFAULT,
            None,
            self._on_message_received,
        )

    def _on_message_received(
        self, stream: Gio.DataInputStream, result: Gio.AsyncResult
    ) -> None:
        """Handle received message payload."""
        if self._shutdown_initiated:
            return
        try:
            gbytes = stream.read_bytes_finish(result)
        except GLib.Error:
            self._emit_error("Lost connection to sync engine.")
            return

        if gbytes is None or gbytes.get_size() == 0:
            self._emit_error("Engine connection closed.")
            return

        data = gbytes.get_data()
        if data is None:
            self._emit_error("Empty message from engine.")
            return

        try:
            message = json.loads(bytes(data).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._read_length_prefix()
            return

        self._dispatch_event(message)
        self._read_length_prefix()

    def _dispatch_event(self, message: dict[str, Any]) -> None:
        """Route an IPC message to the appropriate handler."""
        event_type = message.get("type", "")

        # IPC convention: events ending in `_result` are RESERVED for command
        # responses (request/response correlation). Push events MUST NOT use
        # the `_result` suffix — they would be silently swallowed by this
        # branch and never reach _event_handlers. If you need a new push
        # event, name it without the `_result` suffix (see architecture.md
        # IPC Protocol section for the canonical event list).
        if event_type.endswith("_result"):
            request_id = message.get("id")
            if isinstance(request_id, str):
                callback = self._pending_responses.pop(request_id, None)
                if callback is not None:
                    timeout_source = self._pending_response_timeouts.pop(
                        request_id, None
                    )
                    if timeout_source is not None:
                        try:
                            GLib.source_remove(timeout_source)
                        except Exception:
                            pass  # source may already have fired
                    # Coerce non-dict payloads to {} so callbacks can rely on
                    # the dict contract; an exception inside the callback must
                    # not propagate into Gio's async dispatcher and kill the
                    # reader loop — log to stderr instead.
                    payload = message.get("payload")
                    if not isinstance(payload, dict):
                        payload = {}
                    try:
                        callback(payload)
                    except Exception as exc:
                        print(
                            f"EngineClient: response callback raised: {exc}",
                            file=sys.stderr,
                        )
                    return
            # Unrecognized id — silently ignore (race with timeout/cancellation).
            return

        if event_type == "ready":
            self._on_engine_ready(message.get("payload", {}))
            return

        if event_type == "session_ready":
            if self._session_ready_callback is not None:
                self._session_ready_callback(message.get("payload", {}))
            return

        if event_type == "token_expired":
            if self._token_expired_callback is not None:
                self._token_expired_callback(message.get("payload", {}))
            return

        if event_type == "error":
            payload = message.get("payload", {})
            pair_id = payload.get("pair_id")
            msg = payload.get("message", "Unknown engine error")
            self._emit_error(msg, fatal=False, pair_id=pair_id)
            return

        handler = self._event_handlers.get(event_type)
        if handler is not None:
            handler(message)

    def _on_engine_ready(self, payload: dict[str, Any]) -> None:
        """Handle engine ready event with protocol version validation."""
        self._protocol_version = payload.get("protocol_version")

        if self._protocol_version != SUPPORTED_PROTOCOL_VERSION:
            self._protocol_mismatch = True
            self._emit_error(
                f"Engine protocol version mismatch — expected "
                f"{SUPPORTED_PROTOCOL_VERSION}, got {self._protocol_version}. "
                f"Please update the app.",
                fatal=True,
            )
            return

        self._engine_ready = True
        self._protocol_mismatch = False
        self._flush_pending_commands()
        self.send_command({"type": "get_status"})

        handler = self._event_handlers.get("ready")
        if handler is not None:
            handler({"type": "ready", "payload": payload})

    def _flush_pending_commands(self) -> None:
        """Send all queued commands.

        If a write fails mid-flush, ``_write_message`` tears down the
        connection. The remaining unsent commands are re-queued so a future
        ``_on_engine_ready`` flush will deliver them — silently dropping them
        would lose user-visible work (e.g. a token_refresh waiting on the
        first reconnect).
        """
        pending = self._pending_commands
        self._pending_commands = []
        for index, cmd in enumerate(pending):
            self._write_message(cmd)
            if self._connection is None:
                # The failed command at ``index`` was already attempted; the
                # error callback decides whether to retry it. Re-queue the
                # rest so they survive the next reconnect.
                self._pending_commands.extend(pending[index + 1 :])
                return

    def send_token_refresh(self, token: str) -> None:
        """Send token_refresh command to engine.

        This is a special command — response comes as session_ready or
        token_expired push event, NOT as a _result message.
        """
        self.send_command({"type": "token_refresh", "payload": {"token": token}})

    def send_command(self, cmd: dict[str, Any]) -> None:
        """Send a command to the engine, or queue it if not yet ready."""
        if self._protocol_mismatch:
            return  # Refuse commands on version mismatch

        if "id" not in cmd:
            cmd["id"] = str(uuid.uuid4())

        if not self._engine_ready:
            # Deep-copy queued commands so caller mutations cannot corrupt
            # the message that will eventually be flushed to the engine.
            self._pending_commands.append(copy.deepcopy(cmd))
        else:
            self._write_message(cmd)

    def send_command_with_response(
        self,
        cmd: dict[str, Any],
        on_result: Callable[[dict[str, Any]], None],
        timeout_seconds: float = DEFAULT_RESPONSE_TIMEOUT_SECONDS,
    ) -> None:
        """Send a command and invoke ``on_result`` with the response payload.

        The callback fires exactly once with one of:
        - the response ``payload`` dict on success
        - ``{"error": "protocol_mismatch"}`` if the engine reported an
          unsupported protocol version (fired immediately via the main loop)
        - ``{"error": "timeout"}`` if no response arrives within
          ``timeout_seconds``
        - ``{"error": "engine_restarted"}`` if ``restart()`` or ``cleanup()``
          tears down the connection before a response arrives

        Generates a fresh UUID id (overwriting any caller-provided id) and
        deep-copies ``cmd`` so caller mutations cannot corrupt the queued
        command. Sub-second ``timeout_seconds`` is rejected — GLib's
        seconds-precision timer would floor to 0 and fire immediately.
        """
        if timeout_seconds < 1:
            raise ValueError(
                f"timeout_seconds must be >= 1 (got {timeout_seconds})"
            )

        if self._protocol_mismatch:
            # Fire synchronously via idle so the callback runs in the main
            # loop rather than the caller's stack frame — avoids surprising
            # reentrancy in caller signal handlers.
            GLib.idle_add(on_result, {"error": "protocol_mismatch"})
            return

        cmd = copy.deepcopy(cmd)
        cmd["id"] = str(uuid.uuid4())
        request_id = cmd["id"]

        self._pending_responses[request_id] = on_result
        timeout_source = GLib.timeout_add_seconds(
            int(timeout_seconds), self._on_response_timeout, request_id
        )
        self._pending_response_timeouts[request_id] = timeout_source

        self.send_command(cmd)

    def _on_response_timeout(self, request_id: str) -> bool:
        """GLib timeout callback — invoke pending callback with timeout error.

        Story 2.3 originally specified silent discard, but party-mode review
        of the story (D1) found that combined with the picker's cache-state
        gate it produced unbounded refetch growth under engine hang. The
        callback now receives ``{"error": "timeout"}`` so callers (like
        RemoteFolderPicker) can transition to a terminal state and stop
        retrying.
        """
        callback = self._pending_responses.pop(request_id, None)
        self._pending_response_timeouts.pop(request_id, None)
        if callback is not None:
            try:
                callback({"error": "timeout"})
            except Exception as exc:
                print(
                    f"EngineClient: response timeout callback raised: {exc}",
                    file=sys.stderr,
                )
        return False  # one-shot

    def _write_message(self, msg: dict[str, Any]) -> None:
        """Serialize and write a framed IPC message."""
        if self._connection is None:
            return

        payload = json.dumps(msg).encode("utf-8")
        header = struct.pack(">I", len(payload))
        output_stream = self._connection.get_output_stream()
        try:
            output_stream.write_bytes(GLib.Bytes.new(header + payload), None)
        except GLib.Error:
            # Tear down stale connection BEFORE notifying the error callback —
            # the callback may call restart(), which expects clean state. Any
            # subsequent send_command() will then re-queue rather than write
            # to a dead socket.
            try:
                self._connection.close(None)
            except GLib.Error:
                pass
            self._connection = None
            self._input_stream = None
            self._engine_ready = False
            self._emit_error("Failed to send message to engine.")

    def send_shutdown(self) -> None:
        """Send shutdown command to engine and start kill timer."""
        self._shutdown_initiated = True
        if self._retry_timer_id is not None:
            GLib.source_remove(self._retry_timer_id)
            self._retry_timer_id = None
        if self._connection is not None:
            self._write_message({"type": "shutdown"})
        if self._engine_pid is not None:
            self._kill_timer_id = GLib.timeout_add_seconds(
                SHUTDOWN_TIMEOUT_SECONDS, self._kill_engine
            )

    def _kill_engine(self) -> bool:
        """Force-kill engine process after shutdown timeout."""
        self._kill_timer_id = None
        if self._engine_pid is not None:
            try:
                os.kill(self._engine_pid, signal.SIGKILL)
            except OSError:
                pass
            self._engine_pid = None
        return False  # Don't repeat

    def _on_engine_exit(
        self, pid: int, status: int, *args: object
    ) -> None:
        """Handle engine process exit."""
        self._engine_pid = None

        # Cancel kill timer if shutdown was clean
        if self._kill_timer_id is not None:
            GLib.source_remove(self._kill_timer_id)
            self._kill_timer_id = None

        if self._shutdown_initiated:
            # Expected exit during app close — no error
            return

        self._engine_ready = False
        self._emit_error(
            "Sync engine stopped unexpectedly.", fatal=True
        )

    def _emit_error(
        self,
        message: str,
        *,
        fatal: bool = True,
        pair_id: str | None = None,
    ) -> None:
        """Notify the UI of an engine error.

        Args:
            message: Human-readable error description.
            fatal: If True, show app-level error banner with restart.
                   If False, show inline on pair card or as toast.
            pair_id: If set, error is pair-specific (non-fatal display).
        """
        if self._error_callback is not None:
            self._error_callback(message, fatal, pair_id)

    def restart(self) -> None:
        """Restart the engine after a fatal error.

        Reentrant calls (e.g. an error callback that calls restart() while
        restart() itself is unwinding) are no-ops — a single restart sequence
        runs to completion.
        """
        if self._restart_in_progress:
            return
        self._restart_in_progress = True
        try:
            # Cancel pending retry timer
            if self._retry_timer_id is not None:
                GLib.source_remove(self._retry_timer_id)
                self._retry_timer_id = None

            # Cancel any pending shutdown kill timer — otherwise it fires
            # SHUTDOWN_TIMEOUT_SECONDS later and SIGKILLs whichever PID is
            # currently in ``self._engine_pid``, which by then is the NEW
            # engine spawned by ``self.start()`` below.
            if self._kill_timer_id is not None:
                GLib.source_remove(self._kill_timer_id)
                self._kill_timer_id = None

            # Kill old engine process
            if self._engine_pid is not None:
                try:
                    os.kill(self._engine_pid, signal.SIGKILL)
                except OSError:
                    pass
                self._engine_pid = None

            self._engine_ready = False
            self._protocol_mismatch = False
            self._shutdown_initiated = False
            self._pending_commands.clear()
            self._clear_pending_responses()
            if self._connection is not None:
                try:
                    self._connection.close(None)
                except GLib.Error:
                    pass
                self._connection = None
            self._input_stream = None
            self.start()
        finally:
            self._restart_in_progress = False

    def cleanup(self) -> None:
        """Clean up resources on app shutdown."""
        self.send_shutdown()
        self._clear_pending_responses()
        # Explicitly close the underlying connection so Gio releases the
        # socket fd promptly even if the engine ignores the shutdown command.
        if self._connection is not None:
            try:
                self._connection.close(None)
            except GLib.Error:
                pass
            self._connection = None
        self._input_stream = None

    def _clear_pending_responses(self) -> None:
        """Cancel pending response timeouts and notify callbacks of restart.

        Used by both ``restart()`` and ``cleanup()``. Each pending callback is
        invoked once with ``{"error": "engine_restarted"}`` so callers can
        transition to a terminal state — without this, callers like
        ``RemoteFolderPicker`` would be stuck waiting on a callback that will
        never arrive (D1 from Story 2.3 review).
        """
        for source_id in self._pending_response_timeouts.values():
            try:
                GLib.source_remove(source_id)
            except Exception:
                pass  # source may already have fired
        self._pending_response_timeouts.clear()
        # Snapshot before clearing so callbacks invoked here can safely
        # re-enter send_command_with_response without iterating a mutating dict.
        callbacks = list(self._pending_responses.values())
        self._pending_responses.clear()
        for callback in callbacks:
            try:
                callback({"error": "engine_restarted"})
            except Exception as exc:
                print(
                    f"EngineClient: restart callback raised: {exc}",
                    file=sys.stderr,
                )
