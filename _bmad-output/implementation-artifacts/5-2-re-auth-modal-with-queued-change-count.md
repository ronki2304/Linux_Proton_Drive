# Story 5.2: Re-Auth Modal with Queued Change Count

Status: done

## Story

As a user,
I want to see how many local changes are waiting and re-authenticate easily,
so that I know my data is safe and can resume sync quickly.

## Acceptance Criteria

### AC1 — `token_expired` → `AdwAlertDialog` appears immediately

**Given** a `token_expired` event is received
**When** the app window is visible
**Then** an `AdwAlertDialog` modal appears with:
- Heading: "Session expired"
- Body: "Your Proton session has expired — this can happen after a password change or routine token refresh. [N] local changes are waiting to sync. Sign in to resume." (where N is `queued_changes` from the event payload)
- Button: "Sign in" (suggested/blue)
- Button: "Not now" (dismiss)

### AC2 — Minimized window shows modal on raise

**Given** the app window is minimized when token expires
**When** the user brings the window forward
**Then** the re-auth modal is shown immediately (GTK presents dialog on parent raise naturally)

### AC3 — "Sign in" opens WebKitGTK auth browser

**Given** the re-auth modal is showing
**When** the user clicks "Sign in"
**Then** the modal closes
**And** the embedded WebKitGTK auth browser opens (same `start_auth_flow()` as first-run — no new code path)
**And** on successful auth, the new token is stored in the credential store and sent to the engine via `token_refresh` IPC command (existing `on_auth_completed` / `send_token_refresh` — no change needed)

### AC4 — `session_ready` closes modal and returns UI to normal

**Given** re-auth completes successfully (`session_ready` event received)
**When** `_on_session_ready` runs
**Then** `_pending_reauth_dialog` is closed if still open (belt-and-suspenders; normally already closed when "Sign in" was clicked)
**And** the session-expired banner is hidden (via existing `window.on_session_ready()` → `clear_token_expired_warning()` — already in place from Story 5-1)
**And** the main view is shown (existing `show_main()` + `get_status` — no change needed)

### AC5 — `session_ready` handler is shared (no separate re-auth code path)

**Given** re-auth completes
**When** `session_ready` fires
**Then** the SAME `_on_session_ready` handler runs as for initial auth — implementation confirms no separate path exists

### AC6 — Auth browser error is visible

**Given** the auth browser encounters a network error after "Sign in" is clicked
**When** the error occurs
**Then** the error is shown in `AuthWindow.error_banner` with the existing "Retry" button (existing behavior — `AuthWindow` already handles this; no new code needed in reauth dialog)

### AC7 — Banner gets a "Sign in" action button

**Given** the session-expired banner is revealed
**When** the user sees it
**Then** the banner has a "Sign in" button that presents the reauth modal (tapping it while the dialog is already open is a no-op)

### AC8 — "Not now" dismisses modal; banner stays

**Given** the re-auth modal
**When** the user clicks "Not now"
**Then** the modal closes
**And** the session-expired banner remains revealed
**And** the user can reopen the modal via the banner's "Sign in" button

---

## Tasks / Subtasks

