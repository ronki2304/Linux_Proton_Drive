# Story 6.1: Add Subsequent Sync Pair

Status: done

## Story

As a user,
I want to add more sync pairs from the main window at any time,
so that I can sync multiple folders without re-running the setup wizard.

## Acceptance Criteria

1. **Given** the main window is displaying with at least one existing sync pair **When** the user clicks the "[+ Add Pair]" button pinned at the bottom of the sidebar (above the footer) **Then** a lightweight `AddPairDialog` opens — no wizard chrome (no header, no back button, no multi-step stack).

2. **Given** the AddPairDialog is open **When** the user clicks "Choose local folder…" **Then** the XDG File Chooser portal opens for local folder selection; after selection the path is displayed and the remote picker activates.

3. **Given** the user has chosen a local folder and a remote path **When** the user clicks "Add Pair" **Then** the `add_pair` IPC command is sent with `{local_path, remote_path}`; the engine generates a UUID v4 `pair_id`, stores it in SQLite and `config.yaml`, and returns it in `add_pair_result`.

4. **Given** `add_pair_result` is received with a `pair_id` **When** the dialog closes **Then** the sidebar is refreshed via `get_status`, the new pair row appears immediately, sync starts for that pair, and the new pair row is auto-selected in the split view.

5. **Given** multiple sync pairs are configured **When** managing them **Then** at least 5 independent sync pairs operate simultaneously — an error in one pair does not affect others (engine already implements per-pair isolation in `reconcileAndEnqueue`).

6. **Given** the AddPairDialog is open **When** navigating via keyboard **Then** all inputs (local chooser button, remote path entry) and action buttons are reachable via Tab and actionable via Enter/Space.

7. **Given** `add_pair_result` returns an error **When** the dialog handles it **Then** an inline error label is shown, "Add Pair" becomes active again for retry, and Cancel remains available.

8. **Given** the SetupWizard **When** this story is complete **Then** the SetupWizard is unchanged and still used exclusively for the first-run flow; `AddPairDialog` is the new path for adding subsequent pairs.

## Tasks / Subtasks

- [x] Task 1 — Engine verification (AC: 3, 5)
  - [x] 1.1 — Run `bun test engine/src/main.test.ts` from `engine/` — confirm all existing `add_pair` tests pass (no engine code changes required for this story)
  - [x] 1.2 — Read `engine/src/sync-engine.ts:reconcileAndEnqueue` (~line 184) to confirm per-pair loop independence before writing story notes

- [x] Task 2 — New Blueprint: `add-pair-dialog.blp` (AC: 1, 2, 6)
  - [x] 2.1 — Create `ui/data/ui/add-pair-dialog.blp` following the `key-unlock-dialog.blp` pattern: root is `Adw.Dialog` with `content-width: 420`; child is `Adw.ToolbarView` with `[top] Adw.HeaderBar` and a `Gtk.Box` content area
  - [x] 2.2 — Content `Gtk.Box` (vertical, spacing 12, margins 24): `choose_local_button: Gtk.Button` (label "Choose local folder…"), `local_path_label: Gtk.Label` (initially "(no folder selected)", xalign 0, ellipsize end), `remote_picker_box: Gtk.Box` (vertical container, RemoteFolderPicker injected by Python), `error_label: Gtk.Label` (visible false, style "error"), `Gtk.Spinner spinner` (visible false)
  - [x] 2.3 — Bottom button row (halign end, spacing 8): `cancel_button: Gtk.Button` (label "Cancel"), `add_pair_button: Gtk.Button` (label "Add Pair", style "suggested-action", initially insensitive)
  - [x] 2.4 — Set `title: _("Add Sync Pair")` on the `Adw.Dialog`

