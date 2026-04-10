# Story 2.4: Setup Wizard & First Pair Creation

Status: done

## Story

As a new user,
I want a guided setup flow to choose my local and remote folders and create my first sync pair,
so that I can start syncing without confusion or reading documentation.

## Acceptance Criteria

**AC1 — Routing: session_ready → wizard when no pairs, main window when pairs exist:**

**Given** `session_ready` fires from the engine (initial launch or re-auth)
**When** `main.py` `_on_session_ready` runs
**Then** it reads `$XDG_CONFIG_HOME/protondrive/config.yaml`:
  - If the file is absent, empty, or `pairs` list is empty → call `window.show_setup_wizard(engine_client)`
  - If `pairs` list has at least one entry → call `window.show_main()` + `window.on_session_ready(payload)` (existing behaviour)
**And** `$XDG_CONFIG_HOME` is resolved via `os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))`
**And** YAML parsing failures (corrupt file, missing key) are treated as "no pairs" — wizard is shown, no crash
**Note — re-auth `session_ready`:** This same routing logic runs on every `session_ready` event, including re-auth. Once a pair exists in config.yaml, re-auth always routes to `show_main()` directly — the wizard is never shown again. No special-casing for re-auth is needed.

**Given** the wizard completes (pair created, `add_pair_result` received)
**When** the wizard calls back to its parent
**Then** `window.show_main()` transitions the window to the main split-view
**And** `window.on_session_ready(payload)` is called with the cached session payload (stored at `_on_session_ready` time on the `Application` object)

**AC2 — `SetupWizard` widget renders the folder-selection step (auth already done):**

**Given** `window.show_setup_wizard(engine_client)` is called
**When** the widget is constructed and displayed
**Then** all widget structure lives in `ui/data/ui/setup-wizard.blp` with Python wiring in `ui/src/protondrive/widgets/setup_wizard.py`
**And** the widget class extends `Gtk.Box` with `__gtype_name__ = "ProtonDriveSetupWizard"` matching the Blueprint template class name
**And** the wizard opens at the **folder-selection step** — not an auth step — because auth is already complete by the time `show_setup_wizard` is called
**And** the Blueprint stack has at minimum two pages: `folder_selection` and `syncing_confirmation`
**And** the folder-selection page contains:
  - A **Choose local folder** button that triggers the XDG portal file picker (AC3)
  - A label showing the selected local path (empty state: "No folder selected")
  - The `RemoteFolderPicker` widget embedded from Story 2.3 — instantiated in Python as `RemoteFolderPicker(engine_client=engine_client, local_folder_path=selected_local_path)`; re-instantiated whenever the local path changes
  - A **Back** button (UX-DR4) — navigates back to main pre-auth screen; only visible on this step; pressing it calls `window.show_pre_auth()` via the Application callback pattern
  - A **Next** / **Create Pair** button — enabled only when both local and remote paths are selected; disabled by default

**AC3 — Local folder selection via XDG File Chooser portal (`org.freedesktop.portal.FileChooser`):**

**Given** the user clicks the "Choose local folder" button
**When** the click handler fires
**Then** `Gtk.FileDialog().select_folder(parent=window, cancellable=None, callback=self._on_folder_chosen)` is called
**And** `Gtk.FileDialog` (GTK 4.10+) is used — NOT the deprecated `Gtk.FileChooserDialog` or `Gtk.FileChooserNative` (FR38)
**And** under Flatpak, `Gtk.FileDialog` automatically routes through `org.freedesktop.portal.FileChooser` — no manual portal call needed
**And** `_on_folder_chosen(dialog, result)` calls `dialog.select_folder_finish(result)` → gets `Gio.File` → extracts the path via `gio_file.get_path()`
**And** if the user cancels or an error occurs (catches `GLib.Error`), the selected path is unchanged and no error is shown to the user
**And** on success, the selected path label updates and the `RemoteFolderPicker` is re-instantiated with the new `local_folder_path`
**And** the Create Pair button re-evaluates its enabled state after path update

**AC4 — Setup wizard connects to engine, creates pair via `add_pair` IPC:**

**Given** both local and remote paths are set and the user clicks "Create Pair"
**When** the button handler fires
**Then** the button becomes insensitive (prevents double-submit)
**And** `engine_client.send_command_with_response({"type": "add_pair", "payload": {"local_path": local, "remote_path": remote}}, on_result=self._on_pair_created)` is called (using the correlation helper from Story 2.3)
**And** the wizard shows a `Gtk.Spinner` and "Setting up sync…" label while awaiting the response

