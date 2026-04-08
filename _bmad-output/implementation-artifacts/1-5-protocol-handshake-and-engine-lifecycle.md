# Story 1.5: Protocol Handshake & Engine Lifecycle

Status: review

## Story

As a user,
I want the app to verify engine compatibility and handle engine crashes gracefully,
so that I'm never left with a silently broken or stale sync engine.

**Depends on:** Story 1.4 (Engine Spawn & Socket Connection) — assumes `GLib.spawn_async()` engine spawn and `Gio.SocketClient` connection with `Gio.DataInputStream` reads are already implemented.

## Acceptance Criteria

1. **Given** the UI receives the `ready` event from the engine, **when** processing the event, **then** it validates `protocol_version` for compatibility. If incompatible, shows a version mismatch error and refuses to proceed. If compatible, transitions to the main window or wizard.

2. **Given** the UI receives a `ready` event, **when** the handshake completes, **then** the UI sends `get_status` command — on every `ready` event, not just first launch.

3. **Given** commands are sent before the engine `ready` event, **when** the `ready` event is received, **then** all buffered commands in `_pending_commands` are flushed in order.

4. **Given** the user closes the app, **when** the shutdown sequence begins, **then** the UI sends a `shutdown` command to the engine, waits for clean exit, and kills the process if timeout is exceeded.

5. **Given** the engine process crashes unexpectedly, **when** the UI detects socket close, **then** an app-level error banner is displayed with a restart button (fatal error display). No "restart" button is shown for non-fatal errors (those display inline on affected pair card).

## Tasks / Subtasks