- [x] **Task 1: Create `ui/data/ui/reauth-dialog.blp`** (AC: #1, #3, #7, #8)
  - [x] 1.1 Create `ui/data/ui/reauth-dialog.blp` with this exact content:
    ```blueprint
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDriveReauthDialog: Adw.AlertDialog {
      heading: _("Session expired");
      close-response: "dismiss";

      responses [
        dismiss: _("Not now"),
        sign_in: _("Sign in") suggested,
      ]
    }
    ```
    **Note:** Body is not set in Blueprint — it is set dynamically in Python via `set_body()` because it contains the queued-change count [N]. Heading is static.
  - [x] 1.2 Run `meson compile -C builddir` — zero Blueprint compilation errors

- [x] **Task 2: Create `ui/src/protondrive/widgets/reauth_dialog.py`** (AC: #1, #3)
  - [x] 2.1 Create `ui/src/protondrive/widgets/reauth_dialog.py`:
    ```python
    """ReauthDialog — AdwAlertDialog prompting re-authentication after session expiry."""

    from __future__ import annotations

    from gi.repository import Adw, Gtk


    @Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/reauth-dialog.ui")
    class ReauthDialog(Adw.AlertDialog):
        """Modal dialog shown when the engine emits token_expired.

        Displays the count of locally-queued changes and offers a "Sign in"
        button that re-enters the standard WebKitGTK auth flow.

        Heading is set in Blueprint.  Body is set dynamically via
        set_queued_changes() so the [N] count is live.
        """

        __gtype_name__ = "ProtonDriveReauthDialog"

        def set_queued_changes(self, count: int) -> None:
            """Set the dialog body with the live queued-change count."""
            base = (
                "Your Proton session has expired \u2014 this can happen after a "
                "password change or routine token refresh."
            )
            if count == 1:
                tail = "1 local change is waiting to sync. Sign in to resume."
            elif count > 1:
                tail = f"{count} local changes are waiting to sync. Sign in to resume."
            else:
                tail = "Sign in to resume."
            self.set_body(f"{base} {tail}")
    ```
  - [x] 2.2 Confirm file path is exactly `ui/src/protondrive/widgets/reauth_dialog.py`

- [x] **Task 3: Register in `meson.build` and `protondrive.gresource.xml`** (build plumbing)
  - [x] 3.1 Open `ui/meson.build`
  - [x] 3.2 After the `blueprints_conflict_log` block (line ~100), add:
    ```meson
    blueprints_reauth_dialog = custom_target(
      'blueprint-reauth-dialog',
      input: files('data/ui/reauth-dialog.blp'),
      output: 'reauth-dialog.ui',
      command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
    )
    ```
  - [x] 3.3 In `gnome.compile_resources(...)` `dependencies:` list (line ~112), append `, blueprints_reauth_dialog` before the closing `]`
  - [x] 3.4 In `python_widget_sources` list (line ~153), add `'src/protondrive/widgets/reauth_dialog.py',` after `conflict_log.py`
  - [x] 3.5 Open `ui/data/protondrive.gresource.xml`
  - [x] 3.6 After the `conflict-log.ui` line (line ~17), add:
    ```xml
    <file alias="ui/reauth-dialog.ui" preprocess="xml-stripblanks">reauth-dialog.ui</file>
    ```
  - [x] 3.7 `meson compile -C builddir` — zero errors (GResource compiles with new entry)

- [x] **Task 4: Update `ui/data/ui/window.blp` — add "Sign in" button to banner** (AC: #7)
  - [x] 4.1 Open `ui/data/ui/window.blp`
  - [x] 4.2 In the `Adw.Banner session_expired_banner` block, add `button-label`:
    ```blueprint
    [top]
    Adw.Banner session_expired_banner {
      title: _("Session expired — sign in to resume sync");
      revealed: false;
      button-label: _("Sign in");
      styles ["error"]
    }
    ```
  - [x] 4.3 `meson compile -C builddir` — zero Blueprint compilation errors

- [x] **Task 5: Update `ui/src/protondrive/window.py`** (AC: #7)
  - [x] 5.1 Open `ui/src/protondrive/window.py`
  - [x] 5.2 In `__init__`, after `self.connect("close-request", ...)`, add:
    ```python
    self.session_expired_banner.connect(
        "button-clicked", self._on_session_expired_banner_clicked
    )
    ```
    **Placement:** right after the `close-request` connection (around line 44), before the `_pre_auth_screen: PreAuthScreen | None = None` line.
  - [x] 5.3 Add `_on_session_expired_banner_clicked` method. Insert after `clear_token_expired_warning` (around line 296):
    ```python
    def _on_session_expired_banner_clicked(self, _banner: Adw.Banner) -> None:
        """Banner 'Sign in' button — present the reauth dialog via Application."""
        app = self.get_application()
        if app is not None and hasattr(app, "show_reauth_dialog"):
            app.show_reauth_dialog()
    ```
  - [x] 5.4 Confirm `show_token_expired_warning(self) -> None:` signature is unchanged (no `queued_changes` param — count is now shown in the modal body, not the banner title)

- [x] **Task 6: Update `ui/src/protondrive/main.py`** (AC: #1, #2, #3, #4, #5, #8)
  - [x] 6.1 Open `ui/src/protondrive/main.py`
  - [x] 6.2 Add `_pending_reauth_dialog` and `_last_token_expired_queued_count` to `__init__` (after `_pending_key_unlock_dialog`, around line 40):
    ```python
    self._pending_reauth_dialog: Any | None = None
    self._last_token_expired_queued_count: int = 0
    ```
  - [x] 6.3 Update `_on_token_expired` — extract queued count, cache it, present dialog. Replace the current body with:
    ```python
    def _on_token_expired(self, payload: dict[str, Any]) -> None:
        """Token expired mid-sync — show warning banner and re-auth dialog.

        Story 5-1: banner is shown; credentials are preserved.
        Story 5-2: re-auth modal is presented so user can sign in immediately.
        """
        import sys
        print(f"[APP] token_expired received: {payload}", file=sys.stderr)
        self._cancel_validation_timeout()
        self._watcher_status = "unknown"

        queued_changes: int = payload.get("queued_changes", 0) if isinstance(payload, dict) else 0
        self._last_token_expired_queued_count = queued_changes

        if self._window is not None:
            self._window.show_token_expired_warning()
            self.show_reauth_dialog()
    ```
    **CRITICAL:** The `_watcher_status = "unknown"` and `_cancel_validation_timeout()` calls MUST be preserved — existing tests check these.

  - [x] 6.4 Add `show_reauth_dialog` method. Insert after `_on_token_expired` (before `logout`):
    ```python
    def show_reauth_dialog(self) -> None:
        """Create and present the ReauthDialog if not already showing.

        Idempotent: if the dialog is already on screen, does nothing.
        Called from _on_token_expired and from the banner 'Sign in' button.
        """
        if self._pending_reauth_dialog is not None:
            return  # already showing — do not stack a second dialog

        from protondrive.widgets.reauth_dialog import ReauthDialog

        dialog = ReauthDialog()
        dialog.set_queued_changes(self._last_token_expired_queued_count)
        dialog.connect("response", self._on_reauth_response)
        self._pending_reauth_dialog = dialog

        if self._window is not None:
            dialog.present(self._window)
    ```

  - [x] 6.5 Add `_on_reauth_response` method. Insert after `show_reauth_dialog`:
    ```python
    def _on_reauth_response(self, _dialog: Any, response_id: str) -> None:
        """Handle ReauthDialog button press.

        "sign_in": close dialog, open auth browser (same flow as first-run).
        "dismiss" / window close: close dialog, banner stays revealed.
        """
        self._pending_reauth_dialog = None
        if response_id == "sign_in":
            self.start_auth_flow()
    ```

  - [x] 6.6 Update `_on_session_ready` — close reauth dialog if somehow still open. After the existing `_pending_key_unlock_dialog` block (around line 344), add:
    ```python
    # Close reauth dialog if still open (e.g., session_ready fired before user clicked).
    if self._pending_reauth_dialog is not None:
        try:
            self._pending_reauth_dialog.close()
        except Exception:
            pass
        self._pending_reauth_dialog = None
    ```
    **Placement:** AFTER the existing `_pending_key_unlock_dialog` close block and BEFORE `self._window.close_auth_browser()`.

  - [x] 6.7 Verify `_on_session_ready` already calls `self._window.on_session_ready(payload)` which calls `clear_token_expired_warning()` — do NOT add a duplicate call.

- [x] **Task 7: Update `ui/tests/test_main.py`** (AC: #1, #3, #4, #7, #8)
  - [x] 7.1 Open `ui/tests/test_main.py`
  - [x] 7.2 Update `_make_app()` helper — add the two new Application attributes (after `_pending_key_unlock_dialog = None`, around line 33):
    ```python
    app._pending_reauth_dialog = None
    app._last_token_expired_queued_count = 0
    ```
    **Do NOT remove any existing attributes — existing tests depend on them.**

  - [x] 7.3 Confirm existing `TestTokenExpiredCallsWarning` tests still pass:
    - `test_calls_show_token_expired_warning`: now `_on_token_expired` also calls `show_reauth_dialog()`. Since `_window` is a MagicMock and `show_reauth_dialog` imports `ReauthDialog` at call time, mock it out or mock the import. See note in §Dev Notes §4 — mock `show_reauth_dialog` in existing tests.
    - **Fix existing tests that will now break**: each test in `TestTokenExpiredCallsWarning` must now have `app.show_reauth_dialog = MagicMock()` to prevent the import of the real `ReauthDialog` (which needs GTK). Add this line to each test, or add it once in the `_make_app()` helper.
    - **Recommended fix**: add `app.show_reauth_dialog = MagicMock()` to `_make_app()`.

  - [x] 7.4 Add new test class after the existing `TestTokenExpiredCallsWarning`:
    ```python
    # ---------------------------------------------------------------------------
    # Story 5-2 — ReauthDialog lifecycle
    # ---------------------------------------------------------------------------

    class TestReauthDialogLifecycle:
        """show_reauth_dialog creates dialog; _on_reauth_response handles sign_in/dismiss."""

        def test_show_reauth_dialog_calls_set_queued_changes(self) -> None:
            """Dialog receives the queued-change count from last token_expired payload."""
            app = _make_app()
            app._last_token_expired_queued_count = 5
            mock_dialog = MagicMock()
            # ReauthDialog is a lazy import inside show_reauth_dialog() — patch sys.modules.
            import sys
            import types
            fake_mod = types.ModuleType("protondrive.widgets.reauth_dialog")
            fake_mod.ReauthDialog = MagicMock(return_value=mock_dialog)
            with patch.dict(sys.modules, {"protondrive.widgets.reauth_dialog": fake_mod}):
                app.show_reauth_dialog()
            mock_dialog.set_queued_changes.assert_called_once_with(5)

        def test_show_reauth_dialog_is_idempotent(self) -> None:
            """Calling show_reauth_dialog twice does not create a second dialog."""
            app = _make_app()
            existing = MagicMock()
            app._pending_reauth_dialog = existing
            app.show_reauth_dialog()  # must be a no-op
            # pending_reauth_dialog is still the original (no new dialog created)
            assert app._pending_reauth_dialog is existing

        def test_on_token_expired_calls_show_reauth_dialog(self) -> None:
            """_on_token_expired calls show_reauth_dialog (Story 5-2 addition)."""
            app = _make_app()
            app.show_reauth_dialog = MagicMock()
            app._on_token_expired({"queued_changes": 3})
            app.show_reauth_dialog.assert_called_once_with()

        def test_on_token_expired_caches_queued_count(self) -> None:
            """_on_token_expired stores queued_changes for later dialog use."""
            app = _make_app()
            app.show_reauth_dialog = MagicMock()
            app._on_token_expired({"queued_changes": 7})
            assert app._last_token_expired_queued_count == 7

        def test_on_token_expired_zero_queued_fallback(self) -> None:
            """Missing queued_changes key defaults to 0."""
            app = _make_app()
            app.show_reauth_dialog = MagicMock()
            app._on_token_expired({})
            assert app._last_token_expired_queued_count == 0

        def test_sign_in_response_calls_start_auth_flow(self) -> None:
            """'sign_in' response invokes start_auth_flow (opens auth browser)."""
            app = _make_app()
            app.start_auth_flow = MagicMock()
            app._pending_reauth_dialog = MagicMock()
            app._on_reauth_response(MagicMock(), "sign_in")
            app.start_auth_flow.assert_called_once_with()
            assert app._pending_reauth_dialog is None

        def test_dismiss_response_does_not_start_auth_flow(self) -> None:
            """'dismiss' response clears dialog ref but does NOT start auth."""
            app = _make_app()
            app.start_auth_flow = MagicMock()
            app._pending_reauth_dialog = MagicMock()
            app._on_reauth_response(MagicMock(), "dismiss")
            app.start_auth_flow.assert_not_called()
            assert app._pending_reauth_dialog is None

        def test_session_ready_closes_pending_reauth_dialog(self) -> None:
            """_on_session_ready closes the reauth dialog if still open."""
            app = _make_app()
            mock_dialog = MagicMock()
            app._pending_reauth_dialog = mock_dialog
            app._has_configured_pairs = MagicMock(return_value=True)
            app._engine = MagicMock()
            app._cached_session_data = None
            app._on_session_ready({"display_name": "Test"})
            mock_dialog.close.assert_called_once_with()
            assert app._pending_reauth_dialog is None

        def test_session_ready_no_pending_dialog_is_safe(self) -> None:
            """_on_session_ready with no pending dialog does not raise."""
            app = _make_app()
            assert app._pending_reauth_dialog is None
            app._has_configured_pairs = MagicMock(return_value=True)
            app._engine = MagicMock()
            app._cached_session_data = None
            app._on_session_ready({"display_name": "Test"})  # must not raise
    ```

  - [x] 7.5 Run `meson compile -C builddir && .venv/bin/pytest ui/tests/` — all pass

- [x] **Task 8: Final validation** (all ACs)
  - [x] 8.1 `meson compile -C builddir` — zero Blueprint and GResource compilation errors
  - [x] 8.2 `.venv/bin/pytest ui/tests/` — all pass; new `TestReauthDialogLifecycle` tests pass; all existing `TestTokenExpiredCallsWarning` tests still pass
  - [x] 8.3 `bunx tsc --noEmit` from `engine/` — zero type errors (engine untouched; verify no accidental change)
  - [x] 8.4 Set story status to `review`

---

## Dev Notes

### §1 — `Adw.AlertDialog` vs `Adw.Dialog` — why AlertDialog

The existing `KeyUnlockDialog` uses `Adw.Dialog` with a full custom layout. Story 5-2 uses `Adw.AlertDialog` (as specified) because:
- The dialog has a fixed heading/body/buttons structure — no custom layout needed
- `Adw.AlertDialog` provides the correct `response` signal with response IDs
- The body is set via `set_body()` — this is Python "wiring", not "constructing widget trees"

**GNOME 50 runtime (Libadwaita 1.8) fully supports `Adw.AlertDialog`** — it was added in Libadwaita 1.5.

### §2 — Blueprint `responses []` syntax for `Adw.AlertDialog` templates

Blueprint 0.16+ supports the `responses [...]` block for `Adw.AlertDialog` templates:
```blueprint
responses [
  dismiss: _("Not now"),
  sign_in: _("Sign in") suggested,
]
```
- `dismiss` maps to `close-response: "dismiss"` (close without emitting response) — handled naturally
- `sign_in` is the response ID passed to `dialog.connect("response", handler)` as the second arg
- `suggested` applies `AdwResponseAppearance.SUGGESTED` (blue button)

If Blueprint compilation rejects `responses []` in template context (unlikely but possible), fall back: remove `responses []` from Blueprint and add in Python `__init__`:
```python
def __init__(self, **kwargs: object) -> None:
    super().__init__(**kwargs)
    self.add_response("dismiss", _("Not now"))
    self.add_response("sign_in", _("Sign in"))
    self.set_response_appearance("sign_in", Adw.ResponseAppearance.SUGGESTED)
    self.set_close_response("dismiss")
```
`add_response` is documented `Adw.AlertDialog` API — NOT constructing widget trees. **Verify Blueprint compiles in Task 1.2 before proceeding.**

### §3 — Dynamic body via `set_body()` — never in Blueprint

The body contains `[N]` (queued change count) which is unknown at Blueprint compile time. Blueprint is for static structure; dynamic state is set in Python via GTK property setters. This is the documented pattern (`set_body()` is a regular Python property setter, not widget construction).

Body format:
- count == 0: "Your Proton session has expired — this can happen after a password change or routine token refresh. Sign in to resume."
- count == 1: "…1 local change is waiting to sync. Sign in to resume."
- count > 1: "…{count} local changes are waiting to sync. Sign in to resume."

The em-dash in the body is the Unicode character U+2014 (`\u2014`), consistent with the post-auth toast in `window.py:316`.

### §4 — `_on_token_expired` now calls `show_reauth_dialog()` — existing test fix required

After Task 6.3, `_on_token_expired` calls `self.show_reauth_dialog()`. The `show_reauth_dialog` method does a lazy import of `ReauthDialog` from `protondrive.widgets.reauth_dialog`. In unit tests (no GTK display), this import will attempt to load `Adw.AlertDialog` and fail.

**Fix:** Add `app.show_reauth_dialog = MagicMock()` to `_make_app()` helper (Task 7.2). This means all tests using `_make_app()` get a mock for `show_reauth_dialog` automatically. Tests that specifically want to test `show_reauth_dialog` must replace the mock via `app.show_reauth_dialog = Application.show_reauth_dialog.__get__(app)` or use `patch.dict(sys.modules, ...)`.

### §5 — `_pending_reauth_dialog` lifecycle

Parallel to the existing `_pending_key_unlock_dialog` pattern:
- Created in `show_reauth_dialog()`, set to `None` in `_on_reauth_response()` or `_on_session_ready()`
- **Idempotency guard:** `if self._pending_reauth_dialog is not None: return` prevents double-dialog
- **`_on_session_ready` close:** Uses `dialog.close()` (not `force_close()`) — close-response is "dismiss" so `close()` triggers the dismiss path cleanly. Safe because `_on_reauth_response` sets `_pending_reauth_dialog = None` as its first action before any other calls; the `_on_session_ready` code then sets it to None again (redundant but harmless)
- **Re-entry safety:** `_on_reauth_response` sets `self._pending_reauth_dialog = None` as its FIRST action before calling `start_auth_flow()`

### §6 — `start_auth_flow()` is the canonical re-auth entry point

`start_auth_flow()` (main.py:121-125) already does:
1. `self._had_browser_session = True`
2. `self._window.show_auth_browser()`

No changes to `start_auth_flow`, `on_auth_completed`, `show_auth_browser`, or `_on_auth_completed` are needed. The re-auth flow reuses every single existing method unchanged — this satisfies AC5 (no separate code path).

### §7 — `_on_session_ready` for re-auth vs initial auth

`_on_session_ready` (main.py:320) already handles both cases:
1. Closes auth browser
2. If pairs exist → `show_main()` + `window.on_session_ready()` → `clear_token_expired_warning()`
3. If no pairs → `show_setup_wizard()` (this path is impossible for re-auth since pairs exist)

Task 6.6 adds ONE new block in `_on_session_ready`: close `_pending_reauth_dialog` if still open. Insert AFTER the existing `_pending_key_unlock_dialog` block and BEFORE `self._window.close_auth_browser()`.

### §8 — `_on_session_ready` test impact

The `test_session_ready_closes_pending_reauth_dialog` test (Task 7.4) calls `app._on_session_ready({"display_name": "Test"})` directly. This method touches `_pending_key_unlock_dialog`, `_window.close_auth_browser()`, `_has_configured_pairs()`, `_window.show_main()`, `_window.on_session_ready()`, and `_engine.send_command_with_response()`. The `_make_app()` mock sets all these up. The test must also mock `_has_configured_pairs` and `_engine`.

### §9 — Banner button wiring follows existing pattern

The `session_expired_banner.button-clicked` → `_on_session_expired_banner_clicked` → `app.show_reauth_dialog()` chain exactly mirrors how `_on_sign_in_requested` (window.py:552) calls `app.start_auth_flow()`. No GAction needed — direct `get_application()` call is the project pattern for button→app delegation.

`button-label` in Blueprint does NOT affect the banner's `revealed` state or the existing `session_expired_banner.connect("button-clicked", ...)` signal — it simply makes the button appear. Adding it is backward-compatible with Task 8 of Story 5-1.

### §10 — Minimized window (AC2) — no extra code needed

`Adw.Dialog.present(parent)` is sufficient. GTK/Libadwaita presents the dialog on top of its parent widget. If the parent window is minimized (iconified), the dialog appears when the window is raised. No `window.map` or `notify::is-active` signal handling is needed.

### §11 — Existing tests that must continue to pass unchanged

- `ui/tests/test_main.py:TestTokenExpiredResetsWatcherStatus` — `_watcher_status = "unknown"` is preserved in updated `_on_token_expired`. **No change needed.**
- `ui/tests/test_main.py:TestTokenExpiredCallsWarning` — these call `_on_token_expired` which now also calls `show_reauth_dialog()`. With `app.show_reauth_dialog = MagicMock()` in `_make_app()`, all existing assertions remain valid. Specifically: `test_calls_show_token_expired_warning` still asserts `show_token_expired_warning.assert_called_once_with()` (no arg — correct, signature unchanged).
- `ui/tests/test_launch_routing.py:74` — checks `"show_pre_auth" in source` — still passes (show_pre_auth is called from other handlers).

### §12 — Blueprint ID casing for `Adw.AlertDialog` — no Template.Child() needed

`Adw.AlertDialog` does not require `Gtk.Template.Child()` attributes in Python — the heading, body, and responses are accessed via the `Adw.AlertDialog` API (e.g., `set_heading()`, `set_body()`). Only Blueprint `id` attributes that need Python access require `Gtk.Template.Child()`. Since `ReauthDialog` has no sub-widgets with IDs, no `Gtk.Template.Child()` declarations are needed.

### §13 — Auth browser error handling (AC6) — existing AuthWindow behavior

When `start_auth_flow()` opens the auth browser and a network error occurs:
- `AuthWindow.error_banner` (auth-window.blp:26-31) is revealed with `button-label: "Retry"`
- `error_banner.connect("button-clicked", self._on_retry_clicked)` handles retry (auth-window.py)

This is fully implemented in Story 1-9. Story 5-2 does NOT change this behavior. The reauth dialog is already closed when auth browser opens, so the error is visible in the auth browser itself.

### Project Structure Notes

**Files to create:**
- `ui/data/ui/reauth-dialog.blp`
- `ui/src/protondrive/widgets/reauth_dialog.py`

**Files to modify:**
- `ui/meson.build` — add `blueprints_reauth_dialog` custom_target, add to dependencies list, add `reauth_dialog.py` to widget sources
- `ui/data/protondrive.gresource.xml` — add `reauth-dialog.ui` entry
- `ui/data/ui/window.blp` — add `button-label` to `session_expired_banner`
- `ui/src/protondrive/window.py` — connect banner `button-clicked`, add `_on_session_expired_banner_clicked`
- `ui/src/protondrive/main.py` — add `_pending_reauth_dialog` + `_last_token_expired_queued_count` fields, update `_on_token_expired`, add `show_reauth_dialog` + `_on_reauth_response`, update `_on_session_ready`
- `ui/tests/test_main.py` — update `_make_app()`, add `TestReauthDialogLifecycle`

**Do NOT modify:**
- Any engine files (`engine/src/**`) — engine is complete for this story
- `ui/src/protondrive/auth_window.py` — auth browser handles its own errors
- `ui/src/protondrive/engine.py` — IPC already supports `token_refresh`
- `ui/tests/test_launch_routing.py` — test still passes unchanged
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — dev agent sets to `review`, not `done`

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.2`
- Story 5-1 (completed): `_bmad-output/implementation-artifacts/5-1-401-detection-and-sync-halt.md`
- `show_token_expired_warning` (no-arg signature): `ui/src/protondrive/window.py:291`
- `clear_token_expired_warning`: `ui/src/protondrive/window.py:295`
- `on_session_ready` (clears banner): `ui/src/protondrive/window.py:298`
- `_on_session_ready` in Application: `ui/src/protondrive/main.py:320`
- `_pending_key_unlock_dialog` pattern (model): `ui/src/protondrive/main.py:40,339-344,497-512`
- `start_auth_flow` (canonical auth entry): `ui/src/protondrive/main.py:121`
- `show_auth_browser` (auth browser open): `ui/src/protondrive/window.py:94`
- `on_auth_completed` (stores token, sends token_refresh): `ui/src/protondrive/main.py:127`
- `KeyUnlockDialog` (model for dialog structure): `ui/src/protondrive/widgets/key_unlock_dialog.py`
- `key-unlock-dialog.blp` (model for Blueprint dialog): `ui/data/ui/key-unlock-dialog.blp`
- `session_expired_banner` in Blueprint: `ui/data/ui/window.blp:20-24`
- `session_expired_banner` in Python: `ui/src/protondrive/window.py:34`
- `_on_sign_in_requested` (model for window→app delegation): `ui/src/protondrive/window.py:552`
- `AuthWindow.error_banner` (handles auth network errors): `ui/data/ui/auth-window.blp:26-31`
- `_make_app()` helper: `ui/tests/test_main.py:17`
- `TestTokenExpiredCallsWarning`: `ui/tests/test_main.py:282`
- GResource XML: `ui/data/protondrive.gresource.xml`
- meson.build blueprint registration pattern: `ui/meson.build:93-105`
- Project context (Blueprint rules, widget isolation, no widget trees in Python): `_bmad-output/project-context.md`
- Token expiry cross-process workflow diagram: `_bmad-output/project-context.md` §"Token Expiry — Cross-Process Workflow"

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Build env requires LinuxProtonDrive distrobox container: `distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson setup --wipe builddir && /usr/bin/meson compile -C builddir"`

### Completion Notes List

- Created `ReauthDialog` as `Adw.AlertDialog` template; `responses []` Blueprint syntax confirmed working on blueprint-compiler 0.20.4
- `set_queued_changes()` sets body with singular/plural/zero-count variants using U+2014 em-dash
- `show_reauth_dialog()` is idempotent (guards on `_pending_reauth_dialog is not None`)
- `_on_reauth_response` sets `_pending_reauth_dialog = None` as first action before `start_auth_flow()` — re-entry safe
- `_on_session_ready` closes dialog via `dialog.close()` (not `force_close()`) — triggers dismiss path cleanly
- `_make_app()` now mocks `show_reauth_dialog` to prevent GTK import in all existing tests
- Full build: 16/16 targets, zero errors; 544/544 tests pass; 0 engine TS errors

### File List

- `ui/data/ui/reauth-dialog.blp` (created)
- `ui/src/protondrive/widgets/reauth_dialog.py` (created)
- `ui/meson.build` (modified — new blueprint target, dependencies, widget sources)
- `ui/data/protondrive.gresource.xml` (modified — reauth-dialog.ui entry)
- `ui/data/ui/window.blp` (modified — button-label on session_expired_banner)
- `ui/src/protondrive/window.py` (modified — banner signal, _on_session_expired_banner_clicked)
- `ui/src/protondrive/main.py` (modified — new fields, show_reauth_dialog, _on_reauth_response, updated _on_token_expired + _on_session_ready)
- `ui/tests/test_main.py` (modified — _make_app() updated, TestReauthDialogLifecycle added)

### Review Findings

- [x] [Review][Patch] Dialog stuck when `show_reauth_dialog()` called with `_window is None` — fixed: early return guard added before dialog creation; `dialog.present()` conditional removed [ui/src/protondrive/main.py:440-451]
- [x] [Review][Patch] `hasattr` in `_on_session_expired_banner_clicked` — dismissed: `hasattr` is the project pattern for window→app delegation to avoid circular imports; `isinstance(app, Application)` would require importing `main.py` from `window.py` [ui/src/protondrive/window.py:301-305]
- [x] [Review][Patch] Test coverage gap — fixed: `assert_not_called()` added to `test_no_window_is_noop` [ui/tests/test_main.py]
- [x] [Review][Defer] No default body in Blueprint — if `set_queued_changes()` ever not called before `present()`, dialog shows empty body; current code always calls it [ui/data/ui/reauth-dialog.blp] — deferred, pre-existing footgun not triggered by current callers
- [x] [Review][Defer] Rapid `token_expired` events — second event's count not reflected in already-showing dialog; idempotency guard blocks update [ui/src/protondrive/main.py:428] — deferred, engine-level concern
