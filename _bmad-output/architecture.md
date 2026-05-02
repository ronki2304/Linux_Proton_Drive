# Overall Architecture

Two-process desktop application. The UI process (Python/GTK4) spawns the Engine process (TypeScript/Bun) on startup and communicates with it exclusively over a Unix socket using the IPC protocol.

---

## Diagram

```mermaid
flowchart TD
    subgraph UIProcess
        APP["main.py - AdwApplication"]
        WIN["window.py - AdwApplicationWindow"]
        ENG["engine.py - IPC client"]

        subgraph Widgets
            WIZ[setup_wizard.py]
            AUTH["auth_window.py + auth.py"]
            PAIR[sync_pair_row.py]
            ADD[add_pair_dialog.py]
            REAUTH[reauth_dialog.py]
            UNLOCK[key_unlock_dialog.py]
            ACTIVITY[activity_feed.py]
            CONFLICT[conflict_log.py]
            SETTINGS[settings.py]
            FOOTER[status_footer_bar.py]
        end

        CRED["credential_store.py - libsecret portal"]

        APP --> WIN
        WIN --> ENG
        WIN --> Widgets
        WIN --> CRED
    end

    subgraph EngineProcess
        MAIN["main.ts - command router"]
        IPC["ipc.ts - IpcServer + MessageReader"]
        SYNC["sync-engine.ts - SyncEngine"]
        SDK["sdk.ts - DriveClient - SDK boundary"]
        DB["state-db.ts - StateDb bun:sqlite"]
        WATCH["watcher.ts - FileWatcher"]
        NET["network-monitor.ts - NetworkMonitor"]
        CONF["config.ts - YAML r/w"]
        CONFL["conflict.ts - detectConflict"]

        MAIN --> IPC
        MAIN --> SYNC
        MAIN --> SDK
        MAIN --> DB
        MAIN --> NET
        SYNC --> SDK
        SYNC --> DB
        SYNC --> CONFL
        WATCH --> DB
    end

    subgraph External
        PROTON["Proton Drive API - drive-api.proton.me"]
        FS["Local Filesystem - inotify"]
        KEYRING["OS Keyring - libsecret portal"]
        SQLITE[("SQLite WAL - state.db")]
        YAML[("config.yaml - sync_pairs")]
    end

    ENG -- "Unix socket 4B+JSON" --> IPC
    SDK --> PROTON
    WATCH --> FS
    CRED --> KEYRING
    DB --> SQLITE
    CONF --> YAML
    APP -. spawns .-> MAIN
```

---

## Process Boundaries

| Concern | Process | Technology |
|---------|---------|-----------|
| UI, auth browser, widgets | UIProcess | Python 3.12, GTK4, Libadwaita, WebKitGTK 6.0 |
| Sync, file watching, network | EngineProcess | TypeScript, Bun 1.3.11 |
| Inter-process communication | Unix socket | 4-byte length-prefixed JSON (see `ipc-protocol.md`) |
| Credentials | OS keyring | libsecret via Flatpak Secret portal — never written to disk |
| Sync state | SQLite | WAL mode, `$XDG_DATA_HOME/protondrive/state.db` |
| Pair config | YAML | `$XDG_CONFIG_HOME/protondrive/config.yaml` |
| Remote storage | Proton Drive API | `@protontech/drive-sdk` — all imports confined to `sdk.ts` |

## Key Constraints

- **SDK boundary is enforced** — `@protontech/drive-sdk` may only be imported in `sdk.ts`; all other engine files import `DriveClient` from there.
- **UI never queries SQLite directly** — all state arrives via IPC push events.
- **Engine never reads libsecret** — token flows one way: libsecret → UI → `token_refresh` IPC command → engine.
- **Engine spawning differs by environment** — Flatpak: compiled self-contained binary at `/app/lib/protondrive-engine/dist/engine`; dev: `bun run engine/src/main.ts` via `GLib.find_program_in_path('bun')`.
