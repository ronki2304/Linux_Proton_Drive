---
project_name: 'ProtonDrive-LinuxClient'
user_name: 'Jeremy'
date: '2026-04-07'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'code_quality_rules', 'workflow_rules', 'critical_rules']
status: 'complete'
rule_count: 89
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

**Two-process desktop application:** Python GTK4 UI + TypeScript/Bun sync engine, communicating over Unix socket IPC.

### UI Process (Python/GTK4)
- **Runtime:** Python 3.12 (pinned by `org.gnome.Platform//50` — do not use 3.13+ features)
- **Toolkit:** GTK4 + Libadwaita 1.8 (GNOME 50 runtime)
- **Auth browser:** WebKitGTK 6.0 — import as `gi.repository.WebKit` (NOT deprecated `WebKit2`)
- **Build system:** Meson
- **UI definition:** Blueprint `.blp` files compiled to `.ui` by Meson — all widget structure lives here, never in Python
- **Credentials:** libsecret via Flatpak Secret portal
- **Testing:** pytest — mock IPC socket, never spawn real engine; widget tests via Xvfb (CI-optional)

### Sync Engine (TypeScript/Bun)
- **Runtime:** Bun 1.3.11 — dev via system `bun`; Flatpak via `bun build --compile` self-contained binary (no Bun needed at runtime). CLAUDE.md Bun defaults apply to the engine.
- **Language:** TypeScript ^5, ES2022 target, `module: "ESNext"`, `moduleResolution: "Bundler"`
- **Drive SDK:** `@protontech/drive-sdk` ^0.14.3 — pre-release, treat every bump as breaking; version-pinned until V1
- **PGP:** `openpgp` ^6.3.0 — full bundle only, never `openpgp/lightweight`; confined to `engine/src/sdk.ts`; v6 `Uint8Array<ArrayBufferLike>` ↔ SDK `Uint8Array<ArrayBuffer>` casts required at boundary
- **State DB:** `bun:sqlite` — built-in, no native compilation; WAL mode via `db.exec("PRAGMA journal_mode=WAL")`; rows return plain objects but always type via interface for safety
- **Testing:** `bun:test` (`describe`/`it`/`expect`) — `mock()` factory (not `mock.fn()`); run with `bun test`

### Packaging & Distribution
- **Flatpak App ID:** `io.github.ronki2304.ProtonDriveLinuxClient` — permanent, propagates to all manifests, XDG paths, and GSettings schemas
- **GNOME runtime:** `org.gnome.Platform//50` + `org.gnome.Sdk//50`
- **Joint release gate:** GNOME runtime 50 + SDK v0.14.3 validated together on Fedora 43, Ubuntu 24/25, Bazzite, Arch

### TypeScript strict flags (agent impact)
- `noUncheckedIndexedAccess`: `arr[0]` returns `T | undefined` — use `!` after bounds check
- `verbatimModuleSyntax`: type-only imports MUST use `import type { ... }`
- `noImplicitOverride`: class method overrides require `override` keyword

### Two test runtimes — know which one you're in
- `ui/tests/` → pytest (Python)
- `engine/src/**/*.test.ts` → `bun test` (TypeScript)
- `engine/src/__integration__/` → `bun test` (requires manual Proton token — automated integration tests impossible due to CAPTCHA)

## Critical Implementation Rules

### Language-Specific Rules

#### Python (UI Process)

- **Type hints on all public functions** — GTK signal handlers and `__init__` methods included; use `from __future__ import annotations` for forward references
- **No `lambda` in signal connections** — causes GObject reference cycles and memory leaks in long-running GTK apps; always use explicit method references: `button.connect('clicked', self._on_clicked)`
- **`Gio` async for all I/O** — never use Python `socket`, `http.server` blocking calls from the GTK main loop; exception: the localhost auth callback server uses `http.server` on a background thread (one request, then shutdown)
- **One `Gio.Settings` instance per app** — held by `Application` class, passed to widgets via constructor; never instantiate per-widget
- **GObject property declarations** — use `@GObject.Property` decorator; `__gtype_name__` must match Blueprint template class name exactly
- **`@Gtk.Template` wiring** — `resource_path` must match the GResource path from `meson.build`; `Gtk.Template.Child()` names must match Blueprint `id` attributes exactly

