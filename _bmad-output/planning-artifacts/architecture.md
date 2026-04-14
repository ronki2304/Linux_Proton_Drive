---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-04-07'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
  - _bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient.md
  - _bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient-distillate.md
  - _bmad-output/planning-artifacts/research/technical-linux-packaging-formats-research-2026-04-01.md
  - _bmad-output/planning-artifacts/lessons-learned-cli-iteration.md
  - _bmad-output/project-context.md
  - docs/project-overview.md
  - docs/source-tree-analysis.md
  - docs/component-inventory.md
  - docs/development-guide.md
  - docs/diagrams.md
workflowType: 'architecture'
project_name: 'ProtonDrive-LinuxClient'
user_name: 'Jeremy'
date: '2026-04-06'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
GTK4/Libadwaita desktop app delivering two-way continuous folder sync while the app is open. Core functional areas: embedded WebKitGTK auth over localhost (CAPTCHA + 2FA handled by the browser itself), sync pair management (add/remove, multi-pair), first-sync progress display, live sync status panel, conflict copy creation with in-app notification and log UI, token expiry modal with queued-change replay, offline change queuing with automatic reconnect, window state persistence, Flatpak packaging with AppStream/metainfo and desktop file.

**Non-Functional Requirements:**
- Security: session token never in logs/stdout/stderr; credentials via libsecret Secret portal; localhost auth server bound to 127.0.0.1 only, ephemeral port, closed immediately after callback; crash output sanitised
- Privacy: no telemetry, no analytics, no network I/O outside SDK; SQLite state DB in plaintext (documented); updates via Flathub OSTree only
- Flatpak compliance: static `--filesystem` for inotify, Secret portal for credentials, Background Portal for V1 autostart; App ID propagates to all manifests and XDG paths — must be decided before implementation
- SDK isolation: wrapper layer insulates UI from SDK version churn; openpgp boundary encapsulated in SDK layer; version pinned until V1 ships
- Reliability: conflict copy on any concurrent edit, no silent overwrite, ever; offline queue preserved across restarts; atomic file writes

**Scale & Complexity:**
- Primary domain: Linux desktop application (GTK4/Libadwaita) + cloud sync
- Complexity level: medium-high — constrained rather than at scale; sharp Flatpak/inotify/WebKitGTK constraints are the hard problems
- Estimated architectural components: 5 (GTK4 UI process, Sync Engine subprocess, Unix socket IPC layer, SDK integrated in engine, libsecret credential store)

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Flatpak App ID: `io.github.ronki2304.ProtonDriveLinuxClient`
- GNOME runtime version: `org.gnome.Platform//50`
- Sync engine process lifecycle: `GLib.spawn_async` (MVP) → systemd Background Portal (V1)
- IPC protocol: 4-byte length-prefixed JSON over Unix socket

**Important Decisions (Shape Architecture):**
- Error propagation model: push events (non-fatal) / socket close (fatal)
- Testing strategy per layer
- Node.js bundling approach
- Credential storage model

**Deferred Decisions (Post-MVP):**
- Background daemon / systemd service (V1)
- System tray integration (V1)
- Bandwidth throttling (V1+)
- E2E automated test suite (post-MVP)

---

### Flatpak Identity

- **App ID:** `io.github.ronki2304.ProtonDriveLinuxClient` — permanent, never changes post-Flathub submission
- **AppStream display name:** `ProtonDrive Linux Client`
- **AppStream summary:** `Unofficial open-source sync client for ProtonDrive on Linux`
- **IPC socket path:** `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock` — created automatically by Flatpak sandbox, no manifest permission required
- **XDG paths:**
  - Config: `$XDG_CONFIG_HOME/protondrive/config.yaml`
  - State DB: `$XDG_DATA_HOME/protondrive/state.db`
  - Window state: `$XDG_STATE_HOME/protondrive/`
  - Engine logs (debug only): `$XDG_CACHE_HOME/protondrive/engine.log`

---

### Platform & Runtime

- **GNOME runtime:** `org.gnome.Platform//50` + `org.gnome.Sdk//50`
- **WebKitGTK:** 6.0 — import as `gi.repository.WebKit` (not the deprecated `WebKit2`)
- **Libadwaita:** 1.8 (ships with GNOME 50)
- **Bun:** compiled to a self-contained binary via `bun build --compile` — Bun runtime + `bun:sqlite` embedded in the output binary; no SDK extension or runtime dependency needed
  ```yaml
  # Engine module — TypeScript/Bun compiled to self-contained binary
  - name: protondrive-engine
    buildsystem: simple
    build-options:
      build-args:
        - --share=network
    build-commands:
      - bun install --frozen-lockfile
      - bun build --compile src/main.ts --outfile=dist/engine
      - mkdir -p /app/lib/protondrive-engine/dist
      - install -Dm755 dist/engine /app/lib/protondrive-engine/dist/engine
  ```
