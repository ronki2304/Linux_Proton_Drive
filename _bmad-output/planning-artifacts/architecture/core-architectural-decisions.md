# Core Architectural Decisions

## Decision Priority Analysis

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

## Flatpak Identity

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

## Platform & Runtime

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

## Sync Engine Process Lifecycle

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

## IPC Protocol

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

## Error Propagation

- **Non-fatal errors:** Engine pushes `error` event → UI shows inline error on affected sync pair card; engine keeps running
- **Fatal errors:** Engine exits with non-zero code → UI detects socket close → shows app-level error banner with restart button
- **Engine never swallows errors.** UI never polls for error state — it gets told.
- **Engine stderr:** `/dev/null` in production. Debug mode enabled via env var flag (`PROTONDRIVE_DEBUG=1`) — writes to `$XDG_CACHE_HOME/protondrive/engine.log` with size cap. No tokens, file paths, or file content ever written to logs.

---

## Credential Storage

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

## Testing Strategy

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
