# ProtonDrive Linux Client — Project Overview

**Last Updated:** 2026-04-26
**Version:** 1.0.0
**App ID:** `io.github.ronki2304.ProtonDriveLinuxClient`

---

## What It Is

A native Linux desktop application that keeps local folders synchronized with ProtonDrive cloud storage. It runs as a Flatpak, integrates with GNOME (Libadwaita), and performs end-to-end encrypted file sync using Proton's official Drive SDK.

---

## Architecture at a Glance

The app is **two cooperating processes** that communicate exclusively over a Unix socket:

```
┌─────────────────────────────────┐     Unix socket (IPC)    ┌─────────────────────────────┐
│   UI Process (Python/GTK4)      │ ◄──── 4-byte + JSON ────► │  Engine Process (Bun/TS)    │
│                                 │                           │                             │
│  Adw.Application (global state) │                           │  Sync orchestration         │
│  GTK4 + Libadwaita widgets      │                           │  @protontech/drive-sdk      │
│  WebKitGTK auth browser         │                           │  bun:sqlite state DB        │
│  libsecret credential store     │                           │  inotify file watcher       │
└─────────────────────────────────┘                           └─────────────────────────────┘
```

The UI spawns the engine on startup and kills it on shutdown. They never share memory or files.

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| UI runtime | Python | 3.12 (pinned by GNOME 50 runtime) |
| UI toolkit | GTK4 + Libadwaita | GNOME Platform //50 |
| UI auth browser | WebKitGTK | 6.0 (import as `gi.repository.WebKit`) |
| UI build system | Meson + Blueprint compiler | GNOME SDK //50 |
| Engine runtime | Bun | 1.3.11 (exact) |
| Engine language | TypeScript | ^5.x, ES2022, ESNext modules |
| Engine drive SDK | @protontech/drive-sdk | 0.14.3 (exact pin — pre-release) |
| Engine crypto | openpgp | ^6.3.0 (full bundle — never lightweight) |
| Engine database | bun:sqlite | built-in, no native addon |
| Packaging | Flatpak | org.gnome.Platform//50 |
| License | GPL-3.0-only | — |

---

## Key Features

- **Bidirectional sync** — uploads local changes, downloads remote changes in the same cycle
- **Multiple sync pairs** — any number of local ↔ remote folder pairs
- **Conflict detection** — mtime + content-hash; creates `.conflict-YYYY-MM-DD-N` copies instead of overwriting
- **Offline queue** — changes made offline are queued in SQLite; replayed on reconnect
- **Token re-auth** — pauses sync on 401, shows queued-change count, resumes after re-login
- **Rate limit backoff** — exponential backoff up to 30s with UI "paused" indicator
- **Crash recovery** — dirty-session flag; cleans `.protondrive-tmp-*` files on restart
- **Event-driven reconcile** — subscribes to Proton's remote event stream; targeted incremental reconcile on node events, full walk only on `TreeRefresh`
- **Flatpak sandbox** — runs inside Flatpak with minimal permissions; DoH (Cloudflare 1.1.1.1) workaround for blocked UDP DNS

---

## Repository Structure

| Directory | Contents |
|-----------|---------|
| `ui/` | Python/GTK4 UI process (Meson build) |
| `engine/` | TypeScript/Bun sync engine |
| `flatpak/` | Flatpak manifest + generated npm sources |
| `.github/workflows/` | CI/CD (PR gate + release) |
| `docs/` | Generated documentation (this folder) |
| `scripts/` | bump-version, check-boundaries, epic-pipeline |

---

## XDG Data Locations

| Data | Path |
|------|------|
| Sync pair config | `$XDG_CONFIG_HOME/protondrive/config.yaml` |
| State database | `$XDG_DATA_HOME/protondrive/state.db` |
| Credentials | libsecret Secret portal (never plaintext on disk) |
| Window state | `$XDG_STATE_HOME/protondrive/` |
| IPC socket | `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock` |
| Engine debug log | `$XDG_CACHE_HOME/protondrive/engine.log` (requires `PROTONDRIVE_DEBUG=1`) |

---

## Related Documentation

- [Architecture — UI](./architecture-ui.md) — GTK4 process: auth, widgets, IPC client
- [Architecture — Engine](./architecture-engine.md) — Bun process: sync, SDK, database
- [Integration Architecture](./integration-architecture.md) — IPC protocol wire format and data flows
- [Data Models](./data-models-engine.md) — SQLite schema (8 migrations)
- [Component Inventory](./component-inventory.md) — Full module and widget catalog
- [Development Guide](./development-guide.md) — Local setup, build, test, and deploy commands