- **Joint release gate:** GNOME runtime 50 + `@protontech/drive-sdk` v0.14.3 must be validated together before each release on the tested matrix: Fedora 43, Ubuntu 24/25, Bazzite, Arch

---

### Sync Engine Process Lifecycle

**MVP (foreground-only):**
1. UI calls `GLib.spawn_async()` to start the Node engine process
2. UI polls `Gio.SocketClient` with exponential backoff (not a fixed timeout) for up to 10 seconds
3. Engine starts, creates the Unix socket, sends `ready` event
4. UI receives `ready`, validates `protocol_version` — only then shows main window or wizard
5. Engine crash detected via socket close → UI shows error banner + restart button
6. UI close → sends `shutdown` command → waits for clean engine exit → kills if timeout

**V1 (background daemon):**
- Engine runs as systemd user service registered via Background Portal (one-time user approval)
- UI connects to persistent socket on launch; engine survives UI restarts
- Architecture is identical — only process management changes, IPC contract unchanged

**Missing `node` binary:** UI spawn code emits a clear startup error if `node` is not found on `$PATH` (development) or missing from bundle (Flatpak). Never a cryptic socket timeout.

---

### IPC Protocol

**Wire format:** 4-byte big-endian length prefix + JSON payload

**Commands (UI → Engine):** All commands carry a unique `id` field (UUID v4). Responses use the same `id` with a `_result` suffix. `token_refresh` and `shutdown` respond via push events or socket close — no `_result`.

| Command | Payload | Response |
|---|---|---|
| `add_pair` | `{local_path, remote_path}` | `add_pair_result` → `{pair_id}` |
| `remove_pair` | `{pair_id}` | `remove_pair_result` |
| `get_status` | — | `get_status_result` → `{pairs[], online}` |
| `list_remote_folders` | `{parent_id: string\|null}` | `list_remote_folders_result` → `{folders[]}` |
| `token_refresh` | `{token}` | push `session_ready` or `token_expired` |
| `shutdown` | — | socket close |

`get_status_result` payload rebuilds full UI state after engine restart — called on every `ready` event.
`list_remote_folders` is lazy: `parent_id: null` = root, expand by passing folder `id`. UI fetches on-demand as user expands nodes in the remote folder picker.

**Push Events (Engine → UI, no `id`):**

| Event | Payload | Purpose |
|---|---|---|
| `ready` | `{version: string, protocol_version: number}` | Engine initialised — UI validates protocol_version before proceeding |
| `session_ready` | `{display_name, email, storage_used, storage_total, plan}` | Token validated + account info fetched — UI transitions to main window; also fires on re-auth success |
| `sync_progress` | `{pair_id, files_done, files_total, bytes_done, bytes_total}` | Live transfer progress |
| `sync_complete` | `{pair_id, timestamp}` | Pair finished a sync cycle |
| `conflict_detected` | `{pair_id, local_path, conflict_copy_path}` | Conflict copy created |
| `token_expired` | `{queued_changes}` | Session token rejected by SDK |
| `offline` | — | Network lost |
| `online` | — | Network restored |
| `error` | `{code, message, pair_id?}` | Non-fatal error surfaced to UI |
| `rate_limited` | `{resume_in_seconds}` | SDK returned 429 |

---

### Error Propagation

- **Non-fatal errors:** Engine pushes `error` event → UI shows inline error on affected sync pair card; engine keeps running
- **Fatal errors:** Engine exits with non-zero code → UI detects socket close → shows app-level error banner with restart button
- **Engine never swallows errors.** UI never polls for error state — it gets told.
- **Engine stderr:** `/dev/null` in production. Debug mode enabled via env var flag (`PROTONDRIVE_DEBUG=1`) — writes to `$XDG_CACHE_HOME/protondrive/engine.log` with size cap. No tokens, file paths, or file content ever written to logs.

---

### Credential Storage

**libsecret (GNOME Keyring) stores one thing only: the session token string.**

| Data | Storage | Sensitive |
|---|---|---|
| Session token | libsecret Secret portal | Yes — never written to disk in plaintext |
| Sync pair config | YAML at `$XDG_CONFIG_HOME/protondrive/config.yaml` | No |
| Sync state (mtimes, hashes) | SQLite at `$XDG_DATA_HOME/protondrive/state.db` | No — documented in README |
| Conflict log | SQLite (same DB) | No |
| Window geometry | `$XDG_STATE_HOME/protondrive/` | No |
| Engine logs (debug only) | `$XDG_CACHE_HOME/protondrive/engine.log` | No — token explicitly excluded |

