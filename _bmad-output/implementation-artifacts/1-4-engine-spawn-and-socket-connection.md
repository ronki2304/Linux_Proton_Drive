# Story 1.4: Engine Spawn & Socket Connection

Status: ready-for-dev

## Story

As a user,
I want the app to start the sync engine automatically and connect to it,
So that I don't need to manage processes manually.

**Dependencies:** Story 1.1 (UI scaffold), Story 1.3 (IPC protocol & socket server)

## Acceptance Criteria

1. **Given** the app launches, **when** the UI process starts, **then** it spawns the engine via `GLib.spawn_async()` using the correct `ENGINE_PATH` resolution (Flatpak: `/usr/lib/sdk/node22/bin/node` + `/app/lib/protondrive/engine.js`; dev: `GLib.find_program_in_path('node')` + project-relative `engine/dist/engine.js`) **and** checks `GLib.spawn_async()` return value — `False` means spawn failed; surfaces clear error to user.

2. **Given** the engine has been spawned, **when** the UI attempts to connect to the IPC socket, **then** it uses `Gio.SocketClient` with exponential backoff for up to 10 seconds **and** on successful connection, it reads messages via `Gio.DataInputStream` (never Python `socket.recv()`).

3. **Given** the engine is not found on `$PATH` (dev) or is missing from the bundle (Flatpak), **when** the UI attempts to spawn it, **then** a clear startup error is displayed: "Sync engine not found" — never a cryptic socket timeout.

4. **Given** app launches cold, **when** engine connects and `ready` event is received, **then** main window is interactive within 3 seconds (NFR1).

## Tasks / Subtasks

