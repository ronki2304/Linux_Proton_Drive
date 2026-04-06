---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-02b-vision', 'step-02c-executive-summary', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish']
inputDocuments:
  - '_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient.md'
  - '_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient-distillate.md'
  - '_bmad-output/planning-artifacts/research/technical-linux-packaging-formats-research-2026-04-01.md'
  - '_bmad-output/project-context.md'
workflowType: 'prd'
classification:
  projectType: desktop_app
  domain: cloud_storage_privacy
  complexity: medium_high
  projectContext: greenfield
briefCount: 2
researchCount: 1
projectDocsCount: 0
---

# Product Requirements Document - ProtonDrive-LinuxClient

**Author:** Jeremy
**Date:** 2026-04-06

## Executive Summary

Over 100 million people trust Proton with their most sensitive files. On Windows and macOS, that trust comes with a desktop sync client. On Linux, it comes with nothing — rclone's ProtonDrive backend broke in September 2025 and was delisted in February 2026, the only community GUI attempt (DonnieDice) fails authentication on every mainstream distro, and Celeste — the last maintained multi-cloud sync Flatpak with ProtonDrive support — was archived in November 2025. The Flathub slot is vacant. Users are cancelling subscriptions and moving to pCloud.

ProtonDrive Linux Client is an open-source GTK4/Libadwaita desktop application that syncs selected folders between the user's machine and ProtonDrive. Authenticate once, select your folders, and sync runs continuously while the app is open. It ships on Flathub — the only distribution channel that reaches immutable distro users on Bazzite, Silverblue, and SteamOS — before Proton's own announced CLI (Q2 2026) captures the mindshare, and with no GUI or Flatpak commitment from Proton on the horizon.

### What Makes This Special

The enabling event is the publication of `@protontech/drive-sdk` — Proton's official, MIT-licensed SDK. Every prior community attempt reverse-engineered a private API. This project is built on the same foundation as Proton's own applications, which means it tracks breaking changes before they hit users rather than discovering them after. The SDK publication transformed this from "another workaround" into a legitimate client.

The auth problem that killed DonnieDice is solved: Tauri's `tauri://` URI scheme blocks WebKitGTK Web Workers, which Proton's SRP crypto requires. A native GTK4 app serves the auth webview over `http://127.0.0.1`, which WebKitGTK treats as a fully trusted origin. Workers load, SRP completes, login works — not a workaround, the correct embedding architecture.

For immutable distro users (Bazzite, Silverblue, SteamOS) — the fastest-growing segment of the Linux desktop market — Flatpak is structurally the only delivery mechanism. Flathub-first packaging is the primary design constraint, not an afterthought. The app is open-source by necessity: ProtonDrive's value is client-side E2EE, and a closed-source sync client is a contradiction for users who chose Proton precisely because they can verify what handles their keys.

## Project Classification

- **Project Type:** Desktop application (GTK4/Libadwaita, Linux-only)
- **Domain:** Cloud storage / privacy tooling
- **Complexity:** Medium-High — no regulatory requirements, but sharp technical constraints: WebKitGTK auth, Flatpak sandbox/inotify limitations, ProtonDrive SDK SRP implementation, two-layer UI/sync-engine architecture
- **Project Context:** Greenfield — prior TypeScript/Bun CLI iteration discarded; starting from scratch on the UI

## Success Criteria

### User Success

- First-run experience completes without terminal use and without reading documentation — user authenticates, selects a folder, and sees sync start within 5 minutes of installing from Flathub
- Sync runs reliably while the app is open — no silent failures; errors surface visibly in the UI
- Conflict copies are created correctly, users are notified in-app, and conflict copies are locatable from the UI without needing a file manager
- Re-authentication flow is clear when session token expires — user is prompted via a visible in-app modal or banner, not left with a stalled sync

### Business Success

- Flathub listing published and passing quality review at v1 launch *(primary gate)*
- Flathub submission submitted before implementation completes; first review response tracked within 2 weeks of submission
- 1,000 Flathub installs within 3 months of stable release *(stretch goal)*
- At least X% of installers have an active sync pair after 7 days *(retention signal — baseline TBD from first-month data)*
- 500 GitHub stars within 6 months
- Active community presence on r/ProtonMail, r/linux, and Proton community forum at launch week
- Community answer shift measurable: this project is the linked answer in the top ProtonDrive Linux threads on Reddit and Proton forum within 6 months
- Project linked from at least one Proton-official knowledge base or status page within 6 months