**Token flow:** libsecret → Python UI → IPC socket (`token_refresh` command) → Node sync engine → SDK. The sync engine never reads libsecret directly.

---

### Testing Strategy

**Python UI layer (`pytest`):**
- Unit tests for logic: IPC message parsing, auth flow state machine, error banner logic
- No live network, no real sync engine — mock the IPC socket
- Widget tests via Xvfb (optional, CI-configurable)

**Sync engine (`node:test`):**
- Unit tests co-located alongside source (`*.test.ts`) — mock `DriveClient` at SDK wrapper boundary
- Integration tests in `__integration__/` — require pre-authenticated session token; manual-trigger only

**Integration test prerequisite (documented in `CONTRIBUTING.md`):**
```bash
# 1. Launch app and authenticate via UI
flatpak run io.github.ronki2304.ProtonDriveLinuxClient
# 2. Export token from libsecret
secret-tool lookup app ProtonDriveLinuxClient
# 3. Set env vars
export PROTON_TEST_TOKEN=<token>
export PROTON_TEST_FOLDER=test-sync-$(date +%s)
# 4. Run integration tests
node --test src/__integration__/
```

Token expires without warning (CAPTCHA and 2FA both block automation) — repeat from step 1 when tests start failing with 401.

**E2E:** Deferred to post-MVP. Manual validation on target distros before each release.

---

## Implementation Patterns & Consistency Rules

### Naming Conventions

| Context | Convention | Example |
|---|---|---|
| Python files | `snake_case.py` | `sync_panel.py`, `auth_window.py` |
| Python functions/variables | `snake_case` | `get_token()`, `pair_id` |
| Python classes | `PascalCase` | `SyncPanel`, `AuthWindow` |
| GTK4 signal names | `kebab-case` (GTK convention) | `clicked`, `notify::text` |
| Blueprint UI files | `kebab-case.blp` | `main-window.blp`, `sync-pair-row.blp` |
| GSettings keys | `kebab-case` | `window-width`, `last-sync-time` |
| TypeScript files | `kebab-case.ts` | `drive-client.ts`, `sync-engine.ts` |
| TypeScript functions/variables | `camelCase` | `getToken()`, `pairId` |
| TypeScript classes/interfaces | `PascalCase` | `DriveClient`, `SyncPair` |
| SQLite tables | singular `snake_case` | `sync_pair`, `sync_state` |
| SQLite columns | `snake_case` | `pair_id`, `last_sync_mtime` |
| IPC event/command names | `snake_case` | `sync_progress`, `add_pair` |
| IPC payload fields | `snake_case` | `pair_id`, `files_done`, `local_path` |
| Config YAML keys | `snake_case` | `sync_pairs`, `remote_path` |
| Timestamps | ISO 8601 | `2026-04-06T14:30:00.000Z` |

### Project Structure

```
ProtonDriveLinuxClient/
├── ui/                          ← Python GTK4 UI (Meson project)
│   ├── src/protondrive/         ← Python package
│   ├── data/                    ← Blueprint .blp, GSettings schemas, icons
│   ├── tests/                   ← pytest tests
│   └── meson.build
├── engine/                      ← TypeScript/Node sync engine (npm project)
│   ├── src/
│   │   ├── sdk/                 ← DriveClient wrapper (only SDK imports here)
│   │   ├── core/                ← sync logic, conflict, state-db
│   │   ├── ipc/                 ← Unix socket server, message handling
│   │   └── __integration__/     ← integration tests
│   ├── package.json
│   └── tsconfig.json
├── flatpak/                     ← manifest, AppStream metainfo, desktop file
└── .github/workflows/           ← CI/CD
```

### Mandatory Patterns (breaks the app if violated)

#### Auth Flow Ordering

Server starts before WebView navigates — race condition otherwise:
```python
self._auth_server = AuthCallbackServer()   # binds socket first
port = self._auth_server.get_port()
self._auth_server.start_async(self._on_token_received)
self.webview.load_uri(f'http://127.0.0.1:{port}/auth-start')  # THEN navigate
```

#### WebView Cleanup After Auth

WebView holds network session and cached credentials — must be explicitly destroyed:
```python
def _on_token_received(self, token: str):
    self._auth_server.stop()
    self.webview.try_close()   # triggers WebKit internal cleanup
    self.webview = None        # release GObject reference
    self._transition_to_main_ui(token)
```

