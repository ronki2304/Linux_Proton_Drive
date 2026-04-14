# Epic 2: First Sync Pair & File Sync

User can set up their first sync pair via the setup wizard, see files sync in both directions with live progress (file count, bytes, ETA), and see "Last synced X seconds ago." Window state persists between sessions. The app builds and runs as a Flatpak from this epic onwards.

## Story 2.1: SQLite State Database & Schema

As a developer,
I want the sync engine to have a SQLite state database with WAL mode, schema versioning, and sync pair/state tables,
So that sync state persists across restarts and survives crashes.

**Acceptance Criteria:**

**Given** the engine starts for the first time
**When** `state-db.ts` initializes
**Then** it creates the database at `$XDG_DATA_HOME/protondrive/state.db` (creating the directory with `mkdir -p` if needed)
**And** `PRAGMA journal_mode=WAL` is set
**And** `PRAGMA synchronous=NORMAL` is set

**Given** the database is initialized
**When** querying `PRAGMA journal_mode`
**Then** it returns `wal`

**Given** the database schema
**When** inspecting tables
**Then** `sync_pair` table exists with columns: `pair_id` (TEXT PRIMARY KEY), `local_path` (TEXT), `remote_path` (TEXT), `remote_id` (TEXT), `created_at` (TEXT ISO 8601)
**And** `sync_state` table exists with columns: `pair_id` (TEXT), `relative_path` (TEXT), `local_mtime` (TEXT ISO 8601), `remote_mtime` (TEXT ISO 8601), `content_hash` (TEXT nullable), PRIMARY KEY (`pair_id`, `relative_path`)
**And** `change_queue` table exists with columns: `id` (INTEGER PRIMARY KEY), `pair_id` (TEXT), `relative_path` (TEXT), `change_type` (TEXT), `queued_at` (TEXT ISO 8601)

**Given** schema versioning
**When** querying `PRAGMA user_version`
**Then** it returns the current schema version number
**And** ordered integer migrations run automatically on startup if `user_version` is behind

**Given** unit tests for `state-db.ts`
**When** running `node --import tsx --test engine/src/state-db.test.ts`
**Then** each test uses a fresh `:memory:` database
**And** tests verify WAL mode, schema creation, migration ordering, and CRUD operations

---

## Story 2.2: SDK DriveClient Wrapper

As a developer,
I want a DriveClient wrapper that encapsulates all ProtonDrive SDK interactions behind a clean interface,
So that the rest of the engine is insulated from SDK version churn and breaking changes.

**Acceptance Criteria:**

**Given** `engine/src/sdk.ts`
**When** inspecting its imports
**Then** it is the sole file importing `@protontech/drive-sdk` and `openpgp`
**And** a boundary comment at the top enforces this rule
**And** `openpgp` is imported as the full bundle (never `openpgp/lightweight`)

**Given** the `DriveClient` class
**When** calling `listRemoteFolders(parentId: string | null)`
**Then** `parentId: null` returns root-level folders
**And** passing a folder `id` returns that folder's children (lazy expansion)
**And** `MaybeNode` return values are always unwrapped — `.ok` checked before accessing `.value`

**Given** the `DriveClient` class
**When** calling upload or download methods
**Then** `Uint8Array<ArrayBufferLike>` ↔ SDK `Uint8Array<ArrayBuffer>` casts are applied at the boundary
**And** all methods use `async/await` — no raw `.then()/.catch()` chains

**Given** any SDK method returns an error
**When** the error propagates
**Then** it is wrapped in a typed `SyncError` or `NetworkError` — never a raw `Error` or plain string

**Given** unit tests for `sdk.ts`
**When** running `node --import tsx --test engine/src/sdk.test.ts`
**Then** tests mock the SDK at the package boundary and verify DriveClient behaviour

---

## Story 2.3: Remote Folder Picker Component

As a user,
I want to select a ProtonDrive folder as the remote side of my sync pair,
So that I can choose where my files sync to in ProtonDrive.

**Acceptance Criteria:**

**Given** the remote folder picker dialog opens
**When** it renders
**Then** a text field is displayed pre-filled with the local folder name (e.g., if local is `~/Documents`, remote defaults to `/Documents`)