### Technical Success

- Sync engine language and IPC mechanism decided and documented before implementation begins
- Passes Flathub quality review with correct sandbox permissions justified (static `--filesystem` for inotify, libsecret for credentials)
- Zero critical data loss reports before stable release — conflict copy behaviour verified across real-world conflicting-edit scenarios
- Auth succeeds on Fedora 43, Ubuntu 24/25, Bazzite, Arch — the distros DonnieDice failed on
- Binary builds reproducibly via CI on tag push; no manual release steps

### Measurable Outcomes

- Zero data loss is a hard ongoing requirement post-launch, not just a pre-stable gate
- Flathub install count is the primary adoption signal; 7-day retention rate is the product health signal
- Community answer shift tracked via specific Reddit and Proton forum thread monitoring

## Product Scope & Phased Development

### MVP Philosophy

**Approach:** Experience MVP — the minimum that makes a non-technical Linux user say "it just works." A reliable foreground sync client that does one thing without breaking.

**Completion gate:** A non-technical user on Bazzite can install from Flathub, authenticate, sync a folder, and find their files on another machine — with zero terminal use.

**Flathub submission timing:** after MVP is complete and tested — submit a stable app, not a moving target.

**Architecture constraint:** V1 background daemon requires an IPC-capable sync engine architecture designed from day one. The sync engine language choice (deferred to architecture phase) must account for headless/daemon operation; failing to design for this in MVP forces a rework at V1.

### MVP — Initial Release

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

### V1 — Full Release

*Background sync daemon, system tray, and background notifications are coupled — they ship together or not at all. Foreground desktop notifications (conflicts while app is open) ship in MVP.*

- Background sync daemon (systemd user service via Background Portal — user approves once)
- System tray integration (StatusNotifier via `--talk-name=org.kde.StatusNotifierWatcher`)
- Desktop notifications for sync events and conflicts that occur while the app window is closed
- User-configurable maximum concurrent file transfers

### Phase 2

- FUSE/virtual filesystem mount (online-only file stubs)
- KDE/Plasma visual theming (Libadwaita renders on KDE but looks out of place)

### Vision

- Deep KDE integration (KIO plugin, KWallet credential storage, Dolphin overlay icons)
- Proton-acknowledged integration / official endorsement
- Reference implementation for open-source, SDK-native Linux cloud sync

### Risk Mitigation

**Technical risks:**
- *Sync engine language TBD* — deferred to architecture phase; must account for V1 daemon/headless operation from day one; gates IPC design and testing strategy
- *SDK pre-release* — wrapper layer insulates UI; version pinned in lockfile; treat every minor bump as potentially breaking
- *WebKitGTK auth regression* — GNOME runtime version pinned in manifest; tested on Fedora 43, Ubuntu 24/25, Bazzite, Arch, SteamOS before beta

**Market risks:**
- *Proton ships GUI client* — only real competitive threat; no announced timeline; Proton's Linux delivery history makes near-term execution unlikely
- *Flathub review rejection* — AppStream, manifest, and finish-args justification built correctly from day one; submit once, submit correctly

**Resource risks:**
- *Solo/small team* — MVP scope deliberately minimal; Flathub review timeline outside project control
- *SDK breaking change mid-development* — version pinned until V1 ships

## Innovation & Novel Patterns

### Detected Innovation Areas

**The Auth Fix Nobody Else Could Ship — With Tauri**
DonnieDice's WebKitGTK authentication failure has a documented structural root cause: Tauri serves its frontend via `tauri://localhost`, WebKitGTK blocks Web Workers from non-`http/https` origins, and Proton's SRP auth flow requires Web Workers. Login never completes, and Tauri doesn't expose the API needed to fix it. A native GTK4 app serves the auth webview over `http://127.0.0.1` via an embedded localhost HTTP server — a well-established pattern used by Spotify, VS Code, and GitHub CLI for OAuth flows. WebKitGTK treats this as a fully trusted origin. Workers load, SRP completes. This is not an invented technique — it is the correct application of a proven pattern that Tauri's architecture structurally prevented.