#### Signal Connections — Explicit Method Reference Only

Lambda connections cause reference cycles and memory leaks in long-running GTK apps:
```python
# ✅ correct
self.button.connect('clicked', self._on_button_clicked)
# ❌ forbidden
self.button.connect('clicked', lambda btn: self._on_button_clicked(btn))
```

#### Blueprint Rule — All Widget Structure in .blp

Python wires signals and updates state only — never constructs widget trees:
```python
# ✅ correct
@Gtk.Template(resource_path='/io/github/ronki2304/ProtonDriveLinuxClient/sync-panel.ui')
class SyncPanel(Adw.Bin):
    __gtype_name__ = 'SyncPanel'
    status_label = Gtk.Template.Child()

# ❌ forbidden
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
box.append(Gtk.Label(label='Status'))
```

#### IPC Reads via Gio.DataInputStream Only

Python's `socket` module blocks the GTK main loop — never use it for IPC:
```python
# ✅ correct — non-blocking, integrates with GTK main loop
stream = Gio.DataInputStream.new(connection.get_input_stream())
stream.read_bytes_async(4, GLib.PRIORITY_DEFAULT, None, self._on_length_received)

# ❌ forbidden — blocks UI
data = socket.recv(4)
```

#### MessageReader Class for IPC Framing

Never parse raw socket chunks — TCP fragmentation means one `data` event ≠ one message:
```typescript
// ✅ correct — accumulate buffer until length prefix satisfied
class MessageReader {
    private buffer = Buffer.alloc(0);
    feed(chunk: Buffer): ParsedMessage[] { /* accumulate, parse complete messages */ }
}

// ❌ forbidden — breaks on fragmentation
socket.on('data', (chunk) => { const msg = JSON.parse(chunk.toString()); });
```

#### Engine Enforces Single Connection

Second connection rejected immediately — prevents duplicate event fan-out:
```typescript
if (this.activeConnection !== null) {
    socket.write(JSON.stringify({type: 'error', payload: {code: 'ALREADY_CONNECTED'}}));
    socket.destroy();
    return;
}
```

#### UI Queues Commands Before `ready`

Commands sent before `ready` event are buffered and flushed on receipt — never dropped:
```python
def send_command(self, cmd):
    if not self._engine_ready:
        self._pending_commands.append(cmd)
    else:
        self._write_message(cmd)
```

#### SQLite WAL Mode — Mandatory in StateDB.init()

Prevents DB corruption on engine crash mid-write:
```typescript
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
```

#### SQLite Schema Versioning

`PRAGMA user_version` for version tracking — ordered integer migrations, never destructive (add columns only in v1):
```typescript
const {user_version} = db.query('PRAGMA user_version').get() as {user_version: number};
if (user_version < CURRENT_SCHEMA_VERSION) {
    runMigrations(db, user_version, CURRENT_SCHEMA_VERSION);
}
db.run(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
```

#### Engine Re-reads SQLite on Every Restart

UI re-sends `get_status` on every `ready` event — not just the first:
```python
def _on_engine_ready(self, payload):
    self._engine_ready = True
    self._flush_pending_commands()
    self.send_command({'type': 'get_status'})  # always, not just first launch
```

### Cross-Cutting Rules

**`pair_id` ownership:** UUID v4, generated by engine at `add_pair` time, stored in SQLite, returned in response. UI never generates `pair_id` — only receives and echoes it.

**Cold-start:** Pair present in YAML config but absent from SQLite = fresh full sync. Engine never crashes on missing DB state.

**GSettings:** One `Gio.Settings` instance per app, held by Application class, passed to widgets via constructor. Never instantiated per-widget.

**ENGINE_PATH resolution:**
```python
def get_engine_path() -> tuple[str, ...]:
    """Return launcher argv for the sync engine in the current environment.

    Flatpak (Option A): compiled self-contained binary — returns a 1-tuple.
    Dev: bun runtime + source entry point — returns a 2-tuple.
    """
    if os.environ.get("FLATPAK_ID"):
        return ("/app/lib/protondrive-engine/dist/engine",)

    bun = GLib.find_program_in_path("bun")
    if bun is None:
        raise EngineNotFoundError(
            "Bun runtime not found on PATH. Please install Bun 1.3+."
        )

    engine_script = str(
        Path(__file__).resolve().parent.parent.parent.parent
        / "engine"
        / "src"
        / "main.ts"
    )
    return (bun, engine_script)
```

