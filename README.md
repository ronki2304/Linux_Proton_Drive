# ProtonDrive Linux Client

An unofficial open-source sync client for [ProtonDrive](https://proton.me/drive) on Linux — built as a native GTK4 desktop app using Proton's official SDK.

> **MVP release.** Core sync workflows are complete and functional. Flathub submission is in progress.

---

## What it does

- Authenticate with your Proton account via an embedded browser — no manual token management
- Set up one or more local folders to sync with ProtonDrive
- Two-way sync with conflict detection and automatic conflict copies
- Offline resilience — changes queue while offline and replay on reconnect
- Token expiry recovery — re-auth modal with queued change count, no data loss
- Error surfacing — disk full, permission denied, inotify limit exceeded, file locked
- Multi-pair management — add, remove, and manage multiple sync pairs independently

---

## Why this exists

No native ProtonDrive sync client exists for Linux. Third-party tools either scrape the web API or go unmaintained. This client uses `@protontech/drive-sdk` — Proton's own SDK, the same one their CLI will use — so it stays compatible as the API evolves.

The embedded WebKitGTK auth approach (localhost callback) was validated directly with the Proton SDK team and confirmed as the canonical pattern for desktop clients.

---

## Installation

Flatpak is the only supported installation method for the MVP.

```bash
flatpak install flathub io.github.ronki2304.ProtonDriveLinuxClient
```

> Flathub submission is pending. Until it lands, install from the bundle in [GitHub Releases](https://github.com/ronki2304/ProtonDrive-LinuxClient/releases).

### Why `--filesystem=home`?

The Flatpak manifest requests broad filesystem access. This is a platform limitation: inotify (the Linux file-watching mechanism used for real-time sync) requires direct filesystem access — the XDG portal FUSE layer does not fire inotify events. This is a confirmed upstream limitation ([xdg-desktop-portal #567](https://github.com/flatpak/xdg-desktop-portal/issues/567)), not a design choice. A full plain-language justification is included in the manifest comments.

---

## Building from source

Requirements: Python 3.12, [Bun](https://bun.sh) ≥ 1.1, Meson, GNOME Platform runtime 50.

```bash
git clone https://github.com/ronki2304/ProtonDrive-LinuxClient
cd ProtonDrive-LinuxClient
bun install
distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson setup builddir && /usr/bin/meson compile -C builddir"
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development setup, two-terminal launch procedure, and test commands.

---

## Debug logging

To follow engine activity in real time:

```bash
# Launch with debug logging enabled
PROTONDRIVE_DEBUG=1 flatpak run io.github.ronki2304.ProtonDriveLinuxClient

# In a second terminal
tail -f ~/.cache/protondrive/engine.log
```

Log file is capped at 5 MB and rotates to `engine.log.1`. Tokens are never written to the log.

---

## Roadmap

### MVP (complete — Epics 1–6)

| Area | Status |
|------|--------|
| Proton authentication (embedded WebKit + localhost callback) | ✅ |
| First sync pair setup wizard | ✅ |
| Two-way file sync engine | ✅ |
| Offline resilience & change queue | ✅ |
| Conflict detection & copy creation | ✅ |
| Conflict log & reveal in Files | ✅ |
| Token expiry recovery with queued-change count | ✅ |
| Actionable errors (disk full, permissions, inotify, file locked) | ✅ |
| Multi-pair management (add, remove, nesting/overlap validation) | ✅ |
| Missing local folder detection & recovery | ✅ |

### Flathub release (Epic 7 — in progress)

- Flatpak manifest with justified permissions
- AppStream metainfo & desktop file for GNOME Software / KDE Discover
- CI/CD pipelines (automated test + release builds)
- End-to-end manual validation on Fedora 43, Ubuntu 24/25, Bazzite, Arch

### Post-MVP (planned)

- **System-browser auth** — replace embedded WebKit with `Gio.AppInfo.launch_default_for_uri()` for the Proton login flow. Improves hardware-key 2FA, password manager autofill, and enables aarch64 support (current WebKitGTK JIT instability on ARM64). Same localhost callback pattern, no server-side changes.
- **ARM Linux support** — blocked on system-browser auth above.
- **Remote change polling** — currently the engine detects remote changes only on startup and periodic reconcile. A polling loop or SDK event subscription would surface remote-side edits faster.
- **Selective sync** — choose which remote subfolders to sync per pair, rather than syncing the full remote folder.
- **Tray icon** — background sync with system tray status indicator, without keeping the main window open.

### Known MVP limitations

- No automated integration tests — Proton's auth requires CAPTCHA; integration tests need a manually captured token (`PROTONDRIVE_DEBUG=1` + `secret-tool`). Documented in CONTRIBUTING.md.
- inotify watch limit — the Linux default of 8192 watches may be insufficient for very large sync folders. Increase with `fs.inotify.max_user_watches=524288` in `/etc/sysctl.d/`. The app surfaces this as an actionable error.
- Same-day conflict copies — if the same file produces two conflicts on the same calendar day, the second copy overwrites the first. Rare in practice; scheduled for post-MVP hardening.

---

## License

MIT — see [LICENSE](./LICENSE).