**First Official-SDK Linux GUI Client**
Every prior community ProtonDrive client — rclone, DonnieDice, henrybear327/Proton-API-Bridge — reverse-engineers Proton's private API. This project is built on `@protontech/drive-sdk`, the same MIT-licensed SDK as Proton's own applications. SDK API-surface changes surface as compile-time errors; semantic regressions are caught by integration testing against the wrapper layer. This fundamentally changes the maintenance posture from "racing against Proton" to "moving with Proton." If Proton were to deprecate or relicense the SDK (low probability), the MIT license provides fork rights — the last stable version remains usable and forkable.

**First Sync Client That Works on Immutable Distros Without Workarounds**
Bazzite, Fedora Silverblue, and SteamOS users have no alternative to Flatpak for third-party apps. This project treats Flatpak's constraints — static `--filesystem` for inotify, Secret portal for credentials, Background Portal for autostart — as first-class design requirements from day one. The result: install from GNOME Software or Steam Discover, open the app, pick a folder, sync works. No terminal. No manual permission grants.

### Market Context & Competitive Landscape

| Signal | Status |
|---|---|
| Celeste (only maintained multi-cloud sync Flatpak with ProtonDrive) | Archived November 2025 — users searching for solutions are hitting dead ends |
| DonnieDice (only active GUI ProtonDrive client) | Auth broken on all mainstream distros; no Flathub; no sync engine |
| rclone ProtonDrive backend | Broken September 2025, delisted February 2026 |
| Proton official CLI | Announced Q2 2026; CLI only; no GUI or Flatpak commitment; Proton's Linux delivery track record uncertain |
| Linux Steam share | 5.33% March 2026 — all-time high; Bazzite/SteamOS users structurally Flatpak-dependent |

### Validation Approach

- **Auth fix:** Confirmed working on Fedora 43, Ubuntu 24/25, Bazzite, Arch, and SteamOS before beta — specifically the distros DonnieDice fails on; pass/fail is binary
- **SDK-native posture:** Every SDK version bump that doesn't break the build is a validation data point; every compile error caught before users see it proves the wrapper layer working
- **Non-technical user validation:** First-run flow tested with users who are not developers — if they need documentation or a terminal, the flow has failed
- **Flatpak quality review:** Passing Flathub review without permission exceptions validates the Flatpak-native design claim

## Domain-Specific Requirements

### Privacy

- Files are encrypted client-side before leaving the machine — the app must never log, cache, or expose decrypted file content or file paths beyond what sync requires
- The application makes no network connections of its own — all network I/O is delegated to the ProtonDrive SDK; no analytics, telemetry, update checks, or CDN calls exist in application code; updates are delivered exclusively via Flathub
- The app introduces no additional data storage or transmission beyond what the SDK sends to Proton's infrastructure — no third-party endpoints, no phone-home of any kind
- SQLite state DB stores file paths and sync history in plaintext — acceptable for v1, must be explicitly documented in README and security notes

### Security

- Session token must never appear in logs, stdout, stderr, or JSON output under any circumstances
- Credentials stored via libsecret Secret portal (GNOME) or libsecret local fallback (cross-desktop) — never in plaintext config files
- FileStore credential file must be `0600` permissions, set immediately on creation before any content is written
- Localhost auth server: bind to `127.0.0.1` only (not `0.0.0.0`), use a randomly assigned ephemeral port, close the listener immediately after the auth callback is received — no persistent open port
- Decrypted content buffers zeroed after use — best-effort in v1 given GC runtime constraints, but documented as a requirement
- Crash output must be sanitised — no file paths, tokens, credentials, or user data in crash output or stderr dumps

### Technical Constraints (Flatpak)

