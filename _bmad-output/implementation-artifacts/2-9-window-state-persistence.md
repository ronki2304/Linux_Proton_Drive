# Story 2.9: Window State Persistence

Status: done

## Story

As a user,
I want the app to remember its window size and maximized state between sessions,
so that I don't have to resize it every time I open it.

## Acceptance Criteria

**AC1 — Save on close:**
**Given** the user resizes or maximizes the app window
**When** the window is closed
**Then** the window width, height, and maximized state are saved via `Gio.Settings`
**And** width/height are only updated when NOT maximized (maximized dimensions are not saved as the restore size)

**AC2 — Restore on launch:**
**Given** the app launches
**When** a saved window state exists in GSettings
**Then** the window is restored to the saved width/height and re-maximized if the maximized flag is set

**AC3 — Default dimensions:**
**Given** the app launches fresh (no prior save)
**When** GSettings returns schema defaults
**Then** the default size of 780×520px is used and the window is not maximized

**AC4 — Settings passed via constructor:**
**Given** the implementation
**When** inspecting `MainWindow.__init__`
**Then** it accepts a `settings: Gio.Settings` parameter passed from `Application.do_activate()`
**And** `MainWindow` does NOT call `Gio.Settings.new(APP_ID)` itself (one instance, owned by `Application`)

**AC5 — Storage mechanism:**
**Given** the implementation
**When** inspecting the code
**Then** geometry is stored in `Gio.Settings` (schema `io.github.ronki2304.ProtonDriveLinuxClient`)
**And** NOT in SQLite and NOT in a plain file

**AC6 — UI tests:**
**Given** unit tests in `ui/tests/test_window_state_persistence.py`
**When** running `.venv/bin/pytest ui/tests/`
**Then** tests verify: save-on-close stores correct values, restore uses settings, default fallback when settings return defaults, close-request returns False
**And** no pre-existing test regressions

> **Wayland note:** GTK4 on Wayland does not expose window position (compositor controls placement). Position persistence is intentionally omitted. Width, height, and maximized state only.

---

## Tasks / Subtasks