**Given** `add_pair_result` arrives with a `pair_id` field
**When** `_on_pair_created(payload)` fires
**Then** the wizard transitions the `Gtk.Stack` to the `syncing_confirmation` page:
  - "You're Syncing!" heading
  - Summary of the pair (local path → remote path)
  - A "Go to main window" / "Done" button that triggers the Application callback
**And** the Application `_on_wizard_complete(pair_id)` method:
  1. Calls `window.show_main()`
  2. Calls `window.on_session_ready(self._cached_session_data)` to populate the account header
**And** from this point forward, `session_ready` routing checks config.yaml and finds one pair → main window is shown directly (wizard not shown again)

**Given** `add_pair_result` arrives with an `error` field OR the timeout fires (error payload `{"error": "timeout"}`)
**When** `_on_pair_created(payload)` fires
**Then** the button is re-enabled (sensitive=True), spinner hides, and an inline `Gtk.Label` in the `@error` style class shows the error message below the Create Pair button
**And** the wizard does NOT navigate away — the user can retry

**AC5 — Engine `add_pair` command handler:**

**Given** an `add_pair` IPC command arrives with `{local_path: string, remote_path: string}`
**When** `handleCommand` processes it
**Then** the handler:
  1. Validates `payload.local_path` and `payload.remote_path` are non-empty strings; if either is missing or empty, returns `{type: "add_pair_result", id: command.id, payload: {error: "invalid_payload"}}` without touching the DB or config
  2. Generates `pair_id = crypto.randomUUID()` (Node built-in, no import needed for `crypto.randomUUID()` in Node 22)
  3. Resolves `remote_id` (best-effort, must be wrapped in try/catch): calls `driveClient.listRemoteFolders(null)` to get root folders; finds the folder whose `name` matches the **first path segment** of `remote_path` (e.g., `/Documents` → segment `Documents`); uses the folder's `id` field as `remote_id`; if no match found **OR** if `listRemoteFolders` throws for any reason (network error, SDK error), falls back to `remote_id = ""` and continues — do NOT propagate the error (Story 2.5 resolves on first sync, see Dev Notes)
  4. Calls `stateDb.insertPair({ pair_id, local_path, remote_path, remote_id, created_at: new Date().toISOString() })` to write to SQLite
  5. Calls `writeConfigYaml(pair_id, local_path, remote_path)` to write/update config.yaml (see AC6)
  6. If both DB write and YAML write succeed: returns `{type: "add_pair_result", id: command.id, payload: {pair_id}}`
  7. If YAML write fails: the pair is NOT considered created (per epic spec: "if YAML write fails, pair is not considered created") — delete the newly inserted SQLite row via `stateDb.deletePair(pair_id)` and return `{type: "add_pair_result", id: command.id, payload: {error: "config_write_failed"}}`
  8. If DB write fails: return `{type: "add_pair_result", id: command.id, payload: {error: "db_write_failed"}}` (no YAML write attempted)
**And** `driveClient` must be non-null when `add_pair` is called; if null, return `{error: "engine_not_ready"}`
**And** `stateDb` must be initialized when `add_pair` is called; if undefined (defensive guard consistent with `driveClient` pattern), return `{error: "engine_not_ready"}`
**And** the handler is added to `handleCommand` in `main.ts` after the `list_remote_folders` branch

**AC6 — `writeConfigYaml` helper writes `$XDG_CONFIG_HOME/protondrive/config.yaml`:**

**Given** `add_pair` calls `writeConfigYaml`
**When** the helper runs
**Then** it reads the existing config.yaml (or starts with `{pairs: []}` if file absent)
**And** appends a new entry: `{pair_id, local_path, remote_path, created_at: ISO 8601}`
**And** uses `js-yaml` for serialization (`import yaml from "js-yaml"`) — add `js-yaml` to `engine/package.json` dependencies and `@types/js-yaml` to devDependencies
**And** writes the file atomically: write to `config.yaml.tmp` then `fs.renameSync()` to `config.yaml`
**And** creates the parent directory with `mkdirSync(..., {recursive: true})` if it does not exist
**And** `$XDG_CONFIG_HOME` is read from `process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config")`
**And** the final config path is `{XDG_CONFIG_HOME}/protondrive/config.yaml`