**Given** the user types in the text field
**When** characters are entered
**Then** top-level ProtonDrive folders are fetched as autocomplete suggestions via `list_remote_folders` IPC command (one SDK call, result cached for the session lifetime of the dialog)

**Given** the user wants a nested path
**When** they type `/Work/Projects/2026`
**Then** manual path entry is accepted without autocomplete validation
**And** a "Browse folders..." link is visible but non-functional (deferred to V1)

**Given** the remote folder picker
**When** navigating via keyboard only
**Then** Tab moves between text field and autocomplete suggestions
**And** Enter selects the highlighted suggestion
**And** Escape closes the autocomplete dropdown

---

## Story 2.4: Setup Wizard & First Pair Creation

As a new user,
I want a guided 3-step wizard to set up my first sync pair,
So that I can start syncing without confusion or documentation.

**Acceptance Criteria:**

**Given** the app launches with a valid token but no sync pairs configured
**When** routing logic executes (FR13)
**Then** the setup wizard opens at the folder selection step (not the auth step — auth already complete)

**Given** the app was closed after auth but before configuring a sync pair (interrupted wizard)
**When** the app relaunches
**Then** the wizard resumes at the folder selection step — it does not re-run auth or skip to the main window

**Given** the wizard is at the "Choose Your Folder" step
**When** the user clicks the local folder selector
**Then** the XDG File Chooser portal (`org.freedesktop.portal.FileChooser`) opens — not a raw GTK file dialog (FR38)
**And** the user selects a local folder

**Given** a local folder is selected
**When** the remote folder picker is displayed
**Then** it is the RemoteFolderPicker from Story 2.3

**Given** both local and remote folders are selected
**When** the user confirms the pair
**Then** the UI sends an `add_pair` IPC command with `{local_path, remote_path}`
**And** the engine generates a `pair_id` (UUID v4), stores it in SQLite, and returns it in `add_pair_result`
**And** the pair is also written to `$XDG_CONFIG_HOME/protondrive/config.yaml`
**And** YAML is the authoritative source for pair existence; SQLite is the state cache — a pair present in YAML but absent from SQLite triggers a fresh full sync (cold-start); if the SQLite write succeeds but YAML write fails, the pair is not considered created

**Given** the pair is created
**When** the wizard transitions to "You're Syncing"
**Then** the main window displays with the new pair in the sidebar and first sync begins immediately

**Given** the wizard steps
**When** inspecting navigation
**Then** no Back button exists on the auth step (browser session, server-side state)
**And** a Back button exists on the folder selection step (UX-DR4)

**Given** the wizard UI
**When** defined in Blueprint
**Then** all widget structure is in `ui/data/ui/setup-wizard.blp` with Python wiring in `ui/src/protondrive/widgets/setup_wizard.py`

---

## Story 2.5: Sync Engine Core - Two-Way Sync

As a user,
I want my files to sync in both directions continuously while the app is open,
So that my local files and ProtonDrive stay in sync automatically.

**Acceptance Criteria:**

**Given** a sync pair is active
**When** a sync cycle runs
**Then** the engine compares local file mtimes against stored `sync_state` records
**And** compares remote file mtimes (fetched via SDK) against stored remote mtimes
**And** files changed only locally are uploaded; files changed only remotely are downloaded

**Given** a file is downloaded from ProtonDrive
**When** writing to disk
**Then** the file is written to `<path>.protondrive-tmp-<timestamp>` first
**And** on successful completion, `rename()` moves it to the final destination path (NFR12)
**And** on failure, the tmp file is `unlink()`ed — no partial files at destination

**Given** a sync operation completes for a file
**When** the state is recorded
**Then** both local mtime and remote mtime are written to SQLite `sync_state` before the operation is considered complete (NFR15)
**And** no sync state exists only in memory

**Given** multiple files need syncing
**When** the sync engine processes them
**Then** concurrent file transfers are capped at a default maximum of 3 (NFR4)

**Given** a pair is present in YAML config but absent from SQLite (cold-start)
**When** the engine starts
**Then** it treats this as a fresh full sync — no crash, no error

**Given** the sync engine emits progress
**When** files are transferring
**Then** `sync_progress` push events are sent with `{pair_id, files_done, files_total, bytes_done, bytes_total}`
**And** `sync_complete` push event is sent with `{pair_id, timestamp}` when a cycle finishes