- [x] **Task 1: Add `window-maximized` key to GSettings schema** (AC: #1, #2, #3)
  - [x] 1.1 Edit `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` — add ONE new key after `window-height`:
    ```xml
    <key name="window-maximized" type="b">
      <default>false</default>
      <summary>Window maximized state</summary>
    </key>
    ```
  - [x] 1.2 The schema already has `window-width` (i, default 780) and `window-height` (i, default 520) — no changes to those keys.

- [x] **Task 2: Update `MainWindow` to accept settings and save/restore geometry** (AC: #1, #2, #3, #4, #5)
  - [x] 2.1 In `ui/src/protondrive/window.py`, add `Gio` to the gi import line:
    ```python
    from gi.repository import Adw, Gio, Gtk
    ```
  - [ ] 2.2 Change `MainWindow.__init__` signature — add `settings` as the first explicit parameter:
    ```python
    def __init__(self, settings: Gio.Settings, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._settings = settings
    ```
  - [x] 2.3 Replace the hardcoded `self.set_default_size(780, 520)` line with settings-based restore:
    ```python
    w = settings.get_int("window-width")    # schema default: 780
    h = settings.get_int("window-height")   # schema default: 520
    self.set_default_size(w, h)
    if settings.get_boolean("window-maximized"):
        self.maximize()
    self.connect("close-request", self._on_close_request)
    ```
    Keep `self.set_size_request(360, 480)` — it is the minimum size constraint, unrelated.
  - [x] 2.4 Add `_on_close_request` method to `MainWindow` (new method, add anywhere after `__init__`):
    ```python
    def _on_close_request(self, window: Gtk.Window) -> bool:
        """Save window geometry to GSettings before closing."""
        self._settings.set_boolean("window-maximized", self.is_maximized())
        if not self.is_maximized():
            self._settings.set_int("window-width", self.get_width())
            self._settings.set_int("window-height", self.get_height())
        return False  # False = allow close; True would veto close entirely
    ```

- [x] **Task 3: Pass settings to `MainWindow` in `Application.do_activate()`** (AC: #4)
  - [x] 3.1 In `ui/src/protondrive/main.py`, update the `MainWindow` construction in `do_activate()`:
    ```python
    # BEFORE:
    self._window = MainWindow(application=self)
    
    # AFTER:
    self._window = MainWindow(settings=self.settings, application=self)
    ```
    `self.settings` is the existing lazy-init `Gio.Settings` property on `Application` (main.py:41-45). Do NOT create a new `Gio.Settings.new(APP_ID)` call.

- [x] **Task 4: Patch `_make_window()` in `test_window_routing.py`** (regression guard)
  - [x] 4.1 In `ui/tests/test_window_routing.py`, add `win._settings = MagicMock()` to the `_make_window()` helper (after line `win._row_activated_connected = False`):
    ```python
    def _make_window() -> MainWindow:
        """Construct a MainWindow without GTK init."""
        win = object.__new__(MainWindow)
        win.status_footer_bar = MagicMock()
        win.pair_detail_panel = MagicMock()
        win.nav_split_view = MagicMock()
        win.pairs_list = MagicMock()
        win._sync_pair_rows = {}
        win._pairs_data = {}
        win._row_activated_connected = False
        win._settings = MagicMock()   # ← add this line
        return win
    ```
    **Why:** `MainWindow` will now have `self._settings` set in `__init__`. Any future test that calls `_on_close_request` on a window built by this helper would `AttributeError` without this. No existing tests break — this is defensive hygiene.

- [x] **Task 5: Unit tests** (AC: #6)
  - [x] 4.1 Create `ui/tests/test_window_state_persistence.py`:
    ```python
    """Unit tests for window state persistence (Story 2.9).

    MainWindow GTK init is bypassed via object.__new__; settings and GTK methods
    are mocked so tests run without a display.
    """
    from __future__ import annotations

    from unittest.mock import MagicMock

    from protondrive.window import MainWindow


    def _make_window(width: int = 900, height: int = 600, maximized: bool = False) -> MainWindow:
        """Build a MainWindow bypassing GTK init with controllable geometry."""
        win = object.__new__(MainWindow)
        win._settings = MagicMock()
        win.get_width = MagicMock(return_value=width)
        win.get_height = MagicMock(return_value=height)
        win.is_maximized = MagicMock(return_value=maximized)
        return win


    class TestOnCloseRequest:
        def test_saves_width_height_when_not_maximized(self):
            win = _make_window(width=900, height=600, maximized=False)
            win._on_close_request(win)
            win._settings.set_int.assert_any_call("window-width", 900)
            win._settings.set_int.assert_any_call("window-height", 600)

        def test_saves_maximized_false_when_not_maximized(self):
            win = _make_window(maximized=False)
            win._on_close_request(win)
            win._settings.set_boolean.assert_called_with("window-maximized", False)

        def test_saves_maximized_true_when_maximized(self):
            win = _make_window(maximized=True)
            win._on_close_request(win)
            win._settings.set_boolean.assert_called_with("window-maximized", True)

        def test_does_not_save_size_when_maximized(self):
            win = _make_window(width=1920, height=1080, maximized=True)
            win._on_close_request(win)
            win._settings.set_int.assert_not_called()

        def test_returns_false_to_allow_close(self):
            win = _make_window()
            result = win._on_close_request(win)
            assert result is False


    class TestGeometryRestore:
        def _make_settings(self, width: int, height: int, maximized: bool) -> MagicMock:
            s = MagicMock()
            s.get_int.side_effect = lambda k: {"window-width": width, "window-height": height}[k]
            s.get_boolean.return_value = maximized
            return s

        def test_restores_saved_size(self):
            settings = self._make_settings(1024, 768, False)
            win = object.__new__(MainWindow)
            win.set_default_size = MagicMock()
            win.maximize = MagicMock()

            w = settings.get_int("window-width")
            h = settings.get_int("window-height")
            win.set_default_size(w, h)
            if settings.get_boolean("window-maximized"):
                win.maximize()

            win.set_default_size.assert_called_once_with(1024, 768)
            win.maximize.assert_not_called()

        def test_maximizes_when_flag_set(self):
            settings = self._make_settings(780, 520, True)
            win = object.__new__(MainWindow)
            win.set_default_size = MagicMock()
            win.maximize = MagicMock()

            w = settings.get_int("window-width")
            h = settings.get_int("window-height")
            win.set_default_size(w, h)
            if settings.get_boolean("window-maximized"):
                win.maximize()

            win.maximize.assert_called_once()

        def test_default_dimensions_from_schema_defaults(self):
            settings = self._make_settings(780, 520, False)
            win = object.__new__(MainWindow)
            win.set_default_size = MagicMock()
            win.maximize = MagicMock()

            w = settings.get_int("window-width")
            h = settings.get_int("window-height")
            win.set_default_size(w, h)

            win.set_default_size.assert_called_once_with(780, 520)
            win.maximize.assert_not_called()


    class TestSchemaKeys:
        """Guard against accidental removal of GSettings keys."""

        def test_window_maximized_key_in_schema(self):
            from pathlib import Path
            schema = (
                Path(__file__).parent.parent
                / "data"
                / "io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml"
            ).read_text()
            assert "window-maximized" in schema
            assert "window-width" in schema
            assert "window-height" in schema
    ```

---

## Dev Notes

### Files to modify (no new source files — tests only are new)

| File | Change |
|------|--------|
| `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` | Add `window-maximized` boolean key |
| `ui/src/protondrive/window.py` | Accept `settings: Gio.Settings` param; restore geometry in `__init__`; add `_on_close_request` |
| `ui/src/protondrive/main.py` | Pass `settings=self.settings` to `MainWindow()` in `do_activate()` |
| `ui/tests/test_window_routing.py` | Add `win._settings = MagicMock()` to `_make_window()` helper |
| `ui/tests/test_window_state_persistence.py` | New test file (create) |

### CRITICAL: Do NOT create `window_state.py`

The previous story stub incorrectly proposed a `WindowStateManager` class and plain JSON file. The codebase already uses `Gio.Settings` throughout (`Application.settings`, `main.py:41-45`, schema at `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml`). The schema already has `window-width` and `window-height` keys. Adding a plain-file approach would introduce a redundant second persistence mechanism. Use GSettings exclusively.

### GSettings schema — current state (before this story)

```xml
<key name="window-width" type="i">    <!-- default: 780 -->
<key name="window-height" type="i">   <!-- default: 520 -->
<key name="wizard-auth-complete" type="b">  <!-- default: false -->
```

Only `window-maximized` needs to be added. Do NOT remove or rename existing keys — `wizard-auth-complete` is used in `main.py` for auth state.

### MainWindow constructor — exact before/after

```python
# CURRENT (window.py:34-37):
def __init__(self, **kwargs: object) -> None:
    super().__init__(**kwargs)
    self.set_default_size(780, 520)
    self.set_size_request(360, 480)

# AFTER this story:
def __init__(self, settings: Gio.Settings, **kwargs: object) -> None:
    super().__init__(**kwargs)
    self._settings = settings
    w = settings.get_int("window-width")
    h = settings.get_int("window-height")
    self.set_default_size(w, h)
    if settings.get_boolean("window-maximized"):
        self.maximize()
    self.connect("close-request", self._on_close_request)
    self.set_size_request(360, 480)
    # ... remainder of __init__ unchanged from line 38 onward ...
```

### GTK4 API — no new dependencies

| Method | Notes |
|--------|-------|
| `Gtk.Window.is_maximized()` → `bool` | Already inherited by `Adw.ApplicationWindow` |
| `Gtk.Window.get_width()` / `.get_height()` → `int` | Returns actual surface size; use these (not `get_default_size()`) for saving |
| `Gtk.Window.set_default_size(w, h)` | Already called in current code — same call, different values |
| `Gtk.Window.maximize()` | Already on `Adw.ApplicationWindow` |
| `close-request` signal | Returns `bool`: **False = allow close, True = veto close** |

### Why `get_width()`/`get_height()` and not `get_default_size()`

`get_default_size()` returns the hint set by `set_default_size()`, which is 780×520 after every launch until the user resizes. `get_width()`/`get_height()` return the actual current surface size — what the user actually sees. Use the actual size for saving.

### Wayland position limitation

GTK4 removed `get_position()` — Wayland compositor controls placement. Position is architecturally impossible to persist under Wayland (primary target for Flatpak GNOME). Do NOT attempt to save/restore x/y coordinates. This is the standard behavior in all modern GNOME apps (GNOME Text Editor, GNOME Builder, Nautilus, etc.).

### `close-request` signal timing

`close-request` fires when the user requests close (X button, Alt+F4, `app.quit`), BEFORE the window is destroyed and BEFORE `Application.do_shutdown`. This is the correct place to save state. Do NOT use the `destroy` signal — geometry is reset to 0 by that point. Return `False` from the handler or the window will not close.

### `Application.settings` property

`main.py:41-45` — lazy-init property, creates `Gio.Settings.new(APP_ID)` on first access, caches in `self._settings`. Already used in `on_auth_completed()`, `logout()`, `_on_token_expired()`. Pass it as `settings=self.settings` to `MainWindow` — consistent with "one `Gio.Settings` instance, held by `Application`, passed via constructor" pattern from the epic.

### No `meson.build` changes required

`gschema.xml` is registered in `meson.build` via the existing `install_data` or `gnome.compile_schemas` call. Adding a key to an existing schema requires no new meson entries.

### Test pattern (consistent with existing suite)

Same `object.__new__` bypass pattern as `test_pair_detail_panel.py` and `test_sync_progress_card.py`. No display, no GTK init, mock everything.

```python
# Pattern established in 2-8 tests:
win = object.__new__(MainWindow)
win._settings = MagicMock()
win.get_width = MagicMock(return_value=...)
win.is_maximized = MagicMock(return_value=...)
```

### Previous story learnings (2-8)

- Signal handlers MUST be real methods on the class (not lambdas) to avoid GObject reference cycles in long-running app
- Always `from __future__ import annotations` at top of Python files
- Keep `from gi.repository import ...` at module level, never inside methods
- `object.__new__` + manual mock attachment is the confirmed test pattern for this project

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Added `window-maximized` boolean key to GSettings schema (Task 1)
- Updated `MainWindow.__init__` to accept `settings: Gio.Settings`, restore geometry from settings, connect `close-request` signal (Task 2)
- Added `_on_close_request` method: saves maximized state always, saves width/height only when not maximized, returns False to allow close (Task 2)
- Added `Gio` to gi.repository import in `window.py` (Task 2)
- Updated `Application.do_activate()` to pass `settings=self.settings` to `MainWindow` constructor (Task 3)
- Added `win._settings = MagicMock()` defensive guard to `_make_window()` in `test_window_routing.py` (Task 4)
- Created `ui/tests/test_window_state_persistence.py` with 9 tests across 3 classes: TestOnCloseRequest (5), TestGeometryRestore (3), TestSchemaKeys (1) — all pass (Task 5)
- No regressions introduced; 18 pre-existing failures in auth_window/credential_store/engine tests are unrelated to this story

### File List

- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml`
- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/tests/test_window_routing.py`
- `ui/tests/test_window_state_persistence.py` (new)

---

### Review Findings

- [x] [Review][Patch] TestGeometryRestore tests re-implement `__init__` logic inline instead of calling it — AC6 violation [`ui/tests/test_window_state_persistence.py:58-97`] — fixed: rewrote tests to call `MainWindow.__init__` with `Adw.ApplicationWindow.__init__` patched to no-op

- [x] [Review][Defer] No validation of restored geometry values (zero/negative integers legal in GSettings) [`ui/src/protondrive/window.py:35-37`] — deferred, out of story scope
- [x] [Review][Defer] `close-request` signal does not persist on process crash or session logout [`ui/src/protondrive/window.py:42`] — deferred, out of story scope
- [x] [Review][Defer] `Gio.Settings.sync()` not called; narrow risk of partial write on abnormal exit [`ui/src/protondrive/window.py:56-61`] — deferred, pre-existing pattern
- [x] [Review][Defer] Tiled/snapped window state (GTK4 `is_maximized()` returns False for tiling) saves tiled dimensions as restore size [`ui/src/protondrive/window.py:57-61`] — deferred, known GTK4 limitation
- [x] [Review][Defer] Unrealized window (`close-request` before present) would save 0×0 dimensions [`ui/src/protondrive/window.py:59-60`] — deferred, GTK4 contract prevents this under normal operation
- [x] [Review][Defer] Re-open path (window object reused without recreation) skips `maximize()` re-application [`ui/src/protondrive/main.py:70-84`] — deferred, current implementation creates fresh window on activate
- [x] [Review][Defer] No test for `get_width()`/`get_height()` returning 0 at close time [`ui/tests/test_window_state_persistence.py`] — deferred, tied to geometry validation deferral
- [x] [Review][Defer] No test for `Gio.Settings` write failure [`ui/tests/test_window_state_persistence.py`] — deferred, out of story scope
- [x] [Review][Defer] `connect` not mocked in `_make_window` helper — latent trap if future tests call `__init__` [`ui/tests/test_window_state_persistence.py:13-20`] — deferred, pre-existing pattern
