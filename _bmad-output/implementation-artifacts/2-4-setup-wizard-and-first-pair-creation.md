# Story 2.4: Setup Wizard & First Pair Creation

Status: ready-for-dev

## Story

As a new user,
I want a guided 3-step wizard to set up my first sync pair,
So that I can start syncing without confusion or documentation.

## Acceptance Criteria

**AC1 — Wizard routing:**
**Given** the app launches with a valid token but no sync pairs configured
**When** routing logic executes after `get_status_result`
**Then** the setup wizard opens at the folder selection step (not the auth step — auth already complete)

**AC2 — Interrupted wizard:**
**Given** the app was closed after auth but before configuring a sync pair
**When** the app relaunches
**Then** the wizard resumes at the folder selection step — it does not re-run auth or skip to the main window

**AC3 — XDG File Chooser portal:**
**Given** the wizard is at the "Choose Your Folder" step
**When** the user clicks the local folder selector
**Then** `org.freedesktop.portal.FileChooser` opens — not a raw GTK file dialog
**And** the user selects a local folder

**AC4 — RemoteFolderPicker integration:**
**Given** a local folder is selected
**When** the remote folder picker is displayed
**Then** it is the `RemoteFolderPicker` widget from Story 2.3

**AC5 — add_pair IPC and pair creation:**
**Given** both local and remote folders are selected
**When** the user confirms the pair
**Then** the UI sends `add_pair` with `{local_path, remote_path}`
**And** the engine generates UUID v4 `pair_id`, stores it in SQLite, and returns it in `add_pair_result`
**And** the pair is written to `$XDG_CONFIG_HOME/protondrive/config.yaml` using `js-yaml`
**And** if SQLite write succeeds but YAML write fails, the pair is deleted from SQLite (rollback) and `add_pair_result` returns `{error: "config_write_failed"}`

**AC6 — Wizard completion:**
**Given** the pair is created
**When** the wizard transitions to "You're Syncing"
**Then** the main window displays with the new pair reflected in UI

**AC7 — Navigation:**
**Given** the wizard steps
**When** inspecting navigation
**Then** no Back button on any auth step
**And** a Back button exists on the folder selection step (returns to prior state, preserving local folder selection)

**AC8 — Blueprint and widget location:**
**Given** the wizard UI
**When** defined in Blueprint
**Then** widget structure is in `ui/data/ui/setup-wizard.blp` with Python wiring in `ui/src/protondrive/widgets/setup_wizard.py`

**AC9 — get_status command:**
**Given** the engine receives `get_status`
**When** processing
**Then** it reads `config.yaml` and returns `get_status_result: {pairs: [{pair_id, local_path, remote_path, remote_id}], online: true}`
**And** if `config.yaml` does not exist, returns `{pairs: [], online: true}`

**AC10 — Tests:**
**Given** tests for wizard widget and engine commands
**When** run
**Then** all pass — UI: routing, IPC commands sent, wizard step navigation; Engine: `add_pair` creates pair in SQLite + YAML, `get_status` reads YAML

## Tasks / Subtasks

