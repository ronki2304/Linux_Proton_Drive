# Starter Template Evaluation

## Primary Technology Domain

Dual-process Linux desktop application:
- UI process: GTK4/Libadwaita — **Python (PyGObject)**
- Sync engine process: TypeScript/Node

## UI Language Decision: Python (PyGObject)

Chosen over GJS for four concrete reasons:
1. Localhost HTTP auth server is Python stdlib (3 lines) vs manual Gio socket construction in GJS — a security-critical component deserves the simpler, more auditable path
2. WebKitGTK bindings are identical in both — no GJS advantage on auth
3. SDK lives in the sync engine subprocess — unreachable from UI layer regardless of language; "same language family as sync engine" is not a real benefit
4. Largest GTK4/Libadwaita community, most Flathub reference apps, most complete documentation — meaningful risk reduction for v1

## Scaffolding Approach

**UI layer:** GNOME Builder 49.1 Python/GTK4/Libadwaita template
- Generates: Meson build, Blueprint .blp UI files, GResources, GSettings schema, Flatpak manifest scaffold, AppStream metainfo stub, desktop file, Git init
- Launch: `gnome-builder` → New Project → GTK4/Libadwaita (Python)

**Sync engine:** Standard TypeScript/Node setup
- `npm init` + tsconfig.json targeting Node.js ESM
- `tsx` for development, `tsc` for production build
- No framework — plain Node.js subprocess with Unix socket listener

**Note:** Project scaffolding is the first two implementation stories.

---

## Resolved Architecture Decisions

**Sync engine language: TypeScript/Node**
The SDK (`@protontech/drive-sdk`) is a TypeScript/Node package and the sole interface to Proton. The sync engine is the SDK host — it owns all drive operations, encryption, and API calls. TypeScript/Node is the only language where SDK integration is a direct function call rather than a subprocess hop. Rust and Go both require a Node.js SDK sidecar, adding a layer with no functional benefit. Decision is closed.

**IPC mechanism: Unix socket**
The GTK4 UI process and the sync engine subprocess communicate via a Unix socket at a path under `$XDG_RUNTIME_DIR/$APP_ID/`. The protocol is length-prefixed JSON, supporting both command/response (add pair, remove pair, token refresh) and push events (sync progress, conflict detected, token expired, offline state change). Unix socket preferred over D-Bus: no manifest service name declarations, trivially testable without a running session bus, simpler lifecycle management.

**Auth architecture: GTK4 UI owns it entirely**
The WebKitGTK embedded browser widget loads `accounts.proton.me`. Proton's own JavaScript handles SRP, CAPTCHA, and 2FA — no application code touches these. The localhost HTTP server (bound to 127.0.0.1, random ephemeral port, closed after one callback) receives the session token and lives in the GTK4 UI process. The UI stores the token in libsecret and sends it to the sync engine via IPC as an initialization message. The sync engine passes it to the SDK. The sync engine is inert until it receives a token.

## Technical Constraints & Dependencies

- GTK4/Libadwaita + WebKitGTK 2.40+ (GNOME Flatpak runtime, version pinned as joint release gate with SDK version)
- `@protontech/drive-sdk` v0.14.3 (pre-release, treat as breaking on any bump; version pinned until V1 ships)
- inotify requires static `--filesystem` permission (portal FUSE confirmed broken — xdg-desktop-portal #567)
- Flatpak sandbox constrains credential storage (Secret portal), autostart (Background Portal), and network (declared in finish-args)
- Proton crypto migration expected 2026 — openpgp must remain encapsulated within the SDK layer, never imported by UI or engine directly

## Cross-Cutting Concerns Identified

- **IPC socket vs auth server socket are distinct:** auth server is ephemeral (one request, then closed); IPC socket is persistent for app lifetime. Do not conflate or reuse.
- **Change queue and conflict log live in the engine's SQLite:** the UI never queries StateDB directly; all status data (queued change count, conflict events) arrives via push events over IPC.
- **XDG path resolution:** config, state, credentials, window state, and IPC socket path all use XDG env vars with fallbacks; Flatpak paths differ from native — test explicitly.
- **Flatpak App ID:** reverse-DNS format, decided once before implementation begins; propagates to manifest, AppStream metainfo, desktop file, D-Bus service names (if any), and all XDG paths.
- **GNOME runtime version pin + SDK version pin are a joint release gate:** WebKitGTK version is determined by the GNOME runtime; pin both and test the matrix (Fedora 43, Ubuntu 24/25, Bazzite, Arch) before each release.
- **Token expiry spans both processes:** SDK returns 401 → engine emits `token_expired` event over IPC → UI shows re-auth modal → user re-authenticates in WebKitGTK → UI sends new token to engine via `token_refresh` command → engine reinitialises SDK.