- [ ] Task 1: Implement `ENGINE_PATH` resolution (AC: #1, #3)
  - [ ] 1.1 Add `get_engine_path() -> tuple[str, str]` function to `ui/src/protondrive/engine.py` — detect Flatpak via `os.environ.get('FLATPAK_ID')`, return `(node_binary, engine_script)` tuple
  - [ ] 1.2 Flatpak path: `('/usr/lib/sdk/node22/bin/node', '/app/lib/protondrive/engine.js')`
  - [ ] 1.3 Dev path: `(GLib.find_program_in_path('node'), Path(__file__).parent.parent.parent / 'engine/dist/engine.js')` — resolve relative to source tree
  - [ ] 1.4 Validate both paths exist before spawn — if node binary is `None` or engine script missing, raise clear error immediately (never proceed to socket connection)

- [ ] Task 2: Implement engine spawn via `GLib.spawn_async()` (AC: #1, #3)
  - [ ] 2.1 Add `spawn_engine(self) -> bool` method — calls `GLib.spawn_async()` with `[node_path, engine_script_path]` argv and `GLib.SpawnFlags.DO_NOT_REAP_CHILD`
  - [ ] 2.2 Check return value — `GLib.spawn_async()` returns `(bool, pid)`, does NOT raise on failure; `False` = spawn failed
  - [ ] 2.3 On spawn failure: emit clear error via `AdwStatusPage` or error banner — message: "Sync engine not found. Please ensure Node.js is installed." (dev) or "Sync engine failed to start." (Flatpak) — never proceed to socket connection
  - [ ] 2.4 Store child PID for later cleanup
  - [ ] 2.5 Add `GLib.child_watch_add()` callback to detect engine crashes (socket close = fatal error banner + restart button)

- [ ] Task 3: Implement socket connection with exponential backoff (AC: #2, #4)
  - [ ] 3.1 Add `_connect_to_engine(self) -> None` method — uses `Gio.SocketClient` to connect to Unix socket at `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`
  - [ ] 3.2 Implement exponential backoff: initial delay 100ms, doubling each attempt, max delay capped at 2s, total timeout 10s — use `GLib.timeout_add()` for retry scheduling (never `time.sleep()`)
  - [ ] 3.3 On connection success: store `Gio.SocketConnection` reference, proceed to message reading setup
  - [ ] 3.4 On total timeout (10s): display error — "Could not connect to sync engine" with restart option
  - [ ] 3.5 Resolve socket path via `os.environ.get('XDG_RUNTIME_DIR')` with appropriate fallback

- [ ] Task 4: Implement IPC message reading via `Gio.DataInputStream` (AC: #2)
  - [ ] 4.1 Create `Gio.DataInputStream` from `connection.get_input_stream()`
  - [ ] 4.2 Initiate async read loop: `stream.read_bytes_async(4, GLib.PRIORITY_DEFAULT, None, self._on_length_received)` for the 4-byte length prefix
  - [ ] 4.3 In `_on_length_received`: parse big-endian uint32, then `stream.read_bytes_async(payload_length, ...)` with callback `_on_message_received`
  - [ ] 4.4 In `_on_message_received`: decode JSON, dispatch to event handler, re-enter read loop (read next 4-byte prefix)
  - [ ] 4.5 Handle read errors (connection lost) — show fatal error banner + restart button

- [ ] Task 5: Implement `ready` event handling and command queue (AC: #4)
  - [ ] 5.1 Add `_on_engine_ready(self, payload: dict) -> None` — set `self._engine_ready = True`, validate `protocol_version` from payload
  - [ ] 5.2 Implement `_pending_commands: list[dict]` buffer — commands sent before `ready` are queued, flushed on `ready` receipt via `_flush_pending_commands()`
  - [ ] 5.3 Add `send_command(self, cmd: dict) -> None` — if not ready, append to `_pending_commands`; if ready, call `_write_message(cmd)`
  - [ ] 5.4 Add `_write_message(self, msg: dict) -> None` — serialize to JSON, prepend 4-byte big-endian length, write via `Gio.OutputStream`
  - [ ] 5.5 On `ready`: always send `get_status` command (on every `ready`, not just first launch — engine re-reads SQLite on restart)

- [ ] Task 6: Implement IPC message writing (AC: #2)
  - [ ] 6.1 Add `_write_message(self, msg: dict) -> None` — JSON serialize, encode to bytes, prepend 4-byte big-endian length prefix
  - [ ] 6.2 Write via `connection.get_output_stream().write_bytes_async()` or synchronous `write_bytes()` (small messages, acceptable on main loop)
  - [ ] 6.3 Generate UUID `id` field for commands (except push-only events)

- [ ] Task 7: Write pytest tests (AC: #1-#4)
  - [ ] 7.1 `test_engine.py`: test `get_engine_path()` returns correct tuple for Flatpak (mock `FLATPAK_ID` env var) and dev (mock `GLib.find_program_in_path`)
  - [ ] 7.2 Test spawn failure path — mock `GLib.spawn_async()` returning `False`, verify error surfaced (not silent)
  - [ ] 7.3 Test exponential backoff timing — mock `Gio.SocketClient`, verify retry delays double, verify timeout after 10s
  - [ ] 7.4 Test command queue — send commands before `ready`, verify they are buffered; simulate `ready` event, verify flush
  - [ ] 7.5 Test message framing — verify 4-byte big-endian prefix + JSON payload round-trips correctly
  - [ ] 7.6 Test `ready` event triggers `get_status` command
  - [ ] 7.7 Test engine-not-found error message is user-friendly (not a stack trace or timeout)

## Dev Notes

### ENGINE_PATH Dual Resolution

```python
def get_engine_path() -> tuple[str, str]:
    """Return (node_binary, engine_script) paths for current environment."""
    if os.environ.get('FLATPAK_ID'):
        return ('/usr/lib/sdk/node22/bin/node', '/app/lib/protondrive/engine.js')
    node = GLib.find_program_in_path('node')
    if node is None:
        raise AppError("Node.js not found on PATH")
    engine_script = str(Path(__file__).parent.parent.parent / 'engine/dist/engine.js')
    return (node, engine_script)
```

Both paths must be validated before spawn. In dev mode, `GLib.find_program_in_path('node')` returns `None` if node is not installed — handle this explicitly, never let it reach `GLib.spawn_async()` as `None`.

### GLib.spawn_async() Does NOT Raise

This is a critical GTK4 gotcha. `GLib.spawn_async()` returns a `(bool, pid)` tuple. If the first element is `False`, spawn failed. There is no exception. An agent that wraps the call in `try/except` and assumes success will silently ignore spawn failures.

```python
# Correct pattern:
success, pid = GLib.spawn_async(
    argv=[node_path, engine_script],
    flags=GLib.SpawnFlags.DO_NOT_REAP_CHILD,
)
if not success:
    self._show_engine_error("Sync engine failed to start")
    return
self._engine_pid = pid
GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, self._on_engine_exit)
```

### Gio.SocketClient with Exponential Backoff

Connection retry schedule: 100ms, 200ms, 400ms, 800ms, 1600ms, 2000ms (capped), 2000ms... up to 10s total elapsed. Use `GLib.timeout_add()` for scheduling retries — never `time.sleep()` which blocks the GTK main loop.

```python
def _attempt_connection(self) -> None:
    client = Gio.SocketClient.new()
    socket_path = os.path.join(
        os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'),
        'io.github.ronki2304.ProtonDriveLinuxClient',
        'sync-engine.sock'
    )
    addr = Gio.UnixSocketAddress.new(socket_path)
    client.connect_async(addr, None, self._on_connect_result)
```

On failure, schedule retry:
```python
self._retry_delay_ms = min(self._retry_delay_ms * 2, 2000)
self._elapsed_ms += self._retry_delay_ms
if self._elapsed_ms > 10000:
    self._show_engine_error("Could not connect to sync engine")
    return
GLib.timeout_add(self._retry_delay_ms, self._attempt_connection)
```

### IPC Reads — Gio.DataInputStream ONLY

Never use Python `socket.recv()` — it blocks the GTK main loop. All reads flow through `Gio.DataInputStream.read_bytes_async()`:

```python
stream = Gio.DataInputStream.new(connection.get_input_stream())
stream.read_bytes_async(4, GLib.PRIORITY_DEFAULT, None, self._on_length_received)
```

The read loop is: read 4 bytes (length) -> read N bytes (payload) -> parse JSON -> dispatch -> read 4 bytes (next message).

### IPC Write — 4-Byte Length Prefix

Outgoing messages use the same framing: 4-byte big-endian uint32 length prefix + JSON payload bytes.

```python
import struct, json, uuid

def _write_message(self, msg: dict) -> None:
    if 'id' not in msg:
        msg['id'] = str(uuid.uuid4())
    payload = json.dumps(msg).encode('utf-8')
    header = struct.pack('>I', len(payload))
    output_stream = self._connection.get_output_stream()
    output_stream.write_bytes(GLib.Bytes.new(header + payload), None)
```

### Command Queue Before `ready`

Commands sent before the engine emits `ready` are buffered in `_pending_commands` and flushed on receipt. Never dropped.

```python
def send_command(self, cmd: dict) -> None:
    if not self._engine_ready:
        self._pending_commands.append(cmd)
    else:
        self._write_message(cmd)

def _on_engine_ready(self, payload: dict) -> None:
    self._engine_ready = True
    self._flush_pending_commands()
    self.send_command({'type': 'get_status'})  # always, not just first launch
```

### NFR1: Main Window Interactive Within 3 Seconds

Cold start budget: spawn engine (~200ms) + backoff connection (~500ms typical) + `ready` event + `get_status` round-trip. The 3-second budget is tight but achievable if the initial backoff delay starts at 100ms and connection typically succeeds in 1-3 attempts.

### Error Display Rules

- **Engine not found** (node binary missing or engine script missing): Clear `AdwStatusPage` error — "Sync engine not found. Please ensure Node.js is installed." Never a cryptic timeout.
- **Spawn failed** (`GLib.spawn_async()` returns `False`): "Sync engine failed to start" with details if available.
- **Connection timeout** (10s backoff exhausted): "Could not connect to sync engine" + restart button.
- **Engine crash** (socket close / child process exit): Fatal error banner + restart button (per architecture: fatal = app-level banner + restart).
- **Non-fatal errors** (`error` event with optional `pair_id`): Inline on affected pair card — NOT a restart button.

### Socket Path

`$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`

In Flatpak, the sandbox auto-creates the directory. In dev, the engine must `mkdir -p` before binding (Story 1.3 responsibility). The UI only connects — it never creates the socket directory.

### Code Location

All code lives in `ui/src/protondrive/engine.py` — this file owns engine spawn/monitor + IPC client + protocol constants. Tests in `ui/tests/test_engine.py`.

### Python Rules Checklist

- `from __future__ import annotations` in every file
- Type hints on all public functions (including `__init__`, signal handlers)
- No `lambda` in signal connections — explicit method references only
- All widget structure in Blueprint `.blp` files — error states use `AdwStatusPage` defined in Blueprint, Python only sets properties
- Never `import socket` or use `socket.recv()` — all I/O via `Gio` async
- Error classes: `AppError` base, `IpcError(AppError)` for engine communication failures

### IPC Wire Format Reminder

All payload fields use `snake_case` — even in TypeScript. The `ready` event payload: `{version: string, protocol_version: number}`. The `get_status` response: `{pairs: [], online: bool}`. Never camelCase on the wire.

### What This Story Does NOT Cover

- Protocol version mismatch handling logic (validation in `_on_engine_ready` checks it, but mismatch UX is part of Story 1.5)
- `shutdown` command on app close (Story 1.5: Protocol Handshake & Engine Lifecycle)
- Actual event dispatching beyond `ready` and `get_status` (later stories wire specific events)
- Auth flow or token handling (Story 1.6+)
- Blueprint `.blp` file for error states — if the main `window.blp` from Story 1.1 does not yet include an error state `AdwStatusPage`, add one in this story

### References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 1.4, lines 403-429]
- [Source: _bmad-output/planning-artifacts/architecture.md § Sync Engine Process Lifecycle]
- [Source: _bmad-output/planning-artifacts/architecture.md § ENGINE_PATH resolution]
- [Source: _bmad-output/planning-artifacts/architecture.md § IPC Reads via Gio.DataInputStream Only]
- [Source: _bmad-output/planning-artifacts/architecture.md § UI Queues Commands Before ready]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md § Error states, startup flow]
- [Source: _bmad-output/project-context.md § GTK4 Gotchas, Python rules, IPC protocol]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