#### TypeScript (Sync Engine)

- **Local imports use `.js` extension** — TypeScript files import as `.js` (e.g., `import { foo } from "./bar.js"`); Bun resolves `.ts` via `moduleResolution: "Bundler"` in dev. Never `.ts` in import paths.
- **`import type` mandatory for type-only imports** — `verbatimModuleSyntax` is on; mixing value and type imports in one statement is a compile error
- **`arr[0]` is `T | undefined`** — `noUncheckedIndexedAccess` enabled; use `!` after bounds/existence check
- **`override` keyword required** — `noImplicitOverride` on; class method overrides without it won't compile
- **`async/await` everywhere** — no raw `.then()/.catch()` chains; no callbacks
- **JSON imports require assertion** — `import pkg from "../package.json" with { type: "json" }`
- **Error classes: typed subclasses only** — always throw a subclass of `EngineError` (`SyncError`, `NetworkError`, `IpcError`, `ConfigError`); never `new Error(...)` or plain strings
- **Never return errors — throw them** — engine functions never return `{ error: ... }` or `null` to signal failure; throw typed errors and let IPC layer catch and serialize

### Framework-Specific Rules

#### GTK4 / Libadwaita (UI Process)

- **Blueprint rule — all widget structure in `.blp`** — Python wires signals and updates state only; never construct widget trees in Python (`Gtk.Box()`, `Gtk.Label()` etc. are forbidden outside Blueprint)
- **Widget conventions:**
  - Empty state → `AdwStatusPage`
  - Transient notification (sync complete, conflict) → `AdwToastOverlay`
  - Re-auth modal, destructive confirmations → `AdwDialog`
  - Loading state → `Gtk.Spinner`
  - Never block GTK main loop — all I/O via `Gio` async or `GLib.idle_add()`
- **Widget isolation** — no widget file imports from another widget file; all coordination goes through `window.py`
- **Auth flow ordering is load-bearing** — auth server must bind socket BEFORE WebView navigates; race condition otherwise
- **Auth server lifecycle** — bind to `127.0.0.1` only (never `0.0.0.0`), ephemeral port, closed after ONE callback; server starts → WebView navigates → token arrives → server stops → WebView destroyed. Leaving the server running is a security hole.
- **WebView cleanup after auth** — WebView holds network session and cached credentials; must call `webview.try_close()` + set to `None` after token received
- **IPC reads via `Gio.DataInputStream` only** — Python `socket.recv()` blocks the GTK main loop; use `stream.read_bytes_async()` with `GLib.PRIORITY_DEFAULT`
- **UI queues commands before `ready`** — commands sent before engine `ready` event are buffered in `_pending_commands` and flushed on receipt; never dropped
- **UI must validate `protocol_version` on `ready`** — the `ready` event carries `{version, protocol_version}`; UI must check compatibility before proceeding; version mismatch silently corrupts IPC if unchecked
- **Re-send `get_status` on every `ready` event** — not just first launch; engine re-reads SQLite on restart
- **Fatal vs non-fatal error display** — fatal error (socket close) = app-level error banner + restart button; non-fatal (`error` event with optional `pair_id`) = inline on affected pair card; never show restart button for non-fatal
- **`rate_limited` event needs UI "paused" state** — `{resume_in_seconds}` means engine paused sync; UI must show countdown or paused indicator; failing to handle this makes UI look frozen
- **`ENGINE_PATH` dual resolution** — Flatpak: `("/app/lib/protondrive-engine/dist/engine",)` (1-tuple, compiled binary); dev: `(GLib.find_program_in_path('bun'), <project>/engine/src/main.ts)`; never hardcode either path

#### Sync Engine Architecture (TypeScript)