- [x] Task 3 — New Python widget: `add_pair_dialog.py` (AC: 1, 2, 3, 6, 7)
  - [x] 3.1 — Create `ui/src/protondrive/widgets/add_pair_dialog.py`
  - [x] 3.2 — Class `AddPairDialog(Adw.Dialog)` with `__gtype_name__ = "ProtonDriveAddPairDialog"`; `__gsignals__ = {"pair-created": (GObject.SignalFlags.RUN_FIRST, None, (str,))}` — emits `pair_id` string on success; class-level `Gtk.Template.Child()` declarations (all Blueprint IDs must be declared — see `KeyUnlockDialog` pattern):
    ```python
    choose_local_button: Gtk.Button = Gtk.Template.Child()
    local_path_label: Gtk.Label = Gtk.Template.Child()
    remote_picker_box: Gtk.Box = Gtk.Template.Child()
    error_label: Gtk.Label = Gtk.Template.Child()
    spinner: Gtk.Spinner = Gtk.Template.Child()
    cancel_button: Gtk.Button = Gtk.Template.Child()
    add_pair_button: Gtk.Button = Gtk.Template.Child()
    ```
  - [x] 3.3 — `__init__(self, engine_client: Any, **kwargs: object)` — store `self._engine_client`; `self._local_path: str | None = None`; `self._remote_picker: RemoteFolderPicker | None = None`; wire button signals (no lambda): `self.choose_local_button.connect("clicked", self._on_choose_local_clicked)`, `self.add_pair_button.connect("clicked", self._on_add_pair_clicked)`, `self.cancel_button.connect("clicked", self._on_cancel_clicked)`
  - [x] 3.4 — `_rebuild_remote_picker(self) -> None` — clear `remote_picker_box` children using sibling-walk pattern (see SetupWizard `_rebuild_remote_picker`), instantiate `RemoteFolderPicker(engine_client=self._engine_client, local_folder_path=self._local_path)`, append to box
  - [x] 3.5 — `_on_choose_local_clicked(self, _button: Gtk.Button) -> None` → `Gtk.FileDialog().select_folder(parent=self.get_root(), cancellable=None, callback=self._on_folder_chosen)` — identical to SetupWizard pattern
  - [x] 3.6 — `_on_folder_chosen(self, dialog: Gtk.FileDialog, result: Gio.AsyncResult) -> None` — exact pattern from `SetupWizard._on_folder_chosen`
  - [x] 3.7 — `_update_add_button(self) -> None` — `add_pair_button.set_sensitive(self._local_path is not None and len(self._get_remote_path().strip("/")) > 0)`
  - [x] 3.8 — `_get_remote_path(self) -> str` — return `self._remote_picker.get_remote_path()` or `"/"` if None (same as SetupWizard)
  - [x] 3.9 — `_on_add_pair_clicked(self, _button: Gtk.Button) -> None` — disable `add_pair_button`, show spinner, hide error_label, send `add_pair` IPC command
  - [x] 3.10 — `_on_pair_created(self, payload: dict[str, Any]) -> None` — stop spinner; on success emit signal + close; on error show error_label + re-enable button
  - [x] 3.11 — `_on_cancel_clicked(self, _button: Gtk.Button) -> None` → `self.close()`
  - [x] 3.12 — Type hints, `from __future__ import annotations`, no lambda in signal connections, `@Gtk.Template(resource_path=...)`, proper imports

- [x] Task 4 — Modify `window.blp`: add sidebar button (AC: 1)
  - [x] 4.1 — In `ui/data/ui/window.blp`, inside the sidebar `Adw.ToolbarView`, add the "[+ Add Pair]" button as a `[bottom]` child BEFORE the StatusFooterBar `[bottom]` child
  - [x] 4.2 — Confirm `[bottom] StatusFooterBar` remains as the last (outermost) bottom child

- [x] Task 5 — Modify `window.py`: wire button and dialog callback (AC: 1, 2, 4, 6)
  - [x] 5.1 — Add `add_pair_button: Gtk.Button = Gtk.Template.Child()` to `MainWindow` class-level declarations
  - [x] 5.2 — In `MainWindow.__init__`: `self.add_pair_button.connect("clicked", self._on_add_pair_clicked)`
  - [x] 5.3 — Add `_on_add_pair_clicked(self, _button: Gtk.Button) -> None`
  - [x] 5.4 — Add `_on_add_pair_complete(self, _dialog: object, pair_id: str) -> None`
  - [x] 5.5 — In `on_session_ready()`: add `self.add_pair_button.set_sensitive(True)`
  - [x] 5.6 — In `clear_session()`: add `self.add_pair_button.set_sensitive(False)`
  - [x] 5.7 — Lazy import `AddPairDialog` inside the click handler