**TypeScript required tsconfig flags:**
```json
{"strict": true, "noUncheckedIndexedAccess": true, "verbatimModuleSyntax": true,
 "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "types": ["bun-types"]}
```

**SDK boundary:** All `@protontech/drive-sdk` imports confined to `engine/src/sdk/`. No other engine code imports the SDK directly.

### Advisory Patterns (good practice, not enforced)

- **WebKit navigation policy:** Use judgment to handle external link navigation — avoid over-restrictive allowlists that break on Proton domain changes
- **GObject property bindings:** Use `@GObject.Property` where it simplifies widget-model binding; not required for all state management

### GTK4 Widget Conventions

| Scenario | Widget |
|---|---|
| Empty state (no pairs, offline, error) | `AdwStatusPage` |
| Transient notification (sync complete, conflict) | `AdwToastOverlay` |
| Re-auth modal, destructive confirmations | `AdwDialog` |
| Loading state | `Gtk.Spinner` |
| Never block GTK main loop | All I/O via `Gio` async or `GLib.idle_add()` |

---

## Project Structure & Boundaries

### Design Principle: Modular Monolith

Files that are always edited together are merged. Files that are edited independently stay split. Screens with their own Blueprint file stay split. The unit of isolation is the module, not the class.

Merge rule: **cohesive concern → one file.** Split rule: **independently evolving concern → own file.**

### Complete Project Tree

```
ProtonDriveLinuxClient/
├── README.md
├── LICENSE                          ← MIT
├── CONTRIBUTING.md                  ← integration test token workflow documented here
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml                   ← unit tests on PR (pytest + node:test)
│       └── release.yml              ← Flatpak build + GitHub Release on v* tag
│
├── ui/                              ← Python GTK4 UI (Meson project)
│   ├── meson.build
│   ├── meson_options.txt
│   ├── src/
│   │   └── protondrive/
│   │       ├── __init__.py
│   │       ├── main.py              ← Adw.Application entry, GSettings init, engine spawn
│   │       ├── window.py            ← AdwApplicationWindow, top-level shell, routing
│   │       ├── auth.py              ← localhost HTTP callback server + libsecret wrapper
│   │       ├── auth_window.py       ← WebKitGTK widget (own .blp — stays split)
│   │       ├── engine.py            ← engine spawn/monitor + IPC client + protocol constants
│   │       └── widgets/
│   │           ├── __init__.py
│   │           ├── setup_wizard.py  ← first-run flow: Sign In → Choose Folder → Syncing
│   │           ├── sync_pair_row.py ← pair card: status dot, progress bar, remove action
│   │           ├── conflict_log.py  ← conflict list + Reveal in Files portal action
│   │           ├── reauth_dialog.py ← token expiry modal with queued change count
│   │           └── settings.py      ← account info, storage bar, log out
│   ├── data/
│   │   ├── ui/                      ← Blueprint .blp files (all widget structure here)
│   │   │   ├── window.blp
│   │   │   ├── auth-window.blp
│   │   │   ├── setup-wizard.blp
│   │   │   ├── sync-pair-row.blp
│   │   │   ├── conflict-log.blp
│   │   │   ├── reauth-dialog.blp
│   │   │   └── settings.blp
│   │   ├── icons/
│   │   │   ├── io.github.ronki2304.ProtonDriveLinuxClient.svg
│   │   │   └── io.github.ronki2304.ProtonDriveLinuxClient-symbolic.svg
│   │   └── io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml
│   └── tests/
│       ├── conftest.py
│       ├── test_auth.py             ← localhost server + libsecret (mocked)
│       ├── test_auth_window.py      ← WebKitGTK widget, ordering, cleanup
│       ├── test_engine.py           ← spawn, ENGINE_PATH, command queue, crash detection
│       └── test_widgets.py          ← widget logic (no live engine)
│
├── engine/                          ← TypeScript/Node sync engine (npm project)
│   ├── package.json
│   ├── tsconfig.json                ← strict + noUncheckedIndexedAccess + verbatimModuleSyntax
│   └── src/
│       ├── main.ts                  ← entry: init DB → start IPC server → emit ready
│       ├── errors.ts                ← typed error hierarchy (standalone — imported by all)
│       ├── sdk.ts                   ← DriveClient wrapper + type adapters (ONLY SDK imports here)
│       ├── sdk.test.ts
│       ├── state-db.ts              ← SQLite: WAL mode, schema versioning, migrations
│       ├── state-db.test.ts
│       ├── sync-engine.ts           ← sync orchestration, pair lifecycle, delta detection
│       ├── sync-engine.test.ts
│       ├── conflict.ts              ← conflict detection + copy creation (.conflict-YYYY-MM-DD)
│       ├── conflict.test.ts
│       ├── watcher.ts               ← inotify wrapper + debouncing + offline change queue
│       ├── watcher.test.ts
│       ├── ipc.ts                   ← Unix socket server + MessageReader + protocol types
│       ├── ipc.test.ts
│       └── __integration__/
│           ├── sync.integration.test.ts
│           └── conflict.integration.test.ts
│
└── flatpak/
    ├── io.github.ronki2304.ProtonDriveLinuxClient.yml          ← Flatpak manifest
    ├── io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml ← AppStream
    └── io.github.ronki2304.ProtonDriveLinuxClient.desktop
```