**Given** the engine's `console.log()` or `console.error()`
**When** in production mode
**Then** stdout and stderr are routed to `/dev/null` — `console.log()` would corrupt IPC framing

---

## Story 2.6: inotify File Watcher & Change Detection

As a user,
I want the app to detect file changes in my synced folders automatically,
So that new or modified files sync without me manually triggering anything.

**Acceptance Criteria:**

**Given** a sync pair is active
**When** the watcher initializes
**Then** inotify watches are set up per subdirectory within the synced folder tree
**And** initialization runs asynchronously — does not block the GTK main loop (NFR3a)
**And** the StatusFooterBar shows "Initializing file watcher..." during setup

**Given** a file is modified in a watched directory
**When** inotify fires an event
**Then** the change is debounced and added to the sync queue within 5 seconds (NFR3)

**Given** the system runs out of inotify watches (`ENOSPC`)
**When** the watcher encounters the limit
**Then** a visible error is surfaced to the user: "Too many files to watch — close other apps or increase system inotify limit"
**And** the watcher does not crash — it continues watching the directories it has already registered

**Given** unit tests for `watcher.ts`
**When** running `node --import tsx --test engine/src/watcher.test.ts`
**Then** tests verify debouncing behaviour, event aggregation, and ENOSPC handling

---

## Story 2.7: SyncPairRow & StatusFooterBar Components

As a user,
I want to see the sync status of each pair in the sidebar and a global status bar at the bottom,
So that I know what's happening at a glance without clicking into anything.

**Acceptance Criteria:**

**Given** a sync pair exists
**When** the sidebar renders
**Then** a `SyncPairRow` is displayed with: animated status dot (8px circle) + pair name (13px) + optional status text (10px, secondary colour)
**And** states implemented: synced (green dot), syncing (teal dot with CSS `@keyframes` pulse animation)
**And** the row is a `GtkListBoxRow` subclass with custom `GtkBox` layout

**Given** the main window renders
**When** the `StatusFooterBar` is visible
**Then** it is a persistent bar pinned at the bottom of the window (36px height)
**And** states implemented: "All synced" (green dot), "Syncing N files in [pair]..." (teal dot, animated)
**And** priority logic is enforced: most urgent state always shown (for now: Syncing > All synced)

**Given** the `SyncPairRow` status changes
**When** a screen reader reads the sidebar
**Then** accessible labels announce: "Documents — synced" or "Documents — syncing" — not colour alone

**Given** the `StatusFooterBar` state changes
**When** AT-SPI2 is queried
**Then** state changes are announced with `GTK_ACCESSIBLE_STATE_LIVE` (polite, not assertive)

**Given** both components
**When** using Libadwaita colour tokens
**Then** status dots use Libadwaita semantic tokens (`@success_color` for synced) — no hardcoded colours
**And** the teal accent is used only for the syncing state

**Given** all widget structure
**When** inspecting implementation
**Then** structure is in `ui/data/ui/sync-pair-row.blp` and Python wiring in `ui/src/protondrive/widgets/sync_pair_row.py`
**And** no widget file imports from another widget file — coordination through `window.py`

---

## Story 2.8: SyncProgressCard & Detail Panel

As a user,
I want to see detailed sync progress and stats for the selected pair,
So that I know exactly what's happening during first sync and ongoing operations.

**Acceptance Criteria:**

**Given** a sync pair is selected in the sidebar
**When** the detail panel renders
**Then** it shows: pair name, local path, remote path, last synced timestamp, file count, total size, status

**Given** no sync pair is selected
**When** the detail panel renders
**Then** an `AdwStatusPage` is displayed: "Select a sync pair to see details" (UX-DR16)

**Given** zero sync pairs exist (post-auth, pre-wizard completion)
**When** the detail area renders
**Then** an `AdwStatusPage` with teal CTA "Add your first sync pair to start syncing" is displayed (UX-DR16)

**Given** a sync is actively running for the selected pair
**When** the `SyncProgressCard` renders
**Then** it replaces the normal stats cards in the detail panel
**And** initially shows an indeterminate `GtkProgressBar` + "Counting files..."
**And** once file count is known, switches to determinate bar + file count label + bytes transferred/total label + ETA label (FR15)
**And** after sync completes, transitions back to normal detail stats after 2 seconds

