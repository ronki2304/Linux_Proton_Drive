# Deferred Work

## Resolution Plan (from Epic 1 Retrospective, 2026-04-08)

### Epic 2 Story 0 — Technical Debt Cleanup (9 items)

Items that directly affect Epic 2 stability. Must be resolved before starting Epic 2 feature stories.

| # | Item | Source | Why it matters for Epic 2 |
|---|------|--------|--------------------------|
| 1 | `writeMessage` ignores `socket.write()` backpressure | 1-3 W3 | Continuous sync progress events will flood the socket |
| 2 | `restart()` reentrancy risk if error callback triggers restart | 1-5 W6 | Sync failures in Epic 2 will hit this path |
| 3 | `_write_message` failure doesn't tear down stale connection | 1-5 W4 | Sync disconnects need clean teardown |
| 4 | `cleanup()` doesn't close connection explicitly | 1-5 W1 | Engine lifecycle must be solid for long-running sync |
| 5 | `send_command` queues dict by reference — mutation risk | 1-5 W5 | Sync queue replay could mutate queued commands |
| 6 | Malformed JSON messages silently dropped with no logging | 1-4 W2 | Sync debugging impossible without visibility |
| 7 | `_on_auth_completed` transitions to main UI even if token storage fails | 1-8, 1-6 | Setup wizard (Story 2.4) reuses this flow |
| 8 | WebView network session not explicitly cleared after auth | 1-9 W4 | Auth reuse in setup wizard could leak sessions |
| 9 | `sys.modules` pollution in test fixtures | 1-4 W6, 1-8 | 110+ tests and growing — fix now or never |

### Stays with planned epic (not in Story 0)

| Item | Planned Epic | Reason |
|------|-------------|--------|
| `_on_engine_error` is `pass` — no error display | Epic 5 | Error UI designed in Epic 5 |
| Fatal vs non-fatal error distinction in UI rendering | Epic 5 | Needs error display first |
| `rate_limited` UI paused state | Epic 3 | Offline/network epic |
| Responsive CSS for storage label hiding | Cosmetic | Not blocking |
| Auth server timeout | Low risk | Daemon thread dies with process |
| Thread safety on `_token_received` flag | Low risk | Single-request server |
| `_on_load_changed` hides error banner on sub-resources | Low risk | WebKitGTK main-frame only in practice |
| `logout()` swallows `delete_token()` exceptions | Epic 5 | Error handling scope |
| `start_auth_flow()` dead code | Cleanup | Harmless until called |
| `EngineConnectionError` defined but never raised | Cleanup | Dead code, may be used later |
| Unbounded buffer growth in `MessageReader` | Low risk | Local Unix socket only |
| `shutdown` bypasses `commandHandler` | Future | No cleanup hooks needed yet |
| `encodeMessage` can exceed `MAX_PAYLOAD_SIZE` | Future | No large messages in current scope |
| `setTimeout`-based test synchronization | Low risk | Works for now |
| No test for client disconnect during async command | Low priority | Complex to test |
| `read_bytes_async` short reads | Low risk | Gio buffers for Unix sockets |
| Synchronous `client.connect()` | Acceptable | Near-instant on localhost |
| No tests for backoff timing / Gio read loop | Nice-to-have | Requires GLib integration testing |
| No timeout on auth server (×2) | Low risk | Daemon thread dies with process |
| `time.sleep` synchronization in auth tests | Low flake | Would need threading events |
| `_on_token_expired` during active auth leaks resources | Edge case | Cross-story lifecycle |
| `do_activate` shows empty main UI before engine ready | Resolved | Fixed in Story 1.11 |
| `_on_auth_completed` calls `show_main()` before engine confirms session | Resolved | Fixed in Story 1.10/1.11 |
| `on_event("ready")` handler never dispatches to Application callback | Resolved | Fixed in Story 1.5 |
| Version mismatch and crash both `fatal=True` — indistinguishable | Epic 5 | Needs design decision with error UI |

---

## Original Deferred Items by Story

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

## Deferred from: code review of 2-0-tech-debt-cleanup (2026-04-09)

- W1: AC10 — `meson test -C builddir` returns "No tests defined"; `ui/meson.build` has no `test()` declaration — pytest is the canonical UI runner. Defer to Story 2.10 (Flatpak build validation) which will wire the meson `test()` wrapper.
- W2: `debugLog` parse-error path may theoretically leak frame contents via Node `SyntaxError` message [engine/src/ipc.ts:276] — Node JSON.parse errors do not currently include payload bytes but the format is not a contract. Ratchet later if Node changes message format.
- W3: `EngineClient.restart()` reentrancy guard silently drops legitimate second restart request [engine.py:440-470] — matches AC3 explicit spec ("second call is a no-op"). Revisit after Story 2.5 stresses the restart path under real sync failures.
- W4: Unbounded `writeQueue` under sync_progress storms [engine/src/ipc.ts:236-251] — AC1 met literally ("buffer rather than drop"), but unbounded queueing trades dropped messages for OOM. Defer to Story 2.5: pick cap (length / bytes / coalesce sync_progress) with real load data instead of guessing.
- W5: `AuthWindow.show_credential_error` hardcodes "keyring" message [auth_window.py:115-117] — misleading for non-libsecret AuthErrors (encrypted-file backend, etc.). Plumbing the actual `str(exc)` would require changing `Application.on_auth_completed` return type from `bool` to `str | None` and rewriting 9 tests. Defer until encrypted-file backend tests are added in a future story, or accept the generic message as adequate.
