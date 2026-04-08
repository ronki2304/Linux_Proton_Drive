# Deferred Work

## Deferred from: code review of 1-1-ui-project-scaffolding (2026-04-08)

- `_on_engine_error` is `pass` — needs error display implementation (Story 5.x)
- `on_event("ready")` handler in `engine.py` `_dispatch_event` handles `ready` internally and returns before checking `_event_handlers` — Application's `_on_engine_ready` never fires (story 1-3/1-5)
- `start_auth_flow()` in Application is dead code — no call site reaches it
- `logout()` swallows `CredentialManager.delete_token()` exceptions with bare `except Exception: pass` — token may persist after UI shows logged-out state
- `_on_auth_completed` calls `show_main()` before engine confirms session via `session_ready` — user sees uninitialized main view

## Deferred from: code review of 1-3-ipc-protocol-and-socket-server (2026-04-08)

- W1: Unbounded buffer growth in `MessageReader.feed()` via slow-drip on local Unix socket — theoretical DoS, local socket only
- W2: `shutdown` command bypasses `commandHandler` — no app-level cleanup hook for future stories
- W3: `writeMessage` ignores `socket.write()` backpressure return value — acceptable for MVP volumes on local socket
- W4: `encodeMessage` can produce frames exceeding `MAX_PAYLOAD_SIZE` — no large messages in current scope
- W5: `setTimeout`-based test synchronization is fragile for CI — works for now
- W6: No test for client disconnect during async command processing — complex to test, low priority

## Deferred from: code review of 1-4-engine-spawn-and-socket-connection (2026-04-08)

- W1: `read_bytes_async` short reads may cause framing desync — Gio DataInputStream buffers for Unix sockets, low risk
- W2: Malformed JSON messages silently dropped with no logging — acceptable for MVP, add structured logging later
- W3: Synchronous `client.connect()` instead of `connect_async()` — Unix socket connect is near-instant on localhost
- W4: `EngineConnectionError` defined but never raised — dead code, may be used by future stories
- W5: No tests for backoff timing, Gio read loop, or write framing verification — requires GLib integration testing
- W6: Module-level GI mocks in test_engine.py leak across test session — works for now, revisit when test suite grows