- **SDK boundary: `engine/src/sdk.ts` only** — all `@protontech/drive-sdk` imports confined to this single file; all other engine code imports `DriveClient` from `sdk.ts`
- **IPC protocol: 4-byte big-endian length prefix + JSON** — commands carry UUID `id` field; responses echo `id` with `_result` suffix
- **`token_refresh` and `shutdown` are exceptions** — `token_refresh` responds via push event (`session_ready` or `token_expired`), not `_result`; `shutdown` responds via socket close; do NOT build a generic "wait for `_result`" handler for these two
- **`MessageReader` class for IPC framing** — never parse raw socket chunks; TCP fragmentation means one `data` event ≠ one message; accumulate buffer until length prefix satisfied
- **Engine enforces single connection** — second connection rejected immediately with `ALREADY_CONNECTED` error; prevents duplicate event fan-out
- **`list_remote_folders` is lazy** — `parent_id: null` = root; expand by passing folder `id`; UI fetches on-demand as user expands tree nodes; never recursively prefetch the entire folder tree
- **`pair_id` ownership** — UUID v4 generated by engine at `add_pair` time, stored in SQLite, returned in response; UI never generates `pair_id`
- **Cold-start** — pair present in YAML config but absent from SQLite = fresh full sync; engine never crashes on missing DB state
- **SQLite WAL mode mandatory in init** — `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` prevents corruption on crash
- **SQLite schema versioning** — `PRAGMA user_version` for tracking; ordered integer migrations; never destructive (add columns only in v1)
- **Atomic file writes for downloads** — write to `<path>.protondrive-tmp-<timestamp>` then `rename()` on success; `unlink()` tmp on failure; never write directly to destination
- **Conflict copy suffix appends after extension** — `notes.md` → `notes.md.conflict-2026-04-01`, not `notes.conflict-2026-04-01.md`
- **Engine stderr → `/dev/null` in production** — debug mode via `PROTONDRIVE_DEBUG=1` env var writes to `$XDG_CACHE_HOME/protondrive/engine.log` with size cap; engine code must never rely on stderr reaching anyone; all errors flow through IPC push events

#### Token Expiry — Cross-Process Workflow

SDK returns 401 → engine emits `token_expired` with `{queued_changes}` count → UI shows re-auth modal displaying queued count → user re-authenticates in WebKitGTK → UI sends `token_refresh` with new token → engine emits `session_ready` → UI resumes normal state. `session_ready` fires on both initial auth and re-auth — handle both in the same handler. An agent implementing only one side will break the handshake.

### Testing Rules

#### Test Commands (exact invocations)

- **UI tests:** `meson test -C builddir` — Meson compiles Blueprint `.blp` → `.ui`, GSettings schemas, and GResource bundle before running pytest; raw `python -m pytest` skips these steps and breaks any test touching `@Gtk.Template` or `Gio.Settings`
- **Engine unit:** `bun test` (run from `engine/` or project root)
- **Engine integration:** `bun test engine/src/__integration__/`
- **CI runs both suites** — always run both UI and engine tests before declaring a story done, even if you only touched one side

#### Python UI Tests (pytest via Meson)

- **Mock the IPC socket, never spawn real engine** — UI tests validate signal wiring, state transitions, and IPC message parsing in isolation
- **Widget tests via Xvfb** — optional in CI (`CI_SKIP_WIDGET_TESTS=1`); required for any test that instantiates a GTK widget
- **`conftest.py` provides shared fixtures** — mock engine connection, mock `Gio.Settings`, mock libsecret; never duplicate fixture setup across test files
- **Mock engine must produce real protocol messages** — use the same message format constants the real engine uses; never hand-craft dicts with a different shape
- **Test file naming** — `test_<module>.py` in `ui/tests/` (e.g., `test_auth.py`, `test_engine.py`, `test_widgets.py`)
- **One-time setup:** `meson setup builddir` (then `meson test -C builddir` every time)

#### Sync Engine Tests (bun:test)

- **`bun:test` is Jest-compatible** — use `mock()` factory (not `mock.fn()`); use `expect()` with `.toBe()`, `.toEqual()`, `.toBeTruthy()` etc.; `mock.calls` tracks call arguments; `mock.restore()` cleans up after tests
- **Unit tests co-located** — `*.test.ts` alongside source (e.g., `engine/src/sync-engine.test.ts`)
- **Mock at `DriveClient` boundary** — mock individual methods on the `DriveClient` wrapper from `sdk.ts`; never mock `@protontech/drive-sdk` imports directly
- **SQLite test isolation** — each test uses a fresh `:memory:` database or a temp file deleted in `afterEach`; never share DB state between tests
- **Mandatory `ipc.test.ts` edge cases** — partial message, multiple messages in one chunk, message split across chunks, zero-length payload, oversized payload; `MessageReader` is the most fragile component
- **Integration tests in `engine/src/__integration__/`** — require pre-authenticated session token via manual flow (Proton CAPTCHA blocks automation); env vars: `PROTON_TEST_TOKEN`, `PROTON_TEST_FOLDER`
- **Integration token expires without warning** — when tests start failing with 401, repeat the manual auth flow; no programmatic refresh possible
- **`afterAll` must clean up test data** — integration tests create real files on Proton servers; always remove test folders in cleanup
- **Test file naming** — `*.test.ts` for unit, `*.integration.test.ts` for live API; never `__tests__/` directories