### Requirements → Structure Mapping

| Requirement | Location |
|---|---|
| WebKitGTK auth + localhost server + libsecret | `ui/src/protondrive/auth.py` + `auth_window.py` |
| Engine spawn, IPC client, protocol constants | `ui/src/protondrive/engine.py` |
| First-run wizard | `ui/widgets/setup_wizard.py` + `data/ui/setup-wizard.blp` |
| Sync pair list + progress | `ui/widgets/sync_pair_row.py` + `data/ui/sync-pair-row.blp` |
| Conflict notification + log | `ui/widgets/conflict_log.py` + `data/ui/conflict-log.blp` |
| Re-auth modal | `ui/widgets/reauth_dialog.py` + `data/ui/reauth-dialog.blp` |
| Account/settings | `ui/widgets/settings.py` + `data/ui/settings.blp` |
| SDK boundary | `engine/src/sdk.ts` only |
| Sync orchestration | `engine/src/sync-engine.ts` |
| Conflict copy creation | `engine/src/conflict.ts` |
| SQLite state + migrations | `engine/src/state-db.ts` |
| inotify + offline queue | `engine/src/watcher.ts` |
| IPC server + framing + protocol | `engine/src/ipc.ts` |
| Typed errors | `engine/src/errors.ts` |
| Flatpak packaging | `flatpak/` |
| CI/CD | `.github/workflows/` |

### Architectural Boundaries

**UI ↔ Engine boundary:** Unix socket only. UI never imports engine source. Engine never imports UI source.

**SDK boundary:** `engine/src/sdk.ts` is the sole file that imports `@protontech/drive-sdk`. All other engine files import `DriveClient` from `sdk.ts` only.

**Auth boundary:** The session token flows one direction: libsecret → `auth.py` → `engine.py` (via IPC `token_refresh` command) → `sdk.ts`. It never flows back out.

**Widget boundary:** `widgets/` files contain only GTK signal wiring and state updates. All widget structure is in `data/ui/*.blp`. No widget file imports from another widget file — all coordination goes through `window.py`.

**Test boundary:** Engine unit tests mock `DriveClient` (from `sdk.ts`) at the boundary — never mock `@protontech/drive-sdk` directly. Python tests mock the IPC socket — never spawn a real engine subprocess.

---

## Starter Template Evaluation

### Primary Technology Domain

Dual-process Linux desktop application:
- UI process: GTK4/Libadwaita — **Python (PyGObject)**
- Sync engine process: TypeScript/Node

### UI Language Decision: Python (PyGObject)

Chosen over GJS for four concrete reasons:
1. Localhost HTTP auth server is Python stdlib (3 lines) vs manual Gio socket construction in GJS — a security-critical component deserves the simpler, more auditable path
2. WebKitGTK bindings are identical in both — no GJS advantage on auth
3. SDK lives in the sync engine subprocess — unreachable from UI layer regardless of language; "same language family as sync engine" is not a real benefit
4. Largest GTK4/Libadwaita community, most Flathub reference apps, most complete documentation — meaningful risk reduction for v1

### Scaffolding Approach

**UI layer:** GNOME Builder 49.1 Python/GTK4/Libadwaita template
- Generates: Meson build, Blueprint .blp UI files, GResources, GSettings schema, Flatpak manifest scaffold, AppStream metainfo stub, desktop file, Git init
- Launch: `gnome-builder` → New Project → GTK4/Libadwaita (Python)

**Sync engine:** Standard TypeScript/Node setup
- `npm init` + tsconfig.json targeting Node.js ESM
- `tsx` for development, `tsc` for production build
- No framework — plain Node.js subprocess with Unix socket listener

**Note:** Project scaffolding is the first two implementation stories.

---

### Resolved Architecture Decisions