- Static `--filesystem` permission required for inotify — portal FUSE does not fire inotify events (confirmed upstream bug xdg-desktop-portal #567); Flathub submission must include justification
- Credential storage via Secret portal or libsecret local fallback — never via direct `--talk-name=org.freedesktop.secrets` (insecure: grants cross-app secret access)
- System proxy settings must be respected (`http_proxy`/`https_proxy` env vars and GNOME proxy settings) — or explicitly documented as unsupported in v1 with a filed issue
- No in-app update mechanism — Flathub OSTree is the sole update delivery channel; self-update would bypass sandbox verification
- Background Portal autostart ships in V1 — requires one-time user approval via system dialog; no silent systemd service registration

### Log Policy

- No persistent logs in v1 — if any error output is written to disk in future versions, it goes to `$XDG_CACHE_HOME/protondrive/logs/`, contains no file paths, tokens, or file content, and is rotated with a defined size cap

### SDK Risks

- ProtonDrive SDK is pre-release (`v0.14.3`) — treat as potentially breaking; wrapper/adapter layer must insulate the UI and sync engine from version transitions
- Proton crypto migration expected in 2026 — openpgp version boundary must be encapsulated in `src/sdk/`; the UI layer must never import openpgp directly
- API rate limiting: sync engine must implement exponential backoff on `429` responses and surface rate-limit state visibly to the user ("sync paused — rate limited, resuming in Xs") rather than silently failing

## Desktop Application Specific Requirements

### Platform Support

- **Target platform:** Linux only — x86_64 primary; ARM64 (Raspberry Pi, Pinebook) not committed for v1
- **Desktop environment:** GTK4/Libadwaita; GNOME and GNOME-derived desktops as primary targets; KDE/Plasma renders but visually inconsistent — full KDE integration deferred to Phase 2
- **Display server:** Wayland primary (required for Bazzite/SteamOS); X11 via XWayland
- **Distribution:** Flatpak via Flathub exclusively for v1; Snap and AppImage explicitly deferred
- **Windows/macOS:** Out of scope permanently

### System Integration

- **File watching:** inotify via static `--filesystem` Flatpak permission — not portal FUSE (confirmed broken for inotify); separate watch per subdirectory; graceful `ENOSPC` handling with visible user error; watch tree initialisation runs asynchronously and must not block the UI
- **Credential storage:** libsecret via Secret portal (GNOME) or libsecret local fallback at `~/.var/app/$FLATPAK_ID/data/keyrings/`; explicit error surfaced if neither is available
- **File chooser:** XDG File Chooser portal (`org.freedesktop.portal.FileChooser`) for sync folder selection — not a raw GTK file dialog; ensures correct sandbox behaviour and GNOME UX
- **State persistence:** SQLite at `$XDG_DATA_HOME/protondrive/state.db`; file paths and sync history in plaintext (documented); each sync state record stores both the local mtime and remote mtime at the time of last successful sync, plus an optional content hash for conflict detection fallback
- **Config:** YAML at `$XDG_CONFIG_HOME/protondrive/config.yaml`; XDG paths resolved via env var with `~/.config` / `~/.local/share` fallbacks
- **Window state:** window geometry saved to `$XDG_STATE_HOME/protondrive/` on close and restored on open
- **Proxy:** system proxy settings respected (`http_proxy`/`https_proxy` and GNOME proxy settings) — or explicitly documented as unsupported in v1 with a filed issue
- **WebKitGTK:** version 2.40+ required for trusted-origin behaviour on `http://127.0.0.1`; GNOME runtime version pinned in Flatpak manifest to prevent auth regression from runtime updates

### Flathub Submission Requirements

- **App ID:** reverse-DNS format (e.g. `io.github.username.ProtonDriveLinuxClient`) — must be decided before implementation begins; propagates to manifest, AppStream, desktop file, D-Bus service names, and XDG paths
- **AppStream/metainfo XML:** required deliverable — app ID, name, summary, description, screenshots, release notes, developer info, OARS content rating (`oars-1.1`, all fields `none` for this app type)
- **Desktop file:** `Categories=Network;FileTransfer;`, `Keywords=sync;proton;drive;cloud;`, correct Flatpak `Exec=` line, `StartupNotify=true`
- **finish-args justification document:** written justification for every Flatpak permission prepared before submission — `--share=network`, `--filesystem=` (inotify requirement), `--talk-name=org.freedesktop.portal.Secret`; Flathub reviewers will ask about each

### Update Strategy

- **Update mechanism:** Flathub OSTree exclusively — delta updates, no in-app updater, no self-update mechanism
- **SDK version:** pinned in lockfile; treated as potentially breaking on every minor bump
- **No in-app update notifications:** users discover updates via GNOME Software / KDE Discover / `flatpak update`

### Offline Capabilities

- **Startup offline:** if the app opens with no network, display last-synced timestamp and an offline indicator — no blank screen or hanging spinner
- **Mid-session network drop:** local file changes queued; sync status shows "offline — waiting for connection"; sync resumes automatically on reconnect
- **Change queue:** local changes made while offline preserved and replayed on reconnect; diffed against current remote state before upload to avoid false conflicts
- **No offline access to remote-only files:** v1 is sync-only; files must be locally present to be accessible offline (FUSE/VFS deferred to Phase 2)

### Open Questions

- **Sync engine language:** must be decided before architecture begins — Rust, Go, or TypeScript in a non-Bun runtime; determines Flatpak bundle structure, runtime dependencies, and V1 daemon design; this is the first architecture decision
- **IPC mechanism (in-process vs. out-of-process):** if sync engine runs out-of-process (separate subprocess or D-Bus service), language choice is unconstrained; if in-process, language is constrained to the UI layer; gates the V1 daemon architecture
- **Maximum file size:** deferred to SDK capability discovery and early beta testing; if a practical limit exists it will be documented and surfaced in the UI
- **inotify watch limit on large folders:** `ENOSPC` behaviour — visible error + fallback to polling is the likely approach; to be validated during implementation
- **Bandwidth throttling (byte-rate):** desired capability — byte-rate throttling requires SDK support or network-layer interception; architecture phase to determine feasibility; concurrency-based throttling is resolved (NFR4: default cap, user-configurable in V1)
- **Pause/resume sync:** desired capability — feasibility depends on whether the SDK exposes interruption points within in-flight transfers; to be assessed in architecture phase before committing to scope

## User Journeys

### Journey 1: First Run — "It Finally Works"

**Persona:** Layla, 34, software developer, Fedora Silverblue, paying ProtonDrive subscriber who has been manually uploading files through the browser for two years. Sees the Flathub listing on r/linux, recognises it's different from DonnieDice, opens GNOME Software.

**Opening Scene:** One click install. She opens the app and sees an embedded browser loading Proton's real login page. She enters her credentials, completes 2FA, and the app transitions to a post-auth overview screen: her account name, 47GB of 200GB used, and a list of her existing ProtonDrive folders. She knows auth worked. She trusts what she's looking at.

**Rising Action:** She clicks "Add sync pair." A folder picker lets her select `~/Documents` locally and `Documents` in ProtonDrive. She clicks Start. The sync status panel shows a live count: "Syncing 1,247 files — 340MB of 2.1GB — about 8 minutes remaining." She doesn't walk away thinking it's broken. She makes a coffee.

**Climax:** The status panel shows "Last synced 4 seconds ago." She adds a second sync pair — `~/Projects` ↔ `Projects` — from the main window without re-running any wizard. It starts immediately.

**Resolution:** No terminal. No documentation. Eleven minutes from install to two folders syncing. She posts: "Confirmed working on Silverblue. This is the one."

**Requirements revealed:** Flathub install, WebKitGTK auth, post-auth account overview (name + storage), first-run folder pair wizard, first-sync progress (file count + bytes + ETA), live sync status panel, add-subsequent-sync-pair from main UI.

---

### Journey 2: The Conflict — "I Trust It Got This Right"

**Persona:** Marcus, 41, freelance journalist, two Fedora machines (desktop at home, laptop for travel). Uses ProtonDrive for draft articles and source notes. Has been burned by last-write-wins sync before.

**Opening Scene:** Monday evening Marcus edits `interview-notes-2026-04-06.md` on his desktop, then closes the app before leaving for a trip. On Tuesday, travelling, he opens his laptop — the app was also closed there. He edits the same file, different section, and closes the laptop without opening the sync app.

**Rising Action:** Wednesday morning, home. He opens the app on his desktop. The sync engine loads its last-known state from the database, checks the remote, and detects that the remote version has a newer mtime than its last recorded sync — and so does the local file. Both changed independently since the last known sync point.

**Climax:** A yellow banner: "1 conflict — `interview-notes-2026-04-06.md`." He clicks "View conflict log." Both versions are intact: the current file, and `interview-notes-2026-04-06.md.conflict-2026-04-06` sitting in the same folder. He opens both in his editor, merges the additions, deletes the conflict copy. "It didn't choose for me. Good."

**Resolution:** Nothing lost. The safety guarantee held even across app restarts and offline edits on two machines.

**Requirements revealed:** Conflict detection across app restarts, persistent sync state in StateDB (last-known mtime per file), conflict copy creation (`filename.ext.conflict-YYYY-MM-DD`), in-app conflict notification banner, conflict log UI, no silent overwrites.

---

### Journey 3: Token Expiry — "Don't Just Stall On Me"

**Persona:** Layla again, six weeks after first run. Sync is background noise — she doesn't think about it. While her session token was expired, she edited four files.

**Opening Scene:** The sync engine gets a 401. It does not retry into a loop. The app detects the four locally-changed files are queued but unsent. The window header shifts to a warning state. When Layla brings the window forward she sees a modal: "Your session has expired. 4 local changes are waiting to sync. Sign in to resume."

**Rising Action:** She clicks "Sign in." WebKitGTK auth opens — same embedded flow. She completes 2FA. The modal closes.

**Climax:** The sync engine replays the four queued local changes against the current remote state. None of them conflict with remote changes — they were local-only edits made during the downtime. No spurious conflict copies are created. The status panel shows "4 files synced."

**Resolution:** 45-second interruption. Layla returns to work. No reconfiguration, no lost changes, no false conflict copies for files she edited during the gap.

**Requirements revealed:** 401 detection, change queue preserved during expired session, re-auth modal with queued change count, change queue replayed without false conflicts after re-auth, sync state preserved across re-auth.

---

### Journey 4: The Contributor — "I Need to See the Code"

**Persona:** Tariq, 28, security engineer, NixOS. Does not install software he cannot read. Uses ProtonDrive for encrypted backups of contracts, identity documents, and PGP key material. Found the project via Hacker News.

**Opening Scene:** Tariq reads the repository before touching GNOME Software. He checks the Flatpak manifest permissions and the justification comments. He reads the SDK boundary in `src/sdk/client.ts`. He checks credential storage — libsecret via the Secret portal. He reads the conflict copy logic. Nothing surprises him badly.

**Rising Action:** He installs the Flatpak. On NixOS, libsecret's Secret portal path doesn't resolve as expected — the app detects this, surfaces a clear error: "Credential storage unavailable via Secret portal — falling back to encrypted file store at `~/.var/app/.../credentials`." Explicit. Not silent. He files a bug with a detailed NixOS-specific repro. The maintainer responds within 24 hours.

**Climax:** Tariq submits a PR improving the credential storage fallback path for non-standard XDG environments. It gets merged. He stars the repo and links it from his security blog: "open-source cloud sync clients worth trusting."

**Resolution:** The audit, the failure, the fix, and the contribution — all in one week. This is what open source on the official SDK enables.

**Requirements revealed:** SDK boundary enforcement and documentation, documented Flatpak permission justifications, credential storage fallback with explicit error (not silent fail), public issue tracker with responsive maintainer, MIT license prominent.

---

### Journey 5: The Goodbye — "Don't Touch My Files"

**Persona:** Layla, three months in. Reorganising her folder structure, wants to stop syncing `~/Documents` and replace it with a more specific subfolder.

**Opening Scene:** She opens the sync pairs list and clicks "Remove" next to the `~/Documents` pair. A confirmation dialog appears: "Stop syncing this folder pair? Local files in `~/Documents` will not be affected. Remote files in `ProtonDrive/Documents` will not be affected. Sync will simply stop."

**Resolution:** She confirms. Both sets of files remain exactly where they are. Nothing deleted. Nothing surprising. She adds a new pair for `~/Documents/work` and moves on.

**Requirements revealed:** Sync pair removal confirmation dialog, explicit "no files will be deleted" language, removal leaves both local and remote files intact.

---

### Journey Requirements Summary

| Journey | Key Capabilities Required |
|---|---|
| First Run | Post-auth account overview, first-sync progress (count/bytes/ETA), add-subsequent-pair from main UI |
| Conflict | Persistent StateDB sync state across restarts, conflict copy, in-app conflict notification + log |
| Token Expiry | 401 detection, change queue preservation + replay, re-auth modal with queued count, no false conflicts |
| Contributor | SDK boundary docs, Flatpak permission justifications, credential fallback with explicit error |
| Sync Pair Removal | Confirmation dialog, explicit no-delete guarantee, both-sides files untouched |

## Functional Requirements

### Authentication & Session Management

- **FR1:** User can authenticate with ProtonDrive via an embedded browser on first launch or after logout — the browser handles CAPTCHA and 2FA
- **FR2:** User can view their ProtonDrive account overview (account name, storage used) after successful authentication
- **FR3:** The system validates the stored session token silently on launch and prompts re-authentication immediately if it has expired
- **FR4:** User is prompted to re-authenticate when their session token expires during an active session, without losing queued local changes
- **FR5:** User can see the count of queued local changes pending sync within the re-authentication prompt
- **FR6:** User can log out; the session token is removed and locally synced files are preserved
- **FR7:** User can view their ProtonDrive account info (name, storage, plan) at any time from within the application

### Sync Pair Management

- **FR8:** User is guided through first sync pair setup on first launch via an onboarding flow
- **FR9:** User can add a new sync pair (local folder ↔ ProtonDrive folder) from the main application window at any time after first run
- **FR10:** User can manage multiple independent sync pairs
- **FR11:** User can remove a sync pair without affecting local or remote files
- **FR12:** User sees an explicit confirmation when removing a sync pair, stating no files will be deleted on either side

### Sync Engine & File Operations

- **FR13:** The system routes to the first-run onboarding wizard when no valid session token is stored; any other state — including an authenticated session with no sync pairs configured — routes to the main application screen
- **FR14:** The system syncs file changes two-way continuously while the app is open
- **FR15:** The system displays first-sync progress including file count, bytes transferred, and estimated time remaining
- **FR16:** The system queues local file changes made while offline or during session expiry
- **FR17:** The system replays queued local changes on reconnect by fetching current remote metadata (mtime) for each queued file and comparing against the remote mtime stored at last sync; files changed only locally are uploaded without conflict; files changed on both sides since the last sync point trigger the conflict copy pattern
- **FR18:** The system displays global sync status including in-progress operations and last synced timestamp
- **FR19:** The system displays per-pair sync status including last synced time, in-progress state, and conflict state for each sync pair
- **FR20:** The system displays an offline state and last-synced timestamp when the app opens with no network available
- **FR21:** The system shows an offline indicator and queues changes when network drops mid-session
- **FR22:** The system resumes sync automatically when network becomes available, without user action
- **FR23:** The system applies exponential backoff when rate-limited by the API and surfaces the rate-limited state to the user
- **FR24:** The system shows a meaningful error message when sync fails for reasons other than network or auth, with a suggested resolution

### Conflict Management

- **FR25:** The system detects sync conflicts by comparing the current local mtime against the stored local mtime at last sync, and the current remote mtime against the stored remote mtime at last sync; where mtime resolution is ambiguous (same-second modification), the system falls back to a locally-computed content hash compared against the hash stored at last sync — no live remote fetch is performed for conflict detection
- **FR25a:** Files with no StateDB entry (never previously synced) are checked for remote path collisions before upload; if a remote file exists at the same relative path, the local file is renamed to `filename.ext.conflict-YYYY-MM-DD`, both versions are preserved, and the user is notified — consistent with the standard conflict copy pattern
- **FR26:** The system creates a conflict copy named `filename.ext.conflict-YYYY-MM-DD` — never silently overwrites
- **FR27:** User is notified in-app when one or more sync conflicts occur
- **FR27a:** The system sends a desktop notification when a sync conflict is detected while the application window is open (foreground notification — does not require the background daemon)
- **FR28:** User can view a log of all sync conflicts within the application
- **FR29:** User can locate conflict copies from within the application without opening a file manager; the conflict log provides a "Reveal in Files" action for each entry, implemented via `org.freedesktop.portal.OpenURI`

### Background Sync & Notifications *(V1)*

*Background sync daemon, system tray, and background notifications are coupled — they ship together in V1.*

- **FR30:** The system continues syncing files in the background after the main window is closed *(V1)*
- **FR31:** User can approve the application's request to run in the background via the system Background Portal *(V1)*
- **FR32:** User can view sync status from the system tray without opening the main window *(V1)*
- **FR33:** User receives desktop notifications for sync events and conflicts that occur while the app window is closed *(V1 — background notifications; foreground notifications covered by FR27a)*
- **FR33a:** User can configure the maximum number of concurrent file transfers from application settings *(V1)*

### Security & Credential Management

- **FR34:** The system stores the ProtonDrive session token via the OS credential store and reuses it on subsequent launches without requiring re-authentication
- **FR35:** The system falls back to an encrypted local credential store if the OS credential store is unavailable
- **FR36:** The system surfaces an explicit error if no credential storage method is available
- **FR37:** The system makes no network connections of its own — all network I/O is delegated to the ProtonDrive SDK

### Application & Platform

- **FR38:** User can select sync folders via the system file chooser dialog
- **FR39:** The application window size and position are preserved between sessions
- **FR40:** The system respects system proxy settings for all network operations
- **FR41:** The application source code is publicly available under MIT license
- **FR42:** The application receives updates exclusively through Flathub — no in-app update mechanism

## Non-Functional Requirements

### Performance

- **NFR1:** The application UI is ready for user interaction (main window rendered, stored token loaded from credential store) within 3 seconds of launch — independent of network availability or API response time
- **NFR2:** User interface interactions (button presses, navigation, dialog opens) respond within 200ms — the UI must never block on sync engine operations
- **NFR3:** Local file change detection (inotify event to sync queue entry) completes within 5 seconds of a file being modified — measured after initial inotify watch tree setup is complete
- **NFR3a:** inotify watch tree initialisation runs asynchronously and does not block user interaction; the UI remains responsive (NFR2) throughout watch tree setup; sync status shows a "Initializing file watcher…" indicator while setup is in progress
- **NFR4:** When not throttled or paused, sync throughput is limited only by network bandwidth and SDK capacity; the sync engine caps concurrent file transfers at a default maximum of 3 (user-configurable in V1 via FR33a) to bound CPU and memory usage under load
- **NFR5:** Application memory footprint during steady-state sync (no active transfers, inotify watches active) for a folder tree with up to 10,000 files does not exceed 150MB RSS

### Security

- **NFR6:** The session token must not appear in any log output, stdout, stderr, crash dump, or debug trace under any circumstances
- **NFR7:** The credential file (fallback store) must have `0600` permissions set before any content is written
- **NFR8:** The localhost auth server must bind exclusively to `127.0.0.1` on a randomly assigned ephemeral port and close immediately after the auth callback is received
- **NFR9:** No decrypted file content or file paths appear in any persistent log or diagnostic output
- **NFR10:** The application contains no HTTP client code outside `src/sdk/` — verifiable by static analysis (grep for network/fetch imports outside the SDK boundary)

### Reliability

- **NFR11:** Zero file data loss — a conflict copy must always be created before any local file is overwritten; this must hold across app restarts, network interruptions, and session expiry
- **NFR12:** All file writes use atomic rename (write to `.dl-tmp-<timestamp>-<random>`, then `rename()` on success) — partial writes must never appear at the destination path
- **NFR13:** The sync engine verifies file integrity after download before committing to the destination path — a corrupted download must not silently replace the user's file; integrity is verified using the SDK-returned content hash where available, falling back to a locally-computed hash; the specific mechanism is determined during SDK integration
- **NFR14:** The local change queue is persisted to disk and survives application crashes — no queued change is silently lost on unexpected termination
- **NFR15:** Sync state (last-known local mtime, remote mtime, and optional content hash per file per sync pair) is written to SQLite before a sync operation is considered complete — no in-memory-only state
- **NFR16:** The application recovers to a consistent sync state after a crash without user intervention — consistent state defined as: sync pairs intact, token present, last-known mtime preserved in SQLite, no partial files at destination paths; crash recovery is detected by the presence of incomplete `.dl-tmp-*` files at startup or a dirty-session flag in the state DB, and resolved before the first sync operation begins
- **NFR17:** Auth failure (401) is detected within one failed sync attempt; the sync engine immediately halts and triggers re-auth — no silent 401 retry

### Accessibility

- **NFR18:** The application exposes a complete AT-SPI2 accessibility tree — all interactive elements are reachable and operable by the Orca screen reader
- **NFR19:** All application functions are fully operable via keyboard navigation — no capability requires a pointer device
- **NFR20:** Text contrast ratios meet WCAG AA minimum (4.5:1 for body text, 3:1 for large text) — Libadwaita's default palette satisfies this; any custom colour usage must not regress it

### Open Questions

- **Pause/resume sync:** desired capability — feasibility depends on whether the SDK exposes interruption points within in-flight transfers; to be assessed in architecture phase before committing to scope
- **Bandwidth throttling (byte-rate):** desired capability — byte-rate throttling requires SDK support or network-layer interception; concurrency-based throttling is resolved (NFR4: default cap of 3, user-configurable in V1); architecture phase to determine byte-rate feasibility
