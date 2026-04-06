---
title: "Product Brief Distillate: ProtonDrive-LinuxClient"
type: llm-distillate
source: "product-brief-ProtonDrive-LinuxClient.md"
created: "2026-04-06"
purpose: "Token-efficient context for downstream PRD creation"
---

# Product Brief Distillate: ProtonDrive Linux Client

## Strategic Context

- This is a **fresh greenfield project** — prior CLI iteration (TypeScript/Bun) is discarded; no existing UI code; start from scratch
- **Pivot reason:** CLI-first approach failed because ProtonDrive SDK requires CAPTCHA+2FA at auth, making headless/scripted use impossible; GUI is now v1, CLI is deferred to v2+
- **Window:** Celeste (only maintained multi-cloud sync Flatpak with ProtonDrive support) was archived November 2025 — there is currently zero maintained GUI ProtonDrive sync client on Flathub
- **Urgency:** Proton announced official CLI for Q2 2026 (April–June window); no GUI or Flatpak commitment from Proton; must ship before or immediately after their CLI to capture mindshare
- **Demand signal:** 5,700+ UserVoice votes for a Linux client — second-most-requested feature in Proton's history; users explicitly citing subscription cancellations and switching to pCloud

## Target Users

- **Primary:** Linux desktop users (GNOME/GNOME-derived) who pay for ProtonDrive and expect sync to work; comfortable installing from Flathub; do NOT want CLI configuration; want "open app, pick folder, sync works"
- **Secondary:** Immutable distro users (Bazzite, Fedora Silverblue, SteamOS) — structurally dependent on Flatpak; Bazzite alone is ~5.5% of Linux Steam users; fastest-growing Linux demographic
- **Excluded in v1:** KDE/Plasma users — Libadwaita will render but look out of place; full KDE integration is v2
- **Excluded in v1:** Sysadmins/developers needing headless scripting — that's the deferred CLI v2
- **Not targeted:** Windows, macOS users — explicitly out of scope permanently for this project

## Tech Stack Decisions

- **UI layer:** GTK4/Libadwaita (GJS or Python/PyGObject) — native GNOME, Flathub-preferred, correct choice for immutable distro audience
- **UI ≠ sync engine:** Two-layer architecture required — GTK4 UI communicates with sync engine via IPC/socket; sync engine language TBD (can be Rust, Go, or TypeScript in a non-Bun runtime)
- **Tauri rejected:** DonnieDice proved Tauri fails; root cause is not fixable without framework changes (see WebKitGTK Auth section below)
- **Electron rejected:** Too heavy; privacy-conscious audience actively distrusts it; conflicts with project values
- **Distribution:** Flatpak/Flathub only for v1; Snap and AppImage explicitly deferred
- **License:** MIT

## WebKitGTK Auth — Root Cause Analysis (Critical)