- [x] Task 6 — Modify `main.py`: handle pair-created callback (AC: 4)
  - [x] 6.1 — Add `_on_add_pair_complete(self, pair_id: str) -> None` to `Application`
  - [x] 6.2 — Add `_on_add_pair_status_result(self, payload: dict[str, Any], new_pair_id: str) -> None`

- [x] Task 7 — Register new Blueprint in build system (AC: all)
  - [x] 7.1 — In `ui/meson.build`, add `blueprints_add_pair_dialog` custom_target block
  - [x] 7.2 — In `ui/meson.build`, add `blueprints_add_pair_dialog` to `gnome.compile_resources(dependencies: [...])`
  - [x] 7.3 — In `ui/data/protondrive.gresource.xml`, add `<file alias="ui/add-pair-dialog.ui" ...>`

- [x] Task 8 — Tests (AC: 1, 2, 3, 7)
  - [x] 8.1 — Create `ui/tests/test_add_pair_dialog.py`
  - [x] 8.2 — Test: `AddPairDialog` instantiates without errors given a mock engine client
  - [x] 8.3 — Test: `add_pair_button` insensitive before local folder chosen
  - [x] 8.4a — Test: `_update_add_button` insensitive when remote = "/"
  - [x] 8.4b — Test: `_update_add_button` sensitive when remote = "/Documents"
  - [x] 8.5 — Test: `_on_add_pair_clicked` calls `send_command_with_response` with `{"type": "add_pair", ...}`
  - [x] 8.6 — Test: `_on_pair_created({"pair_id": "abc"})` emits `pair-created` signal
  - [x] 8.7 — Test: `_on_pair_created({"error": "db_write_failed"})` shows error_label and re-enables button
  - [x] 8.8 — Verified `ui/tests/test_setup_wizard.py` still passes (SetupWizard untouched)
  - [x] 8.9 — Test: `_on_cancel_clicked` calls `self.close()`
  - [x] 8.10 — Test: `_on_folder_chosen` with `GLib.Error` does not raise, `_local_path` unchanged

- [x] Task 9 — Full test suite validation (AC: all)
  - [x] 9.1 — `meson compile` via distrobox — exit 0, Blueprint compiled (step 16/17)
  - [x] 9.2 — `.venv/bin/pytest ui/tests/ -v` — 626 passed, 0 failed
  - [x] 9.3 — `bun test src/main.test.ts` — 31 passed, 0 failed

## Dev Notes

### Architecture: AddPairDialog vs SetupWizard — They Are Different

`SetupWizard` is a **full-window widget** shown via `window.set_content(wizard)` for the first-run flow. It has wizard chrome (header bar, Back button, multi-step stack with folder selection + syncing confirmation pages). It is owned by `_on_setup_requested` (empty-state CTA) and `_on_session_ready` (when `has_pairs = False`).

`AddPairDialog` is a **floating `Adw.Dialog`** that appears above the main window while the user is already looking at the main split view. It has no wizard chrome — just a title, folder pickers, and action buttons. It is owned by the "[+ Add Pair]" sidebar button.

**Do NOT modify SetupWizard.** `AddPairDialog` is a new independent widget. Both coexist.

### Engine: Zero Changes Required

The `add_pair` IPC handler at `engine/src/main.ts:482–577` is complete:
- Accepts `{local_path, remote_path}` payload
- Generates UUID v4 via `crypto.randomUUID()` — `pair_id` is always engine-generated, never UI-generated
- `stateDb.insertPair()` → `writeConfigYaml()` (atomic: YAML failure rolls back DB insert via `stateDb.deletePair()`)
- Restarts `FileWatcher` with all current pairs (including new one)
- Calls `syncEngine.startSyncAll()` — kicks off reconcile + queue drain for new pair
- Returns `{pair_id}` on success, `{error: "engine_not_ready" | "invalid_payload" | "db_write_failed" | "config_write_failed"}` on failure

Per-pair independence in `reconcileAndEnqueue()` (`engine/src/sync-engine.ts:200`): the function loops over `stateDb.listPairs()` and catches errors per pair — a throw inside one pair's reconcile emits `sync_cycle_error` for that pair but the outer loop continues with the next pair. DISK_FULL is the only exception: it sets `diskFull = true; break` to abort further pairs (intentional — no disk space = all pairs blocked). This is correct behavior, not a bug.