#### IPC Contract Testing

- **IPC message schema must be validated on both sides** — Python UI tests and TypeScript engine tests must use identical message shapes in fixtures; if one side changes the protocol, both test suites must catch it
- **E2E tests deferred to post-MVP** — manual validation on target distros before each release

### Code Quality & Style Rules

#### Naming Conventions

| Context | Convention | Example |
|---|---|---|
| Python files | `snake_case.py` | `sync_panel.py`, `auth_window.py` |
| Python functions/variables | `snake_case` | `get_token()`, `pair_id` |
| Python classes | `PascalCase` | `SyncPanel`, `AuthWindow` |
| Python error classes | `PascalCase` + `Error` suffix, base = `AppError` | `IpcError`, `AuthError`, `ConfigError` |
| GTK4 signal names | `kebab-case` (GTK convention) | `clicked`, `notify::text` |
| Blueprint UI files | `kebab-case.blp` | `main-window.blp`, `sync-pair-row.blp` |
| Blueprint widget IDs | `kebab-case` | `status-label`, `sync-button` |
| GSettings keys | `kebab-case` | `window-width`, `last-sync-time` |
| TypeScript files | `kebab-case.ts` | `drive-client.ts`, `sync-engine.ts` |
| TypeScript functions/variables | `camelCase` | `getToken()`, `pairId` |
| TypeScript classes/interfaces | `PascalCase` (no `I` prefix) | `DriveClient`, `SyncPair` |
| TypeScript error classes | `PascalCase` + `Error` suffix, base = `EngineError` | `SyncError`, `NetworkError`, `IpcError` |
| SQLite tables | singular `snake_case` | `sync_pair`, `sync_state` |
| SQLite columns | `snake_case` | `pair_id`, `last_sync_mtime` |
| IPC event/command names | `snake_case` | `sync_progress`, `add_pair` |
| IPC payload fields | `snake_case` | `pair_id`, `files_done` |
| Config YAML keys | `snake_case` | `sync_pairs`, `remote_path` |
| Timestamps | ISO 8601 | `2026-04-06T14:30:00.000Z` |

#### IPC Wire Format — snake_case on Both Sides

IPC payloads use `snake_case` even in TypeScript — the wire format is the canonical form. Do NOT transform to `camelCase` on either side. An agent instinctively camelCasing payload fields in TypeScript will break the Python parser.

#### Blueprint ID → Python Template.Child() Mapping

Blueprint `kebab-case` IDs (e.g., `status-label`) auto-convert to `snake_case` in Python `Gtk.Template.Child()` (e.g., `status_label`). GTK handles the conversion, but only if names match after `kebab→snake`. Using `statusLabel` (camelCase) in Python breaks the binding silently.

#### Code Organization

- **Modular monolith** — files always edited together are merged; independently evolving concerns stay split; the unit of isolation is the module, not the class
- **Engine source is flat** — all files directly under `engine/src/` (`sdk.ts`, `sync-engine.ts`, `ipc.ts`, `state-db.ts`, `conflict.ts`, `watcher.ts`, `errors.ts`, `main.ts`); no subdirectories except `__integration__/`; do not create `src/core/`, `src/ipc/`, etc.
- **`errors.ts` has zero internal imports** — it is imported by all other engine files; any import from another engine file creates circular dependencies
- **No comments on obvious code** — only add comments where logic is non-evident; the `sdk.ts` boundary comment is the canonical exception (it enforces the SDK import rule)
- **Timestamps as ISO 8601 TEXT in SQLite** — never INTEGER epoch; conflict copy suffix uses `YYYY-MM-DD` local date
- **No linter configured** — follow the naming table and existing patterns; do not install or configure ESLint, ruff, or flake8 unless explicitly asked

#### Error Handling