**AC7 — Engine `get_status` command handler (routing prerequisite):**

**Given** a `get_status` IPC command arrives
**When** `handleCommand` processes it
**Then** the handler reads all pairs from SQLite via `stateDb.listPairs()` (already exists on `StateDb` from Story 2-1 — no new method needed)
**And** returns `{type: "get_status_result", id: command.id, payload: {pairs: SyncPair[], online: true}}`
**And** `SyncPair[]` in the response contains `{pair_id, local_path, remote_path}` for each pair (not `remote_id` — internal detail)
**And** `online: true` is hardcoded for Story 2.4; Story 3.x adds real network detection
**Note:** The Python routing in AC1 reads config.yaml **directly** (does NOT use `get_status`). `get_status` is implemented here because project-context.md mandates it be sent on every `ready` event — the main window needs it in Story 2.7 to populate the pair list.

**AC8 — `StateDb` methods `listPairs()` and `deletePair()` — already implemented (Story 2-1):**

`listPairs(): SyncPair[]` and `deletePair(pairId: string): void` were built in Story 2-1 and are already tested in `engine/src/state-db.test.ts`. No new methods needed — Task 2 below is removed. Use these directly in AC5 (`insertPair`, `deletePair`) and AC7 (`listPairs`).

**AC9 — Wizard Back button and interrupted-wizard resumption:**

**Given** the user clicks Back on the folder-selection step
**When** the handler fires
**Then** the Application `_on_wizard_back()` method is called, which calls `window.show_pre_auth()`
**And** the `SetupWizard` widget is destroyed (window.show_pre_auth sets new content, old content is released)

**Given** the app was closed mid-wizard (after auth, before pair creation)
**When** the app relaunches with a valid token
**Then** `session_ready` fires → routing reads config.yaml → no pairs → `show_setup_wizard()` again — wizard restarts at the folder-selection step
**And** this is correct behaviour per epic spec: "wizard resumes at the folder selection step" (effectively restarts since no wizard state is persisted)

**AC10 — Meson + GResource wiring:**

**Given** `ui/meson.build`
**When** building
**Then** a new `blueprints_setup_wizard` custom_target mirrors the `blueprints_remote_folder_picker` block:
  ```meson
  blueprints_setup_wizard = custom_target(
    'blueprint-setup-wizard',
    input: files('data/ui/setup-wizard.blp'),
    output: 'setup-wizard.ui',
    command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
  )
  ```
**And** `blueprints_setup_wizard` is added to the `dependencies` list in `gnome.compile_resources`
**And** `src/protondrive/widgets/setup_wizard.py` is added to `python_widget_sources`
**And** `data/protondrive.gresource.xml` adds:
  ```xml
  <file alias="ui/setup-wizard.ui" preprocess="xml-stripblanks">setup-wizard.ui</file>
  ```
**And** GSettings schema `io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` gains NO new keys — routing is based on config.yaml, not GSettings flags

**AC11 — Tests:**

**UI tests (pytest via `python3 -m pytest tests/`):**
- New `ui/tests/test_setup_wizard.py` covering:
  - Widget instantiates with `object.__new__(...)` pattern (matches `test_widgets.py` + `test_remote_folder_picker.py` scaffold)
  - Back button calls the provided back-callback
  - "Create Pair" button disabled when local or remote path is empty; enabled when both are set
  - `_on_folder_chosen` success path: updates local label, re-instantiates `RemoteFolderPicker`
  - `_on_folder_chosen` cancel path (catches `GLib.Error`): no state change, no crash
  - `_on_pair_created` success: stack transitions to syncing_confirmation page; button re-enabled
  - `_on_pair_created` error: inline error label shows, button re-enabled, stack stays on folder_selection
  - `_on_pair_created` timeout (payload `{"error": "timeout"}`): same as error path above
- New `ui/tests/test_main.py` (or extend existing) covering routing:
  - `_on_session_ready` routes to wizard when config.yaml absent
  - `_on_session_ready` routes to wizard when config.yaml exists but `pairs: []`
  - `_on_session_ready` routes to main window when config.yaml has one pair
  - YAML parse failure → wizard shown, no exception raised
- All 202 existing UI tests still pass

