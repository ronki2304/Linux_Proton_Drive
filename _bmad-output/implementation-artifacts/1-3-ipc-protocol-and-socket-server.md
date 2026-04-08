# Story 1.3: IPC Protocol & Socket Server

Status: ready-for-dev

## Story

As a developer,
I want the engine to start a Unix socket server with length-prefixed JSON framing and emit a `ready` event,
so that the UI process can establish a reliable communication channel with the sync engine.

## Acceptance Criteria

1. **Given** the engine starts via `node --import tsx src/main.ts`, **when** initialization completes, **then** a Unix socket is created at `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock` **and** the engine emits a `ready` event with `{version, protocol_version}` payload.

2. **Given** the `MessageReader` class in `ipc.ts`, **when** processing incoming data, **then** it correctly handles 4-byte big-endian length prefix + JSON payload framing **and** all commands carry a unique `id` field (UUID v4) **and** responses echo `id` with `_result` suffix.

3. **Given** unit tests for `MessageReader`, **when** running `node --import tsx --test engine/src/ipc.test.ts`, **then** tests pass for: partial message, multiple messages in one chunk, message split across chunks, zero-length payload, oversized payload.

4. **Given** an active connection exists, **when** a second client attempts to connect, **then** the engine rejects it immediately with `ALREADY_CONNECTED` error and destroys the socket.

5. **Given** the engine receives a `shutdown` command, **when** processing the command, **then** the engine closes the socket and exits cleanly.

## Tasks / Subtasks

- [ ] Task 1: Create `engine/src/errors.ts` — typed error hierarchy (AC: all)
  - [ ] 1.1 Define `EngineError` base class extending `Error`
  - [ ] 1.2 Define subclasses: `IpcError`, `SyncError`, `NetworkError`, `ConfigError`
  - [ ] 1.3 Zero internal imports — this file is imported by all other engine files