**Given** `sync_progress` IPC events arrive
**When** the UI processes them
**Then** the progress card updates in real time with `files_done/files_total` and `bytes_done/bytes_total`
**And** UI interactions remain responsive within 200ms during progress updates (NFR2)

**Given** `sync_complete` IPC events arrive
**When** the UI processes them
**Then** the detail panel shows "Last synced X seconds ago" with the timestamp from the event (FR18, FR19)

---

## Story 2.9: Window State Persistence

As a user,
I want the app to remember its window size and position between sessions,
So that I don't have to resize it every time I open it.

**Acceptance Criteria:**

**Given** the user resizes or moves the app window
**When** the window is closed
**Then** the window geometry (width, height, position, maximized state) is saved to `$XDG_STATE_HOME/protondrive/` (creating the directory if needed)

**Given** the app launches
**When** a saved window state exists
**Then** the window is restored to the saved geometry
**And** if no saved state exists, the default size of 780x520px is used

**Given** the window state storage
**When** inspecting the implementation
**Then** window geometry is stored via `Gio.Settings` or a plain file — not in SQLite
**And** one `Gio.Settings` instance is held by the `Application` class and passed to widgets via constructor (never per-widget)

---

## Story 2.10: Flatpak Build Validation

As a developer,
I want to verify the app builds and runs correctly as a Flatpak,
So that sandbox issues are caught early and not discovered at Flathub submission time.

**Acceptance Criteria:**

**Given** the Flatpak manifest at `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** `flatpak-builder --user --install builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` is run
**Then** the build completes successfully

**Given** the Flatpak build
**When** inspecting the manifest
**Then** Node.js 22 is bundled via `org.freedesktop.Sdk.Extension.node22`
**And** `better-sqlite3` native addon is built from source (not pre-built binary)
**And** GNOME runtime is `org.gnome.Platform//50`

**Given** the built Flatpak
**When** launched via `flatpak run io.github.ronki2304.ProtonDriveLinuxClient`
**Then** the app starts, engine spawns within the sandbox, IPC connects, and the main window appears
**And** the engine can create the SQLite database at the sandbox-mapped `$XDG_DATA_HOME` path
**And** inotify watches work on folders accessible via `--filesystem=home`

**Given** the Flatpak finish-args
**When** inspecting permissions
**Then** `--share=network` is declared
**And** `--filesystem=home` is declared (inotify requires direct filesystem access)
**And** Secret portal access is declared for credential storage

---

## Story 2.11: Post-Auth Key Password Derivation and Drive Crypto Unlock

_Added via Sprint Change Proposal CC-2026-04-11: browser cookie auth captures AccessToken but not the
bcrypt-derived keyPassword needed to decrypt the user's OpenPGP private keys. Without it,
`getPrivateKeys()` returns `[]` and all Proton Drive share key decryption fails._

As a user who has signed in via the embedded browser,
I want the app to derive my Proton cryptographic key password from my login password,
So that the sync engine can decrypt my Proton Drive share keys and actually sync files.

**Acceptance Criteria:**

**Given** a valid AccessToken and UID stored from browser auth
**When** the engine receives `token_refresh` without a `key_password`
**Then** the engine emits `key_unlock_required` and the UI shows a native "Unlock Sync" password dialog

**Given** the user enters their Proton password in the unlock dialog
**When** they press "Unlock"
**Then** the engine fetches the bcrypt salt via `GET /core/v4/auth/info`
**And** derives `keyPassword = bcrypt(password, salt)`
**And** fetches and decrypts the user's private keys via `GET /core/v4/keys/user`
**And** `ProtonAccountAdapter.getPrivateKeys()` returns the decrypted keys
**And** subsequent `listRemoteFolders` and sync operations succeed

**Given** successful key unlock
**When** the session is established
**Then** `keyPassword` (not the raw password) is stored in the OS keyring
**And** on the next launch, `token_refresh` includes the stored `keyPassword` and keys are decrypted silently with no dialog shown

**Given** any error path in this story
**When** writing logs or IPC events
**Then** the raw user password is never written anywhere (logged, transmitted, or stored)

---
