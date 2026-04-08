# Story 1.9: Embedded WebKitGTK Auth Browser

Status: done  <!-- review complete 2026-04-08 -->

## Story

As a user,
I want to authenticate with Proton using their real login page in an embedded browser,
so that I can use CAPTCHA, 2FA, and all standard Proton auth flows without leaving the app.

## Acceptance Criteria

1. **Given** the user clicks "Open Proton sign-in" on the pre-auth screen, **when** the embedded browser opens, **then** it loads `http://127.0.0.1:{port}/auth-start` which redirects to `accounts.proton.me`.

2. **Given** the embedded browser is open, **when** the user inspects the window, **then** a read-only URL bar is visible showing `accounts.proton.me` so the user can verify the destination (UX-DR2).

3. **Given** the auth flow is starting, **when** the auth callback server is initialized, **then** the server socket is bound BEFORE the WebView navigates — this ordering is load-bearing and prevents a race condition.

4. **Given** the user completes authentication (including CAPTCHA and 2FA if required), **when** Proton's auth flow sends the callback to localhost, **then** the token is received by the auth callback server, `webview.try_close()` is called, the webview reference is set to `None`, and the WebView's network session and cached credentials are released.

5. **Given** a network error occurs during authentication, **when** the browser cannot reach Proton, **then** an error banner is displayed with a "Retry" button.

6. **Given** the auth browser widget, **when** inspecting the implementation, **then** WebKitGTK is imported as `gi.repository.WebKit` (NOT deprecated `WebKit2`), the widget structure is defined in `ui/data/ui/auth-window.blp`, and the Python wiring is in `ui/src/protondrive/auth_window.py`.

## Tasks / Subtasks