**Sync engine language: TypeScript/Node**
The SDK (`@protontech/drive-sdk`) is a TypeScript/Node package and the sole interface to Proton. The sync engine is the SDK host — it owns all drive operations, encryption, and API calls. TypeScript/Node is the only language where SDK integration is a direct function call rather than a subprocess hop. Rust and Go both require a Node.js SDK sidecar, adding a layer with no functional benefit. Decision is closed.

**IPC mechanism: Unix socket**
The GTK4 UI process and the sync engine subprocess communicate via a Unix socket at a path under `$XDG_RUNTIME_DIR/$APP_ID/`. The protocol is length-prefixed JSON, supporting both command/response (add pair, remove pair, token refresh) and push events (sync progress, conflict detected, token expired, offline state change). Unix socket preferred over D-Bus: no manifest service name declarations, trivially testable without a running session bus, simpler lifecycle management.

**Auth architecture: GTK4 UI owns it entirely**
The WebKitGTK embedded browser widget loads `accounts.proton.me`. Proton's own JavaScript handles SRP, CAPTCHA, and 2FA — no application code touches these. The localhost HTTP server (bound to 127.0.0.1, random ephemeral port, closed after one callback) receives the session token and lives in the GTK4 UI process. The UI stores the token in libsecret and sends it to the sync engine via IPC as an initialization message. The sync engine passes it to the SDK. The sync engine is inert until it receives a token.

### Technical Constraints & Dependencies

