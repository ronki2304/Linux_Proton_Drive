# Story 1.7: Localhost Auth Callback Server

Status: ready-for-dev

## Story

As a developer,
I want a secure localhost HTTP server that receives the auth callback token,
so that the embedded browser can complete authentication and pass the token to the app.

## Acceptance Criteria

1. **Given** the auth flow is initiated, **when** the auth callback server starts, **then** it binds exclusively to `127.0.0.1` (never `0.0.0.0`) on a randomly assigned ephemeral port (NFR8).

2. **Given** the server is running, **when** the auth callback is received with a session token, **then** the token is captured and passed to the credential storage layer, **and** the server closes immediately -- no persistent open port.

3. **Given** the auth server lifecycle, **when** the server has received one callback, **then** it does not accept any further connections, **and** it is fully stopped before the auth flow transitions to the next step.

4. **Given** the server is started, **when** the WebView navigates to `http://127.0.0.1:{port}/auth-start`, **then** the server responds with an HTTP redirect (302) to `https://accounts.proton.me` with the appropriate auth parameters, **and** the redirect URL includes the callback URL pointing back to `http://127.0.0.1:{port}/callback`.

5. **Given** the auth callback server, **when** inspecting its implementation, **then** it is in `ui/src/protondrive/auth.py` and uses Python stdlib `http.server` on a background thread.

## Tasks / Subtasks