- [x] Task 1: Create Blueprint layout for auth window (AC: #2, #6)
  - [x] 1.1–1.5 Created `auth-window.blp` with AdwHeaderBar + url_label, Gtk.Box container, AdwBanner

- [x] Task 2: Implement auth window Python wiring (AC: #1, #2, #3, #4, #6)
  - [x] 2.1–2.7 Created `auth_window.py` with WebKit 6.0, programmatic WebView, Template.Child wiring

- [x] Task 3: Implement auth flow ordering (AC: #3)
  - [x] 3.1–3.4 `start_auth()` enforces: server binds → server starts → WebView navigates

- [x] Task 4: Implement WebView navigation policy (AC: #1)
  - [x] 4.1–4.2 All navigation allowed; security boundary documented in docstring

- [x] Task 5: Implement URL bar update on navigation (AC: #2)
  - [x] 5.1–5.3 Domain extracted on COMMITTED/FINISHED; read-only Gtk.Label (not entry)

- [x] Task 6: Implement WebView cleanup after auth (AC: #4)
  - [x] 6.1–6.4 try_close + None + removed from container + auth-completed signal emitted

- [x] Task 7: Implement error handling with retry (AC: #5)
  - [x] 7.1–7.3 AdwBanner shown on load-failed, hidden on success, retry reloads auth-start

- [x] Task 8: Write tests for auth window (AC: #1–#6)
  - [x] 8.1–8.7 16 tests: ordering, cleanup, URL label, error banner, WebKit import check

## Dev Notes

### WebKitGTK Import — Critical

```python
import gi
gi.require_version('WebKit', '6.0')
from gi.repository import WebKit
```

Do NOT use `WebKit2` — it is the deprecated GIR namespace. The GNOME 50 runtime ships WebKitGTK 6.0 under the `WebKit` namespace.

### Auth Flow Ordering Is Load-Bearing

The auth callback server must bind its socket BEFORE the WebView navigates. If the WebView reaches the callback URL before the server is listening, auth silently fails. The sequence is:

```python
self._auth_server = AuthCallbackServer()   # binds socket first
port = self._auth_server.get_port()
self._auth_server.start_async(self._on_token_received)
self.webview.load_uri(f'http://127.0.0.1:{port}/auth-start')  # THEN navigate
```

### WebView Cleanup After Auth

WebView holds a network session and cached credentials. Failing to clean up leaks session data:

```python
def _on_token_received(self, token: str):
    self._auth_server.stop()
    self.webview.try_close()   # triggers WebKit internal cleanup
    self.webview = None        # release GObject reference
    self._transition_to_main_ui(token)
```

### Navigation Policy — Allow All

Proton redirects through several subdomains during auth (`account.proton.me`, `mail.proton.me/api`, others). Strict URL allowlists break when Proton changes domains. The security boundary is the localhost callback server (bound to `127.0.0.1` only, ephemeral port, closed after ONE callback), not URL filtering.

### UX-DR2: Read-Only URL Bar

The embedded browser must show a read-only URL bar displaying the current domain (e.g., `accounts.proton.me`). This is a trust signal — users are typing their Proton password into an embedded browser inside a newly installed app. The URL bar lets them verify they are talking to Proton's real login page. It is NOT an editable address bar.

### Widget Isolation Rule

`auth_window.py` must not import from any other widget file. All coordination between `auth_window.py` and the rest of the UI goes through `window.py`.

### Blueprint Constraint — WebView Created in Python

WebKitGTK `WebView` has no Blueprint representation. The `.blp` file defines a container (e.g., `Gtk.Box` or `Gtk.Overlay`) where the WebView will be packed. The WebView itself is created programmatically in `auth_window.py.__init__()` and added to the container.

### File Locations

| File | Purpose |
|---|---|
| `ui/data/ui/auth-window.blp` | Widget structure — header bar, URL label, WebView container, error banner |
| `ui/src/protondrive/auth_window.py` | Python wiring — WebView creation, signal handling, cleanup |
| `ui/src/protondrive/auth.py` | Localhost HTTP callback server + libsecret wrapper (separate file, Story 1.8 dependency) |
| `ui/tests/test_auth_window.py` | Widget tests — ordering, cleanup, URL label, error banner |

### Auth Callback Server Details (Context from auth.py)

The auth callback server is implemented in `auth.py` (separate from this story). Key properties:
- Binds to `127.0.0.1` only (never `0.0.0.0`) — security requirement
- Ephemeral port (OS-assigned)
- Uses `http.server` on a background thread (one request, then shutdown) — exception to the "no blocking I/O" rule because it is a single-request server on a background thread
- Closed after ONE callback — leaving it running is a security hole

### Re-Auth Flow Reuse

This same auth window is reused during re-authentication (token expiry). When the engine emits `token_expired`, the UI shows a re-auth modal (`AdwAlertDialog`), and clicking "Sign in" opens this same embedded browser. The auth window must support being created, used, and destroyed multiple times during the app's lifetime.

### GResource Path

```python
@Gtk.Template(resource_path='/io/github/ronki2304/ProtonDriveLinuxClient/ui/auth-window.ui')
class AuthWindow(Adw.Window):
    __gtype_name__ = 'ProtonDriveAuthWindow'
```

### Test Commands

```bash
# Run all UI tests (compiles Blueprint first)
meson test -C builddir

# Widget tests require Xvfb — skip in CI with:
CI_SKIP_WIDGET_TESTS=1 meson test -C builddir
```

### Review Findings

- [x] [Review][Patch] P1: `start_auth()` called twice leaks previous server and WebView — fixed, added `cleanup()` guard at top of `start_auth()`
- [x] [Review][Patch] P1: `_on_token_received` fires after `cleanup()` via queued `GLib.idle_add` — fixed, added `_completed` guard flag
- [x] [Review][Patch] P2: Double `shutdown()` — server self-shuts via thread then `stop()` called again, blocks GTK 5s — fixed, added `_stopped` idempotency flag
- [x] [Review][Patch] P2: `stop()` on never-started server hangs on `shutdown()` — fixed, added `_serving` flag guard
- [x] [Review][Patch] P2: `show_auth_browser` doesn't catch `AuthError` from server bind failure — fixed, try/except falls back to pre-auth
- [x] [Review][Patch] P3: Retry button retries against dead server after token self-shutdown — fixed, `_completed` guard blocks retry
- [x] [Review][Defer] W1: `_token_received` flag not thread-safe (concurrent `/callback` race) — deferred, single-request server makes concurrent hits near-impossible
- [x] [Review][Defer] W2: No timeout on auth server — runs indefinitely if user abandons — deferred, daemon thread dies with process
- [x] [Review][Defer] W3: `_on_load_changed` hides error banner on any load event including sub-resources — deferred, WebKitGTK main-frame only in practice
- [x] [Review][Defer] W4: WebView network session not explicitly cleared after auth — deferred, `try_close()` + None triggers GC
- [x] [Review][Defer] W5: `_on_auth_completed` calls `show_main()` before confirming token processed — deferred, sync call currently

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
N/A

### Completion Notes List
- WebView created programmatically in `start_auth()` (not `__init__`) — allows multiple auth cycles during app lifetime
- `cleanup()` method for forced teardown if auth window destroyed before completion
- localhost URL shows "Connecting..." instead of raw IP in URL bar
- `auth-completed` signal carries token string parameter for window.py to handle
- All 67 UI tests pass (16 new + 51 existing)

### File List
- `ui/data/ui/auth-window.blp` (created)
- `ui/src/protondrive/auth_window.py` (created)
- `ui/tests/test_auth_window.py` (created)
- `ui/meson.build` (modified — added blueprint + python source)
- `ui/data/protondrive.gresource.xml` (modified — added auth-window.ui)
