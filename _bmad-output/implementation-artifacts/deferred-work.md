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

## Deferred from: code review of stories 1-6 and 1-7 (2026-04-08)

- No timeout on auth server — daemon thread dies with process, not spec'd; consider adding for robustness later
- time.sleep synchronization in auth tests — low flake risk, would need threading events to fix properly
- on_auth_completed in main.py doesn't handle store_token failure — pre-existing code, needs try/except around credential ops

## Deferred from: code review of 1-8-pre-auth-screen-and-credential-comfort (2026-04-08)

- `_on_auth_completed` transitions to main UI even if token storage fails [window.py:121] — story 1.9/1.10 scope
- `_on_token_expired` during active auth browser leaks auth resources (no cleanup call) [main.py:96] — cross-story lifecycle issue
- `do_activate` shows empty main UI before engine ready fires [main.py:54] — story 1.11 launch routing scope
- Test `sys.modules` pollution not scoped to fixtures [test_pre_auth.py] — pre-existing pattern across all UI tests

## Deferred from: code review of 1-5-protocol-handshake-and-engine-lifecycle (2026-04-08)

- W1: `cleanup()` doesn't close connection explicitly — OS cleans up on exit; engine closes its end
- W2: `_on_engine_error` in main.py is a no-op — no error display UI yet, scoped to future story
- W3: Version mismatch and crash both `fatal=True` — indistinguishable for UI rendering, needs design decision
- W4: `_write_message` failure doesn't tear down stale connection — needs broader connection teardown strategy
- W5: `send_command` queues dict by reference — mutation risk, but internal callers create fresh dicts
- W6: `restart()` reentrancy risk if error callback triggers restart — theoretical until error display implemented

## Deferred from: code review of 1-9-embedded-webkitgtk-auth-browser (2026-04-08)

- W1: `_token_received` flag not thread-safe (concurrent `/callback` race) — single-request server makes concurrent hits near-impossible
- W2: No timeout on auth server — runs indefinitely if user abandons — daemon thread dies with process
- W3: `_on_load_changed` hides error banner on any load event including sub-resources — WebKitGTK main-frame only in practice
- W4: WebView network session not explicitly cleared after auth — `try_close()` + None triggers GC
- W5: `_on_auth_completed` calls `show_main()` before confirming token processed — sync call currently
