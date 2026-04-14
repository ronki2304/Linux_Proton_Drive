# Product Scope & Phased Development

## MVP Philosophy

**Approach:** Experience MVP — the minimum that makes a non-technical Linux user say "it just works." A reliable foreground sync client that does one thing without breaking.

**Completion gate:** A non-technical user on Bazzite can install from Flathub, authenticate, sync a folder, and find their files on another machine — with zero terminal use.

**Flathub submission timing:** after MVP is complete and tested — submit a stable app, not a moving target.

**Architecture constraint:** V1 background daemon requires an IPC-capable sync engine architecture designed from day one. The sync engine is TypeScript/Node, communicating with the Python GTK4 UI over Unix socket IPC — designed for headless/daemon operation from MVP to avoid rework at V1.

## MVP — Initial Release

**Core User Journeys Supported:** first run, conflict handling, token expiry, sync pair removal.

**Must-Have Capabilities:**

- GTK4/Libadwaita desktop application
- Authentication via embedded WebKitGTK 2.40+ browser over `http://127.0.0.1` (handles CAPTCHA and 2FA)
- Post-auth account overview (name + storage used)
- One or more user-selected folder pairs via XDG File Chooser portal
- First-sync progress display (file count + bytes transferred + ETA)
- Two-way continuous sync while app is open (foreground only)
- Conflict copy creation (`filename.ext.conflict-YYYY-MM-DD`) — no silent overwrites *(3–4 stories: detection, creation, notification, log UI)*
- In-app conflict notification banner, conflict log UI, and desktop notifications for conflicts detected while the app is open; conflict copies locatable without a file manager via "Reveal in Files" portal action
- Re-auth modal with queued change count when session token expires *(3 stories: queue persistence, replay on reconnect, false-conflict prevention)*
- Live sync status panel (in-progress operations, last synced timestamp)
- Startup and mid-session offline state display with change queuing
- Sync pair removal with explicit "no files deleted on either side" confirmation
- Window state persistence across sessions
- Flatpak packaging, AppStream/metainfo XML, desktop file, OARS content rating (`oars-1.1`, all fields `none`)
- MIT license

## V1 — Full Release

*Background sync daemon, system tray, and background notifications are coupled — they ship together or not at all. Foreground desktop notifications (conflicts while app is open) ship in MVP.*

- Background sync daemon (systemd user service via Background Portal — user approves once)
- System tray integration (StatusNotifier via `--talk-name=org.kde.StatusNotifierWatcher`)
- Desktop notifications for sync events and conflicts that occur while the app window is closed
- User-configurable maximum concurrent file transfers

## Phase 2

- FUSE/virtual filesystem mount (online-only file stubs)
- KDE/Plasma visual theming (Libadwaita renders on KDE but looks out of place)

## Vision

- Deep KDE integration (KIO plugin, KWallet credential storage, Dolphin overlay icons)
- Proton-acknowledged integration / official endorsement
- Reference implementation for open-source, SDK-native Linux cloud sync

## Risk Mitigation

**Technical risks:**
- *Sync engine is TypeScript/Node* — communicates with Python GTK4 UI over Unix socket IPC; designed for V1 daemon/headless operation from day one
- *SDK pre-release* — wrapper layer insulates UI; version pinned in lockfile; treat every minor bump as potentially breaking
- *WebKitGTK auth regression* — GNOME runtime version pinned in manifest; tested on Fedora 43, Ubuntu 24/25, Bazzite, Arch, SteamOS before beta

**Market risks:**
- *Proton ships GUI client* — only real competitive threat; no announced timeline; Proton's Linux delivery history makes near-term execution unlikely
- *Flathub review rejection* — AppStream, manifest, and finish-args justification built correctly from day one; submit once, submit correctly

**Resource risks:**
- *Solo/small team* — MVP scope deliberately minimal; Flathub review timeline outside project control
- *SDK breaking change mid-development* — version pinned until V1 ships
