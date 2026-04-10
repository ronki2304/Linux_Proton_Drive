# Story 2.9: Window State Persistence

Status: ready-for-dev

## Story

As a user,
I want the app to remember its window size and position between sessions,
So that I don't have to resize it every time I open it.

## Acceptance Criteria

**AC1 — Save on close:**
**Given** the user resizes or moves the app window
**When** the window is closed
**Then** width, height, and maximized state are saved to `$XDG_STATE_HOME/protondrive/window-state.json`
**And** the directory is created if it does not exist

**AC2 — Restore on launch:**
**Given** the app launches
**When** a saved `window-state.json` exists and is valid
**Then** the window is restored to the saved width/height and maximized state
**And** if no saved state exists or the file is malformed, the default size of 780×520px is used (no crash)

**AC3 — Storage mechanism:**
**Given** the window state storage
**When** inspecting the implementation
**Then** geometry is stored in a plain JSON file at `$XDG_STATE_HOME/protondrive/window-state.json` — not in SQLite, not in libsecret
**And** the file is written atomically (write tmp → rename) to prevent corruption on crash

**AC4 — Application-level ownership:**
**Given** the `Application` class in `main.py`
**When** the window state manager is created
**Then** one `WindowStateManager` instance is held by `Application` — not created per-window
**And** the manager is passed to `MainWindow` via a setter call, not a constructor argument

**AC5 — Tests:**
**Given** unit tests in `ui/tests/test_window_state.py`
**When** running `meson test -C builddir`
**Then** tests verify: save writes correct JSON, load restores values, missing file returns defaults, malformed JSON returns defaults

## Tasks / Subtasks

- [ ] **Task 1: Implement WindowStateManager** (AC: #1, #2, #3, #4)
  - [ ] 1.1 Create `ui/src/protondrive/window_state.py`:
    - `from __future__ import annotations`
    - `import json`, `import os`, `from pathlib import Path`
    - `DEFAULT_WIDTH = 780`, `DEFAULT_HEIGHT = 520`
    - `class WindowStateManager:`
      - `__init__(self, state_dir: Path | None = None)` — defaults to `Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local' / 'state')) / 'protondrive'`; stores `_path = self._state_dir / 'window-state.json'`
      - `load(self) -> dict` — reads JSON from `_path`; returns `{'width': int, 'height': int, 'maximized': bool}`; on missing/malformed file returns `{'width': DEFAULT_WIDTH, 'height': DEFAULT_HEIGHT, 'maximized': False}`
      - `save(self, width: int, height: int, maximized: bool) -> None` — creates `_state_dir` if needed; writes JSON atomically (tmp path + `os.replace`)
  - [ ] 1.2 Atomic write pattern:
    ```python
    def save(self, width: int, height: int, maximized: bool) -> None:
        self._state_dir.mkdir(parents=True, exist_ok=True)
        data = {'width': width, 'height': height, 'maximized': maximized}
        tmp = self._path.with_suffix('.tmp')
        tmp.write_text(json.dumps(data))
        os.replace(tmp, self._path)
    ```

- [ ] **Task 2: Wire into Application and MainWindow** (AC: #4)
  - [ ] 2.1 In `ui/src/protondrive/main.py` (the `Application` class):
    - Import `WindowStateManager` from `protondrive.window_state`
    - Create `self._window_state = WindowStateManager()` in `__init__`
    - After creating `self._window = MainWindow(...)`, call `self._window.set_state_manager(self._window_state)`
    - After `self._window.present()`, apply saved state:
      ```python
      state = self._window_state.load()
      if state['maximized']:
          self._window.maximize()
      else:
          self._window.set_default_size(state['width'], state['height'])
      ```
  - [ ] 2.2 In `ui/src/protondrive/window.py` (`MainWindow`):
    - Add `set_state_manager(manager: WindowStateManager) -> None` method; stores `self._state_manager = manager`
    - Connect `self.connect('close-request', self._on_close_request)` in `__init__`
    - `_on_close_request(self, _) -> bool`:
      ```python
      if self._state_manager is not None:
          width, height = self.get_width(), self.get_height()
          maximized = self.is_maximized()
          self._state_manager.save(width, height, maximized)
      return False  # allow close to proceed
      ```

- [ ] **Task 3: Unit tests** (AC: #5)
  - [ ] 3.1 Create `ui/tests/test_window_state.py`:
    - Use `tmp_path` fixture (pytest) or `tempfile.TemporaryDirectory`
    - Test: `save()` writes valid JSON to `window-state.json` in given dir
    - Test: `load()` after `save()` returns matching width/height/maximized
    - Test: `load()` with no file returns defaults (780, 520, False)
    - Test: `load()` with malformed JSON returns defaults (no exception raised)
    - Test: atomic write — tmp file does not remain after `save()`
    - Do NOT require GTK or display — `WindowStateManager` has zero GTK imports
  - [ ] 3.2 `meson test -C builddir` — all tests pass

## Dev Notes

### XDG_STATE_HOME default
Per XDG spec: `$XDG_STATE_HOME` defaults to `~/.local/state` if not set.
```python
xdg_state = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local' / 'state'))
state_dir = xdg_state / 'protondrive'
```

### No GTK in WindowStateManager
`WindowStateManager` is a pure Python class with zero GTK imports. This enables testing without a display.

### Gio.Settings alternative
The AC notes `Gio.Settings` as an option, but a plain JSON file is simpler for Flatpak (no schema compilation required) and fully satisfies NFRs. Use JSON.

### Maximized state + size
When the window is maximized, `get_width()` and `get_height()` return the maximized dimensions. Save the `maximized` flag separately. On restore:
```python
# Restore maximized before presenting to avoid flicker
if state['maximized']:
    window.maximize()
else:
    window.set_default_size(state['width'], state['height'])
window.present()
```
`set_default_size()` must be called before `present()` — or use `resize()` after present if already shown.

### References
- [Source: ui/src/protondrive/main.py] — Application class, window creation
- [Source: ui/src/protondrive/window.py] — MainWindow, close-request signal
- [Source: ui/tests/conftest.py] — test infrastructure

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `ui/src/protondrive/window_state.py` — new: WindowStateManager
- `ui/src/protondrive/main.py` — update: create WindowStateManager, apply/save state
- `ui/src/protondrive/window.py` — update: set_state_manager(), close-request handler
- `ui/tests/test_window_state.py` — new: unit tests

## Change Log

- 2026-04-09: Story 2.9 created — Window State Persistence