**Engine tests (`node --import tsx --test engine/src/main.test.ts`):**
- New `describe("add_pair command", ...)` block:
  - Success: `driveClient` set, valid payload → `add_pair_result` with `pair_id` field (UUID format)
  - Missing `local_path` → `{error: "invalid_payload"}`
  - Missing `remote_path` → `{error: "invalid_payload"}`
  - `driveClient` null → `{error: "engine_not_ready"}`
- New `describe("get_status command", ...)` block:
  - Returns `{pairs: [], online: true}` when no pairs
- New `engine/src/config.test.ts`:
  - Creates file if absent
  - Appends to existing file
  - Atomic write (tmp + rename pattern)
  - Written YAML contains correct fields

## Tasks / Subtasks

- [x] **Task 1: Engine `js-yaml` dependency + `config.ts` helper** (AC: #6)
  - [x] 1.1 In `engine/`, run `npm install js-yaml` and `npm install --save-dev @types/js-yaml` to add dependency
  - [x] 1.2 Create `engine/src/config.ts` with `readConfigYaml()`, `writeConfigYaml(pair_id, local_path, remote_path)`, and `listConfigPairs()` exports
  - [x] 1.3 `getConfigPath()` internal helper: `process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")` + `/protondrive/config.yaml`
  - [x] 1.4 `writeConfigYaml` atomic write: write to `path + ".tmp"` → `renameSync(tmp, path)`; `mkdirSync(dirname(path), {recursive: true})` before write
  - [x] 1.5 `readConfigYaml` wraps everything in try/catch — returns `{pairs: []}` on any failure (missing file, parse error, wrong schema)
  - [x] 1.6 Create `engine/src/config.test.ts` with tests per AC11; use a temp directory via `os.tmpdir()` for file operations

- [x] **Task 2: `StateDb` methods** *(already complete — Story 2-1, no action needed)*
  - `insertPair()`, `listPairs()`, and `deletePair()` all exist in `engine/src/state-db.ts` and are tested in `state-db.test.ts`

- [x] **Task 3: Engine `add_pair` + `get_status` handlers** (AC: #5, #7)
  - [x] 3.1 In `main.ts`, declare `let stateDb: StateDb | undefined;` at module scope (mirrors `let driveClient: DriveClient | null`), initialise inside `main()` via `stateDb = new StateDb()` (before `server.start()`)
  - [x] 3.1b Export `_setStateDbForTests(db: StateDb | undefined): void` at module scope alongside `_setDriveClientForTests` — **required** for test isolation: `main()` never runs under `node --test` (argv guard at lines 119–123 of `main.ts`), so without this hook `stateDb` is `undefined` when tests call `handleCommand` and `add_pair` crashes
  - [x] 3.2 Import `{ writeConfigYaml }` from `"./config.js"` at top of `main.ts`; also import `StateDb` and `type SyncPair` from `"./state-db.js"`
  - [x] 3.3 Add `add_pair` branch in `handleCommand` per AC5 (after `list_remote_folders` branch); use `insertPair`, `deletePair` — not `addSyncPair`/`removeSyncPair`
  - [x] 3.4 Add `get_status` branch in `handleCommand` per AC7; use `stateDb.listPairs()` — not `listSyncPairs()`
  - [x] 3.5 Add engine tests in `main.test.ts` per AC11; test setup: `beforeEach` injects `new StateDb(":memory:")` via `_setStateDbForTests`; `afterEach` calls `_setStateDbForTests(undefined)` to reset state

- [x] **Task 4: `SetupWizard` Blueprint** (AC: #2, #3)
  - [x] 4.1 Create `ui/data/ui/setup-wizard.blp` with:
    - `template $ProtonDriveSetupWizard: Gtk.Box` — vertical orientation
    - `Adw.HeaderBar header_bar` with `[start] Gtk.Button back_button` and `Adw.WindowTitle`
    - `Gtk.Stack wizard_stack` with two pages: `folder_selection` and `syncing_confirmation`
    - `folder_selection` page: `choose_local_button`, `local_path_label`, `remote_picker_box` (empty Gtk.Box for Python to populate), `error_label` (visible: false, styles ["error"]), `create_pair_button` (sensitive: false, styles ["suggested-action"])
    - `syncing_confirmation` page: `Adw.StatusPage syncing_page` with title "You're Syncing!", child containing `sync_summary_label` + `done_button`
    - `back_button` starts visible (the folder_selection page is the only page where Back makes sense)

- [x] **Task 5: `SetupWizard` Python widget** (AC: #2, #3, #4, #9)
  - [x] 5.1 Create `ui/src/protondrive/widgets/setup_wizard.py`
  - [x] 5.2 Constructor: `__init__(self, engine_client: Any, on_pair_created: Callable[[str], None], on_back: Callable[[], None]) -> None`
  - [x] 5.3 Template children wired: `header_bar`, `back_button`, `wizard_stack`, `choose_local_button`, `local_path_label`, `remote_picker_box`, `error_label`, `create_pair_button`, `sync_summary_label`, `done_button`
  - [x] 5.4 `back_button.connect("clicked", self._on_back_clicked)` — calls `on_back()`; NO lambda (project-context.md line 61)
  - [x] 5.5 `choose_local_button.connect("clicked", self._on_choose_local_clicked)`
  - [x] 5.6 `create_pair_button.connect("clicked", self._on_create_pair_clicked)`
  - [x] 5.7 `done_button.connect("clicked", self._on_done_clicked)`
  - [x] 5.8 `_on_choose_local_clicked`: `Gtk.FileDialog().select_folder(parent=self.get_root(), cancellable=None, callback=self._on_folder_chosen)` (import `Gtk.FileDialog` — GTK 4.10+)
  - [x] 5.9 `_on_folder_chosen`: try `dialog.select_folder_finish(result)` / except `GLib.Error: return`; update `_local_path`, label, rebuild picker, call `_update_create_button()`
  - [x] 5.10 `_rebuild_remote_picker`: remove all children from `remote_picker_box` using the safe 4-line iteration pattern from Dev Notes ("GTK child removal pattern") — **do NOT use walrus operator** (`while child := ...`); create new `RemoteFolderPicker(...)`; `remote_picker_box.append(self._remote_picker)`
  - [x] 5.11 `_update_create_button`: `sensitive = self._local_path is not None and len(self._get_remote_path().strip("/")) > 0`
  - [x] 5.12 `_on_create_pair_clicked`: `create_pair_button.set_sensitive(False)`; `create_pair_button.set_label("Creating…")`; call `engine_client.send_command_with_response(...)`
  - [x] 5.13 `_on_pair_created(payload)`: if `"pair_id" in payload` → store `self._pair_id = payload["pair_id"]`; update `sync_summary_label`; `wizard_stack.set_visible_child_name("syncing_confirmation")` — else restore button + show error
  - [x] 5.14 `_on_done_clicked`: calls `self._on_pair_created_cb(self._pair_id)`

- [x] **Task 6: `window.py` + `main.py` routing** (AC: #1, #9)
  - [x] 6.1 Add to `window.py` `MainWindow`:
    - `self._setup_wizard: SetupWizard | None = None` in `__init__`
    - `show_setup_wizard(self, engine_client: Any) -> None`: constructs `SetupWizard`, `set_content(wizard)`
    - `_on_wizard_pair_created(self, pair_id: str) -> None`: calls `app._on_wizard_complete(pair_id)` via `self.get_application()`
    - `_on_wizard_back(self) -> None`: calls `self.show_pre_auth()`; sets `self._setup_wizard = None`
  - [x] 6.2 Add to `main.py` `Application`:
    - `self._cached_session_data: dict[str, Any] | None = None` in `__init__`
    - In `_on_session_ready`: cache `self._cached_session_data = payload` first
    - `_has_configured_pairs(self) -> bool`: calls `_read_config_pairs()`, returns `len(pairs) > 0`
    - `_read_config_pairs(self) -> list[dict[str, Any]]`: reads + parses config.yaml with `import yaml`; catches all exceptions; returns `[]` on failure
    - Routing: if `_has_configured_pairs()` → `show_main()` + `on_session_ready(payload)` else → `show_setup_wizard(self._engine)`
    - `_on_wizard_complete(self, pair_id: str) -> None`: `window.show_main()` + `window.on_session_ready(self._cached_session_data or {})`
  - [x] 6.3 Import `yaml` (PyYAML) at top of `main.py`

- [x] **Task 7: Meson + GResource wiring** (AC: #10)
  - [x] 7.1 Add `blueprints_setup_wizard` custom_target in `ui/meson.build` after `blueprints_remote_folder_picker`
  - [x] 7.2 Add `blueprints_setup_wizard` to `dependencies:` in `gnome.compile_resources`
  - [x] 7.3 Add `'src/protondrive/widgets/setup_wizard.py'` to `python_widget_sources`
  - [x] 7.4 Add setup-wizard.ui entry to `ui/data/protondrive.gresource.xml`

- [x] **Task 8: Tests** (AC: #11)
  - [x] 8.1 Create `ui/tests/test_setup_wizard.py` (13 tests)
  - [x] 8.2 Create `ui/tests/test_main_routing.py` with routing tests (6 tests)
  - [x] 8.3 Add engine tests in `engine/src/main.test.ts` (5 new tests: 4 add_pair + 1 get_status)
  - [x] 8.4 Create `engine/src/config.test.ts` (6 tests)
  - [x] 8.5 Verified: 19 new UI tests pass; 190 existing UI tests pass (18 pre-existing failures unrelated to this story); 99/99 engine tests pass (zero regressions)

### Review Findings

- [x] [Review][Patch] `stateDb.deletePair` rollback can throw and leave orphan pair in DB [`engine/src/main.ts` add_pair handler rollback block]
- [x] [Review][Patch] `Gtk.Spinner` absent from AC4 "Setting up sync…" wait state — spec requires spinner during IPC round-trip [`ui/data/ui/setup-wizard.blp` + `setup_wizard.py:_on_create_pair_clicked`]
- [x] [Review][Patch] Back button visible on `syncing_confirmation` page (spec says folder_selection only); also visible during in-flight IPC — must be hidden in `_on_create_pair_clicked` and re-shown on error [`setup-wizard.blp:9-12`, `setup_wizard.py:_on_pair_created`]
- [x] [Review][Patch] Missing engine test: `add_pair` with non-null `driveClient` + `stateDb=undefined` → `engine_not_ready` (AC5 lists as distinct condition; untested) [`engine/src/main.test.ts`]
- [x] [Review][Defer] Concurrent write race in `writeConfigYaml` (read-modify-write not atomic across process) [`engine/src/config.ts:writeConfigYaml`] — deferred, pre-existing: single-process desktop app; concurrent `add_pair` not a Story 2.4 scenario; revisit for multi-pair Stories 2.x

## Dev Notes

### Routing — why config.yaml directly, not GSettings

`_on_session_ready` routes to wizard or main window. The authoritative source for pair existence is `$XDG_CONFIG_HOME/protondrive/config.yaml` per architecture.md. Do NOT add a `wizard-pair-created` GSettings flag — that creates desync risk (GSettings says "complete" but file missing). Read config.yaml directly; treat any failure as "no pairs."

### Widget composition exception — `setup_wizard.py` imports `RemoteFolderPicker`

`setup_wizard.py` must import `RemoteFolderPicker` from `widgets/remote_folder_picker.py`. This is an exception to the "no widget imports another widget" rule (project-context.md line 88). `RemoteFolderPicker` is **structurally embedded** in the wizard, not a coordination dependency. All session data and pair completion callbacks still flow through `window.py` → `main.py`. Document this with a comment in `setup_wizard.py`.

### Application callback pattern — NOT GObject signals

Use constructor-injected callbacks: `SetupWizard(engine_client, on_pair_created=..., on_back=...)`. This matches the `settings.py` `set_logout_callback()` pattern. Do NOT register GObject signals for this one-shot widget.

### `remote_id` placeholder

`sync_pair` table has `remote_id TEXT NOT NULL`. At `add_pair`, the engine attempts to resolve the first path segment via `listRemoteFolders(null)`. If not found, uses `""`. SQLite accepts empty string for TEXT NOT NULL. Add comment `// TODO(story-2.5): resolve remote_id for unresolved/nested paths`. Story 2.5's sync engine handles resolution during first sync.

### `stateDb` initialisation in `main.ts`

Add `let stateDb: StateDb;` at module scope (like `let server: IpcServer;`), initialise inside `main()`. Avoids side effects on test import. The `_setDriveClientForTests` pattern already exists for `driveClient` — use same approach.

### `Gtk.FileDialog` API (GTK 4.10+, available on GNOME 50 / GTK 4.18)

```python
def _on_choose_local_clicked(self, _button: Gtk.Button) -> None:
    dialog = Gtk.FileDialog()
    dialog.set_title("Choose local folder to sync")
    dialog.select_folder(
        parent=self.get_root(),
        cancellable=None,
        callback=self._on_folder_chosen,
    )

def _on_folder_chosen(self, dialog: Gtk.FileDialog, result: Gio.AsyncResult) -> None:
    try:
        gio_file = dialog.select_folder_finish(result)
    except GLib.Error:
        return
    if gio_file is None:
        return
    self._local_path = gio_file.get_path()
    self.local_path_label.set_text(self._local_path or "No folder selected")
    self._rebuild_remote_picker()
    self._update_create_button()
```
Import: `from gi.repository import Gio, GLib, Gtk`

### PyYAML — available in GNOME 50 runtime

`python3-yaml` (PyYAML) is available in `org.gnome.Platform//50`. No Flatpak manifest change needed. In dev on Fedora, it is pre-installed. Use `import yaml` (not `ruamel.yaml`).

### GTK child removal pattern

To clear all children from `remote_picker_box` before appending the new picker:
```python
child = self.remote_picker_box.get_first_child()
while child is not None:
    next_child = child.get_next_sibling()
    self.remote_picker_box.remove(child)
    child = next_child
```
Do NOT use `while child := ...` walrus operator — GTK child lists can be modified mid-iteration.

### Test scaffold — SetupWizard

Follow `test_remote_folder_picker.py` exactly — `object.__new__(SetupWizard)`, attach `MagicMock` for all `Gtk.Template.Child()` slots, never call `super().__init__()`:
```python
wizard = object.__new__(SetupWizard)
wizard._engine_client = MagicMock()
wizard._on_pair_created_cb = MagicMock()
wizard._on_back_cb = MagicMock()
wizard._local_path = None
wizard._remote_picker = MagicMock()
wizard._pair_id = None
wizard.back_button = MagicMock()
wizard.create_pair_button = MagicMock()
wizard.error_label = MagicMock()
wizard.wizard_stack = MagicMock()
wizard.local_path_label = MagicMock()
wizard.remote_picker_box = MagicMock()
wizard.sync_summary_label = MagicMock()
wizard.done_button = MagicMock()
```

### Files to create / modify

**Engine (new):**
- `engine/src/config.ts`
- `engine/src/config.test.ts`

**Engine (modified):**
- `engine/src/state-db.ts` — `listSyncPairs()` + `removeSyncPair()`
- `engine/src/state-db.test.ts` — 2 new tests
- `engine/src/main.ts` — `add_pair` + `get_status` handlers; `stateDb` init; import `config.ts`
- `engine/src/main.test.ts` — new `add_pair` + `get_status` test blocks
- `engine/package.json` — `js-yaml` + `@types/js-yaml`

**UI (new):**
- `ui/data/ui/setup-wizard.blp`
- `ui/src/protondrive/widgets/setup_wizard.py`
- `ui/tests/test_setup_wizard.py`

**UI (modified):**
- `ui/src/protondrive/window.py` — `show_setup_wizard`, `_on_wizard_pair_created`, `_on_wizard_back`
- `ui/src/protondrive/main.py` — routing logic, `_has_configured_pairs`, `_on_wizard_complete`, `import yaml`
- `ui/meson.build` — `blueprints_setup_wizard` + dependencies + python_widget_sources
- `ui/data/protondrive.gresource.xml` — setup-wizard.ui entry
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story status update

### References

- Epic 2.4 requirements: [Source: `_bmad-output/planning-artifacts/epics.md` line 810]
- IPC command table (`add_pair`, `get_status`): [Source: architecture.md line 127-136]
- Config YAML storage + authoritative pair source: [Source: architecture.md line 172; epics.md line 840]
- Blueprint rule (structure in .blp only): [Source: project-context.md line 81]
- No lambda in signal connections: [Source: project-context.md line 61]
- Widget isolation rule + exception: [Source: project-context.md line 88; architecture.md line 538]
- `Gtk.FileDialog` XDG portal (FR38): [Source: epics.md line 828]
- `send_command_with_response` correlation helper: [Source: `2-3-remote-folder-picker-component.md` AC6]
- `get_status` on every `ready` event: [Source: project-context.md line 95]
- `remote_id` UUID4 generated by engine: [Source: architecture.md line 705]
- Test scaffold pattern: [Source: `ui/tests/test_remote_folder_picker.py`]
- Meson Blueprint pattern: [Source: `ui/meson.build` line 51-56]
- Callback pattern (vs signals): [Source: `ui/src/protondrive/widgets/settings.py` `set_logout_callback`]
- `noUncheckedIndexedAccess`: arr[0] is T|undefined: [Source: project-context.md line 43]
- `verbatimModuleSyntax`: type-only imports: [Source: project-context.md line 45]
- Local imports use `.js` extension: [Source: project-context.md line 68]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (Bob / bmad-agent-sm → bmad-create-story; Amelia / bmad-agent-dev → implementation)

### Debug Log References

### Completion Notes List

- Task 1: Created `engine/src/config.ts` with `readConfigYaml`, `writeConfigYaml` (atomic: .tmp + rename), `listConfigPairs`. Used `js-yaml` for serialization. All file ops wrapped in try/catch returning `{pairs: []}` on any failure. 6 tests in `config.test.ts` use `XDG_CONFIG_HOME` env override per test for isolation.
- Task 3: Added `stateDb: StateDb | undefined` at module scope in `main.ts`; initialized in `main()` before `server.start()`. Exported `_setStateDbForTests` for test injection. `add_pair` handler validates payload, attempts `listRemoteFolders` for `remote_id` (falls back to `""` on any error), calls `insertPair` then `writeConfigYaml` with rollback (`deletePair`) on YAML write failure. `get_status` returns `{pairs, online: true}` using `listPairs()`.
- Task 4: Blueprint `setup-wizard.blp` compiled cleanly. Uses `Gtk.Stack` with `folder_selection` / `syncing_confirmation` pages. `create_pair_button` starts `sensitive: false`. `error_label` starts `visible: false` with `styles ["error"]`.
- Task 5: `setup_wizard.py` uses constructor-injected callbacks (not GObject signals). GTK child removal pattern (4-line, no walrus operator) in `_rebuild_remote_picker`. `Gtk.FileDialog` (GTK 4.10+) for folder selection. `GLib.Error` caught silently on cancel.
- Task 6: `_on_session_ready` now caches `_cached_session_data` first, then routes to wizard (no pairs) or main window (pairs exist). `_read_config_pairs` reads config.yaml via PyYAML, returns `[]` on any failure. `_on_wizard_complete` calls `show_main()` + `on_session_ready(cached_data or {})`.
- Task 7: `blueprints_setup_wizard` custom_target added to meson.build; added to dependencies; `setup_wizard.py` added to `python_widget_sources`; `setup-wizard.ui` entry added to gresource.xml. Build verified with `meson compile -C builddir`.
- Task 8: 19 new UI tests (13 wizard + 6 routing) all pass. 99/99 engine tests pass. 18 pre-existing UI test failures in test_auth_window.py / test_credential_store.py / test_engine.py are unrelated to this story (pre-existing from prior stories, none of those files modified here).

### File List

- `engine/src/config.ts` (new)
- `engine/src/config.test.ts` (new)
- `engine/src/main.ts` (modified — stateDb init, _setStateDbForTests, add_pair + get_status handlers, imports)
- `engine/src/main.test.ts` (modified — add_pair + get_status test blocks, StateDb import, beforeEach)
- `engine/package.json` (modified — js-yaml + @types/js-yaml dependencies)
- `engine/package-lock.json` (modified — lockfile updated)
- `ui/data/ui/setup-wizard.blp` (new)
- `ui/src/protondrive/widgets/setup_wizard.py` (new)
- `ui/tests/test_setup_wizard.py` (new)
- `ui/tests/test_main_routing.py` (new)
- `ui/src/protondrive/window.py` (modified — show_setup_wizard, _on_wizard_pair_created, _on_wizard_back, SetupWizard import)
- `ui/src/protondrive/main.py` (modified — routing logic, _has_configured_pairs, _read_config_pairs, _on_wizard_complete, yaml import, _cached_session_data)
- `ui/meson.build` (modified — blueprints_setup_wizard target + dependency + python_widget_sources)
- `ui/data/protondrive.gresource.xml` (modified — setup-wizard.ui entry)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — 2-4 → review)

## Change Log

- 2026-04-10: Story 2-4 implemented — setup wizard + first pair creation. Engine: js-yaml config helper, add_pair + get_status handlers. UI: SetupWizard Blueprint + Python widget, session routing, meson wiring. Tests: 99 engine + 209 UI pass.
