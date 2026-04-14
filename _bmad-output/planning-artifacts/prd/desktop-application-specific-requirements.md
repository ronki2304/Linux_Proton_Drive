# Desktop Application Specific Requirements

## Platform Support

- **Target platform:** Linux only — x86_64 primary; ARM64 (Raspberry Pi, Pinebook) not committed for v1
- **Desktop environment:** GTK4/Libadwaita; GNOME and GNOME-derived desktops as primary targets; KDE/Plasma renders but visually inconsistent — full KDE integration deferred to Phase 2
- **Display server:** Wayland primary (required for Bazzite/SteamOS); X11 via XWayland
- **Distribution:** Flatpak via Flathub exclusively for v1; Snap and AppImage explicitly deferred
- **Windows/macOS:** Out of scope permanently

## System Integration

- **File watching:** inotify via static `--filesystem` Flatpak permission — not portal FUSE (confirmed broken for inotify); separate watch per subdirectory; graceful `ENOSPC` handling with visible user error; watch tree initialisation runs asynchronously and must not block the UI
- **Credential storage:** libsecret via Secret portal (GNOME) or libsecret local fallback at `~/.var/app/$FLATPAK_ID/data/keyrings/`; explicit error surfaced if neither is available
- **File chooser:** XDG File Chooser portal (`org.freedesktop.portal.FileChooser`) for sync folder selection — not a raw GTK file dialog; ensures correct sandbox behaviour and GNOME UX
- **State persistence:** SQLite at `$XDG_DATA_HOME/protondrive/state.db`; file paths and sync history in plaintext (documented); each sync state record stores both the local mtime and remote mtime at the time of last successful sync, plus an optional content hash for conflict detection fallback
- **Config:** YAML at `$XDG_CONFIG_HOME/protondrive/config.yaml`; XDG paths resolved via env var with `~/.config` / `~/.local/share` fallbacks
- **Window state:** window geometry saved to `$XDG_STATE_HOME/protondrive/` on close and restored on open
- **Proxy:** system proxy settings respected (`http_proxy`/`https_proxy` and GNOME proxy settings) — or explicitly documented as unsupported in v1 with a filed issue
- **WebKitGTK:** version 2.40+ required for trusted-origin behaviour on `http://127.0.0.1`; GNOME runtime version pinned in Flatpak manifest to prevent auth regression from runtime updates

## Flathub Submission Requirements

- **App ID:** reverse-DNS format (e.g. `io.github.username.ProtonDriveLinuxClient`) — must be decided before implementation begins; propagates to manifest, AppStream, desktop file, D-Bus service names, and XDG paths
- **AppStream/metainfo XML:** required deliverable — app ID, name, summary, description, screenshots, release notes, developer info, OARS content rating (`oars-1.1`, all fields `none` for this app type)
- **Desktop file:** `Categories=Network;FileTransfer;`, `Keywords=sync;proton;drive;cloud;`, correct Flatpak `Exec=` line, `StartupNotify=true`
- **finish-args justification document:** written justification for every Flatpak permission prepared before submission — `--share=network`, `--filesystem=home` (inotify requires direct filesystem access; portal FUSE does not fire inotify events; no portal alternative supports both dynamic folder selection and file watching), `--talk-name=org.freedesktop.portal.Secret`; the `--filesystem=home` justification must explain the platform limitation in plain language for both Flathub reviewers and end users reading the manifest

## Update Strategy

- **Update mechanism:** Flathub OSTree exclusively — delta updates, no in-app updater, no self-update mechanism
- **SDK version:** pinned in lockfile; treated as potentially breaking on every minor bump
- **No in-app update notifications:** users discover updates via GNOME Software / KDE Discover / `flatpak update`

## Offline Capabilities

- **Startup offline:** if the app opens with no network, display last-synced timestamp and an offline indicator — no blank screen or hanging spinner
- **Mid-session network drop:** local file changes queued; sync status shows "offline — waiting for connection"; sync resumes automatically on reconnect
- **Change queue:** local changes made while offline preserved and replayed on reconnect; diffed against current remote state before upload to avoid false conflicts
- **No offline access to remote-only files:** v1 is sync-only; files must be locally present to be accessible offline (FUSE/VFS deferred to Phase 2)

## Open Questions

- **Maximum file size:** deferred to SDK capability discovery and early beta testing; if a practical limit exists it will be documented and surfaced in the UI
- **inotify watch limit on large folders:** `ENOSPC` behaviour — visible error + fallback to polling is the likely approach; to be validated during implementation
- **Bandwidth throttling (byte-rate):** desired capability — byte-rate throttling requires SDK support or network-layer interception; architecture phase to determine feasibility; concurrency-based throttling is resolved (NFR4: default cap, user-configurable in V1)
- **Pause/resume sync:** desired capability — feasibility depends on whether the SDK exposes interruption points within in-flight transfers; to be assessed in architecture phase before committing to scope