##### Engine (TypeScript)
- **Typed error subclasses only** — throw `SyncError`, `NetworkError`, `IpcError`, `ConfigError` (all extend `EngineError`); never `new Error(...)` or plain strings
- **Engine never swallows errors** — no catch-and-log; let errors propagate to IPC layer for serialization as push events

##### UI (Python)
- **Minimal custom hierarchy:**
  - `AppError` — base for all application-level UI errors
  - `IpcError(AppError)` — engine communication failures (timeout, disconnect, protocol mismatch)
  - `AuthError(AppError)` — libsecret failures, token storage/retrieval issues
  - `ConfigError(AppError)` — YAML parse failures, missing required fields
- **Signal handlers catch `AppError` subclasses specifically** — never bare `except Exception`; GLib/GTK errors must propagate normally
- **Non-fatal = inline on pair card; fatal = banner + restart** — never mix these display paths

### Development Workflow Rules

#### Dev Prerequisites

GNOME SDK 50 (`org.gnome.Sdk//50`), Bun 1.3.11 (`curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"`), Meson, Blueprint compiler (`blueprint-compiler`). Flatpak Builder for packaging.

#### Local Development — Two-Terminal Launch

```
# Terminal A — Engine
cd engine && rtk bun install    # first time only
rtk bun run src/main.ts

# Terminal B — UI
meson setup builddir        # first time only
meson compile -C builddir
python -m protondrive
```

UI auto-spawns the engine in production (Flatpak). In dev, run them separately to see engine stdout. The UI's `ENGINE_PATH` resolution finds system `bun` via `GLib.find_program_in_path()`.

#### Build & Run

- **Engine dev:** `rtk bun run engine/src/main.ts` — no compile step
- **Engine production:** `rtk bun build --compile src/main.ts --outfile=dist/engine` → self-contained binary with Bun + bun:sqlite embedded; no native addon required
- **UI dev:** `meson compile -C builddir` then `python -m protondrive` or GNOME Builder
- **Full app (Flatpak):** `flatpak-builder --user --install builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`

#### XDG Paths — Flatpak vs Native

| Data | Path | Notes |
|---|---|---|
| Config | `$XDG_CONFIG_HOME/protondrive/config.yaml` | App creates directory on first run |
| State DB | `$XDG_DATA_HOME/protondrive/state.db` | App creates directory on first run |
| Credentials | libsecret Secret portal | Never written to disk in plaintext |
| Window state | `$XDG_STATE_HOME/protondrive/` | App creates directory on first run |
| IPC socket | `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock` | Flatpak: auto-created by sandbox; native dev: engine must `mkdir -p` before binding |
| Engine logs | `$XDG_CACHE_HOME/protondrive/engine.log` | Debug only (`PROTONDRIVE_DEBUG=1`) |

Always resolve via env var with fallback — never hardcode `~/.config` or `~/.local/share`. Flatpak paths differ from native — test explicitly in both environments.

#### Git Conventions

- **Branch naming:** `feat/<story-id>-short-desc`, `fix/<issue>-short-desc`, `chore/<desc>` (e.g., `feat/story-3-sync-panel`, `fix/ipc-timeout`, `chore/update-deps`)
- **Commit messages:** Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:` prefix; imperative mood; scope optional (e.g., `feat(engine): add conflict detection`)
- **`dist/` is gitignored** — never commit compiled output

#### CI/CD

- **`ci.yml` (PR gate):** `meson test` (UI) + `rtk bun test` (engine unit) — both must pass
- **`release.yml` (on `v*` tag):** Flatpak build + GitHub Release
- **No automated integration tests in CI** — Proton CAPTCHA blocks unattended auth
- **Tested distro matrix:** Fedora 43, Ubuntu 24/25, Bazzite, Arch — validated before each release

#### Flatpak Constraints

- **inotify requires static `--filesystem` permission** — portal FUSE is broken (`xdg-desktop-portal #567`); must declare watched directories in manifest `finish-args`
- **Network access declared in `finish-args`** — `--share=network`
- **Secret portal for credentials** — no direct filesystem access to keyring
- **Background Portal for V1 autostart** — deferred; MVP is foreground-only

### Critical Don't-Miss Rules

#### Architectural Boundaries