- [ ] Task 2: Create `engine/src/ipc.ts` — MessageReader + IPC server + protocol types (AC: #1, #2, #4, #5)
  - [ ] 2.1 Define IPC message types/interfaces: `IpcCommand`, `IpcResponse`, `IpcPushEvent`
  - [ ] 2.2 Implement `MessageReader` class with `feed(chunk: Buffer): ParsedMessage[]` method
    - Accumulates chunks in internal buffer
    - Reads 4-byte big-endian length prefix
    - Extracts JSON payload when full message available
    - Returns array of zero or more complete parsed messages per call
  - [ ] 2.3 Implement `writeMessage(socket, message)` — serializes JSON, prepends 4-byte big-endian length prefix, writes to socket
  - [ ] 2.4 Implement `IpcServer` class
    - Creates `net.Server` bound to Unix socket path
    - On connection: if `activeConnection !== null`, write `ALREADY_CONNECTED` error and `socket.destroy()` immediately
    - Wires `data` event through `MessageReader.feed()`
    - Routes parsed commands to a handler callback
    - Tracks `activeConnection` reference (set on connect, cleared on close/error)
  - [ ] 2.5 Implement `shutdown` command handler — closes active connection, closes server, process exits cleanly
  - [ ] 2.6 Implement `emitReady()` — sends `ready` push event with `{version, protocol_version}` payload on new connection
  - [ ] 2.7 Socket path resolution: `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`
  - [ ] 2.8 Delete stale socket file before binding (handle `EADDRINUSE`)
  - [ ] 2.9 `mkdir -p` for socket directory in dev mode (Flatpak sandbox auto-creates it)

- [ ] Task 3: Create `engine/src/main.ts` — entry point (AC: #1)
  - [ ] 3.1 Import and instantiate `IpcServer`
  - [ ] 3.2 Start server, emit `ready` event on first connection
  - [ ] 3.3 Read `version` from `package.json` (with `{ type: "json" }` import assertion)
  - [ ] 3.4 Set `protocol_version` to `1`

- [ ] Task 4: Create `engine/src/ipc.test.ts` — comprehensive MessageReader and server tests (AC: #2, #3, #4, #5)
  - [ ] 4.1 MessageReader: partial message — feed incomplete chunk, verify no messages returned; feed remainder, verify message returned
  - [ ] 4.2 MessageReader: multiple messages in one chunk — feed buffer containing two complete messages, verify both returned
  - [ ] 4.3 MessageReader: message split across chunks — split a message at arbitrary byte offset, feed in two calls, verify message returned on second call
  - [ ] 4.4 MessageReader: zero-length payload — 4-byte header with length 0, verify handled gracefully (error or empty object)
  - [ ] 4.5 MessageReader: oversized payload — length prefix exceeding max (e.g., >1MB), verify rejection with `IpcError`
  - [ ] 4.6 Server: `ALREADY_CONNECTED` — connect two clients, verify second receives error and is disconnected
  - [ ] 4.7 Server: `shutdown` command — send shutdown, verify server closes and process can exit
  - [ ] 4.8 Server: `ready` event — verify first message after connection is `ready` with `version` and `protocol_version`
  - [ ] 4.9 Response ID: send command with `id` field, verify response `id` has `_result` suffix

## Dev Notes

### IPC Wire Format

Every message (both directions) is framed as:

```
[4 bytes: big-endian uint32 payload length][N bytes: UTF-8 JSON payload]
```

- Length prefix is the byte length of the JSON payload only (excludes the 4-byte header itself).
- Maximum payload size: enforce a reasonable cap (1 MB recommended). Reject oversized with `IpcError`.

### Command/Response ID Convention

- Every command from UI carries a `id` field (UUID v4 string).
- Engine responses echo the same `id` with `_result` appended to the command `type`.
- Example: command `{type: "get_status", id: "abc-123"}` produces response `{type: "get_status_result", id: "abc-123", payload: {...}}`.
- **Exceptions — no `_result` response:**
  - `token_refresh` — engine responds asynchronously via `session_ready` or `token_expired` push event
  - `shutdown` — engine responds by closing the socket and exiting

### Push Events (Engine to UI)

Push events have no `id` field. They are fire-and-forget notifications:

```typescript
{type: "ready", payload: {version: "0.1.0", protocol_version: 1}}
```

### MessageReader Implementation

```typescript
class MessageReader {
    private buffer = Buffer.alloc(0);

    feed(chunk: Buffer): ParsedMessage[] {
        // 1. Concatenate chunk to internal buffer
        // 2. Loop: while buffer.length >= 4
        //    a. Read uint32 BE from bytes 0-3 → payloadLength
        //    b. If buffer.length < 4 + payloadLength → break (incomplete)
        //    c. Slice bytes 4..(4+payloadLength), JSON.parse → message
        //    d. Advance buffer past consumed bytes
        //    e. Push message to results
        // 3. Return results array
    }
}
```

Key: the `feed` method must handle the loop — a single chunk may contain zero, one, or multiple complete messages, plus a trailing partial message.

### ALREADY_CONNECTED Rejection

When `activeConnection` is already set, the server must write an error frame (using the standard wire format) and immediately destroy the socket:

```typescript
// Wire format — NOT raw JSON.stringify to socket
writeMessage(socket, {type: 'error', payload: {code: 'ALREADY_CONNECTED'}});
socket.destroy();
```

### snake_case Wire Format

All IPC payload fields use `snake_case` on both TypeScript and Python sides. Do NOT transform to `camelCase` in TypeScript. The wire format is canonical. Example: `protocol_version`, `pair_id`, `files_done` — never `protocolVersion`.

### Socket Path Resolution

```typescript
const runtimeDir = process.env['XDG_RUNTIME_DIR'];
if (!runtimeDir) throw new ConfigError('XDG_RUNTIME_DIR not set');
const socketDir = path.join(runtimeDir, 'io.github.ronki2304.ProtonDriveLinuxClient');
const socketPath = path.join(socketDir, 'sync-engine.sock');
```

- In dev mode, `mkdir -p` the socket directory before binding (Flatpak sandbox creates it automatically).
- Before binding, `unlink` the socket file if it exists (handles stale socket from prior crash).

### Engine Source Structure

All files flat under `engine/src/` — no subdirectories except `__integration__/`:

```
engine/src/
  errors.ts          ← this story (Task 1)
  ipc.ts             ← this story (Task 2)
  ipc.test.ts        ← this story (Task 4)
  main.ts            ← this story (Task 3)
```

### errors.ts Constraints

- Zero internal imports — imported by all other engine files; any import from another engine file creates circular dependencies.
- Typed subclasses only — never throw `new Error(...)` or plain strings anywhere in the engine.
- All subclasses extend `EngineError`:

```typescript
export class EngineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
    }
}
export class IpcError extends EngineError {}
export class SyncError extends EngineError {}
export class NetworkError extends EngineError {}
export class ConfigError extends EngineError {}
```

### Testing Framework

- **Use `node:test`** (`describe`/`it`/`test`) + **`node:assert/strict`** — NOT Jest, Vitest, or `expect()`.
- Run: `node --import tsx --test engine/src/ipc.test.ts`
- Use `mock.fn()` from `node:test` for mocking, check calls via `mock.calls`.
- For server tests, create actual `net.Socket` connections to the Unix socket — test real TCP framing behavior, not mocked streams.
- Clean up socket files in `after`/`afterEach`.

### Engine stdout/stderr

Engine must never write to stdout or stderr — `console.log()` corrupts IPC framing. All output goes through IPC push events or the debug log file (`PROTONDRIVE_DEBUG=1`). Remove or guard any `console.*` calls.

### Dependency Rule

- `ipc.ts` imports from `errors.ts` only (within engine source).
- `ipc.ts` must NOT import from `sdk.ts`, `sync-engine.ts`, or any other engine file.
- `main.ts` orchestrates — it imports from `ipc.ts` and `errors.ts`.

### package.json version

`main.ts` reads `version` from `../package.json` using JSON import assertion: `import pkg from "../package.json" with { type: "json" }`. This value is sent in the `ready` event.

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 370-400]
- [Source: _bmad-output/planning-artifacts/architecture.md, IPC Protocol section, lines 121-153]
- [Source: _bmad-output/planning-artifacts/architecture.md, MessageReader pattern, lines 315-327]
- [Source: _bmad-output/planning-artifacts/architecture.md, Single connection enforcement, lines 329-337]
- [Source: _bmad-output/planning-artifacts/architecture.md, File structure, lines 481-501]
- [Source: _bmad-output/project-context.md, full file]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