- GTK4/Libadwaita + WebKitGTK 2.40+ (GNOME Flatpak runtime, version pinned as joint release gate with SDK version)
- `@protontech/drive-sdk` v0.14.3 (pre-release, treat as breaking on any bump; version pinned until V1 ships)
- inotify requires static `--filesystem` permission (portal FUSE confirmed broken — xdg-desktop-portal #567)
- Flatpak sandbox constrains credential storage (Secret portal), autostart (Background Portal), and network (declared in finish-args)
- Proton crypto migration expected 2026 — openpgp must remain encapsulated within the SDK layer, never imported by UI or engine directly

### Cross-Cutting Concerns Identified

- **IPC socket vs auth server socket are distinct:** auth server is ephemeral (one request, then closed); IPC socket is persistent for app lifetime. Do not conflate or reuse.
- **Change queue and conflict log live in the engine's SQLite:** the UI never queries StateDB directly; all status data (queued change count, conflict events) arrives via push events over IPC.
- **XDG path resolution:** config, state, credentials, window state, and IPC socket path all use XDG env vars with fallbacks; Flatpak paths differ from native — test explicitly.
- **Flatpak App ID:** reverse-DNS format, decided once before implementation begins; propagates to manifest, AppStream metainfo, desktop file, D-Bus service names (if any), and all XDG paths.
- **GNOME runtime version pin + SDK version pin are a joint release gate:** WebKitGTK version is determined by the GNOME runtime; pin both and test the matrix (Fedora 43, Ubuntu 24/25, Bazzite, Arch) before each release.
- **Token expiry spans both processes:** SDK returns 401 → engine emits `token_expired` event over IPC → UI shows re-auth modal → user re-authenticates in WebKitGTK → UI sends new token to engine via `token_refresh` command → engine reinitialises SDK.

## Architecture Validation Results

### Coherence Validation ✅

**Decision compatibility:** All technology choices are compatible — Python/PyGObject + GTK4 + GNOME 50 + WebKitGTK 6.0 + Node.js via `org.freedesktop.Sdk.Extension.node22` + libsecret Secret portal. No version conflicts. Modular monolith structure supports the IPC-boundary architecture cleanly.

**Pattern consistency:** Naming conventions consistent across IPC boundary (snake_case for all IPC fields, SQLite columns, YAML keys). Blueprint rule enforced — widget structure never in Python. SDK boundary enforced — no SDK imports outside `sdk.ts`. WAL mode and schema versioning pinned as mandatory.

**Structure alignment:** Modular monolith consolidation matches actual editing patterns. Files always edited together are merged (auth.py, engine.py, ipc.ts, watcher.ts). Independently evolving concerns stay split (sync-engine.ts, conflict.ts, state-db.ts, each widget). Boundaries between UI/engine/SDK clearly defined and non-overlapping.

### Requirements Coverage Validation ✅

**All MVP functional requirements covered:**
- GTK4/Libadwaita UI → Python + Blueprint + GNOME 50 runtime
- WebKitGTK auth + localhost server → `auth.py` + `auth_window.py`
- Account overview post-auth → `session_ready` push event → `window.py`
- Sync pair management → IPC commands + `sync_pair_row.py`
- Remote folder picker → `list_remote_folders` lazy command
- First-sync progress → `sync_progress` events + `sync_pair_row.py`
- Conflict copies + notification + log → `conflict.ts` + `conflict_log.py`
- Re-auth modal + queue replay → `token_expired` event + `reauth_dialog.py`
- Offline queuing + reconnect → `watcher.ts` change queue
- Sync pair removal → `remove_pair` command + confirmation dialog
- Window state persistence → GSettings (`window-width`, `window-height`)
- Flatpak packaging → `flatpak/` with AppStream, desktop file, manifest

**All NFRs covered:**
- Security: token in libsecret only, never in logs, localhost server 127.0.0.1-only
- Privacy: no telemetry, no network I/O outside SDK, updates via Flathub OSTree only
- Flatpak compliance: static `--filesystem`, Secret portal, App ID finalized
- Reliability: conflict copies mandatory, WAL mode, atomic writes, cold-start handling
- SDK isolation: `sdk.ts` is the sole import boundary

### Gap Analysis — All Resolved

**Gap 1 (Critical) — `account_info` IPC event:** Resolved. `session_ready` push event added — fires after engine validates token and fetches account info from SDK. UI transitions to main window only on `session_ready`. Doubles as re-auth success signal.

**Gap 2 (Important) — Remote folder picker:** Resolved. `list_remote_folders` command with `parent_id` for lazy tree expansion. Request ID pattern (`id` field on all commands, `_result` suffix on responses) applied consistently to entire protocol.

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Project context thoroughly analyzed (47 rules from project-context.md)
- [x] Scale and complexity assessed (medium-high, constraint-driven)
- [x] Technical constraints identified (Flatpak, inotify, WebKitGTK, SDK pre-release)
- [x] Cross-cutting concerns mapped (IPC, XDG paths, token lifecycle, offline state)

**✅ Architectural Decisions**
- [x] Sync engine language: TypeScript/Node (SDK host requirement)
- [x] UI language: Python/PyGObject (community depth, stdlib auth server)
- [x] IPC: Unix socket, 4-byte length-prefix JSON, request IDs, push events
- [x] GNOME runtime: org.gnome.Platform//50 (WebKitGTK 6.0)
- [x] Flatpak App ID: io.github.ronki2304.ProtonDriveLinuxClient
- [x] Engine bundling: `bun build --compile` self-contained binary (no SDK extension)
- [x] Process lifecycle: GLib.spawn_async (MVP) → Background Portal (V1)
- [x] Credential storage: libsecret only, session token only

**✅ Implementation Patterns**
- [x] Naming conventions across both languages and IPC boundary
- [x] Modular monolith file consolidation rules
- [x] 11 mandatory patterns documented with code examples
- [x] Advisory patterns distinguished from mandatory
- [x] GTK4 widget conventions pinned

**✅ Project Structure**
- [x] Complete directory tree (8 engine files, 8 Python files)
- [x] All requirements mapped to specific files
- [x] Architectural boundaries defined (UI/engine/SDK/widget)
- [x] Flatpak two-module build structure documented

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**

**Confidence level: High**

**Key strengths:**
- Two blocking open questions from PRD (sync engine language + IPC mechanism) fully resolved with clear rationale
- IPC protocol fully specified including all edge cases (framing, request IDs, startup ordering, single connection, command queue)
- Mandatory implementation patterns cover the failure modes most likely to cause silent bugs (WAL mode, WebView cleanup, auth server ordering, MessageReader)
- Modular monolith structure matches actual editing patterns — agents won't be hunting across micro-files

**Areas for future enhancement (post-MVP):**
- Background daemon / systemd service (V1)
- System tray via StatusNotifier (V1)
- Bandwidth throttling if SDK exposes rate controls (V1+)
- E2E automated test suite with Xvfb (post-MVP)
- KDE/Plasma visual theming (Phase 2)
- FUSE/VFS virtual filesystem (Phase 2)

### Implementation Handoff

**First stories:**
1. Scaffold UI layer via GNOME Builder (Python/GTK4/Libadwaita project)
2. Scaffold engine (`npm init` + tsconfig + `errors.ts` + `state-db.ts` with WAL)
3. Scaffold Flatpak manifest with two-module structure and Node.js SDK extension

**AI Agent Guidelines:**
- Read `project-context.md` before implementing any code
- Follow ALL mandatory patterns — they encode decisions made after Party Mode stress-testing
- Respect module boundaries: UI never imports engine source; engine never imports UI; SDK imports only in `sdk.ts`
- The IPC protocol is the contract — do not add fields or events without updating this document
- `pair_id` is always UUID v4, always generated by the engine, never by the UI