- [ ] **Task 1: Add js-yaml dependency to engine** (AC: #5, #9)
  - [ ] 1.1 Run `cd engine && npm install js-yaml && npm install --save-dev @types/js-yaml`
  - [ ] 1.2 Verify `package.json` and `package-lock.json` updated

- [ ] **Task 2: Engine — create config.ts for YAML config management** (AC: #5, #9)
  - [ ] 2.1 Create `engine/src/config.ts` with `ConfigManager` class:
    - Constructor: `ConfigManager(configPath?: string)` — defaults to `$XDG_CONFIG_HOME/protondrive/config.yaml` (fallback: `$HOME/.config`)
    - `readPairs(): SyncPairConfig[]` — read YAML; return `[]` if file not found; throw `ConfigError` on parse failure
    - `addPair(pair: SyncPairConfig): void` — read existing pairs, append new, write YAML atomically (write to `.tmp`, rename)
    - `removePair(pairId: string): void` — filter out pair with matching `pair_id`, write back
    - Use `js-yaml` for both read (`yaml.load`) and write (`yaml.dump`)
  - [ ] 2.2 Export `SyncPairConfig` interface: `{ pair_id: string; local_path: string; remote_path: string; remote_id: string; created_at: string }`
  - [ ] 2.3 `config.ts` imports: `js-yaml`, `node:fs`, `node:path`, `node:os`, `./errors.js` — nothing else

- [ ] **Task 3: Engine — add_pair and get_status handlers in main.ts** (AC: #5, #9)
  - [ ] 3.1 Import `ConfigManager`, `SyncPairConfig` from `./config.js`; import `StateDb` from `./state-db.js` in `main.ts`
  - [ ] 3.2 Add module-level `let stateDb: StateDb | null = null;` and `let configManager: ConfigManager | null = null;`
  - [ ] 3.3 In `main()`: init `stateDb = new StateDb()` and `configManager = new ConfigManager()` before starting server
  - [ ] 3.4 Add `add_pair` handler in `handleCommand`:
    - Extract `local_path`, `remote_path` from `command.payload`
    - Generate `pair_id = crypto.randomUUID()`
    - Call `stateDb.insertPair({ pair_id, local_path, remote_path, remote_id: '', created_at: new Date().toISOString() })`
    - Try `configManager.addPair(...)` — if fails: `stateDb.deletePair(pair_id)` then return `{error: 'config_write_failed'}`
    - On success: return `add_pair_result: { pair_id }`
  - [ ] 3.5 Add `get_status` handler in `handleCommand`:
    - Call `configManager.readPairs()`
    - Return `get_status_result: { pairs: [...], online: true }`

- [ ] **Task 4: Engine — tests for add_pair and get_status** (AC: #10)
  - [ ] 4.1 Create `engine/src/config.test.ts`:
    - Test `readPairs()` returns `[]` when file missing
    - Test `addPair()` creates file and appends correctly
    - Test `addPair()` appends to existing file without losing other pairs
    - Test `removePair()` removes correct pair
    - Test rollback: mock YAML write failure → pair deleted from SQLite (tested in integration with StateDb)
  - [ ] 4.2 Add `describe('add_pair command')` tests to `engine/src/main.test.ts`:
    - Test `add_pair` returns `pair_id` (UUID v4 format)
    - Test `add_pair` failure (mock config write error) returns `{error: "config_write_failed"}`
  - [ ] 4.3 Add `describe('get_status command')` tests:
    - Test returns `{pairs: [], online: true}` when no config file
    - Test returns correct pairs array from config

- [ ] **Task 5: UI — setup-wizard.blp** (AC: #7, #8)
  - [ ] 5.1 Create `ui/data/ui/setup-wizard.blp`:
    - Template `$ProtonDriveSetupWizard: Adw.Bin`
    - `Adw.NavigationView wizard_nav` as root child
    - Step 1 — `Adw.NavigationPage` id `"folder-selection"` title `"Choose Your Folder"`:
      - `Adw.ToolbarView` with `Adw.HeaderBar` (Back button auto-provided by `AdwNavigationView` for non-root pages)
      - Content: `GtkBox` vertical with:
        - `Adw.ActionRow local_folder_row` title `"Local Folder"` with `Gtk.Button local_folder_button` suffix (label `"Choose…"`)
        - `$ProtonDriveRemoteFolderPicker remote_folder_picker` (child widget from Story 2-3)
        - `Gtk.Button confirm_button` label `"Start Syncing"` style `suggested-action pill` (disabled until both folders selected)
    - Step 2 — `Adw.NavigationPage` id `"syncing"` title `"You're Syncing!"`:
      - Content: `AdwStatusPage` icon `"emblem-ok-symbolic"` title `"You're Syncing!"` description `"Your first sync has started."`
      - `Gtk.Button go_to_main_button` label `"Open ProtonDrive"` style `suggested-action pill`
  - [ ] 5.2 Register in `ui/meson.build`: add `custom_target('blueprint-setup-wizard', ...)` and add to gresource dependencies list
  - [ ] 5.3 Add to `ui/data/protondrive.gresource.xml`: `<file alias="ui/setup-wizard.ui">setup-wizard.ui</file>`

- [ ] **Task 6: UI — setup_wizard.py widget** (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] 6.1 Create `ui/src/protondrive/widgets/setup_wizard.py`:
    - `@Gtk.Template(resource_path=".../ui/setup-wizard.ui")`
    - `class SetupWizard(Adw.Bin)` with `__gtype_name__ = "ProtonDriveSetupWizard"`
    - `GObject.Signal('pair-created', arg_types=(str, str, str))` — emits `(pair_id, local_path, remote_path)`
    - Template children: `wizard_nav`, `local_folder_row`, `local_folder_button`, `remote_folder_picker`, `confirm_button`, `go_to_main_button`
    - `__init__`: store `_engine`, `_local_path = None`, `_remote_path = None`
    - `set_engine(engine)`: called by `window.py`; also calls `remote_folder_picker.set_engine(engine)`
    - `_on_local_folder_button_clicked(btn)`: open XDG FileChooser portal via `Xdp.Portal().open_uri_async()` or `Xdp.Portal().pick_folder()` — AC3
    - `_on_folder_chosen(portal, result)`: set `_local_path`; update `local_folder_row` subtitle; call `remote_folder_picker.set_local_folder_name(basename)`; enable `confirm_button` if both set
    - `remote_folder_picker.connect('folder-selected', self._on_remote_folder_selected)`
    - `_on_remote_folder_selected(picker, path)`: set `_remote_path = path`; enable `confirm_button` if both set
    - `_on_confirm_clicked(btn)`: send `add_pair` IPC; register handler for `add_pair_result`
    - `_on_add_pair_result(msg)`: on success, emit `pair-created(pair_id, local_path, remote_path)`; navigate to "syncing" page
    - `_on_go_to_main_clicked(btn)`: emit signal (or call callback) to tell `window.py` to switch to main view
  - [ ] 6.2 Add `SetupWizard` to `python_widget_sources` in `ui/meson.build`

- [ ] **Task 7: UI — window.py routing** (AC: #1, #2)
  - [ ] 7.1 Add `show_setup_wizard(engine)` to `window.py`:
    - Create `SetupWizard`, call `wizard.set_engine(engine)`
    - Connect `pair-created` signal to `_on_pair_created`
    - Call `self.set_content(wizard)`
  - [ ] 7.2 Update `on_session_ready`: do NOT route to main here — routing happens on `get_status_result`
  - [ ] 7.3 In `application.py` or wherever `get_status_result` is handled: if `pairs == []` → `window.show_setup_wizard(engine)`; else → `window.show_main()`
  - [ ] 7.4 `_on_pair_created(wizard, pair_id, local_path, remote_path)`: call `window.show_main()`; update sidebar with new pair

- [ ] **Task 8: UI — FileChooser portal** (AC: #3)
  - [ ] 8.1 Use `libportal` (`gi.repository import Xdp`) for XDG FileChooser portal:
    - `portal = Xdp.Portal.new()`
    - `portal.pick_folder(parent, None, Xdp.OpenFileFlags.NONE, None, self._on_folder_chosen, None)`
  - [ ] 8.2 If `libportal-python` (Xdp) is not available in test env, mock `Xdp` in `conftest.py`

- [ ] **Task 9: UI — tests for SetupWizard** (AC: #10)
  - [ ] 9.1 Create `ui/tests/test_setup_wizard.py`:
    - Test routing: `get_status_result` with `pairs=[]` triggers `show_setup_wizard`
    - Test routing: `get_status_result` with pairs → `show_main` (not wizard)
    - Test `confirm_button` disabled until both folders selected
    - Test `add_pair` IPC command sent with correct `{local_path, remote_path}`
    - Test `pair-created` signal emitted on successful `add_pair_result`

- [ ] **Task 10: Run full test suite** (AC: #10)
  - [ ] 10.1 `node --import tsx --test 'engine/src/**/*.test.ts'` — all tests pass
  - [ ] 10.2 `meson test -C builddir` — all tests pass

## Dev Notes

### New dependency: js-yaml
This story requires `js-yaml` in the engine for YAML read/write. Approve at story start:
```bash
cd engine && npm install js-yaml && npm install --save-dev @types/js-yaml
```
No alternative — the config.yaml format is in the architecture spec and requires a proper YAML library for safe parsing.

### config.yaml format (snake_case per architecture convention)
```yaml
sync_pairs:
  - pair_id: "550e8400-e29b-41d4-a716-446655440000"
    local_path: "/home/user/Documents"
    remote_path: "/Documents"
    remote_id: ""
    created_at: "2026-04-09T12:00:00.000Z"
```
`remote_id` is empty string at pair creation time — will be populated when sync runs.

### Atomic YAML write pattern
Never write directly to `config.yaml` — crash during write corrupts the file:
```typescript
const tmpPath = configPath + '.tmp';
fs.writeFileSync(tmpPath, yaml.dump(data));
fs.renameSync(tmpPath, configPath);
```

### UUID v4 via Node.js crypto
```typescript
import crypto from 'node:crypto';
const pairId = crypto.randomUUID();
```
No external UUID library needed — `node:crypto` provides `randomUUID()` since Node 15.

### `config.ts` location — flat engine/src/ structure
```
engine/src/config.ts      ← new
engine/src/config.test.ts ← new
```
Architecture requires flat `engine/src/` — no subdirectories. Do NOT create `engine/src/core/config.ts`.

### `config.ts` imports only from errors.ts internally
Like `state-db.ts`, `config.ts` may only import from `node:*`, `js-yaml`, and `./errors.js`. No circular deps.

### Rollback on YAML failure
```typescript
// In add_pair handler:
stateDb.insertPair(pair);
try {
  configManager.addPair(pair);
} catch (err) {
  stateDb.deletePair(pair.pair_id);  // rollback SQLite
  return { type: 'add_pair_result', id: command.id, payload: { error: 'config_write_failed' } };
}
return { type: 'add_pair_result', id: command.id, payload: { pair_id: pair.pair_id } };
```

### XDG portal for file chooser (AC3)
Mandatory per architecture spec (FR38) — NOT raw GTK file dialog:
```python
from gi.repository import Xdp
portal = Xdp.Portal.new()
portal.pick_folder(
    Xdp.parent_new_gtk(self.get_root()),  # parent window
    None,   # title (None = default)
    Xdp.OpenFileFlags.NONE,
    None,   # cancellable
    self._on_folder_chosen,
    None,   # user_data
)
```
In test env, mock `Xdp.Portal` in `conftest.py` (add `gi.repository.Xdp = MagicMock()` to the mock setup).

### Wizard routing — where it lives
The routing decision (wizard vs main) lives in `window.py` (or the `on_event` handler that processes `get_status_result`). The `engine.py` fires the `get_status_result` handler registered by `window.py`. Current `window.py` doesn't handle `get_status_result` — add this in Task 7.

### Wizard uses AdwNavigationView for step navigation
`AdwNavigationView` manages back navigation automatically. The "Back" button appears automatically on non-root pages. No manual Back button widget needed.

### wizard_nav.push() to advance steps
```python
# Navigate to syncing step after pair created:
next_page = Adw.NavigationPage.new_with_tag(syncing_content, "syncing", "syncing")
self.wizard_nav.push(next_page)
# Or, if defined in Blueprint, navigate by tag:
self.wizard_nav.push_by_tag("syncing")
```

### meson.build — add to dependencies list
The gresource `dependencies` list (line 56) must be updated:
```python
# Add blueprints_setup_wizard and blueprints_remote_folder_picker to the list
dependencies: [blueprints_window, blueprints_pre_auth, blueprints_auth_window,
               blueprints_account_header_bar, blueprints_settings,
               blueprints_remote_folder_picker, blueprints_setup_wizard],
```

### meson.build — add Python widget sources
```python
python_widget_sources = [
  ...
  'src/protondrive/widgets/remote_folder_picker.py',  # Story 2-3
  'src/protondrive/widgets/setup_wizard.py',           # This story
]
```

### ConfigManager XDG path
```typescript
function getConfigPath(): string {
  const xdgConfig = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'protondrive', 'config.yaml');
}
```

### stateDb and configManager initialization in main()
```typescript
async function main(): Promise<void> {
  stateDb = new StateDb();         // opens DB, runs migrations
  configManager = new ConfigManager();
  // ... start server
}
```
Both must be initialized before `server.start()` so commands can be handled immediately after `ready`.

### References
- [Source: engine/src/state-db.ts] — StateDb.insertPair(), deletePair() for rollback
- [Source: engine/src/errors.ts] — ConfigError for YAML parse failures
- [Source: engine/src/main.ts] — extend handleCommand with add_pair and get_status
- [Source: ui/src/protondrive/widgets/remote_folder_picker.py] — RemoteFolderPicker (Story 2-3)
- [Source: ui/src/protondrive/window.py] — show_main(), set_content() patterns
- [Source: ui/src/protondrive/engine.py] — send_command, on_event patterns
- [Source: ui/data/ui/settings.blp] — Blueprint syntax reference
- [Source: ui/meson.build] — FULL FILE — update dependencies list and python_widget_sources
- [Source: _bmad-output/planning-artifacts/architecture.md#IPC Protocol] — add_pair, get_status formats
- [Source: _bmad-output/planning-artifacts/architecture.md#Cross-Cutting Rules] — pair_id ownership, cold-start
- [Source: _bmad-output/implementation-artifacts/2-1-sqlite-state-database-and-schema.md] — StateDb API

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `engine/package.json` — add js-yaml dependency
- `engine/package-lock.json` — updated by npm install
- `engine/src/config.ts` — new: ConfigManager for YAML config read/write
- `engine/src/config.test.ts` — new: ConfigManager unit tests
- `engine/src/main.ts` — add add_pair, get_status handlers; init stateDb and configManager
- `engine/src/main.test.ts` — add add_pair and get_status command tests
- `ui/data/ui/setup-wizard.blp` — new: SetupWizard Blueprint
- `ui/meson.build` — add blueprint-setup-wizard, blueprint-remote-folder-picker to dependencies; update python_widget_sources
- `ui/data/protondrive.gresource.xml` — add setup-wizard.ui and remote-folder-picker.ui
- `ui/src/protondrive/widgets/setup_wizard.py` — new: SetupWizard widget
- `ui/src/protondrive/window.py` — add show_setup_wizard, get_status_result routing
- `ui/tests/test_setup_wizard.py` — new: SetupWizard unit tests

## Change Log

- 2026-04-09: Story 2.4 created — Setup Wizard & First Pair Creation