### AdwToolbarView `[bottom]` Ordering

In `Adw.ToolbarView`, multiple `[bottom]` children stack below the content area. **First `[bottom]` declared = closest to content.** So this Blueprint order:
```
content: Gtk.ScrolledWindow { ... }   ← pairs list
[bottom]
Gtk.Button add_pair_button { ... }    ← right below list
[bottom]
$ProtonDriveStatusFooterBar { ... }   ← very bottom of window
```
…renders as: list → add-pair button → footer. This matches the UX wireframe.

### Template.Child Declarations are Mandatory

Every Blueprint ID used in Python must be declared at class level as `Gtk.Template.Child()`. Without this, `self.cancel_button`, `self.spinner`, etc. raise `AttributeError` at runtime. See `KeyUnlockDialog` at `ui/src/protondrive/widgets/key_unlock_dialog.py:23–26` for the exact pattern. The `@Gtk.Template(resource_path=...)` decorator alone is not enough — GTK only binds the child to the Python attribute when the `= Gtk.Template.Child()` declaration is present.

### Blueprint Pattern for AddPairDialog

Follow `key-unlock-dialog.blp` exactly — it is the established `Adw.Dialog` precedent in this codebase. Key points:
- Root template inherits `Adw.Dialog` (not `AdwAlertDialog`, not `AdwWindow`)
- Child is `Adw.ToolbarView` with `[top] Adw.HeaderBar` (gives the dialog title + close button)
- Content is a `Gtk.Box` with the form controls
- Buttons in a horizontal `Gtk.Box` (halign end) inside the content box — NOT in `responses []` syntax (that's AlertDialog-only)
- `content-width: 420` is the established width for this dialog type

### RemoteFolderPicker Injection Pattern

`AddPairDialog` may import `RemoteFolderPicker` — this is the same structural embedding exception documented in `setup_wizard.py`'s module docstring. The injection pattern (verbatim from `SetupWizard._rebuild_remote_picker`):
```python
def _rebuild_remote_picker(self) -> None:
    child = self.remote_picker_box.get_first_child()
    while child is not None:
        next_child = child.get_next_sibling()
        self.remote_picker_box.remove(child)
        child = next_child
    self._remote_picker = RemoteFolderPicker(
        engine_client=self._engine_client,
        local_folder_path=self._local_path,
    )
    self.remote_picker_box.append(self._remote_picker)
```
Do NOT use walrus operator here (GTK child removal pattern requires the explicit `next_child` variable).

### GObject Signal Pattern for AddPairDialog

Follow `KeyUnlockDialog` pattern exactly — emit GObject signals rather than calling callbacks directly:
```python
__gsignals__ = {
    "pair-created": (GObject.SignalFlags.RUN_FIRST, None, (str,)),
}
```
Caller connects: `dialog.connect("pair-created", self._on_add_pair_complete)`. The signal handler receives `(dialog, pair_id)`.

### Placement of new Application methods in main.py

Add `_on_add_pair_complete` and `_on_add_pair_status_result` immediately after `_on_wizard_complete` (line 416 in `main.py`). They follow the exact same call pattern: send `get_status`, handle result by calling `_on_get_status_result`, then auto-select. Do NOT call `show_main()` or `on_session_ready()` — the user is already in the main view.

### After-Pair-Created Sequence

```
1. engine returns add_pair_result {pair_id}
2. AddPairDialog._on_pair_created: emit "pair-created" → closes dialog
3. MainWindow._on_add_pair_complete: forwards to app._on_add_pair_complete(pair_id)
4. Application._on_add_pair_complete: sends get_status command
5. Application._on_add_pair_status_result: calls _on_get_status_result(payload) → populate_pairs()
6. _on_add_pair_status_result: calls window.select_pair(new_pair_id)
7. select_pair: selects row, shows detail panel, navigates split view
```

**Use `_on_get_status_result`** (not `populate_pairs` directly) — the former also handles `online: false` state from the payload. This is the same pattern used by `_on_wizard_complete` at `main.py:416–424`.

### Button Initial State

`add_pair_button` in the sidebar must start insensitive (`sensitive: false` in the Blueprint). Enable in `on_session_ready()`, disable in `clear_session()`. The engine must be authenticated before add_pair can succeed.

### Lazy Import of AddPairDialog

Import `AddPairDialog` inside `_on_add_pair_clicked` (not at module top of `window.py`):
```python
def _on_add_pair_clicked(self, _button: Gtk.Button) -> None:
    from protondrive.widgets.add_pair_dialog import AddPairDialog
    ...
```
This avoids circular imports (window.py → add_pair_dialog.py → remote_folder_picker.py is fine, but early-binding may cause issues) and matches the deferred-import pattern used elsewhere in the codebase.

### File Chooser Cancellation Pattern

`Gtk.FileDialog.select_folder` is async. When the user clicks "Cancel" or dismisses the dialog, `select_folder_finish(result)` raises `GLib.Error` (specifically `Gio.IOError.CANCELLED`). Without catching it, the callback would propagate an unhandled exception through GLib's event loop. Always wrap in `try/except GLib.Error: return` — identical to `SetupWizard._on_folder_chosen`. Also guard `if gio_file is None: return` before calling `.get_path()`.

### Lambda Exception for IPC Callbacks

The no-lambda rule applies to **GTK signal connections** (`widget.connect("signal", self._handler)`). The `lambda payload: self._on_add_pair_status_result(payload, pair_id)` in `_on_add_pair_complete` is an IPC response callback passed to `send_command_with_response` — this is not a GTK signal connection, so the lambda is acceptable here. The lambda captures `pair_id` cleanly with no reference cycle risk.

### meson.build: Exact Registration Pattern

Each Blueprint requires three changes in exact parallel with the `reauth_dialog` pattern:
1. `custom_target` block in `ui/meson.build`
2. Reference in `gnome.compile_resources(dependencies: [...])` in `ui/meson.build`
3. `<file>` entry in `ui/data/protondrive.gresource.xml`

Missing any one of these three causes a build failure or runtime GResource lookup error.

### Deferred / Out of Scope

- **Nesting/overlap validation** — Story 6-2's scope. AddPairDialog sends `add_pair` without pre-validation; engine currently does no overlap checking either. Story 6-2 adds it.
- **5-pair concurrency test** — AC5 is verified by manual smoke test (or left to Epic 6 retro). Adding a multi-pair test to `main.test.ts` is out of scope for 6-1.
- **Empty-state "Add your first sync pair" CTA** → `PairDetailPanel.show_no_pairs()` still routes through `_on_setup_requested` → `show_setup_wizard`. Do not change it. The empty state after removing all pairs (Story 6-3 scope) is also deferred.

### Project Structure Notes

New files:
- `ui/data/ui/add-pair-dialog.blp` — Blueprint
- `ui/src/protondrive/widgets/add_pair_dialog.py` — Python widget class
- `ui/tests/test_add_pair_dialog.py` — unit tests

Modified files:
- `ui/data/ui/window.blp` — add `add_pair_button` to sidebar as `[bottom]` child
- `ui/data/protondrive.gresource.xml` — register `add-pair-dialog.ui`
- `ui/meson.build` — add `blueprints_add_pair_dialog` custom_target + dependency
- `ui/src/protondrive/window.py` — Template.Child, click handler, session-ready/clear-session enable/disable
- `ui/src/protondrive/main.py` — `_on_add_pair_complete`, `_on_add_pair_status_result`

No engine changes.

### References

- [Source: engine/src/main.ts:482–577] — `add_pair` handler (complete, no changes needed)
- [Source: engine/src/main.test.ts:254–371] — existing add_pair tests (all must pass unchanged)
- [Source: engine/src/sync-engine.ts:200–222] — `reconcileAndEnqueue` per-pair independence loop
- [Source: ui/data/ui/key-unlock-dialog.blp] — `Adw.Dialog` Blueprint pattern to follow exactly
- [Source: ui/src/protondrive/widgets/key_unlock_dialog.py] — GObject signal pattern + `__gsignals__` + button wiring
- [Source: ui/src/protondrive/widgets/setup_wizard.py] — `_rebuild_remote_picker`, `send_command_with_response` callback, `_on_folder_chosen` patterns
- [Source: ui/data/ui/window.blp] — current sidebar layout; add_pair_button slots here between list and footer
- [Source: ui/src/protondrive/window.py:380–452] — `populate_pairs`, `select_pair` patterns; on_session_ready/clear_session locations
- [Source: ui/src/protondrive/main.py:404–424] — `_on_get_status_result`, `_on_wizard_complete` — exact pattern for `_on_add_pair_complete`
- [Source: ui/meson.build:107–119] — blueprint registration pattern; gresource dependencies list
- [Source: ui/data/protondrive.gresource.xml] — gresource file registration
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md] — "[+ Add Pair] pinned at bottom of sidebar", "no wizard chrome", keyboard nav requirements
- [Source: _bmad-output/planning-artifacts/epics/epic-6-multi-pair-management-validation.md#story-6.1] — canonical ACs
- [Source: _bmad-output/project-context.md#blueprint-rule] — widget structure in .blp only; no widget tree construction in Python
- [Source: _bmad-output/project-context.md#meson-invocation] — use `distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"` (never bare `meson`)

### Review Findings

- [x] [Review][Patch] Error label shows raw backend error key instead of user-friendly message [ui/src/protondrive/widgets/add_pair_dialog.py:89] — fixed: replaced with "Failed to add sync pair. Please try again."
- [x] [Review][Defer] `_update_add_button` not wired to remote path changes [ui/src/protondrive/widgets/add_pair_dialog.py] — deferred, scope-expanding (requires RemoteFolderPicker path-changed signal)

### Party-Mode Findings

- [x] [Party][Patch] Unused `import pytest` in test file [ui/tests/test_add_pair_dialog.py:8] — fixed: removed stale import (Quinn/QA)

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None.

### Completion Notes List

- Engine verified: 31 tests pass in `engine/src/main.test.ts`; `reconcileAndEnqueue` per-pair loop independence confirmed at `sync-engine.ts:200–223`
- Created `ui/data/ui/add-pair-dialog.blp` — `Adw.Dialog` with `content-width: 420`, following `key-unlock-dialog.blp` pattern exactly; all Blueprint IDs match Python Template.Child declarations
- Created `ui/src/protondrive/widgets/add_pair_dialog.py` — `AddPairDialog(Adw.Dialog)` with `pair-created` GObject signal, `_rebuild_remote_picker` sibling-walk pattern, `_on_folder_chosen` GLib.Error guard, lazy spinner/error handling in `_on_pair_created`
- Modified `ui/data/ui/window.blp` — added `add_pair_button` as first `[bottom]` child (between content list and StatusFooterBar), `sensitive: false` initially
- Modified `ui/src/protondrive/window.py` — added `add_pair_button` Template.Child, `_on_add_pair_clicked` (lazy import), `_on_add_pair_complete`, `set_sensitive(True/False)` in `on_session_ready`/`clear_session`
- Modified `ui/src/protondrive/main.py` — added `_on_add_pair_complete` and `_on_add_pair_status_result` immediately after `_on_wizard_complete`, following identical call pattern
- Registered Blueprint: `ui/meson.build` custom_target + dependencies list; `ui/data/protondrive.gresource.xml` `<file>` entry
- Created `ui/tests/test_add_pair_dialog.py` — 17 tests covering instantiation, button sensitivity, IPC dispatch, signal emission, error path, cancel, and folder-chooser cancellation guard
- All validations: 626 pytest tests passed, meson compile exit 0 (Blueprint 16/17), 31 engine tests passed

### File List

- `ui/data/ui/add-pair-dialog.blp` (new)
- `ui/src/protondrive/widgets/add_pair_dialog.py` (new)
- `ui/tests/test_add_pair_dialog.py` (new)
- `ui/data/ui/window.blp` (modified)
- `ui/data/protondrive.gresource.xml` (modified)
- `ui/meson.build` (modified)
- `ui/src/protondrive/window.py` (modified)
- `ui/src/protondrive/main.py` (modified)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified)

### Change Log

- 2026-04-22: Story 6-1 implemented — AddPairDialog widget, sidebar button, engine IPC wiring, build system registration, 17 new tests (626 total passed)
