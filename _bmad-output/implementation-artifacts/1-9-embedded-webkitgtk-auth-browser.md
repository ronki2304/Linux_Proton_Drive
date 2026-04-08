# Story 1.9: Embedded WebKitGTK Auth Browser

Status: ready-for-dev

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

- [ ] Task 1: Create Blueprint layout for auth window (AC: #2, #6)
  - [ ] 1.1 Create `ui/data/ui/auth-window.blp` with template class `ProtonDriveAuthWindow`
  - [ ] 1.2 Define `AdwHeaderBar` with read-only URL label (not an editable entry) showing current domain
  - [ ] 1.3 Add a placeholder container for the WebKitGTK `WebView` widget (WebView must be created in Python — it has no Blueprint representation)
  - [ ] 1.4 Add an error banner (`AdwBanner`) with "Retry" button, hidden by default
  - [ ] 1.5 Register `.blp` file in `ui/data/ui/meson.build` for Blueprint compilation

- [ ] Task 2: Implement auth window Python wiring (AC: #1, #2, #3, #4, #6)
  - [ ] 2.1 Create `ui/src/protondrive/auth_window.py` with `@Gtk.Template` decorator pointing to compiled `auth-window.ui`
  - [ ] 2.2 Import WebKitGTK as `gi.require_version('WebKit', '6.0')` then `from gi.repository import WebKit`
  - [ ] 2.3 Create `WebKit.WebView` programmatically in `__init__` and pack into the Blueprint placeholder container
  - [ ] 2.4 Set `__gtype_name__ = 'ProtonDriveAuthWindow'` matching the Blueprint template class name
  - [ ] 2.5 Wire `Gtk.Template.Child()` for `url_label`, `error_banner`, and the WebView container
  - [ ] 2.6 Connect WebView `load-changed` signal to update the read-only URL label with the current URI's domain
  - [ ] 2.7 Connect WebView `load-failed` signal to show the error banner with "Retry"

- [ ] Task 3: Implement auth flow ordering — server binds before WebView navigates (AC: #3)
  - [ ] 3.1 Accept `AuthCallbackServer` (from `auth.py`) as a constructor parameter or create the server internally
  - [ ] 3.2 Implement `start_auth()` method that enforces the sequence: server binds socket → server starts async → WebView navigates to `http://127.0.0.1:{port}/auth-start`
  - [ ] 3.3 Verify server port is available before constructing the navigation URI
  - [ ] 3.4 Never navigate the WebView before the server socket is confirmed bound

- [ ] Task 4: Implement WebView navigation policy (AC: #1)
  - [ ] 4.1 Allow all navigation — Proton redirects through multiple subdomains (`account.proton.me`, `mail.proton.me/api`, etc.); strict URL allowlists break when Proton changes domains
  - [ ] 4.2 Security boundary is the localhost callback server, not URL filtering — document this in a code comment

- [ ] Task 5: Implement URL bar update on navigation (AC: #2)
  - [ ] 5.1 On each `load-changed` event (specifically `COMMITTED` or `FINISHED`), extract domain from `webview.get_uri()`
  - [ ] 5.2 Update the read-only URL label to show the domain (e.g., `accounts.proton.me`)
  - [ ] 5.3 URL label must not be editable — it is purely informational for user trust (UX-DR2)

- [ ] Task 6: Implement WebView cleanup after auth (AC: #4)
  - [ ] 6.1 On token received callback, call `self.webview.try_close()` to trigger WebKit internal cleanup
  - [ ] 6.2 Set `self.webview = None` to release the GObject reference
  - [ ] 6.3 WebView holds network session and cached credentials — both must be released by this cleanup
  - [ ] 6.4 Emit a signal or invoke a callback to notify the parent (called via `window.py`) that auth completed with the token

- [ ] Task 7: Implement error handling with retry (AC: #5)
  - [ ] 7.1 On `load-failed` signal, show the `AdwBanner` with error message and "Retry" button
  - [ ] 7.2 "Retry" button reloads `http://127.0.0.1:{port}/auth-start` (server must still be running)
  - [ ] 7.3 Hide the error banner on successful navigation after retry

- [ ] Task 8: Write tests for auth window (AC: #1–#6)
  - [ ] 8.1 Create `ui/tests/test_auth_window.py`
  - [ ] 8.2 Test auth flow ordering: assert server socket is bound before WebView `load_uri` is called
  - [ ] 8.3 Test WebView cleanup: assert `try_close()` called and reference set to `None` after token received
  - [ ] 8.4 Test URL label updates on navigation events
  - [ ] 8.5 Test error banner visibility on load failure
  - [ ] 8.6 Tests require Xvfb (widget tests — CI-optional via `CI_SKIP_WIDGET_TESTS=1`)
  - [ ] 8.7 Mock the auth callback server — never make real network requests in tests

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

## Dev Agent Record

### Agent Model Used
(to be filled during implementation)

### Debug Log References
(to be filled during implementation)

### Completion Notes List
(to be filled during implementation)

### File List
(to be filled during implementation — expected files below)

- `ui/data/ui/auth-window.blp`
- `ui/src/protondrive/auth_window.py`
- `ui/tests/test_auth_window.py`
- `ui/data/ui/meson.build` (modified — add auth-window.blp)
