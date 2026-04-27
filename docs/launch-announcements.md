# Launch Announcement Drafts

## 1. r/ProtonDrive (primary target)

**Title:** `I built an open-source Proton Drive sync client for Linux (GTK4, official SDK, GPL-3.0) — looking for feedback`

**Body:**

I've been working on a native Linux sync client for Proton Drive and just tagged v1.0.0. Looking for feedback from anyone willing to try it.

**What it does:**

- Two-way file sync between local folders and your Proton Drive
- Native GTK4/Libadwaita UI — looks and feels like a GNOME app
- Built on `@protontech/drive-sdk` (the same SDK Proton's own CLI will use), not web scraping
- Auth via embedded browser — same flow as the web app, no manual token wrangling
- Conflict detection with automatic conflict copies (no silent overwrites)
- Multiple sync pairs — sync different local folders to different Proton Drive folders
- Offline resilience — changes queue while you're offline and replay on reconnect
- Token expiry recovery — re-auth prompt shows how many changes are queued, no data loss
- Error surfacing — disk full, permission denied, inotify limits, file locked

**Install (Flatpak bundle):**

```
# Download from GitHub Releases, then:
flatpak install --user io.github.ronki2304.ProtonDriveLinuxClient.flatpak
```

Flathub submission is in progress.

<!-- INSERT SCREENSHOTS HERE -->

**What I'm looking for:**

- Does the auth flow work with your account? (especially 2FA users)
- Any sync issues — files not appearing, conflicts not detected, errors not surfaced?
- UI rough edges — anything confusing or missing?
- Distro compatibility — tested on Fedora 43, Ubuntu 24/25, Bazzite, Arch. If you're on something else, I'd love to know if it works.

**Known limitations:**

- x86_64 only for now (ARM64 blocked by a WebKitGTK JIT issue — planned fix is switching to system browser auth)
- inotify watch limit may need increasing for very large folders (`fs.inotify.max_user_watches=524288`)
- No selective sync yet (full remote folder syncs)
- No tray icon yet (foreground only)

GPL-3.0, source on GitHub: https://github.com/ronki2304/Linux_Proton_Drive

Happy to answer any questions about the architecture or take feature requests.

---

## 2. r/linux

**Title:** `Show r/linux: Native GTK4 sync client for Proton Drive — open source, official SDK, looking for testers`

**Body:**

There's no official Proton Drive sync client for Linux. The third-party options either scrape the web API or are abandoned. So I built one using Proton's official `@protontech/drive-sdk`.

**The stack:**

- UI: Python + GTK4/Libadwaita (native GNOME look)
- Sync engine: TypeScript/Bun (separate process, talks to UI over Unix socket)
- Auth: Embedded WebKitGTK browser with localhost callback (approach confirmed by Proton SDK team)
- Packaging: Flatpak (Flathub submission pending)
- License: GPL-3.0

**What works today:** two-way sync, multiple sync pairs, conflict detection, offline queueing, token expiry recovery, actionable error messages (disk full, permissions, inotify, file locked).

<!-- INSERT SCREENSHOTS HERE -->

Just tagged v1.0.0 and I'm looking for real-world feedback before polishing further. Install the Flatpak bundle from GitHub Releases: https://github.com/ronki2304/Linux_Proton_Drive

Tested on Fedora 43, Ubuntu 24/25, Bazzite, Arch. x86_64 only for now. Would love reports from other distros.

---

## 3. r/ProtonMail (cross-post — shorter variant)

**Title:** `Open-source Proton Drive sync client for Linux — v1.0.0 released, looking for testers`

**Body:**

I built a native Linux desktop client for Proton Drive — GTK4/Libadwaita UI, two-way sync, conflict detection, offline queueing, multi-pair support. Uses Proton's official `@protontech/drive-sdk`, not web scraping. GPL-3.0.

Just hit v1.0.0 and I'm looking for feedback from real users. Packaged as Flatpak — grab the bundle from GitHub Releases.

<!-- INSERT SCREENSHOTS HERE -->

If you're on Linux and use Proton Drive, I'd love to hear what breaks, what's confusing, and what's missing.

https://github.com/ronki2304/Linux_Proton_Drive

---

## 4. Hacker News — Show HN

**Title:** `Show HN: Open-source Proton Drive sync client for Linux (GTK4, official SDK)`

**Body:**

Native GTK4 desktop client that syncs local folders with Proton Drive on Linux. Uses Proton's official `@protontech/drive-sdk` rather than scraping.

Two-way sync, conflict detection, offline queueing, multi-pair support. Packaged as Flatpak. GPL-3.0.

Just hit v1.0.0 — looking for feedback from Proton users on Linux.

https://github.com/ronki2304/Linux_Proton_Drive

---

## 5. Proton Community Forum

**Title:** `Unofficial open-source Proton Drive sync client for Linux — v1.0.0`

**Body:**

Hi all,

I've built an unofficial sync client for Proton Drive on Linux and just released v1.0.0. It's a native GTK4/Libadwaita desktop app that uses Proton's official `@protontech/drive-sdk` — the same SDK the upcoming Proton CLI will use.

**Features:**

- Two-way file sync with conflict detection
- Multiple sync pairs (different local folders to different Drive folders)
- Offline change queuing with automatic replay on reconnect
- Token expiry recovery without data loss
- Actionable error messages (disk full, permissions, inotify limits, file locked)
- Embedded browser auth with 2FA support

**Install:** Flatpak bundle available on GitHub Releases. Flathub submission is in progress.

**Looking for:** feedback on auth flow, sync reliability, UI, and distro compatibility. Tested on Fedora 43, Ubuntu 24/25, Bazzite, Arch (x86_64).

GPL-3.0: https://github.com/ronki2304/Linux_Proton_Drive

---

## Posting order (recommended)

1. **r/ProtonDrive** — post first, this is your highest-conversion audience
2. **r/ProtonMail** — same day or next day
3. **Proton Community Forum** — same day as r/ProtonMail
4. **r/linux** — 1-2 days later, after incorporating any early feedback
5. **Hacker News** — post independently, best on a weekday morning US time (Tue-Thu)

## Before posting

- [ ] Add screenshots to `screenshots/` directory (main-window.png, pair-detail.png, sign-in.png)
- [ ] Replace `<!-- INSERT SCREENSHOTS HERE -->` with actual image links
- [ ] Verify the Flatpak bundle download works from a clean machine
- [ ] Confirm GitHub Releases page has clear install instructions
