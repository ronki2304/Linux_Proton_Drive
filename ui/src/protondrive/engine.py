from __future__ import annotations

import json
import os
import signal
import struct
import uuid
from pathlib import Path
from typing import Any, Callable

from gi.repository import Gio, GLib

APP_ID = "io.github.ronki2304.ProtonDriveLinuxClient"
SOCKET_NAME = "sync-engine.sock"
MAX_RETRY_DELAY_MS = 2000
TOTAL_TIMEOUT_MS = 10000
INITIAL_RETRY_DELAY_MS = 100
SUPPORTED_PROTOCOL_VERSION = 1
SHUTDOWN_TIMEOUT_SECONDS = 5


class EngineError(Exception):
    """Base error for engine communication failures."""


class EngineNotFoundError(EngineError):
    """Engine binary or script not found."""


class EngineConnectionError(EngineError):
    """Failed to connect to engine IPC socket."""


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
        / "engine.js"
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
        self._connection: Gio.SocketConnection | None = None
        self._input_stream: Gio.DataInputStream | None = None
        self._engine_ready: bool = False
        self._protocol_mismatch: bool = False
        self._pending_commands: list[dict[str, Any]] = []
        self._retry_delay_ms: int = INITIAL_RETRY_DELAY_MS
        self._elapsed_ms: int = 0
        self._event_handlers: dict[str, Any] = {}
        self._error_callback: Callable[[str, bool], None] | None = None
        self._session_ready_callback: Callable[[dict[str, Any]], None] | None = None
        self._token_expired_callback: Callable[[dict[str, Any]], None] | None = None
        self._protocol_version: int | None = None
        self._shutdown_initiated: bool = False
        self._kill_timer_id: int | None = None

    def on_event(self, event_type: str, handler: Any) -> None:
        """Register handler for a specific IPC event type."""
        self._event_handlers[event_type] = handler

    def on_error(self, callback: Callable[[str, bool], None]) -> None:
        """Register callback for errors. callback(message, is_fatal)."""
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

        success, pid = GLib.spawn_async(
            working_directory=None,
            argv=[node_path, engine_script],
            envp=None,
            flags=GLib.SpawnFlags.DO_NOT_REAP_CHILD
            | GLib.SpawnFlags.SEARCH_PATH,
            child_setup=None,
        )

        if not success:
            self._emit_error("Sync engine failed to start.")
            return

        self._engine_pid = pid
        GLib.child_watch_add(
            GLib.PRIORITY_DEFAULT, pid, self._on_engine_exit
        )

        self._retry_delay_ms = INITIAL_RETRY_DELAY_MS
        self._elapsed_ms = 0
        GLib.timeout_add(self._retry_delay_ms, self._attempt_connection)

    def _attempt_connection(self) -> bool:
        """Try connecting to the engine socket. Returns False to stop GLib timer."""
        socket_path = _get_socket_path()

        if not os.path.exists(socket_path):
            return self._schedule_retry()

        client = Gio.SocketClient.new()
        addr = Gio.UnixSocketAddress.new(socket_path)

        try:
            connection = client.connect(
                Gio.SocketAddressEnumerator.new_from_connectable(addr),
                None,
            )
        except GLib.Error:
            return self._schedule_retry()

        self._connection = connection
        self._setup_reader()
        return False  # Stop retry timer

    def _schedule_retry(self) -> bool:
        """Schedule next connection retry with exponential backoff."""
        self._elapsed_ms += self._retry_delay_ms
        if self._elapsed_ms >= TOTAL_TIMEOUT_MS:
            self._emit_error("Could not connect to sync engine.")
            return False

        self._retry_delay_ms = min(self._retry_delay_ms * 2, MAX_RETRY_DELAY_MS)
        GLib.timeout_add(self._retry_delay_ms, self._attempt_connection)
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

    def _flush_pending_commands(self) -> None:
        """Send all queued commands."""
        pending = self._pending_commands
        self._pending_commands = []
        for cmd in pending:
            self._write_message(cmd)

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
            self._pending_commands.append(cmd)
        else:
            self._write_message(cmd)

    def _write_message(self, msg: dict[str, Any]) -> None:
        """Serialize and write a framed IPC message."""
        if self._connection is None:
            return

        payload = json.dumps(msg).encode("utf-8")
        header = struct.pack(">I", len(payload))
        output_stream = self._connection.get_output_stream()
        output_stream.write_bytes(GLib.Bytes.new(header + payload), None)

    def send_shutdown(self) -> None:
        """Send shutdown command to engine and start kill timer."""
        self._shutdown_initiated = True
        if self._connection is not None:
            self._write_message({"type": "shutdown"})
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

        if self._engine_ready:
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
            self._error_callback(message, fatal)

    def restart(self) -> None:
        """Restart the engine after a fatal error."""
        self._engine_ready = False
        self._protocol_mismatch = False
        self._shutdown_initiated = False
        self._pending_commands.clear()
        if self._connection is not None:
            try:
                self._connection.close(None)
            except GLib.Error:
                pass
            self._connection = None
        self.start()

    def cleanup(self) -> None:
        """Clean up resources on app shutdown."""
        self.send_shutdown()
        if self._connection is not None:
            try:
                self._connection.close(None)
            except GLib.Error:
                pass
            self._connection = None
