# Project Structure & Boundaries

## Design Principle: Modular Monolith

Files that are always edited together are merged. Files that are edited independently stay split. Screens with their own Blueprint file stay split. The unit of isolation is the module, not the class.

Merge rule: **cohesive concern → one file.** Split rule: **independently evolving concern → own file.**

## Complete Project Tree

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

## Requirements → Structure Mapping

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

## Architectural Boundaries

**UI ↔ Engine boundary:** Unix socket only. UI never imports engine source. Engine never imports UI source.

**SDK boundary:** `engine/src/sdk.ts` is the sole file that imports `@protontech/drive-sdk`. All other engine files import `DriveClient` from `sdk.ts` only.

**Auth boundary:** The session token flows one direction: libsecret → `auth.py` → `engine.py` (via IPC `token_refresh` command) → `sdk.ts`. It never flows back out.

**Widget boundary:** `widgets/` files contain only GTK signal wiring and state updates. All widget structure is in `data/ui/*.blp`. No widget file imports from another widget file — all coordination goes through `window.py`.

**Test boundary:** Engine unit tests mock `DriveClient` (from `sdk.ts`) at the boundary — never mock `@protontech/drive-sdk` directly. Python tests mock the IPC socket — never spawn a real engine subprocess.

---