- [ ] Task 1: Create `AuthCallbackServer` class in `ui/src/protondrive/auth.py` (AC: #1, #5)
  - [ ] 1.1 Create `AuthCallbackServer` class using `http.server.HTTPServer` and `http.server.BaseHTTPRequestHandler`
  - [ ] 1.2 Bind to `('127.0.0.1', 0)` -- port 0 tells the OS to assign an ephemeral port
  - [ ] 1.3 Implement `get_port() -> int` method that returns `self.server.server_address[1]` after bind
  - [ ] 1.4 Add `from __future__ import annotations` and type hints on all public methods

- [ ] Task 2: Implement `/auth-start` endpoint (AC: #4)
  - [ ] 2.1 In request handler `do_GET`, match path `/auth-start`
  - [ ] 2.2 Build redirect URL to `https://accounts.proton.me` with auth parameters
  - [ ] 2.3 Include `redirect_uri=http://127.0.0.1:{port}/callback` in the redirect URL parameters
  - [ ] 2.4 Respond with 302 redirect and `Location` header

- [ ] Task 3: Implement `/callback` endpoint (AC: #2, #3)
  - [ ] 3.1 In request handler `do_GET`, match path `/callback`
  - [ ] 3.2 Extract session token from query parameters
  - [ ] 3.3 Store token in server instance for retrieval by callback
  - [ ] 3.4 Respond with 200 and minimal HTML success page (e.g., "Authentication complete. You may close this tab.")
  - [ ] 3.5 Signal the server to shut down after responding (one-shot behavior)

- [ ] Task 4: Implement async lifecycle methods (AC: #1, #2, #3)
  - [ ] 4.1 Implement `start_async(callback: Callable[[str], None]) -> None` -- starts `serve_forever()` on a `threading.Thread(daemon=True)`
  - [ ] 4.2 Implement `stop() -> None` -- calls `self.server.shutdown()` then `self.server.server_close()`
  - [ ] 4.3 After token is received in `/callback`, schedule callback invocation via `GLib.idle_add()` to marshal back to the GTK main thread
  - [ ] 4.4 After callback invocation, trigger server shutdown automatically (no second request accepted)

- [ ] Task 5: Reject unexpected requests (AC: #3)
  - [ ] 5.1 Return 404 for any path other than `/auth-start` and `/callback`
  - [ ] 5.2 After token received, return 410 Gone or simply refuse connections
  - [ ] 5.3 Suppress `http.server` default stderr logging (tokens could leak via query string in access logs)

- [ ] Task 6: Write unit tests in `ui/tests/test_auth.py` (AC: #1-#5)
  - [ ] 6.1 Test server binds to `127.0.0.1` only (inspect `server_address[0]`)
  - [ ] 6.2 Test ephemeral port is non-zero after bind
  - [ ] 6.3 Test `/auth-start` returns 302 with correct `Location` header containing callback URL
  - [ ] 6.4 Test `/callback?token=...` triggers the token callback with correct value
  - [ ] 6.5 Test server stops accepting connections after one callback
  - [ ] 6.6 Test unknown paths return 404
  - [ ] 6.7 Test token value is never written to stdout/stderr during test execution

## Dev Notes

### Security: 127.0.0.1 Only (NFR8)

The server MUST bind to `127.0.0.1`, NEVER `0.0.0.0`. Binding to all interfaces would expose the auth callback to the local network. Use `HTTPServer(('127.0.0.1', 0), handler_class)` -- the empty string `''` or `'0.0.0.0'` are both forbidden.

### Ephemeral Port

Pass port `0` to `HTTPServer` to let the OS assign a random available port. Retrieve the actual assigned port via `server.server_address[1]` after construction. Never hardcode a port number.

### One-Shot Lifecycle

The server accepts exactly ONE callback, then shuts down. The lifecycle is:

1. `AuthCallbackServer()` -- constructor binds the socket (port is now reserved)
2. `get_port()` -- returns the assigned ephemeral port
3. `start_async(callback)` -- starts `serve_forever()` on background thread
4. WebView navigates to `http://127.0.0.1:{port}/auth-start` (happens in caller)
5. `/auth-start` responds with 302 redirect to `accounts.proton.me`
6. User authenticates in WebView (Proton handles SRP, CAPTCHA, 2FA)
7. Proton redirects to `http://127.0.0.1:{port}/callback?token=...`
8. `/callback` captures token, responds 200, schedules shutdown
9. Callback fires on GTK main thread via `GLib.idle_add()`
10. `stop()` called -- server fully closed, thread joins

Leaving the server running after token receipt is a security hole.

### Auth Flow Ordering is LOAD-BEARING

The server MUST bind its socket BEFORE the WebView navigates. If the WebView navigates first, there is a race condition where Proton's redirect could arrive before the server is listening. The architecture mandates this ordering:

```python
self._auth_server = AuthCallbackServer()   # binds socket first
port = self._auth_server.get_port()
self._auth_server.start_async(self._on_token_received)
self.webview.load_uri(f'http://127.0.0.1:{port}/auth-start')  # THEN navigate
```

This ordering is enforced by the caller (`auth_window.py`, Story 1.8) but the server's API must support it -- constructor binds, `start_async` begins serving, port is available between the two.

### IPC Socket vs Auth Server Socket -- DISTINCT

The IPC Unix socket (`$XDG_RUNTIME_DIR/$APP_ID/sync-engine.sock`) and the auth callback HTTP server are completely separate:

- **IPC socket**: persistent for app lifetime, Unix domain socket, length-prefixed JSON
- **Auth server**: ephemeral TCP socket on 127.0.0.1, HTTP protocol, one request then closed

Never conflate, reuse, or share these sockets.

### Token Security (NFR6)

- Token MUST NEVER appear in stdout, stderr, logs, or debug output
- Suppress `http.server` default logging -- it logs request paths including query strings, which would leak the token
- Override `log_message()` in the request handler to be a no-op (or log only the path without query parameters)
- The token flows: `/callback` query param -> `GLib.idle_add(callback, token)` -> caller stores in libsecret

### File Location

`ui/src/protondrive/auth.py` -- this file also hosts the libsecret credential wrapper (Story 1.9). The auth server class is self-contained and does not depend on libsecret; they coexist in the same module because both are auth-related infrastructure.

### Threading Model

- `http.server.HTTPServer.serve_forever()` runs on a `threading.Thread(daemon=True)`
- The token callback MUST be marshalled back to the GTK main thread via `GLib.idle_add()` -- GTK is not thread-safe; calling GTK functions from a background thread causes undefined behavior
- `shutdown()` can be called from any thread (it signals `serve_forever()` to exit)

### Error Handling

- If the server fails to bind (port exhaustion, permission error), raise `AuthError` -- do not swallow
- `AuthError` is a subclass of `AppError` (defined per project error hierarchy)
- If the callback receives malformed data (missing token parameter), log a sanitized error (no token values) and do not invoke the callback

### Request Handler Pattern

```python
class _AuthRequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith('/auth-start'):
            # build redirect URL, send 302
            ...
        elif self.path.startswith('/callback'):
            # extract token from query, store, respond 200, schedule shutdown
            ...
        else:
            self.send_error(404)

    def log_message(self, format: str, *args: object) -> None:
        pass  # suppress all logging -- token in query string
```

### Test Approach

Tests in `ui/tests/test_auth.py` use `pytest`. Mock `GLib.idle_add` since tests run without a GTK main loop. Use `urllib.request` or `http.client` to make requests to the server in tests. The server runs on a real ephemeral port during tests -- no mocking of the HTTP server itself.

Run tests via: `meson test -C builddir` (compiles Blueprint, schemas first).

### Dependencies on Other Stories

- **Story 1.1** (scaffolding) must be complete -- provides the Meson build, directory structure
- **Story 1.8** (auth_window.py) is the caller -- it instantiates `AuthCallbackServer`, calls `start_async`, and navigates the WebView
- **Story 1.9** (libsecret integration) consumes the token after callback fires

This story is self-contained: it implements and tests the HTTP server class only. Integration with WebView and libsecret happens in Stories 1.8 and 1.9.

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 492-523]
- [Source: _bmad-output/planning-artifacts/architecture.md, "Auth Flow Ordering" and "Auth architecture" sections]
- [Source: _bmad-output/project-context.md, "Auth server lifecycle", "Auth flow ordering is load-bearing", NFR6/NFR8]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
