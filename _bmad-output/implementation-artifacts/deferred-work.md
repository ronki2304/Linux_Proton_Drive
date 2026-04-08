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