- **DonnieDice failure mode (confirmed via WORKER_DEBUGGING.md and GitHub issues #25, #32):** Tauri serves frontend via custom `tauri://localhost` scheme → WebKitGTK blocks Web Workers from non-`http/https` origins → Proton's auth flow uses Workers for SRP crypto → login spins forever, never completes; reproduced on Fedora 43, Ubuntu 24/25, Bazzite, Arch, Debian 13
- **Secondary issue:** WebKitGTK 2.44+ has EGL/DMA-BUF rendering bug (WebKit bug #280239) causing white screens on Fedora 40+ and AMD/Wayland — separate from the Worker issue
- **Fix for native GTK4 app:** Serve Proton auth webview over `http://127.0.0.1` (embedded localhost HTTP server) — WebKitGTK treats this as fully trusted origin, Workers load correctly; this is the chosen implementation approach for v1 auth
- **Alternative fix:** `webkit_security_manager_register_uri_scheme_as_secure()` — available to native GTK4 apps, not exposed by Tauri
- **Auth flow:** Embedded WebKitGTK browser over localhost handles CAPTCHA and 2FA interactively; session token cached after first login; subsequent syncs use cached token without re-auth
- **Session token lifetime:** Tokens expire; re-auth requires interactive session (user must be present); v1 foreground-only model is consistent with this — no unattended re-auth problem in v1

## Flatpak/Sandbox Constraints (Implementation-Critical)

- **inotify:** Portal FUSE mount does NOT fire inotify events (confirmed bug: xdg-desktop-portal #567); must use static `--filesystem` permission for sync to work; Flathub reviewers will scrutinize — requires justification in submission
- **Background autostart:** Flatpak Background Portal requires explicit user approval dialog; cannot silently register systemd service; v1 is foreground-only so not a v1 blocker
- **Tray/StatusNotifier:** No proper StatusNotifier portal yet; workaround is `--talk-name=org.kde.StatusNotifierWatcher`; deferred to v2
- **File manager overlay icons:** Cannot load extensions from sandboxed app; requires separate native package; deferred post-v2
- **Credential storage:** Use libsecret/kwallet via OS keychain (sandbox-respecting); file-store fallback for edge cases
- **State DB location:** Must use XDG_CONFIG_HOME/XDG_DATA_HOME — test explicitly on Flatpak paths
- **Flathub quality review:** Multi-week process; AppStream metadata, icon compliance, sandbox permission justification all required; plan for this in timeline

## Sync Engine Design

- **Scope:** One or more user-selected folder pairs (local ↔ ProtonDrive folder); folder-level only, not file-granularity selective sync
- **Direction:** Two-way continuous sync while app is open
- **Conflict handling:** Conflict copy (not last-write-wins) — create timestamped copy of both versions; never silently overwrite; non-negotiable data safety default for E2EE audience
- **State persistence:** SQLite for sync state; note DB is unencrypted — file paths, sync history, conflict log are readable plaintext; acceptable for v1 but acknowledge in security notes
- **Change detection:** inotify for local changes; poll or SDK push events for remote; need debouncing/batching to avoid CPU spike on rapid edits
- **Offline behavior:** Queue local changes, retry on reconnect; detect remote changes only on next connected sync
- **Performance:** Define max folder size, max file size, max concurrent transfers, CPU/memory bounds before shipping

## ProtonDrive SDK Notes

- **SDK:** `@protontech/drive-sdk` (TypeScript, MIT) v0.14.3 — official Proton SDK, pre-release, treat as potentially breaking
- **Auth module:** SDK has NO built-in auth module; SRP must be implemented from scratch; reference: henrybear327/Proton-API-Bridge (Go) and rclone
- **Base URL:** `mail.proton.me/api` (not `drive.proton.me`)
- **Crypto:** openpgp v6 full bundle (NOT lightweight); Uint8Array type boundary casts needed at SDK interface
- **Breaking change risk:** Proton crypto migration planned in 2026; SDK wrapper/adapter layer must insulate sync engine from version transitions

## Competitive Intelligence

| Competitor | Status | Gap |
|---|---|---|
| Celeste | Archived Nov 2025 | Vacant Flathub slot — direct opportunity |
| DonnieDice/protondrive-linux | Active but broken | No Flathub; WebKitGTK Worker failure; no sync engine |
| rclone ProtonDrive backend | Broken Sep 2025, delisted Feb 2026 | No GUI; broken regardless |
| Proton official CLI | Announced Q2 2026 | CLI only; no GUI; no Flatpak commitment |
| pCloud Linux client | Active, native GUI | Named defection target by users; not E2EE by default |
| Nextcloud | Active, Flathub | Self-hosted; no Proton integration |

- **pCloud is the benchmark users name** — native Linux GUI and CLI; users cite it as "what I switched to when Proton failed me"
- **Proton's own apps exist for Windows and macOS** — gap is Linux-specific and explicit

## Rejected Ideas (Do Not Re-Propose)

- **CLI-first / headless sync:** SDK CAPTCHA+2FA blocks unattended use; tried in prior iteration, failed; GUI is v1
- **Snap packaging for v1:** Canonical-patched AppArmor required; auto-updates 4x/day; Ubuntu-only in practice
- **AppImage for GUI v1:** No sandbox, credential security concerns; fine for CLI, not GUI with sensitive auth
- **FUSE/VFS virtual filesystem:** Blocked by Flatpak sandbox; deferred post-v2
- **Windows/macOS support:** Out of scope permanently
- **Electron:** Too heavy; community hostility; contradicts privacy-first values
- **Tauri:** WebKitGTK Worker failure unfixable without framework changes; DonnieDice proved this

## Open Questions for PRD

- **Sync engine implementation language:** UI (GJS/Python) established; engine language TBD — Rust, Go, or TypeScript? Needs decision before architecture
- **IPC mechanism:** D-Bus, Unix socket, or in-process? Flatpak D-Bus constraints apply
- **Re-auth UX when token expires:** How does foreground app prompt user mid-session? Modal dialog? Status bar? What if minimized?
- **Conflict copy UI:** Shown in notification/log or silent? How does user find and resolve conflict copies?
- **Initial setup flow:** First-run wizard or settings screen? How does user add/remove sync pairs post-setup?
- **Security audit:** Third-party audit planned before stable or post-launch?
- **Telemetry:** Confirm no telemetry by default; if opt-in crash reporting added, must be explicit and auditable

## Success Metrics

- Flathub listing published at v1 launch (primary gate)
- 1,000 Flathub installs within 3 months
- 500 GitHub stars within 6 months
- Active community presence (r/ProtonMail, r/linux, Proton forum) at launch
- Zero critical data loss reports before stable release

## Market Data Points

- Flathub: 435M app downloads in 2025 (20.3% YoY growth), 3B+ cumulative, 1M+ active users
- Linux on Steam: 5.33% share March 2026 (all-time high, +57% YoY)
- Bazzite: ~5.5% of Linux Steam users as of late 2025
- Proton: 100M+ accounts globally as of 2025
- ProtonDrive UserVoice: 5,700+ votes, second-most-requested feature across all Proton products
