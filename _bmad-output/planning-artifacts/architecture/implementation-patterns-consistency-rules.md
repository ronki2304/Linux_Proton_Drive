# Implementation Patterns & Consistency Rules

## Naming Conventions

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

## Project Structure

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

## Mandatory Patterns (breaks the app if violated)

### Auth Flow Ordering

Server starts before WebView navigates — race condition otherwise:
```python
self._auth_server = AuthCallbackServer()   # binds socket first
port = self._auth_server.get_port()
self._auth_server.start_async(self._on_token_received)
self.webview.load_uri(f'http://127.0.0.1:{port}/auth-start')  # THEN navigate
```

### WebView Cleanup After Auth

WebView holds network session and cached credentials — must be explicitly destroyed:
```python
def _on_token_received(self, token: str):
    self._auth_server.stop()
    self.webview.try_close()   # triggers WebKit internal cleanup
    self.webview = None        # release GObject reference
    self._transition_to_main_ui(token)
```

### Signal Connections — Explicit Method Reference Only

Lambda connections cause reference cycles and memory leaks in long-running GTK apps:
```python
# ✅ correct
self.button.connect('clicked', self._on_button_clicked)
# ❌ forbidden
self.button.connect('clicked', lambda btn: self._on_button_clicked(btn))
```

### Blueprint Rule — All Widget Structure in .blp

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

### IPC Reads via Gio.DataInputStream Only

Python's `socket` module blocks the GTK main loop — never use it for IPC:
```python
# ✅ correct — non-blocking, integrates with GTK main loop
stream = Gio.DataInputStream.new(connection.get_input_stream())
stream.read_bytes_async(4, GLib.PRIORITY_DEFAULT, None, self._on_length_received)

# ❌ forbidden — blocks UI
data = socket.recv(4)
```

### MessageReader Class for IPC Framing

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

### Engine Enforces Single Connection

Second connection rejected immediately — prevents duplicate event fan-out:
```typescript
if (this.activeConnection !== null) {
    socket.write(JSON.stringify({type: 'error', payload: {code: 'ALREADY_CONNECTED'}}));
    socket.destroy();
    return;
}
```

### UI Queues Commands Before `ready`

Commands sent before `ready` event are buffered and flushed on receipt — never dropped:
```python
def send_command(self, cmd):
    if not self._engine_ready:
        self._pending_commands.append(cmd)
    else:
        self._write_message(cmd)
```

### SQLite WAL Mode — Mandatory in StateDB.init()

Prevents DB corruption on engine crash mid-write:
```typescript
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
```

### SQLite Schema Versioning

`PRAGMA user_version` for version tracking — ordered integer migrations, never destructive (add columns only in v1):
```typescript
const {user_version} = db.query('PRAGMA user_version').get() as {user_version: number};
if (user_version < CURRENT_SCHEMA_VERSION) {
    runMigrations(db, user_version, CURRENT_SCHEMA_VERSION);
}
db.run(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
```

### Engine Re-reads SQLite on Every Restart

UI re-sends `get_status` on every `ready` event — not just the first:
```python
def _on_engine_ready(self, payload):
    self._engine_ready = True
    self._flush_pending_commands()
    self.send_command({'type': 'get_status'})  # always, not just first launch
```

## Cross-Cutting Rules

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

## Advisory Patterns (good practice, not enforced)

- **WebKit navigation policy:** Use judgment to handle external link navigation — avoid over-restrictive allowlists that break on Proton domain changes
- **GObject property bindings:** Use `@GObject.Property` where it simplifies widget-model binding; not required for all state management

## GTK4 Widget Conventions

| Scenario | Widget |
|---|---|
| Empty state (no pairs, offline, error) | `AdwStatusPage` |
| Transient notification (sync complete, conflict) | `AdwToastOverlay` |
| Re-auth modal, destructive confirmations | `AdwDialog` |
| Loading state | `Gtk.Spinner` |
| Never block GTK main loop | All I/O via `Gio` async or `GLib.idle_add()` |

---