- [x] Task 1: Implement `protocol_version` validation on `ready` event (AC: #1)
  - [x] 1.1 Define `SUPPORTED_PROTOCOL_VERSION = 1` constant in `engine.py`
  - [x] 1.2 `_on_engine_ready` validates protocol_version against supported version
  - [x] 1.3 On match: sets `_engine_ready = True`, clears `_protocol_mismatch`
  - [x] 1.4 On mismatch: sets `_protocol_mismatch = True`, emits fatal error, refuses commands
  - [x] 1.5 Version stored for diagnostics

- [x] Task 2: Send `get_status` on every `ready` event (AC: #2)
  - [x] 2.1 `_on_engine_ready` sends get_status after flush — no first-launch gate
  - [x] 2.2 Verified with test: two ready events produce two get_status sends

- [x] Task 3: Implement `_pending_commands` buffer (AC: #3)
  - [x] 3.1 Initialized in constructor
  - [x] 3.2 `send_command` queues if not ready, rejects on protocol mismatch
  - [x] 3.3 `_flush_pending_commands` sends in order, clears list
  - [x] 3.4 Flush called before get_status in `_on_engine_ready`

- [x] Task 4: Implement shutdown sequence (AC: #4)
  - [x] 4.1 `send_shutdown` sends shutdown command, sets `_shutdown_initiated`
  - [x] 4.2 5-second kill timer via `GLib.timeout_add_seconds`
  - [x] 4.3 `_on_engine_exit` cancels kill timer if clean exit
  - [x] 4.4 `_kill_engine` sends SIGKILL on timeout
  - [x] 4.5 `cleanup` calls `send_shutdown` and closes connection

- [x] Task 5: Implement fatal vs non-fatal error display (AC: #5)
  - [x] 5.1 Unexpected socket close / engine exit → fatal error (`_emit_error(msg, fatal=True)`)
  - [x] 5.2 `restart()` method resets state and re-invokes `start()`
  - [x] 5.3 `error` push event dispatched as non-fatal (`fatal=False`) with optional `pair_id`
  - [x] 5.4 Error callback signature: `(message, fatal)` — UI can display appropriately
  - [x] 5.5 Expected shutdown exit: no error emitted (`_shutdown_initiated` flag)

- [x] Task 6: Write pytest tests for handshake and lifecycle logic (AC: #1-#5)
  - [x] 6.1 Matching protocol_version transitions to ready (1 test)
  - [x] 6.2 Mismatched protocol_version blocks commands (1 test)
  - [x] 6.3 Pending commands flushed in order (1 test)
  - [x] 6.4 get_status on every ready event — two readys, two sends (1 test)
  - [x] 6.5 Shutdown sends command and starts timer (1 test)
  - [x] 6.6 Unexpected crash shows fatal error (1 test)
  - [x] 6.7 Non-fatal error events: with and without pair_id (2 tests)
  - [x] 6.8 All tests mock IPC — never spawn real engine

## Dev Notes

### Protocol Version Validation

The `ready` event payload is `{version: string, protocol_version: number}`. `version` is the engine semver; `protocol_version` is an integer for IPC contract compatibility. The UI must check `protocol_version` — if it doesn't match, IPC messages will silently have wrong shapes and corrupt state. This is the primary safety gate for two-process version skew.

```python
SUPPORTED_PROTOCOL_VERSION = 1  # bump when IPC contract changes

def _on_engine_ready(self, payload: dict[str, Any]) -> None:
    if payload.get('protocol_version') != SUPPORTED_PROTOCOL_VERSION:
        self._show_version_mismatch_error(payload)
        return
    self._engine_ready = True
    self._flush_pending_commands()
    self.send_command({'type': 'get_status', 'id': str(uuid.uuid4())})
```

### Re-send `get_status` on Every `ready` Event

Engine re-reads SQLite on restart. After a crash and restart, the `get_status_result` rebuilds full UI state (pairs list, online status). This must happen on every `ready`, not just the first — do not gate behind an `_initial_ready_done` flag.

### `_pending_commands` Buffer

Commands sent before `ready` (e.g., during engine startup) must not be dropped. They are buffered in `_pending_commands` and flushed in insertion order when `ready` arrives. After flush, `_pending_commands` is cleared. New commands after `ready` go directly to socket.

```python
def send_command(self, cmd: dict[str, Any]) -> None:
    if not self._engine_ready:
        self._pending_commands.append(cmd)
    else:
        self._write_message(cmd)

def _flush_pending_commands(self) -> None:
    for cmd in self._pending_commands:
        self._write_message(cmd)
    self._pending_commands.clear()
```

### Shutdown Sequence

`shutdown` is a special command — it does NOT produce a `_result` response. The engine responds by closing the socket and exiting. The UI flow:

1. Send `{'type': 'shutdown'}` to engine
2. Start kill timer (`GLib.timeout_add_seconds(5, self._kill_engine)`)
3. If socket close detected before timeout: cancel timer, proceed with app exit
4. If timeout fires: `os.kill(pid, signal.SIGKILL)` or `GLib.spawn_close_pid()`

Store the engine PID from the `GLib.spawn_async()` call in Story 1.4. The shutdown command must be sent via `_write_message()` directly (bypass `send_command()` since we don't want it queued).

### Fatal vs Non-Fatal Error Display

**Fatal error** = socket close (engine process crashed or exited unexpectedly):
- Show app-level error banner covering the main content area
- Include a "Restart Engine" button that re-triggers `GLib.spawn_async()` + connection sequence
- Use `AdwStatusPage` with error icon, or `AdwBanner` at top of window
- Reset `_engine_ready = False` so new commands get buffered

**Non-fatal error** = `error` push event `{code, message, pair_id?}`:
- If `pair_id` present: show inline on the affected sync pair card (pair-specific error state)
- If no `pair_id`: show as `AdwToast` via `AdwToastOverlay` (transient notification)
- Engine keeps running — never show a restart button for these
- Never escalate a non-fatal error to the fatal error banner

### Distinguishing Expected vs Unexpected Socket Close

The UI must track whether it initiated shutdown. If `_shutdown_initiated = True` and socket closes, that is expected — proceed with app exit, no error banner. If `_shutdown_initiated = False` and socket closes, that is a crash — show fatal error banner.

### Python/GTK4 Conventions (Mandatory)

- **No `lambda` in signal connections** — causes GObject reference cycles and memory leaks; use explicit method references: `button.connect('clicked', self._on_restart_clicked)`
- **Type hints on all public functions** — including `__init__`, signal handlers, and the `_on_engine_ready` callback
- **`from __future__ import annotations`** — in all Python files
- **Blueprint rule** — all widget structure (error banner, restart button, status pages) defined in `.blp` files; Python only wires signals and updates state
- **`Gio.DataInputStream` for IPC reads** — never Python `socket.recv()` from GTK main loop
- **All I/O via `Gio` async or `GLib.idle_add()`** — never block the GTK main loop

### IPC Wire Format Reminder

4-byte big-endian length prefix + JSON payload. All commands carry a UUID `id` field. `shutdown` responds via socket close, not `_result`. Wire format uses `snake_case` on both sides — do not transform to `camelCase` in TypeScript.

### Error Classes

UI-side errors related to this story should use `IpcError(AppError)` for protocol mismatch, disconnect, and timeout scenarios. Do not use bare `except Exception`.

### Widget Conventions

| Scenario | Widget |
|---|---|
| Fatal error (engine crash) | `AdwStatusPage` with error icon + restart button, or `AdwBanner` |
| Non-fatal error (no `pair_id`) | `AdwToast` via `AdwToastOverlay` |
| Non-fatal error (with `pair_id`) | Inline error state on sync pair card |
| Version mismatch | `AdwStatusPage` with warning icon, no restart button |

### File Locations

Expected files touched or created by this story:

```
ui/src/protondrive/
  engine_manager.py   # or ipc_client.py — handshake, lifecycle, pending commands buffer
  window.py           # fatal error banner display, restart button wiring
ui/data/ui/
  window.blp          # error banner / status page widget structure (Blueprint)
ui/tests/
  test_engine.py      # pytest tests for handshake, lifecycle, error display
```

### Testing Approach

- Mock the IPC socket — never spawn real engine in tests
- Use `conftest.py` fixtures for mock engine connection producing real protocol messages
- Test the `_pending_commands` buffer by sending commands before emitting `ready`, then verifying they flush in order
- Verify `get_status` is sent on simulated second `ready` event (engine restart scenario)
- Verify fatal vs non-fatal display paths are mutually exclusive

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 431-462]
- [Source: _bmad-output/planning-artifacts/architecture.md § Sync Engine Process Lifecycle]
- [Source: _bmad-output/planning-artifacts/architecture.md § IPC Protocol]
- [Source: _bmad-output/planning-artifacts/architecture.md § Error Propagation]
- [Source: _bmad-output/planning-artifacts/architecture.md § UI Queues Commands Before ready]
- [Source: _bmad-output/project-context.md § GTK4/Libadwaita rules, error handling, IPC rules]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
None.

### Completion Notes List
- Protocol version validation: mismatch sets `_protocol_mismatch` flag and emits fatal error, blocks all further commands
- Shutdown lifecycle: `send_shutdown()` sends command + starts 5s kill timer; `_on_engine_exit` distinguishes expected vs unexpected exit via `_shutdown_initiated` flag
- Fatal vs non-fatal: error callback now receives `(message, fatal)` tuple; `error` push events are non-fatal, socket close is fatal
- `restart()` method resets all state and re-invokes `start()`
- 20 pytest tests pass (10 from Story 1-4 + 10 new for Story 1-5)
- 9 engine TypeScript tests still pass (regression verified)

### Change Log
- 2026-04-08: Story 1-5 implemented — protocol validation, shutdown lifecycle, fatal/non-fatal error distinction

### File List
- ui/src/protondrive/engine.py (modified — protocol validation, shutdown, restart, error types)
- ui/tests/test_engine.py (modified — 10 new tests for handshake and lifecycle)