- **Never import `@protontech/drive-sdk` outside `engine/src/sdk.ts`** — any accidental import elsewhere breaks the SDK migration boundary; the boundary comment at top of `sdk.ts` is the enforcement signal
- **Never import across UI ↔ Engine boundary** — Python UI never imports TypeScript; engine never imports Python; the Unix socket is the only interface
- **One-way dependency rule in engine is load-bearing** — `sdk.ts` must not import from `sync-engine.ts`, `ipc.ts`, or any other engine file except `errors.ts`; `ipc.ts` must not import from `sdk.ts`; violations create circular deps or break the modular boundary
- **IPC socket and auth server socket are distinct** — auth server is ephemeral (one request, then closed); IPC socket is persistent for app lifetime; do not conflate or reuse
- **Change queue and conflict log live in engine's SQLite** — UI never queries StateDB directly; all status data arrives via IPC push events

#### Security

- **Token must never appear in output** — not in stdout, stderr, logs, IPC error messages, or debug output; `PROTONDRIVE_DEBUG=1` logs explicitly exclude tokens
- **Token flow is one-directional** — libsecret → Python UI → IPC `token_refresh` → engine `sdk.ts` → SDK; engine never reads libsecret directly; UI never sends token to stdout

#### SDK Footguns

- **`MaybeNode` must be unwrapped** — SDK methods return `MaybeNode<T>`; always check `.ok` before accessing `.value` or call `resolveNode(maybeNode)`; accessing properties directly gives `undefined` at runtime with no compile error — the #1 SDK integration footgun
- **Pin SDK exact version, not caret** — `@protontech/drive-sdk` is pre-release (`0.14.3`); semver guarantees don't apply at `0.x`; use exact version in `package.json` (no `^`); `npm update` or dependabot patch merges will silently break the app
- **openpgp: full bundle only** — import from `openpgp`, never `openpgp/lightweight`; confined to `sdk.ts`; Proton crypto migration expected 2026 — openpgp must remain encapsulated

#### GTK4 Gotchas

- **`GLib.spawn_async()` returns bool, does NOT raise** — an agent must check the return value; `False` = spawn failed; failing to check means engine spawn failures are silently ignored
- **WebView allows all navigation** — Proton redirects through several subdomains during auth (`account.proton.me`, `mail.proton.me/api`); strict URL allowlists break when Proton changes domains; the security boundary is the localhost callback server, not URL filtering
- **First-run wizard must resume on next launch if interrupted** — if user closes app after auth but before selecting a sync folder, next launch must re-enter wizard; persist wizard state (at minimum: "auth complete, no pair configured"); never skip to main panel with zero pairs

#### Sync & Data Integrity

- **No silent overwrites** — sync engine creates conflict copy (`filename.ext.conflict-YYYY-MM-DD`) instead of overwriting a changed local file; never skip conflict detection
- **Engine never writes to stdout or stderr** — all output goes through IPC push events or the debug log file (`PROTONDRIVE_DEBUG=1`); `console.log()` corrupts IPC framing if anything writes to stdout while the socket is active

#### Environment & Build

- **CLAUDE.md Bun defaults apply to the engine** — engine runs Bun 1.3.11; use `bun:sqlite`, `bun test`, `bun run`
- **`bun build --compile` produces a self-contained binary** — embeds Bun runtime + bun:sqlite; no native addon or runtime dependency
- **Flatpak App ID propagates everywhere** — `io.github.ronki2304.ProtonDriveLinuxClient` appears in manifest, AppStream metainfo, desktop file, GSettings schema, GResource paths, IPC socket path, and icon filenames; changing it post-Flathub submission breaks installed instances

#### Testing

- **Integration test cleanup failure must be reported, not swallowed** — if `afterAll` cleanup fails, the test must still report the failure AND log which resources leaked; silently swallowing cleanup errors leads to orphaned files filling the Proton account quota

---

## Usage Guidelines

**For AI Agents:**
- Read this file before implementing any code in this project
- Follow ALL rules exactly as documented — they encode hard-won decisions
- When in doubt, prefer the more restrictive option
- Never import across the documented module boundaries

**For Humans:**
- Keep this file lean and focused on agent needs
- Update when technology stack or patterns change
- Review quarterly for outdated rules
- Remove rules that become obvious over time

_Last Updated: 2026-04-07_
