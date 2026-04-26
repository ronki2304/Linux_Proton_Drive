# Source Tree Analysis

**Project:** ProtonDrive Linux Client
**Repository Type:** Multi-part (UI process + Engine process)
**Last Updated:** 2026-04-26

---

## Annotated Directory Tree

```
ProtonDrive-LinuxClient/          # Project root
│
├── ui/                           # ← PART 1: Python/GTK4 UI process
│   ├── src/protondrive/          # Python package entry point
│   │   ├── __main__.py           # `python -m protondrive` entry
│   │   ├── main.py               # Application class (Adw.Application) — global state hub
│   │   ├── window.py             # MainWindow — split-view layout + all event routing
│   │   ├── engine.py             # EngineClient — IPC framing, process lifecycle
│   │   ├── auth_window.py        # AuthWindow — embedded WebKitGTK browser + cookie poller
│   │   ├── auth.py               # AuthCallbackServer — localhost OAuth callback server
│   │   ├── pre_auth.py           # PreAuthScreen — sign-in landing page widget
│   │   ├── credential_store.py   # CredentialManager — libsecret / encrypted-file backends
│   │   ├── errors.py             # Error hierarchy (zero internal imports)
│   │   └── widgets/              # Reusable UI components (one file per widget)
│   │       ├── account_header_bar.py   # Top bar: avatar, name, email, storage ring
│   │       ├── activity_feed.py        # Scrolled list of recent file_synced events
│   │       ├── add_pair_dialog.py      # Dialog: local + remote folder picker for new pairs
│   │       ├── conflict_log.py         # Full conflict history list with resolve/reveal actions
│   │       ├── key_unlock_dialog.py    # Password dialog for bcrypt key derivation
│   │       ├── pair_detail_panel.py    # Right-panel: pair info, progress, conflict banner
│   │       ├── reauth_dialog.py        # Modal: "Session expired, N changes queued" + sign-in
│   │       ├── remote_folder_picker.py # Lazy tree picker for ProtonDrive remote folders
│   │       ├── settings.py             # Settings page: account info + logout
│   │       ├── setup_wizard.py         # First-run wizard: local + remote folder selection
│   │       ├── status_footer_bar.py    # Bottom bar: All synced / Syncing / Offline / Error
│   │       ├── sync_pair_row.py        # Sidebar row for one sync pair (teal/grey/amber/red dot)
│   │       └── sync_progress_card.py   # Inline card: files_done/files_total progress bar
│   ├── data/                     # GTK resource files (compiled by Meson)
│   │   ├── *.blp                 # Blueprint UI definitions (compiled to .ui)
│   │   ├── *.gschema.xml         # GSettings schema
│   │   └── protondrive.gresource.xml  # GResource manifest
│   ├── tests/                    # pytest test suite
│   │   ├── conftest.py           # Shared fixtures: mock IPC socket, GSettings, libsecret
│   │   └── test_*.py             # Per-module test files
│   └── meson.build               # Build: Blueprint compile, GResource, GSettings install
│
├── engine/                       # ← PART 2: TypeScript/Bun sync engine
│   └── src/                      # All source files flat (no subdirectories)
│       ├── main.ts               # Entry: orchestrates modules, handles IPC commands
│       ├── ipc.ts                # IpcServer, MessageReader, wire framing (4-byte + JSON)
│       ├── sync-engine.ts        # SyncEngine: reconcile, drain queue, event subscription
│       ├── sdk.ts                # DriveClient — ONLY file importing @protontech/drive-sdk
│       ├── state-db.ts           # StateDb: SQLite via bun:sqlite (8-migration schema)
│       ├── watcher.ts            # FileWatcher: inotify via node:fs.watch + debounce
│       ├── network-monitor.ts    # NetworkMonitor: TCP probe to 1.1.1.1:443
│       ├── conflict.ts           # Pure conflict detection (mtime + hash)
│       ├── config.ts             # Config YAML read/write (XDG_CONFIG_HOME)
│       ├── errors.ts             # Error hierarchy (zero internal imports)
│       ├── debug-log.ts          # Capped file logger (XDG_CACHE_HOME, PROTONDRIVE_DEBUG=1)
│       ├── __integration__/      # Live integration tests (require manual Proton token)
│       └── *.test.ts             # Unit tests co-located with source
│
├── flatpak/                      # Flatpak packaging
│   ├── io.github.ronki2304.ProtonDriveLinuxClient.yml  # Flatpak manifest
│   ├── generated-sources.json    # Offline npm sources for flatpak-builder
│   └── PERMISSIONS.md            # Permission justifications
│
├── .github/workflows/            # CI/CD
│   ├── ci.yml                    # PR gate: engine tsc + tests + UI meson + pytest
│   └── release.yml               # Tag trigger: Flatpak build + GitHub Release
│
├── scripts/                      # Developer utilities
│   ├── bump-version.sh           # Bump VERSION + package.json atomically
│   ├── check-boundaries.sh       # Verify SDK import boundary
│   └── epic-pipeline.sh          # Sprint automation helper
│
├── docs/                         # Generated documentation (this folder)
├── screenshots/                  # App screenshots for Flathub listing
├── VERSION                       # Canonical version string
└── LICENSE                       # GPL-3.0-only
```

---

## Critical Directories

| Directory | Purpose | Notes |
|-----------|---------|-------|
| `ui/src/protondrive/` | Python UI package | Entry via `python -m protondrive` |
| `ui/src/protondrive/widgets/` | GTK4 widget components | No cross-imports between widget files |
| `ui/data/` | Blueprint + GSettings + GResource | Must compile before running/testing |
| `ui/tests/` | Python pytest test suite | Requires `meson compile -C builddir` first |
| `engine/src/` | TypeScript engine source | Flat — no subdirs except `__integration__/` |
| `engine/src/__integration__/` | Live integration tests | Require manual Proton session token |
| `flatpak/` | Packaging manifest | App ID: `io.github.ronki2304.ProtonDriveLinuxClient` |

---

## Entry Points

| Context | Command | Entry File |
|---------|---------|-----------|
| UI (dev) | `python -m protondrive` | `ui/src/protondrive/__main__.py` |
| Engine (dev) | `bun run engine/src/main.ts` | `engine/src/main.ts` |
| Engine (prod) | `./dist/engine` | Compiled self-contained binary |
| Flatpak | `flatpak run io.github.ronki2304.ProtonDriveLinuxClient` | `protondrive` command |
| UI tests | `.venv/bin/pytest ui/tests/` | `ui/tests/conftest.py` |
| Engine tests | `bun test` | `engine/src/*.test.ts` |

---

## Integration Points

The two processes communicate **exclusively** via Unix socket IPC:

```
ui/src/protondrive/engine.py  ←→  engine/src/ipc.ts
      (EngineClient)                  (IpcServer)
```

Socket: `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`
