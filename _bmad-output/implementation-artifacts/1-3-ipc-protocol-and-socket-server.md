# Story 1.3: IPC Protocol & Socket Server

Status: done

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

- [x] Task 1: Create `engine/src/errors.ts` — typed error hierarchy (AC: all)
  - [x] 1.1 Define `EngineError` base class extending `Error`
  - [x] 1.2 Define subclasses: `IpcError`, `SyncError`, `NetworkError`, `ConfigError`
  - [x] 1.3 Zero internal imports — this file is imported by all other engine files

- [x] Task 2: Create `engine/src/ipc.ts` — MessageReader + IPC server + protocol types (AC: #1, #2, #4, #5)
  - [x] 2.1 Define IPC message types/interfaces: `IpcCommand`, `IpcResponse`, `IpcPushEvent`
  - [x] 2.2 Implement `MessageReader` class with `feed(chunk: Buffer): ParsedMessage[]` method
  - [x] 2.3 Implement `writeMessage(socket, message)` — serializes JSON, prepends 4-byte big-endian length prefix, writes to socket
  - [x] 2.4 Implement `IpcServer` class with single connection enforcement
  - [x] 2.5 Implement `shutdown` command handler — closes active connection, closes server
  - [x] 2.6 Implement `emitReady()` via `onConnect` callback — sends `ready` push event on new connection
  - [x] 2.7 Socket path resolution: `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`
  - [x] 2.8 Delete stale socket file before binding (handle `EADDRINUSE`)
  - [x] 2.9 `mkdir -p` for socket directory in dev mode

- [x] Task 3: Create `engine/src/main.ts` — entry point (AC: #1)
  - [x] 3.1 Import and instantiate `IpcServer`
  - [x] 3.2 Start server, emit `ready` event on first connection
  - [x] 3.3 Read `version` from `package.json` (with `{ type: "json" }` import assertion)
  - [x] 3.4 Set `protocol_version` to `1`

- [x] Task 4: Create `engine/src/ipc.test.ts` — comprehensive MessageReader and server tests (AC: #2, #3, #4, #5)
  - [x] 4.1 MessageReader: partial message — 0 messages on incomplete, 1 on remainder
  - [x] 4.2 MessageReader: multiple messages in one chunk — 2 messages returned
  - [x] 4.3 MessageReader: message split across chunks — split at byte 6, message returned on second feed
  - [x] 4.4 MessageReader: zero-length payload — throws IpcError
  - [x] 4.5 MessageReader: oversized payload — throws IpcError for 2MB
  - [x] 4.6 Server: ALREADY_CONNECTED — second client receives error and is disconnected
  - [x] 4.7 Server: shutdown command — server closes
  - [x] 4.8 Server: ready event — first message has version and protocol_version
  - [x] 4.9 Response ID: response echoes id with _result suffix

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

### Review Findings

- [x] [Review][Patch] P1: `JSON.parse` failure in `feed()` throws raw `SyntaxError` (not `IpcError`), drops already-parsed messages in batch [ipc.ts:65] — fixed
- [x] [Review][Patch] P2: Unhandled promise rejection in `void this.handleCommand()` — crashes process if handler rejects [ipc.ts:209] — fixed
- [x] [Review][Patch] P3: Race condition — `activeConnection` may change between `await` and `writeMessage` in `handleCommand` [ipc.ts:218-221] — fixed
- [x] [Review][Patch] P4: `onData` catch block silently swallows errors — violates "engine never swallows errors" constraint [ipc.ts:198-204] — fixed
- [x] [Review][Patch] P5: No runtime validation that parsed JSON has `type`/`id` fields [ipc.ts:65-66] — fixed
- [x] [Review][Patch] P6: `shutdown` command does not trigger `process.exit()` — AC 5 requires "exits cleanly" [main.ts:56-81] — fixed
- [x] [Review][Patch] P7: Empty `after()` hook in tests — assertion failures leak sockets/servers [ipc.test.ts:130-132] — fixed
- [x] [Review][Patch] P8: Missing test — malformed JSON payload (valid length header, invalid JSON body) [ipc.test.ts] — fixed
- [x] [Review][Patch] P9: Missing test — command handler that throws/rejects [ipc.test.ts] — fixed
- [x] [Review][Patch] P10: `main.ts` hardcodes `ENGINE_VERSION` instead of JSON import assertion from `package.json` [main.ts:2] — fixed
- [x] [Review][Defer] W1: Unbounded buffer growth via slow-drip on local Unix socket [ipc.ts:37] — deferred, local socket only
- [x] [Review][Defer] W2: `shutdown` bypasses `commandHandler` — no app-level cleanup hook [ipc.ts:198] — deferred, future stories
- [x] [Review][Defer] W3: `writeMessage` ignores backpressure (`socket.write` return value) [ipc.ts:91] — deferred, MVP volumes
- [x] [Review][Defer] W4: `encodeMessage` can produce frames exceeding `MAX_PAYLOAD_SIZE` [ipc.ts:79] — deferred, no large messages yet
- [x] [Review][Defer] W5: `setTimeout`-based test synchronization is fragile [ipc.test.ts] — deferred, works for now
- [x] [Review][Defer] W6: No test for client disconnect during async command processing [ipc.test.ts] — deferred, complex to test

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
None.

### Completion Notes List
- `errors.ts` reused from Story 1-2 (already complete)
- `ipc.ts`: MessageReader with 4-byte BE length prefix framing, IpcServer with single-connection enforcement, ALREADY_CONNECTED rejection, shutdown command, onConnect callback for ready event
- `main.ts`: reads version from package.json via JSON import assertion, emits ready with protocol_version=1 on connection
- All 9 tests pass: 5 MessageReader edge cases + 4 server behavior tests
- Tests run from engine/ dir: `node --import tsx --test src/ipc.test.ts`

### Change Log
- 2026-04-08: Story 1-3 implemented — IPC protocol with MessageReader, Unix socket server, 9 passing tests

### File List
- engine/src/ipc.ts (new)
- engine/src/ipc.test.ts (new)
- engine/src/main.ts (modified)
- engine/src/errors.ts (unchanged — from Story 1-2)
