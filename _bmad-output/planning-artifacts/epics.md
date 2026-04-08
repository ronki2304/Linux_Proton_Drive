---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
status: 'complete'
completedAt: '2026-04-08'
totalEpics: 7
totalStories: 50
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/planning-artifacts/ux-design-specification.md'
  - '_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient.md'
projectName: 'ProtonDrive-LinuxClient'
date: '2026-04-08'
partyModeFeedback:
  gapsAdded: ['FR43-engine-handshake', 'FR44-crash-recovery-ux', 'FR45-local-folder-missing', 'FR13-wizard-resume-clarified']
  sizingWarnings: ['FR24-split-by-error-type', 'FR25-FR25a-separate-stories', 'NFR16-dependency-chain']
---

# ProtonDrive-LinuxClient - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for ProtonDrive-LinuxClient, decomposing the requirements from the PRD, UX Design, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

**Authentication & Session Management**

FR1: User can authenticate with ProtonDrive via an embedded browser on first launch or after logout — the browser handles CAPTCHA and 2FA
FR2: User can view their ProtonDrive account overview (account name, storage used) after successful authentication
FR3: The system validates the stored session token silently on launch and prompts re-authentication immediately if it has expired
FR4: User is prompted to re-authenticate when their session token expires during an active session, without losing queued local changes
FR5: User can see the count of queued local changes pending sync within the re-authentication prompt
FR6: User can log out; the session token is removed and locally synced files are preserved
FR7: User can view their ProtonDrive account info (name, storage, plan) at any time from within the application

**Sync Pair Management**

FR8: User completes first sync pair setup on first launch via a step-by-step onboarding wizard (authenticate → select local folder → select remote folder → confirm and start sync)
FR9: User can add a new sync pair (local folder ↔ ProtonDrive folder) from the main application window at any time after first run
FR10: User can manage at least 5 independent sync pairs simultaneously
FR11: User can remove a sync pair without affecting local or remote files
FR12: User sees an explicit confirmation when removing a sync pair, stating no files will be deleted on either side
FR13: The system routes to the first-run onboarding wizard when no valid session token is stored; any other state — including an authenticated session with no sync pairs configured — routes to the main application screen. If the wizard was interrupted after auth but before configuring a sync pair, the next launch re-enters the wizard at the folder selection step (wizard resume).

**Sync Engine & File Operations**

FR14: The system syncs file changes two-way continuously while the app is open
FR15: The system displays first-sync progress including file count, bytes transferred, and estimated time remaining
FR16: The system queues local file changes made while offline or during session expiry
FR17: The system replays queued local changes on reconnect by fetching current remote metadata (mtime) for each queued file and comparing against the remote mtime stored at last sync; files changed only locally are uploaded without conflict; files changed on both sides since the last sync point trigger the conflict copy pattern
FR18: The system displays global sync status including in-progress operations and last synced timestamp
FR19: The system displays per-pair sync status including last synced time, in-progress state, and conflict state for each sync pair
FR20: The system displays an offline state and last-synced timestamp when the app opens with no network available
FR21: The system shows an offline indicator and queues changes when network drops mid-session
FR22: The system resumes sync automatically when network becomes available, without user action
FR23: The system applies exponential backoff when rate-limited by the API and surfaces the rate-limited state to the user
FR24: The system shows a specific error message with an actionable resolution when sync fails for reasons other than network or auth. Known failure categories and expected messages: (a) disk full — "Free up space on [drive] to continue syncing", (b) permission denied — "Check folder permissions for [path]", (c) inotify watch limit exceeded — "Too many files to watch — close other apps or increase system inotify limit", (d) file locked by another process — "[file] is in use — sync will retry when it's released", (e) SDK/API error — "Sync error [code] — try again or check ProtonDrive status". Each error message identifies the cause and provides one actionable next step. [SIZING NOTE: Split into separate stories per error category]

**Conflict Management**

FR25: The system detects sync conflicts for previously-synced files by comparing the current local mtime against the stored local mtime at last sync, and the current remote mtime against the stored remote mtime at last sync; where mtime resolution is ambiguous (same-second modification), the system falls back to a locally-computed content hash compared against the hash stored at last sync — no live remote fetch is performed for conflict detection. [SIZING NOTE: Separate story from FR25a]
FR25a: Files with no StateDB entry (never previously synced) are checked for remote path collisions before upload; if a remote file exists at the same relative path, the local file is renamed to filename.ext.conflict-YYYY-MM-DD, both versions are preserved, and the user is notified — consistent with the standard conflict copy pattern. [SIZING NOTE: Separate story from FR25]
FR26: The system creates a conflict copy named filename.ext.conflict-YYYY-MM-DD — never silently overwrites
FR27: User is notified in-app when one or more sync conflicts occur
FR27a: The system sends a desktop notification when a sync conflict is detected while the application window is open (foreground notification — does not require the background daemon)
FR28: User can view a log of all sync conflicts within the application
FR29: User can locate conflict copies from within the application without opening a file manager; the conflict log provides a "Reveal in Files" action for each entry, implemented via org.freedesktop.portal.OpenURI

**Security & Credential Management**

FR34: The system stores the ProtonDrive session token via the OS credential store and reuses it on subsequent launches without requiring re-authentication
FR35: The system falls back to an encrypted local credential store if the OS credential store is unavailable
FR36: The system surfaces an explicit error if no credential storage method is available
FR37: The system makes no network connections of its own — all network I/O is delegated to the ProtonDrive SDK

**Application & Platform**

FR38: User can select sync folders via the system file chooser dialog
FR39: The application window size and position are preserved between sessions
FR40: The system respects system proxy settings for all network operations
FR41: The application source code is publicly available under MIT license
FR42: The application receives updates exclusively through Flathub — no in-app update mechanism

**Added from Party Mode Feedback**

FR43: The UI spawns the sync engine via GLib.spawn_async, connects to the Unix socket with exponential backoff (up to 10s), receives the ready event, validates protocol_version compatibility, and only then transitions to the main window or wizard. If protocol version is incompatible, the app shows a version mismatch error and refuses to proceed. If the engine fails to start or the socket connection times out, the app shows a clear startup error — never a cryptic timeout.
FR44: On crash recovery (detected via dirty-session flag in StateDB or incomplete .dl-tmp-* files at startup), the system cleans up partial files and shows a transient toast notification ("Recovered from unexpected shutdown — sync resuming") before the first sync operation begins. No user action required for recovery; the notification is informational only.
FR45: The system detects when a sync pair's local folder has been deleted or moved. The affected pair shows a dedicated error state in the sidebar with copy: "Local folder not found at [path]. Was it moved?" and offers two actions: "Update path" (opens XDG file chooser to re-point the pair) and "Remove pair" (triggers the standard removal confirmation). The pair is never silently dropped from the list.

### NonFunctional Requirements

**Performance**

NFR1: The application UI is ready for user interaction (main window rendered, stored token loaded from credential store) within 3 seconds of launch — independent of network availability or API response time
NFR2: User interface interactions (button presses, navigation, dialog opens) respond within 200ms — the UI must never block on sync engine operations
NFR3: Local file change detection (inotify event to sync queue entry) completes within 5 seconds of a file being modified — measured after initial inotify watch tree setup is complete
NFR3a: inotify watch tree initialisation runs asynchronously and does not block user interaction; the UI remains responsive (NFR2) throughout watch tree setup; sync status shows an "Initializing file watcher..." indicator while setup is in progress
NFR4: When not throttled or paused, sync throughput is limited only by network bandwidth and SDK capacity; the sync engine caps concurrent file transfers at a default maximum of 3 to bound CPU and memory usage under load
NFR5: Application memory footprint during steady-state sync (no active transfers, inotify watches active) for a folder tree with up to 10,000 files does not exceed 150MB RSS

**Security**

NFR6: The session token must not appear in any log output, stdout, stderr, crash dump, or debug trace under any circumstances
NFR7: The credential file (fallback store) must have 0600 permissions set before any content is written
NFR8: The localhost auth server must bind exclusively to 127.0.0.1 on a randomly assigned ephemeral port and close immediately after the auth callback is received
NFR9: No decrypted file content or file paths appear in any persistent log or diagnostic output
NFR10: The application contains no HTTP client code outside src/sdk/ — verifiable by static analysis (grep for network/fetch imports outside the SDK boundary)

**Reliability**

NFR11: Zero file data loss — a conflict copy must always be created before any local file is overwritten; this must hold across app restarts, network interruptions, and session expiry
NFR12: All file writes use atomic rename (write to .dl-tmp-<timestamp>-<random>, then rename() on success) — partial writes must never appear at the destination path
NFR13: The sync engine verifies file integrity after download before committing to the destination path — a corrupted download must not silently replace the user's file; integrity is verified using the SDK-returned content hash where available, falling back to a locally-computed hash
NFR14: The local change queue is persisted to disk and survives application crashes — no queued change is silently lost on unexpected termination
NFR15: Sync state (last-known local mtime, remote mtime, and optional content hash per file per sync pair) is written to SQLite before a sync operation is considered complete — no in-memory-only state
NFR16: The application recovers to a consistent sync state after a crash without user intervention — consistent state defined as: sync pairs intact, token present, last-known mtime preserved in SQLite, no partial files at destination paths; crash recovery is detected by the presence of incomplete .dl-tmp-* files at startup or a dirty-session flag in the state DB, and resolved before the first sync operation begins. [DEPENDENCY NOTE: Requires dirty-session flag and tmp file cleanup mechanisms to be implemented as prerequisite stories before crash recovery can be tested]
NFR17: Auth failure (401) is detected within one failed sync attempt; the sync engine immediately halts and triggers re-auth — no silent 401 retry

**Accessibility**

NFR18: The application exposes a complete AT-SPI2 accessibility tree — all interactive elements are reachable and operable by the Orca screen reader
NFR19: All application functions are fully operable via keyboard navigation — no capability requires a pointer device
NFR20: Text contrast ratios meet WCAG AA minimum (4.5:1 for body text, 3:1 for large text) — Libadwaita's default palette satisfies this; any custom colour usage must not regress it

### Additional Requirements

**From Architecture:**

- Flatpak App ID: io.github.ronki2304.ProtonDriveLinuxClient — permanent, propagates to all manifests, XDG paths, GSettings schemas, icon filenames
- GNOME runtime: org.gnome.Platform//50 + org.gnome.Sdk//50
- Node.js 22 bundled via org.freedesktop.Sdk.Extension.node22 SDK extension
- IPC protocol: 4-byte big-endian length prefix + JSON payload over Unix socket
- Engine enforces single connection — second connection rejected with ALREADY_CONNECTED
- MessageReader class for IPC framing — must handle partial messages, multi-message chunks, split across chunks, zero-length payload, oversized payload (mandatory test edge cases per architecture doc)
- SQLite WAL mode mandatory in StateDB init; schema versioning via PRAGMA user_version
- pair_id ownership: UUID v4 generated by engine at add_pair time; UI never generates pair_id
- Cold-start: pair in YAML config but absent from SQLite = fresh full sync; engine never crashes on missing DB state
- Atomic file writes for downloads: write to <path>.protondrive-tmp-<timestamp> then rename() on success
- Conflict copy suffix appends after extension: notes.md → notes.md.conflict-2026-04-01
- Engine stderr → /dev/null in production; debug via PROTONDRIVE_DEBUG=1 env var
- Starter template: GNOME Builder Python/GTK4/Libadwaita template for UI scaffolding; standard npm init + tsconfig.json for engine
- CI/CD: ci.yml (PR gate: meson test + node --test) and release.yml (tag-triggered Flatpak build + GitHub Release)
- Complete project structure defined with file-level requirements mapping (see architecture.md § Project Structure)
- SDK boundary: all @protontech/drive-sdk imports confined to engine/src/sdk.ts only
- Token flow one-directional: libsecret → Python UI → IPC token_refresh → engine sdk.ts → SDK
- Widget boundary: no widget file imports from another widget file; all coordination through window.py

### UX Design Requirements

UX-DR1: Pre-auth native screen with credential comfort copy before embedded browser opens — explains "Your password is sent directly to Proton — this app only receives a session token after you sign in"
UX-DR2: Read-only URL bar in embedded WebKitGTK browser showing accounts.proton.me so users can verify they are talking to Proton
UX-DR3: Post-auth account overview with name + storage bar before any CTA — "I'm in" confirmation moment
UX-DR4: 3-step setup wizard (Sign In → Choose Folder → You're Syncing) — runs once only on first launch with no valid token; no Back button on auth step, Back button on folder selection step
UX-DR5: AccountHeaderBar custom component — avatar (28px circle, initials) + account name (13px) + storage bar (AdwLevelBar, min-width 140px) + storage label; states: normal (teal), warning at >90% (@warning_color + amber label), critical at >99% (error colour + "Storage full" label); storage label hidden at <480px width
UX-DR6: SyncPairRow custom component — animated status dot (8px circle) + pair name (13px) + optional status text (10px, secondary colour); states: synced (green), syncing (teal, pulsing), conflict (amber), error (red), offline (grey), selected (teal background tint); dot state communicated via accessible label
UX-DR7: StatusFooterBar custom component — persistent bottom bar; priority logic: Error > Conflict > Syncing > Offline > All synced; states: all synced (green dot), syncing (teal dot animated + "Syncing N files in [pair]..."), conflict (amber dot + "N conflicts need attention"), error (red dot + "Sync error in [pair]"), offline (grey dot + "Offline — changes queued")
UX-DR8: RemoteFolderPicker custom component (MVP) — text field pre-filled with local folder name, typing fetches top-level ProtonDrive folders as autocomplete suggestions (one SDK call, cached for session lifetime of dialog), manual path entry for nested paths; "Browse folders..." link present but deferred to V1
UX-DR9: SyncProgressCard custom component — replaces stats cards in detail panel during active sync; indeterminate bar + "Counting files..." until file count known, then determinate bar + count/bytes/ETA; transitions to normal detail stats after 2s on complete
UX-DR10: ConflictLogRow custom component — warning icon + filename (bold, amber) + pair name + timestamp + "Reveal in Files" action link via org.freedesktop.portal.OpenURI; states: unresolved (amber), resolved (dimmed, strikethrough — auto-detected when conflict copy deleted)
UX-DR11: Mandatory dark theme via AdwStyleManager with ADW_COLOR_SCHEME_FORCE_DARK — one call at app startup
UX-DR12: Deep teal #0D9488 as sole custom accent colour applied via AdwAccentColor API; all semantic colours (success, warning, error) inherited from Libadwaita tokens — never overridden
UX-DR13: AdwNavigationSplitView main layout with responsive collapse at ~480px; sidebar ~220px fixed width; minimum window size 360x480px; default window size 780x520px
UX-DR14: Nested/overlapping sync pair validation — 4 checks (local nesting, local overlap, remote nesting, remote overlap) with specific error copy naming the conflicting pair and suggesting resolution
UX-DR15: Destructive action pattern — AdwAlertDialog with heading naming the action, body copy explicitly stating what will/won't be affected, two buttons: Cancel (default/escape, suggested-action style) and destructive action (destructive-action style); no "I understand" checkbox
UX-DR16: Empty state pattern — AdwStatusPage for zero pairs ("Add your first sync pair to start syncing"), no pair selected ("Select a sync pair to see details"), error states, offline state; no blank panels ever; no spinners without a label
UX-DR17: Button hierarchy — one primary (suggested-action, teal) per screen; destructive never adjacent to primary; cancel always default/escape action in dialogs
UX-DR18: Feedback patterns — toasts (AdwToastOverlay) for transient positive feedback only (auto-dismiss 3s); banners (AdwBanner) for persistent states requiring awareness (user-dismissible); modals (AdwAlertDialog) only for re-auth — used sparingly
UX-DR19: Local folder deleted/moved — dedicated pair-level error state in sidebar with copy: "Local folder not found at [path]. Was it moved?" and actions: "Update path" (XDG file chooser) and "Remove pair" (standard removal confirmation); pair never silently dropped

### FR Coverage Map

| FR | Epic | Description |
|---|---|---|
| FR1 | Epic 1 | Authenticate via embedded browser |
| FR2 | Epic 1 | Account overview post-auth |
| FR3 | Epic 1 | Silent token validation on launch |
| FR4 | Epic 5 | Re-auth on token expiry mid-session |
| FR5 | Epic 5 | Queued change count in re-auth prompt |
| FR6 | Epic 1 | Log out |
| FR7 | Epic 1 | View account info anytime |
| FR8 | Epic 2 | First-run setup wizard |
| FR9 | Epic 6 | Add pair from main window |
| FR10 | Epic 6 | Manage 5+ pairs simultaneously |
| FR11 | Epic 6 | Remove pair without affecting files |
| FR12 | Epic 6 | Removal confirmation dialog |
| FR13 | Epic 2 | Routing logic + wizard resume |
| FR14 | Epic 2 | Two-way continuous sync |
| FR15 | Epic 2 | First-sync progress display |
| FR16 | Epic 3 | Queue changes while offline |
| FR17 | Epic 3 | Replay queued changes on reconnect |
| FR18 | Epic 2 | Global sync status display |
| FR19 | Epic 2 | Per-pair sync status |
| FR20 | Epic 3 | Offline state on startup |
| FR21 | Epic 3 | Offline indicator mid-session |
| FR22 | Epic 3 | Auto-resume on reconnect |
| FR23 | Epic 3 | Rate-limit backoff + UI |
| FR24 | Epic 5 | Actionable error messages (5 categories) |
| FR25 | Epic 4 | Conflict detection (existing files) |
| FR25a | Epic 4 | Collision detection (new files) |
| FR26 | Epic 4 | Conflict copy creation |
| FR27 | Epic 4 | In-app conflict notification |
| FR27a | Epic 4 | Desktop notification for conflicts |
| FR28 | Epic 4 | Conflict log |
| FR29 | Epic 4 | "Reveal in Files" portal action |
| FR34 | Epic 1 | Credential storage via libsecret |
| FR35 | Epic 1 | Credential fallback store |
| FR36 | Epic 1 | Error if no credential store available |
| FR37 | Epic 1 | No app-initiated network connections |
| FR38 | Epic 2 | XDG file chooser for folder selection |
| FR39 | Epic 2 | Window state persistence |
| FR40 | Epic 7 | System proxy support (document as unsupported in v1 or implement) |
| FR41 | Epic 7 | MIT license |
| FR42 | Epic 7 | Flathub-only updates |
| FR43 | Epic 1 | Engine spawn + protocol handshake |
| FR44 | Epic 5 | Crash recovery UX |
| FR45 | Epic 6 | Local folder missing detection |

All 45 FRs mapped. Zero orphans.

## Epic List

### Epic 1: App Foundation & Authentication

User can launch the app, authenticate with Proton via embedded browser, and see their account overview (name, storage, plan). Credentials persist via libsecret or fallback. The engine spawns, connects, and validates protocol. This is the "it actually works" moment — the trust-building milestone.

**FRs covered:** FR1, FR2, FR3, FR6, FR7, FR34, FR35, FR36, FR37, FR43
**UX-DRs:** UX-DR1, UX-DR2, UX-DR3, UX-DR5, UX-DR11, UX-DR12, UX-DR13
**NFRs as acceptance constraints:** NFR1 (3s launch), NFR2 (200ms UI response), NFR6 (token never in output), NFR7 (0600 credential file), NFR8 (localhost-only auth server), NFR10 (no HTTP outside SDK)

**Includes:** Project scaffolding (UI via GNOME Builder template + engine via npm init/tsconfig), IPC foundation (Unix socket server, MessageReader with mandatory edge case tests, protocol types, 4-byte length-prefixed framing), SQLite state DB init (WAL mode, schema versioning), typed error hierarchy (errors.ts), auth flow (localhost HTTP server, WebKitGTK embedded browser, libsecret + fallback credential store), account header component (AccountHeaderBar), mandatory dark theme (ADW_COLOR_SCHEME_FORCE_DARK), teal accent (#0D9488 via AdwAccentColor), main window shell (AdwNavigationSplitView), settings page (account info, storage bar, log out).

**Sizing note:** This is the largest epic (~12-15 stories). Consider splitting into two phases during sprint planning: Phase A (scaffolding + IPC + engine spawn) and Phase B (auth + credentials + account UI).

### Epic 2: First Sync Pair & File Sync

User can set up their first sync pair via the setup wizard, see files sync in both directions with live progress (file count, bytes, ETA), and see "Last synced X seconds ago." Window state persists between sessions. The app builds and runs as a Flatpak from this epic onwards to catch sandbox issues early.

**FRs covered:** FR8, FR13, FR14, FR15, FR18, FR19, FR38, FR39
**UX-DRs:** UX-DR4, UX-DR6 (synced + syncing states only), UX-DR7 (synced + syncing states only), UX-DR8, UX-DR9, UX-DR16
**NFRs as acceptance constraints:** NFR2 (200ms UI), NFR3 (5s inotify detection), NFR3a (async watch init), NFR4 (concurrent transfer cap), NFR5 (150MB RSS), NFR12 (atomic writes), NFR15 (sync state in SQLite)

**Includes:** 3-step setup wizard (Sign In → Choose Folder → You're Syncing), wizard resume on interrupted first-run, remote folder picker (MVP text+autocomplete), sync engine core (two-way sync orchestration), inotify file watcher with debouncing, SyncPairRow (synced/syncing states — additional states added by later epics), StatusFooterBar (synced/syncing states), SyncProgressCard, empty states (AdwStatusPage), basic per-pair and global status display, XDG file chooser portal, window state persistence, Flatpak build validation (app builds and runs in sandbox).

**Progressive component states:** SyncPairRow and StatusFooterBar are built with synced (green) and syncing (teal) states. Conflict (amber), error (red), and offline (grey) states are added by Epics 3, 4, and 5 respectively as those behaviours are implemented.

### Epic 3: Offline Resilience & Network Handling

User always knows when they're offline, changes queue automatically and persist to disk, and sync resumes without user action when network returns. Rate limiting is surfaced visibly. The app never appears frozen or broken during network disruptions.

**FRs covered:** FR16, FR17, FR20, FR21, FR22, FR23
**UX-DRs:** UX-DR6 (adds offline grey state), UX-DR7 (adds offline + rate-limited states), UX-DR16 (offline empty state)
**NFRs as acceptance constraints:** NFR14 (persistent change queue), NFR15 (sync state in SQLite)

**Includes:** Offline change queue (persisted to SQLite, survives crashes), queue replay with remote-state diffing (no false conflicts), offline/online detection and indicators, rate-limit UI ("Sync paused — resuming in Xs"), SyncPairRow offline state (grey dot), StatusFooterBar offline state.

### Epic 4: Conflict Detection & Resolution

User's files are never silently overwritten. Conflicts create date-stamped copies, trigger both in-app and desktop notifications, and are discoverable via the conflict log with "Reveal in Files." Both file versions are always preserved.

**FRs covered:** FR25, FR25a, FR26, FR27, FR27a, FR28, FR29
**UX-DRs:** UX-DR6 (adds conflict amber state), UX-DR7 (adds conflict state), UX-DR10
**NFRs as acceptance constraints:** NFR11 (zero data loss), NFR12 (atomic writes)

**Includes:** Conflict detection for existing files (mtime comparison + content hash fallback — separate story from FR25a), new-file collision detection (FR25a — separate story), conflict copy creation (filename.ext.conflict-YYYY-MM-DD), in-app notification banner (AdwBanner), desktop notification (foreground only), conflict log panel, ConflictLogRow component (unresolved/resolved states), "Reveal in Files" via org.freedesktop.portal.OpenURI, SyncPairRow conflict state (amber dot), StatusFooterBar conflict state.

**Accessibility story:** Verify ConflictLogRow AT-SPI2 tree, keyboard navigation through conflict log, Orca announces conflict filenames and "Reveal in Files" action.

### Epic 5: Token Expiry & Error Recovery

User can recover from expired sessions with zero data loss — queued changes are preserved and replayed without false conflicts. Crash recovery is automatic with an informational toast. Sync errors are actionable with specific resolution guidance.

**FRs covered:** FR4, FR5, FR24, FR44
**UX-DRs:** UX-DR6 (adds error red state), UX-DR7 (adds error state), UX-DR15 (re-auth modal), UX-DR18 (feedback patterns)
**NFRs as acceptance constraints:** NFR14 (persistent queue), NFR16 (crash recovery), NFR17 (401 detection)

**Includes:** Re-auth modal with queued change count (AdwAlertDialog), 401 detection and immediate sync halt, change queue replay without false conflicts, dirty-session flag mechanism in StateDB, crash recovery cleanup (.dl-tmp-* files), crash recovery toast notification, actionable error messages — separate stories per category: (a) disk full, (b) permission denied, (c) inotify limit exceeded, (d) file locked, (e) SDK/API error. SyncPairRow error state (red dot), StatusFooterBar error state.

**Dependency note:** Dirty-session flag and tmp file cleanup stories must be implemented before crash recovery can be tested (per NFR16).

### Epic 6: Multi-Pair Management & Validation

User can confidently manage multiple sync pairs — add subsequent pairs from the main window without re-running the wizard, remove pairs with explicit no-delete confirmation, and trust that nesting/overlap validation prevents configuration errors. Missing local folders are detected and recoverable.

**FRs covered:** FR9, FR10, FR11, FR12, FR45
**UX-DRs:** UX-DR14, UX-DR15, UX-DR17

**Includes:** Add-subsequent-pair flow (lightweight — no wizard chrome), remove pair confirmation dialog (AdwAlertDialog with explicit "will/won't" copy), nesting/overlap validation (4 checks: local nesting, local overlap, remote nesting, remote overlap — specific error copy naming conflicting pair), local folder missing detection with "Update path" (XDG file chooser) and "Remove pair" options, button hierarchy enforcement (one primary per screen, destructive never adjacent).

**Accessibility story:** Verify all dialog AT-SPI2 trees, keyboard navigation for add/remove flows, Orca announces validation errors and confirmation copy.

### Epic 7: Packaging & Distribution

User can install from Flathub with one click. AppStream metainfo, desktop file, CI/CD pipelines, and Flatpak manifest with justified permissions are complete and pass Flathub quality review.

**FRs covered:** FR40, FR41, FR42
**UX-DRs:** None (infrastructure epic)

**Includes:** Flatpak manifest with finish-args and plain-language justification document (--filesystem=home for inotify, --share=network, Secret portal), AppStream metainfo XML (app ID, name, summary, description, screenshots, release notes, developer info, OARS oars-1.1 all fields none), desktop file (Categories=Network;FileTransfer;, Keywords, correct Exec, StartupNotify=true), CI/CD pipelines (ci.yml PR gate: meson test + node --test; release.yml tag-triggered Flatpak build + GitHub Release), MIT license, FR40 proxy support (document as unsupported in v1 with filed issue, or implement if SDK supports it).

**Note:** Flatpak build validation starts in Epic 2 (the app builds and runs in sandbox from that point). This epic covers the submission-quality artifacts and CI/CD automation.

---

## Epic 1: App Foundation & Authentication

User can launch the app, authenticate with Proton via embedded browser, and see their account overview (name, storage, plan). Credentials persist via libsecret or fallback. The engine spawns, connects, and validates protocol. This is the "it actually works" moment.

### Story 1.1: UI Project Scaffolding

As a developer,
I want a working GTK4/Libadwaita project scaffold with Meson build, Blueprint UI files, and Flatpak manifest stub,
So that all subsequent UI stories have a buildable foundation to work from.

**Acceptance Criteria:**

**Given** the GNOME Builder Python/GTK4/Libadwaita template has been generated
**When** `meson setup builddir && meson compile -C builddir` is run
**Then** the project compiles without errors
**And** the Flatpak App ID `io.github.ronki2304.ProtonDriveLinuxClient` is set in all manifests, GSettings schema, GResource paths, desktop file, and AppStream metainfo stub

**Given** the app is launched
**When** the main window renders
**Then** an empty `AdwNavigationSplitView` window is displayed with mandatory dark theme (`ADW_COLOR_SCHEME_FORCE_DARK`) and teal accent (`#0D9488` via `AdwAccentColor` API)
**And** the window has a minimum size of 360x480px and default size of 780x520px

**Given** the project structure
**When** inspecting the source tree
**Then** `ui/src/protondrive/` contains `__init__.py`, `main.py`, `window.py`
**And** `ui/data/ui/` contains `window.blp`
**And** `ui/data/` contains the GSettings schema XML and app icon SVGs
**And** all widget structure is defined in Blueprint `.blp` files, never in Python

---

### Story 1.2: Engine Project Scaffolding

As a developer,
I want a TypeScript/Node project scaffold with strict tsconfig and the typed error hierarchy,
So that all subsequent engine stories have a buildable foundation with consistent error handling.

**Acceptance Criteria:**

**Given** `npm init` has been run in `engine/`
**When** inspecting `tsconfig.json`
**Then** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride` are all `true`
**And** `target` is `ES2022`, `module` is `NodeNext`, `moduleResolution` is `NodeNext`

**Given** `engine/src/errors.ts` exists
**When** inspecting its imports
**Then** it has zero internal imports from other engine files
**And** it exports `EngineError` base class and typed subclasses: `SyncError`, `NetworkError`, `IpcError`, `ConfigError`

**Given** `@protontech/drive-sdk` is added to `package.json`
**When** inspecting the version
**Then** it is pinned to exact version `0.14.3` (no `^` or `~` prefix)

**Given** `openpgp` is added to `package.json`
**When** inspecting the version
**Then** it is pinned to exact version `^6.3.0`

**Given** the engine project
**When** running `npx tsc --noEmit`
**Then** the project compiles without errors

---

### Story 1.3: IPC Protocol & Socket Server

As a developer,
I want the engine to start a Unix socket server with length-prefixed JSON framing and emit a `ready` event,
So that the UI process can establish a reliable communication channel with the sync engine.

**Acceptance Criteria:**

**Given** the engine starts via `node --import tsx src/main.ts`
**When** initialization completes
**Then** a Unix socket is created at `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`
**And** the engine emits a `ready` event with `{version, protocol_version}` payload

**Given** the `MessageReader` class in `ipc.ts`
**When** processing incoming data
**Then** it correctly handles 4-byte big-endian length prefix + JSON payload framing
**And** all commands carry a unique `id` field (UUID v4)
**And** responses echo `id` with `_result` suffix

**Given** unit tests for `MessageReader`
**When** running `node --import tsx --test engine/src/ipc.test.ts`
**Then** tests pass for: partial message, multiple messages in one chunk, message split across chunks, zero-length payload, oversized payload

**Given** an active connection exists
**When** a second client attempts to connect
**Then** the engine rejects it immediately with `ALREADY_CONNECTED` error and destroys the socket

**Given** the engine receives a `shutdown` command
**When** processing the command
**Then** the engine closes the socket and exits cleanly

---

### Story 1.4: Engine Spawn & Socket Connection

As a user,
I want the app to start the sync engine automatically and connect to it,
So that I don't need to manage processes manually.

**Acceptance Criteria:**

**Given** the app launches
**When** the UI process starts
**Then** it spawns the engine via `GLib.spawn_async()` using the correct `ENGINE_PATH` resolution (Flatpak: `/usr/lib/sdk/node22/bin/node` + `/app/lib/protondrive/engine.js`; dev: `GLib.find_program_in_path('node')` + project-relative `engine/dist/engine.js`)
**And** checks `GLib.spawn_async()` return value — `False` means spawn failed; surfaces clear error to user

**Given** the engine has been spawned
**When** the UI attempts to connect to the IPC socket
**Then** it uses `Gio.SocketClient` with exponential backoff for up to 10 seconds
**And** on successful connection, it reads messages via `Gio.DataInputStream` (never Python `socket.recv()`)

**Given** the engine is not found on `$PATH` (dev) or is missing from the bundle (Flatpak)
**When** the UI attempts to spawn it
**Then** a clear startup error is displayed: "Sync engine not found" — never a cryptic socket timeout

**Given** app launches cold
**When** engine connects and `ready` event is received
**Then** main window is interactive within 3 seconds (NFR1)

---

### Story 1.5: Protocol Handshake & Engine Lifecycle

As a user,
I want the app to verify engine compatibility and handle engine crashes gracefully,
So that I'm never left with a silently broken or stale sync engine.

**Acceptance Criteria:**

**Given** the UI receives the `ready` event from the engine
**When** processing the event
**Then** it validates `protocol_version` for compatibility
**And** if incompatible, shows a version mismatch error and refuses to proceed
**And** if compatible, transitions to the main window or wizard

**Given** the UI receives a `ready` event
**When** the handshake completes
**Then** the UI sends `get_status` command — on every `ready` event, not just first launch

**Given** commands are sent before the engine `ready` event
**When** the `ready` event is received
**Then** all buffered commands in `_pending_commands` are flushed in order

**Given** the user closes the app
**When** the shutdown sequence begins
**Then** the UI sends a `shutdown` command to the engine, waits for clean exit, and kills the process if timeout is exceeded

**Given** the engine process crashes unexpectedly
**When** the UI detects socket close
**Then** an app-level error banner is displayed with a restart button (fatal error display)
**And** no "restart" button is shown for non-fatal errors (those display inline on affected pair card)

---

### Story 1.6: Credential Storage (libsecret + Fallback)

As a user,
I want my session token stored securely so I don't need to re-authenticate every time I open the app,
So that launch is seamless after first-time setup.

**Acceptance Criteria:**

**Given** a valid session token is received after authentication
**When** the UI stores it
**Then** it is stored via libsecret Secret portal (GNOME Keyring) under the app's credential attributes

**Given** the Secret portal is unavailable (e.g., non-GNOME desktop, NixOS)
**When** the UI attempts to store the token
**Then** it falls back to an encrypted local credential store at `~/.var/app/$FLATPAK_ID/data/keyrings/`
**And** the credential file has `0600` permissions set immediately on creation, before any content is written (NFR7)
**And** the UI surfaces an explicit message about the fallback: "Credential storage unavailable via Secret portal — falling back to encrypted file store"

**Given** neither libsecret Secret portal nor the fallback store is available
**When** the UI attempts to store credentials
**Then** a clear error is surfaced: "No secure credential storage available" (FR36)

**Given** any code path in the application
**When** inspecting stdout, stderr, logs, debug traces, or crash dumps
**Then** the session token never appears in any output (NFR6)

---

### Story 1.7: Localhost Auth Callback Server

As a developer,
I want a secure localhost HTTP server that receives the auth callback token,
So that the embedded browser can complete authentication and pass the token to the app.

**Acceptance Criteria:**

**Given** the auth flow is initiated
**When** the auth callback server starts
**Then** it binds exclusively to `127.0.0.1` (never `0.0.0.0`) on a randomly assigned ephemeral port (NFR8)

**Given** the server is running
**When** the auth callback is received with a session token
**Then** the token is captured and passed to the credential storage layer
**And** the server closes immediately — no persistent open port

**Given** the auth server lifecycle
**When** the server has received one callback
**Then** it does not accept any further connections
**And** it is fully stopped before the auth flow transitions to the next step

**Given** the server is started
**When** the WebView navigates to `http://127.0.0.1:{port}/auth-start`
**Then** the server responds with an HTTP redirect (302) to `https://accounts.proton.me` with the appropriate auth parameters
**And** the redirect URL includes the callback URL pointing back to `http://127.0.0.1:{port}/callback`

**Given** the auth callback server
**When** inspecting its implementation
**Then** it is in `ui/src/protondrive/auth.py` and uses Python stdlib `http.server` on a background thread

---

### Story 1.8: Pre-Auth Screen & Credential Comfort

As a user,
I want to understand what's about to happen before I see an embedded browser asking for my Proton password,
So that I trust the app isn't phishing me.

**Acceptance Criteria:**

**Given** the app launches with no valid session token
**When** the pre-auth screen is displayed
**Then** it shows a native GTK4 screen (not the browser) with credential comfort copy: "Your password is sent directly to Proton — this app only receives a session token after you sign in"
**And** a primary CTA button "Open Proton sign-in" is displayed

**Given** the pre-auth screen is visible
**When** a screen reader (Orca) reads the page
**Then** the heading "Sign in to Proton" and the credential comfort body text are announced
**And** the "Open Proton sign-in" button is announced as a button

**Given** the pre-auth screen
**When** the user clicks "Open Proton sign-in"
**Then** the auth callback server starts (Story 1.7) and the embedded browser opens (Story 1.9)

---

### Story 1.9: Embedded WebKitGTK Auth Browser

As a user,
I want to authenticate with Proton using their real login page in an embedded browser,
So that I can use CAPTCHA, 2FA, and all standard Proton auth flows without leaving the app.

**Acceptance Criteria:**

**Given** the user clicks "Open Proton sign-in" on the pre-auth screen
**When** the embedded browser opens
**Then** it loads `http://127.0.0.1:{port}/auth-start` which redirects to `accounts.proton.me`
**And** a read-only URL bar is visible showing `accounts.proton.me` so the user can verify the destination (UX-DR2)
**And** the auth callback server socket was bound BEFORE the WebView navigates (auth flow ordering is load-bearing)

**Given** the user completes authentication (including CAPTCHA and 2FA if required)
**When** Proton's auth flow sends the callback to localhost
**Then** the token is received by the auth callback server
**And** the WebView is cleaned up: `webview.try_close()` is called and the reference is set to `None`
**And** the WebView's network session and cached credentials are released

**Given** a network error occurs during authentication
**When** the browser cannot reach Proton
**Then** an error banner is displayed with a "Retry" button

**Given** the auth browser widget
**When** inspecting the implementation
**Then** WebKitGTK is imported as `gi.repository.WebKit` (not deprecated `WebKit2`)
**And** the widget is defined in `ui/data/ui/auth-window.blp` with Python wiring in `ui/src/protondrive/auth_window.py`

---

### Story 1.10: Post-Auth Account Overview & Session Handoff

As a user,
I want to see my account name and storage usage immediately after authentication,
So that I know auth worked and I'm connected to the right account.

**Acceptance Criteria:**

**Given** authentication completes successfully
**When** the token is sent to the engine via IPC `token_refresh` command
**Then** the engine validates the token with the SDK and emits a `session_ready` event with `{display_name, email, storage_used, storage_total, plan}`

**Given** the UI receives the `session_ready` event
**When** rendering the post-auth state
**Then** the `AccountHeaderBar` component is displayed showing: avatar (28px circle with initials), account name (13px, medium weight), storage bar (`AdwLevelBar`, min-width 140px), and storage label ("X GB / Y GB", 10px)
**And** post-auth confirmation line: "Signed in as [account name] — your password was never stored by this app" (UX-DR3)

**Given** the storage usage
**When** usage exceeds 90% of total
**Then** the storage bar shifts to `@warning_color` (amber) with amber label
**And** when usage exceeds 99%, the bar shifts to error colour with "Storage full" label

**Given** window width is less than 480px
**When** the `AccountHeaderBar` renders
**Then** the storage text label is hidden; the storage bar remains visible

**Given** the `AccountHeaderBar` is visible
**When** a screen reader (Orca) reads it
**Then** it announces "Signed in as [name], [X] of [Y] storage used"

**Given** the `session_ready` event
**When** it fires on both initial auth AND re-auth
**Then** both cases are handled by the same handler — no separate code paths

---

### Story 1.11: Silent Token Validation on Launch

As a returning user,
I want the app to automatically validate my stored token on launch,
So that I go straight to the main window without re-authenticating every time.

**Acceptance Criteria:**

**Given** the app launches and a session token is stored in the credential store
**When** the token is loaded
**Then** it is sent to the engine via IPC `token_refresh` command without showing the auth browser

**Given** the engine validates the token
**When** the SDK accepts it
**Then** a `session_ready` event is emitted and the UI transitions to the main window (not the wizard)

**Given** the engine validates the token
**When** the SDK rejects it (expired or invalid)
**Then** the UI immediately shows the pre-auth screen for re-authentication (FR3)
**And** no error banner is shown — token expiry at launch is treated as a normal routing decision, not an error

**Given** the app launches with no stored token
**When** the credential store is empty
**Then** the UI routes to the first-run wizard (pre-auth screen)

---

### Story 1.12: Settings Page & Log Out

As a user,
I want to view my account details and log out when needed,
So that I can verify my account info and securely end my session.

**Acceptance Criteria:**

**Given** the user navigates to Settings (gear icon in `AdwHeaderBar`)
**When** the settings page opens
**Then** it displays account info: display name, email, storage usage, plan type
**And** a "Manage account at Proton" external link (opens in system browser via `Gtk.show_uri`)
**And** no password fields — ever

**Given** the user clicks "Log out"
**When** the confirmation dialog appears
**Then** it is an `AdwAlertDialog` with heading "Sign out?" and body: "Sign out of your Proton account? Your synced local files will not be deleted. You will need to sign in again to resume sync."
**And** two buttons: "Cancel" (default/escape, suggested-action style) and "Sign out" (destructive-action style)

**Given** the user confirms logout
**When** the logout completes
**Then** the session token is removed from the credential store
**And** local files and sync pair config are untouched
**And** the UI transitions to the pre-auth screen

**Given** the settings page
**When** navigating via keyboard only
**Then** all elements are reachable via Tab and actionable via Enter/Space
**And** Escape closes the settings page

**Given** the About dialog (via `⋯` menu in header bar)
**When** it opens
**Then** it is an `AdwAboutWindow` showing: MIT license with GitHub link, SDK version in use, Flatpak App ID, link to Flatpak manifest

---

### Story 1.13: SDK Boundary & No-App-Network Verification

As a security-conscious user,
I want to be certain the app makes no network connections of its own,
So that I can trust all network I/O goes through the ProtonDrive SDK.

**Acceptance Criteria:**

**Given** the complete UI codebase (`ui/src/`)
**When** inspecting for HTTP client code
**Then** no imports of `http.client`, `urllib`, `requests`, or any network library exist outside of `auth.py` (localhost-only server)

**Given** the complete engine codebase (`engine/src/`)
**When** inspecting for HTTP/fetch imports
**Then** no imports of `http`, `https`, `fetch`, `node-fetch`, `axios`, or any network library exist outside of `sdk.ts` (NFR10)

**Given** `engine/src/sdk.ts`
**When** inspecting its imports
**Then** it is the only file that imports `@protontech/drive-sdk`
**And** a boundary comment at the top of the file enforces this rule

**Given** any engine file other than `errors.ts`
**When** inspecting its imports
**Then** it does not import from `@protontech/drive-sdk` directly — only from `sdk.ts`

---

## Epic 2: First Sync Pair & File Sync

User can set up their first sync pair via the setup wizard, see files sync in both directions with live progress (file count, bytes, ETA), and see "Last synced X seconds ago." Window state persists between sessions. The app builds and runs as a Flatpak from this epic onwards.

### Story 2.1: SQLite State Database & Schema

As a developer,
I want the sync engine to have a SQLite state database with WAL mode, schema versioning, and sync pair/state tables,
So that sync state persists across restarts and survives crashes.

**Acceptance Criteria:**

**Given** the engine starts for the first time
**When** `state-db.ts` initializes
**Then** it creates the database at `$XDG_DATA_HOME/protondrive/state.db` (creating the directory with `mkdir -p` if needed)
**And** `PRAGMA journal_mode=WAL` is set
**And** `PRAGMA synchronous=NORMAL` is set

**Given** the database is initialized
**When** querying `PRAGMA journal_mode`
**Then** it returns `wal`

**Given** the database schema
**When** inspecting tables
**Then** `sync_pair` table exists with columns: `pair_id` (TEXT PRIMARY KEY), `local_path` (TEXT), `remote_path` (TEXT), `remote_id` (TEXT), `created_at` (TEXT ISO 8601)
**And** `sync_state` table exists with columns: `pair_id` (TEXT), `relative_path` (TEXT), `local_mtime` (TEXT ISO 8601), `remote_mtime` (TEXT ISO 8601), `content_hash` (TEXT nullable), PRIMARY KEY (`pair_id`, `relative_path`)
**And** `change_queue` table exists with columns: `id` (INTEGER PRIMARY KEY), `pair_id` (TEXT), `relative_path` (TEXT), `change_type` (TEXT), `queued_at` (TEXT ISO 8601)

**Given** schema versioning
**When** querying `PRAGMA user_version`
**Then** it returns the current schema version number
**And** ordered integer migrations run automatically on startup if `user_version` is behind

**Given** unit tests for `state-db.ts`
**When** running `node --import tsx --test engine/src/state-db.test.ts`
**Then** each test uses a fresh `:memory:` database
**And** tests verify WAL mode, schema creation, migration ordering, and CRUD operations

---

### Story 2.2: SDK DriveClient Wrapper

As a developer,
I want a DriveClient wrapper that encapsulates all ProtonDrive SDK interactions behind a clean interface,
So that the rest of the engine is insulated from SDK version churn and breaking changes.

**Acceptance Criteria:**

**Given** `engine/src/sdk.ts`
**When** inspecting its imports
**Then** it is the sole file importing `@protontech/drive-sdk` and `openpgp`
**And** a boundary comment at the top enforces this rule
**And** `openpgp` is imported as the full bundle (never `openpgp/lightweight`)

**Given** the `DriveClient` class
**When** calling `listRemoteFolders(parentId: string | null)`
**Then** `parentId: null` returns root-level folders
**And** passing a folder `id` returns that folder's children (lazy expansion)
**And** `MaybeNode` return values are always unwrapped — `.ok` checked before accessing `.value`

**Given** the `DriveClient` class
**When** calling upload or download methods
**Then** `Uint8Array<ArrayBufferLike>` ↔ SDK `Uint8Array<ArrayBuffer>` casts are applied at the boundary
**And** all methods use `async/await` — no raw `.then()/.catch()` chains

**Given** any SDK method returns an error
**When** the error propagates
**Then** it is wrapped in a typed `SyncError` or `NetworkError` — never a raw `Error` or plain string

**Given** unit tests for `sdk.ts`
**When** running `node --import tsx --test engine/src/sdk.test.ts`
**Then** tests mock the SDK at the package boundary and verify DriveClient behaviour

---

### Story 2.3: Remote Folder Picker Component

As a user,
I want to select a ProtonDrive folder as the remote side of my sync pair,
So that I can choose where my files sync to in ProtonDrive.

**Acceptance Criteria:**

**Given** the remote folder picker dialog opens
**When** it renders
**Then** a text field is displayed pre-filled with the local folder name (e.g., if local is `~/Documents`, remote defaults to `/Documents`)

**Given** the user types in the text field
**When** characters are entered
**Then** top-level ProtonDrive folders are fetched as autocomplete suggestions via `list_remote_folders` IPC command (one SDK call, result cached for the session lifetime of the dialog)

**Given** the user wants a nested path
**When** they type `/Work/Projects/2026`
**Then** manual path entry is accepted without autocomplete validation
**And** a "Browse folders..." link is visible but non-functional (deferred to V1)

**Given** the remote folder picker
**When** navigating via keyboard only
**Then** Tab moves between text field and autocomplete suggestions
**And** Enter selects the highlighted suggestion
**And** Escape closes the autocomplete dropdown

---

### Story 2.4: Setup Wizard & First Pair Creation

As a new user,
I want a guided 3-step wizard to set up my first sync pair,
So that I can start syncing without confusion or documentation.

**Acceptance Criteria:**

**Given** the app launches with a valid token but no sync pairs configured
**When** routing logic executes (FR13)
**Then** the setup wizard opens at the folder selection step (not the auth step — auth already complete)

**Given** the app was closed after auth but before configuring a sync pair (interrupted wizard)
**When** the app relaunches
**Then** the wizard resumes at the folder selection step — it does not re-run auth or skip to the main window

**Given** the wizard is at the "Choose Your Folder" step
**When** the user clicks the local folder selector
**Then** the XDG File Chooser portal (`org.freedesktop.portal.FileChooser`) opens — not a raw GTK file dialog (FR38)
**And** the user selects a local folder

**Given** a local folder is selected
**When** the remote folder picker is displayed
**Then** it is the RemoteFolderPicker from Story 2.3

**Given** both local and remote folders are selected
**When** the user confirms the pair
**Then** the UI sends an `add_pair` IPC command with `{local_path, remote_path}`
**And** the engine generates a `pair_id` (UUID v4), stores it in SQLite, and returns it in `add_pair_result`
**And** the pair is also written to `$XDG_CONFIG_HOME/protondrive/config.yaml`
**And** YAML is the authoritative source for pair existence; SQLite is the state cache — a pair present in YAML but absent from SQLite triggers a fresh full sync (cold-start); if the SQLite write succeeds but YAML write fails, the pair is not considered created

**Given** the pair is created
**When** the wizard transitions to "You're Syncing"
**Then** the main window displays with the new pair in the sidebar and first sync begins immediately

**Given** the wizard steps
**When** inspecting navigation
**Then** no Back button exists on the auth step (browser session, server-side state)
**And** a Back button exists on the folder selection step (UX-DR4)

**Given** the wizard UI
**When** defined in Blueprint
**Then** all widget structure is in `ui/data/ui/setup-wizard.blp` with Python wiring in `ui/src/protondrive/widgets/setup_wizard.py`

---

### Story 2.5: Sync Engine Core - Two-Way Sync

As a user,
I want my files to sync in both directions continuously while the app is open,
So that my local files and ProtonDrive stay in sync automatically.

**Acceptance Criteria:**

**Given** a sync pair is active
**When** a sync cycle runs
**Then** the engine compares local file mtimes against stored `sync_state` records
**And** compares remote file mtimes (fetched via SDK) against stored remote mtimes
**And** files changed only locally are uploaded; files changed only remotely are downloaded

**Given** a file is downloaded from ProtonDrive
**When** writing to disk
**Then** the file is written to `<path>.protondrive-tmp-<timestamp>` first
**And** on successful completion, `rename()` moves it to the final destination path (NFR12)
**And** on failure, the tmp file is `unlink()`ed — no partial files at destination

**Given** a sync operation completes for a file
**When** the state is recorded
**Then** both local mtime and remote mtime are written to SQLite `sync_state` before the operation is considered complete (NFR15)
**And** no sync state exists only in memory

**Given** multiple files need syncing
**When** the sync engine processes them
**Then** concurrent file transfers are capped at a default maximum of 3 (NFR4)

**Given** a pair is present in YAML config but absent from SQLite (cold-start)
**When** the engine starts
**Then** it treats this as a fresh full sync — no crash, no error

**Given** the sync engine emits progress
**When** files are transferring
**Then** `sync_progress` push events are sent with `{pair_id, files_done, files_total, bytes_done, bytes_total}`
**And** `sync_complete` push event is sent with `{pair_id, timestamp}` when a cycle finishes

**Given** the engine's `console.log()` or `console.error()`
**When** in production mode
**Then** stdout and stderr are routed to `/dev/null` — `console.log()` would corrupt IPC framing

---

### Story 2.6: inotify File Watcher & Change Detection

As a user,
I want the app to detect file changes in my synced folders automatically,
So that new or modified files sync without me manually triggering anything.

**Acceptance Criteria:**

**Given** a sync pair is active
**When** the watcher initializes
**Then** inotify watches are set up per subdirectory within the synced folder tree
**And** initialization runs asynchronously — does not block the GTK main loop (NFR3a)
**And** the StatusFooterBar shows "Initializing file watcher..." during setup

**Given** a file is modified in a watched directory
**When** inotify fires an event
**Then** the change is debounced and added to the sync queue within 5 seconds (NFR3)

**Given** the system runs out of inotify watches (`ENOSPC`)
**When** the watcher encounters the limit
**Then** a visible error is surfaced to the user: "Too many files to watch — close other apps or increase system inotify limit"
**And** the watcher does not crash — it continues watching the directories it has already registered

**Given** unit tests for `watcher.ts`
**When** running `node --import tsx --test engine/src/watcher.test.ts`
**Then** tests verify debouncing behaviour, event aggregation, and ENOSPC handling

---

### Story 2.7: SyncPairRow & StatusFooterBar Components

As a user,
I want to see the sync status of each pair in the sidebar and a global status bar at the bottom,
So that I know what's happening at a glance without clicking into anything.

**Acceptance Criteria:**

**Given** a sync pair exists
**When** the sidebar renders
**Then** a `SyncPairRow` is displayed with: animated status dot (8px circle) + pair name (13px) + optional status text (10px, secondary colour)
**And** states implemented: synced (green dot), syncing (teal dot with CSS `@keyframes` pulse animation)
**And** the row is a `GtkListBoxRow` subclass with custom `GtkBox` layout

**Given** the main window renders
**When** the `StatusFooterBar` is visible
**Then** it is a persistent bar pinned at the bottom of the window (36px height)
**And** states implemented: "All synced" (green dot), "Syncing N files in [pair]..." (teal dot, animated)
**And** priority logic is enforced: most urgent state always shown (for now: Syncing > All synced)

**Given** the `SyncPairRow` status changes
**When** a screen reader reads the sidebar
**Then** accessible labels announce: "Documents — synced" or "Documents — syncing" — not colour alone

**Given** the `StatusFooterBar` state changes
**When** AT-SPI2 is queried
**Then** state changes are announced with `GTK_ACCESSIBLE_STATE_LIVE` (polite, not assertive)

**Given** both components
**When** using Libadwaita colour tokens
**Then** status dots use Libadwaita semantic tokens (`@success_color` for synced) — no hardcoded colours
**And** the teal accent is used only for the syncing state

**Given** all widget structure
**When** inspecting implementation
**Then** structure is in `ui/data/ui/sync-pair-row.blp` and Python wiring in `ui/src/protondrive/widgets/sync_pair_row.py`
**And** no widget file imports from another widget file — coordination through `window.py`

---

### Story 2.8: SyncProgressCard & Detail Panel

As a user,
I want to see detailed sync progress and stats for the selected pair,
So that I know exactly what's happening during first sync and ongoing operations.

**Acceptance Criteria:**

**Given** a sync pair is selected in the sidebar
**When** the detail panel renders
**Then** it shows: pair name, local path, remote path, last synced timestamp, file count, total size, status

**Given** no sync pair is selected
**When** the detail panel renders
**Then** an `AdwStatusPage` is displayed: "Select a sync pair to see details" (UX-DR16)

**Given** zero sync pairs exist (post-auth, pre-wizard completion)
**When** the detail area renders
**Then** an `AdwStatusPage` with teal CTA "Add your first sync pair to start syncing" is displayed (UX-DR16)

**Given** a sync is actively running for the selected pair
**When** the `SyncProgressCard` renders
**Then** it replaces the normal stats cards in the detail panel
**And** initially shows an indeterminate `GtkProgressBar` + "Counting files..."
**And** once file count is known, switches to determinate bar + file count label + bytes transferred/total label + ETA label (FR15)
**And** after sync completes, transitions back to normal detail stats after 2 seconds

**Given** `sync_progress` IPC events arrive
**When** the UI processes them
**Then** the progress card updates in real time with `files_done/files_total` and `bytes_done/bytes_total`
**And** UI interactions remain responsive within 200ms during progress updates (NFR2)

**Given** `sync_complete` IPC events arrive
**When** the UI processes them
**Then** the detail panel shows "Last synced X seconds ago" with the timestamp from the event (FR18, FR19)

---

### Story 2.9: Window State Persistence

As a user,
I want the app to remember its window size and position between sessions,
So that I don't have to resize it every time I open it.

**Acceptance Criteria:**

**Given** the user resizes or moves the app window
**When** the window is closed
**Then** the window geometry (width, height, position, maximized state) is saved to `$XDG_STATE_HOME/protondrive/` (creating the directory if needed)

**Given** the app launches
**When** a saved window state exists
**Then** the window is restored to the saved geometry
**And** if no saved state exists, the default size of 780x520px is used

**Given** the window state storage
**When** inspecting the implementation
**Then** window geometry is stored via `Gio.Settings` or a plain file — not in SQLite
**And** one `Gio.Settings` instance is held by the `Application` class and passed to widgets via constructor (never per-widget)

---

### Story 2.10: Flatpak Build Validation

As a developer,
I want to verify the app builds and runs correctly as a Flatpak,
So that sandbox issues are caught early and not discovered at Flathub submission time.

**Acceptance Criteria:**

**Given** the Flatpak manifest at `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** `flatpak-builder --user --install builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` is run
**Then** the build completes successfully

**Given** the Flatpak build
**When** inspecting the manifest
**Then** Node.js 22 is bundled via `org.freedesktop.Sdk.Extension.node22`
**And** `better-sqlite3` native addon is built from source (not pre-built binary)
**And** GNOME runtime is `org.gnome.Platform//50`

**Given** the built Flatpak
**When** launched via `flatpak run io.github.ronki2304.ProtonDriveLinuxClient`
**Then** the app starts, engine spawns within the sandbox, IPC connects, and the main window appears
**And** the engine can create the SQLite database at the sandbox-mapped `$XDG_DATA_HOME` path
**And** inotify watches work on folders accessible via `--filesystem=home`

**Given** the Flatpak finish-args
**When** inspecting permissions
**Then** `--share=network` is declared
**And** `--filesystem=home` is declared (inotify requires direct filesystem access)
**And** Secret portal access is declared for credential storage

---

## Epic 3: Offline Resilience & Network Handling

User always knows when they're offline, changes queue automatically and persist to disk, and sync resumes without user action when network returns. Rate limiting is surfaced visibly. The app never appears frozen or broken during network disruptions.

### Story 3.1: Offline Detection & UI Indicators

As a user,
I want to clearly see when the app is offline,
So that I understand why sync isn't happening and trust that my changes are safe.

**Acceptance Criteria:**

**Given** the app launches with no network available
**When** the main window renders
**Then** an offline banner is displayed with last-synced timestamps per pair — never a blank screen or hanging spinner (FR20)
**And** the `StatusFooterBar` shows "Offline — changes queued" with a grey dot

**Given** the network drops mid-session
**When** the engine detects the loss
**Then** the engine emits an `offline` push event
**And** the UI immediately shows an offline indicator (FR21)
**And** each `SyncPairRow` in the sidebar shifts to the offline state: grey dot with accessible label "[pair name] — offline"

**Given** the network is restored
**When** the engine detects connectivity
**Then** the engine emits an `online` push event
**And** the UI clears the offline indicator and pair rows return to their previous states

**Given** the offline state
**When** a screen reader reads the sidebar
**Then** each pair announces its offline state: "Documents — offline"
**And** the `StatusFooterBar` announces "Offline — changes queued" via AT-SPI2 (polite)

---

### Story 3.2: Offline Change Queue (Persistent)

As a user,
I want my local file changes to be queued while offline,
So that nothing is lost and changes sync when the connection returns.

**Acceptance Criteria:**

**Given** the app is offline (network unavailable or session expired)
**When** local files are modified in a watched sync pair folder
**Then** the changes are added to the `change_queue` table in SQLite (FR16)
**And** the queue is persisted to disk — survives application crashes (NFR14)

**Given** the change queue has entries
**When** the UI queries status via `get_status`
**Then** the response includes the count of queued changes per pair

**Given** the app crashes while offline with queued changes
**When** the app restarts
**Then** all previously queued changes are still present in the `change_queue` table
**And** no queued change is silently lost

**Given** the change queue
**When** inspecting the storage
**Then** each entry records: `pair_id`, `relative_path`, `change_type` (created/modified/deleted), `queued_at` (ISO 8601)

---

### Story 3.3: Queue Replay & Auto-Resume on Reconnect

As a user,
I want my queued changes to sync automatically when the connection returns,
So that I don't have to manually trigger sync after being offline.

**Acceptance Criteria:**

**Given** the network is restored after an offline period
**When** the engine receives the `online` event
**Then** sync resumes automatically without user action (FR22)

**Given** queued local changes exist
**When** the queue is replayed
**Then** for each queued file, the engine fetches the current remote metadata (mtime) and compares it against the remote mtime stored at last sync (FR17)
**And** files changed only locally (remote mtime unchanged since last sync) are uploaded without conflict
**And** files changed on both sides since the last sync point trigger the conflict copy pattern (deferred to Epic 4 for full implementation — in this story, both-sides-changed files are skipped and kept in the queue)
**And** for skipped files, the `StatusFooterBar` shows a temporary indicator: "N files need conflict resolution" so the user knows files are pending, not lost

**Given** the queue replay completes
**When** all queued changes are processed
**Then** successfully synced entries are removed from the `change_queue` table
**And** the `StatusFooterBar` updates to reflect the new sync state
**And** a toast "N files synced" is shown via `AdwToastOverlay` (auto-dismiss 3s)

**Given** queue replay
**When** a file in the queue no longer exists locally (deleted while offline)
**Then** the deletion is synced to the remote (if the remote file is unchanged since last sync)
**And** the queue entry is removed

---

### Story 3.4: Rate Limit Handling & UI

As a user,
I want to know when ProtonDrive is rate-limiting my sync,
So that I understand why sync is paused and know it will resume automatically.

**Acceptance Criteria:**

**Given** the SDK returns a 429 (rate limited) response
**When** the engine processes it
**Then** the engine applies exponential backoff on retries (FR23)
**And** emits a `rate_limited` push event with `{resume_in_seconds}`

**Given** the UI receives a `rate_limited` event
**When** rendering the rate-limited state
**Then** the `StatusFooterBar` shows "Sync paused — resuming in Xs" with a countdown or paused indicator
**And** the footer auto-clears when the engine resumes sync

**Given** the rate-limited state
**When** the countdown expires
**Then** the engine automatically retries the operation
**And** the UI transitions back to the syncing or synced state

**Given** the rate-limited state
**When** the user inspects the UI
**Then** no error is shown — rate limiting is presented as a temporary pause, not a failure

---

## Epic 4: Conflict Detection & Resolution

User's files are never silently overwritten. Conflicts create date-stamped copies, trigger both in-app and desktop notifications, and are discoverable via the conflict log with "Reveal in Files." Both file versions are always preserved.

### Story 4.1: Conflict Detection (Existing Files)

As a user,
I want the sync engine to detect when a file has been changed on both my machine and ProtonDrive since the last sync,
So that neither version is silently overwritten.

**Acceptance Criteria:**

**Given** a file exists in `sync_state` with stored `local_mtime` and `remote_mtime`
**When** a sync cycle runs
**Then** the engine compares current local mtime against stored local mtime AND current remote mtime against stored remote mtime
**And** if both have changed since last sync, the file is flagged as a conflict (FR25)

**Given** both mtimes changed but are within the same second (ambiguous resolution)
**When** conflict detection runs
**Then** the engine falls back to comparing a locally-computed content hash against the hash stored at last sync (FR25)
**And** no live remote fetch is performed for hash comparison — uses the stored hash only

**Given** only the local mtime changed (remote unchanged)
**When** a sync cycle runs
**Then** the file is uploaded normally — no conflict

**Given** only the remote mtime changed (local unchanged)
**When** a sync cycle runs
**Then** the file is downloaded normally — no conflict

**Given** unit tests for `conflict.ts`
**When** running `node --import tsx --test engine/src/conflict.test.ts`
**Then** tests cover: both-sides-changed, same-second mtime with differing hashes, same-second mtime with same hash (no conflict), local-only change, remote-only change

---

### Story 4.2: New-File Collision Detection

As a user,
I want the sync engine to handle collisions when I add a new file that already exists remotely,
So that neither my local file nor the remote file is lost.

**Acceptance Criteria:**

**Given** a new local file has no entry in `sync_state` (never previously synced)
**When** the engine prepares to upload it
**Then** it checks for remote path collisions — whether a remote file exists at the same relative path (FR25a)

**Given** a remote file exists at the same relative path
**When** the collision is detected
**Then** the local file is renamed to `filename.ext.conflict-YYYY-MM-DD`
**And** both versions are preserved (local conflict copy + remote original)
**And** the user is notified via the standard conflict notification pattern

**Given** no remote file exists at the same relative path
**When** the new file is uploaded
**Then** it proceeds as a normal upload — no conflict copy created

---

### Story 4.3: Conflict Copy Creation

As a user,
I want conflict copies to be created with a clear, consistent naming pattern,
So that I can easily identify and find them.

**Acceptance Criteria:**

**Given** a conflict is detected
**When** a conflict copy is created
**Then** it is named `filename.ext.conflict-YYYY-MM-DD` — suffix appended AFTER the extension (FR26)
**And** example: `notes.md` → `notes.md.conflict-2026-04-08`

**Given** a conflict copy is created
**When** the file is written
**Then** it uses atomic write: write to `<path>.protondrive-tmp-<timestamp>` then `rename()` on success (NFR12)
**And** the original file at the destination path is never overwritten before the conflict copy is safely written

**Given** a conflict is detected
**When** the conflict copy is created
**Then** a `conflict_detected` push event is emitted with `{pair_id, local_path, conflict_copy_path}`

**Given** zero file data loss is required (NFR11)
**When** any conflict scenario occurs
**Then** a conflict copy is ALWAYS created before any local file is overwritten
**And** this holds across app restarts, network interruptions, and session expiry

---

### Story 4.4: In-App Conflict Notification & Pair Status

As a user,
I want to see conflict notifications inside the app and on the affected sync pair,
So that I notice conflicts without checking my filesystem manually.

**Acceptance Criteria:**

**Given** a `conflict_detected` event is received by the UI
**When** the notification renders
**Then** an `AdwBanner` appears with amber styling: "1 conflict in [pair name]" (FR27)
**And** the banner is persistent and user-dismissible (not auto-dismiss)

**Given** a conflict exists on a sync pair
**When** the sidebar renders
**Then** the affected `SyncPairRow` shows an amber dot with accessible label "[pair name] — 1 conflict"
**And** the `StatusFooterBar` shows "N conflicts need attention" with an amber dot (UX-DR7)

**Given** the `StatusFooterBar` priority logic
**When** both conflicts and syncing are active
**Then** conflict state takes priority over syncing state (Conflict > Syncing > All synced)

**Given** a conflict is resolved (conflict copy deleted by user in file manager)
**When** the next sync cycle detects the deletion
**Then** the conflict state clears — pair dot returns to green, banner dismissed, footer updates

---

### Story 4.5: Desktop Notification for Conflicts

As a user,
I want a desktop notification when a conflict is detected while the app is open,
So that I notice conflicts even if the app window isn't in focus.

**Acceptance Criteria:**

**Given** a `conflict_detected` event is received
**When** the application window is open (foreground notification — no background daemon required)
**Then** a desktop notification is sent via the GNOME notification API (FR27a)
**And** the notification body includes the filename and pair name

**Given** the desktop notification
**When** the user clicks it
**Then** the app window is brought to focus with the affected pair selected in the sidebar

---

### Story 4.6: Conflict Log & Reveal in Files

As a user,
I want to view a log of all conflicts and locate conflict copies from within the app,
So that I can find and resolve them without opening a file manager.

**Acceptance Criteria:**

**Given** one or more conflicts have occurred
**When** the user opens the conflict log (via "View conflict log" button in detail panel)
**Then** a list of all conflicts is displayed (FR28)

**Given** each entry in the conflict log
**When** it renders
**Then** a `ConflictLogRow` component is displayed with: warning icon + filename (bold, amber) + pair name + timestamp + "Reveal in Files" action link (UX-DR10)

**Given** an unresolved conflict entry
**When** the user clicks "Reveal in Files"
**Then** `org.freedesktop.portal.OpenURI` opens the system file manager at the conflict copy location (FR29)

**Given** a conflict copy has been deleted by the user (resolved manually)
**When** the next sync cycle runs and detects the deletion
**Then** the `ConflictLogRow` transitions to resolved state: dimmed, strikethrough filename, auto-detected

**Given** the conflict log panel
**When** navigating via keyboard
**Then** Tab moves between conflict entries, Enter activates "Reveal in Files"
**And** screen reader announces: conflict filename, pair name, timestamp, and "Reveal in Files" action

**Given** all widget structure
**When** inspecting implementation
**Then** structure is in `ui/data/ui/conflict-log.blp` with Python wiring in `ui/src/protondrive/widgets/conflict_log.py`

---

## Epic 5: Token Expiry & Error Recovery

User can recover from expired sessions with zero data loss — queued changes are preserved and replayed without false conflicts. Crash recovery is automatic with an informational toast. Sync errors are actionable with specific resolution guidance.

### Story 5.1: 401 Detection & Sync Halt

As a user,
I want the sync engine to immediately stop retrying when my session expires,
So that it doesn't loop on failed requests and instead prompts me to re-authenticate.

**Acceptance Criteria:**

**Given** the SDK returns a 401 (unauthorized) response
**When** the engine processes it
**Then** sync halts immediately — no retry on 401 (NFR17)
**And** the engine emits a `token_expired` push event with `{queued_changes}` (count of locally-changed files pending sync)

**Given** a `token_expired` event is emitted
**When** the UI processes it
**Then** the window header shifts to a warning state
**And** local file changes continue to be queued to the `change_queue` table (they are not dropped)

**Given** the 401 detection
**When** it occurs within one failed sync attempt
**Then** the engine does not silently retry — detection is immediate, not after N retries

---

### Story 5.2: Re-Auth Modal with Queued Change Count

As a user,
I want to see how many changes are waiting and re-authenticate easily,
So that I know my data is safe and can resume sync quickly.

**Acceptance Criteria:**

**Given** a `token_expired` event is received
**When** the app window is visible
**Then** an `AdwAlertDialog` modal appears with: heading "Session expired" and body "Your Proton session has expired — this can happen after a password change or routine token refresh. [N] local changes are waiting to sync. Sign in to resume." (FR4, FR5)

**Given** the app window is minimized when token expires
**When** the user brings the window forward
**Then** the re-auth modal is shown immediately

**Given** the re-auth modal
**When** the user clicks "Sign in"
**Then** the embedded WebKitGTK auth browser opens (same flow as first-run auth)
**And** on successful auth, the new token is stored in the credential store and sent to the engine via `token_refresh` IPC command

**Given** re-auth completes
**When** the engine validates the new token
**Then** a `session_ready` event is emitted
**And** the modal closes and the UI transitions to normal state
**And** the `session_ready` handler is the same handler used for initial auth — no separate code path

**Given** re-auth fails (e.g., network error during auth)
**When** the auth browser encounters an error
**Then** an error is shown within the modal with a "Retry" option

**Given** the re-auth modal
**When** inspecting implementation
**Then** structure is in `ui/data/ui/reauth-dialog.blp` with Python wiring in `ui/src/protondrive/widgets/reauth_dialog.py`

---

### Story 5.3: Change Queue Replay After Re-Auth

As a user,
I want my queued changes to sync automatically after I re-authenticate,
So that I don't lose any work that happened while my session was expired.

**Acceptance Criteria:**

**Given** re-auth completes successfully (`session_ready` received)
**When** queued changes exist in the `change_queue` table
**Then** the engine replays them against the current remote state

**Given** a queued file where only the local version changed (remote mtime unchanged since last sync)
**When** the queue replays
**Then** the file is uploaded without creating a conflict copy — no false conflicts (FR17)

**Given** a queued file where both local and remote changed since last sync
**When** the queue replays
**Then** a conflict copy is created following the standard conflict pattern (Epic 4)

**Given** all queued changes are replayed
**When** the replay completes
**Then** successfully synced entries are removed from the `change_queue` table
**And** the `StatusFooterBar` shows "N files synced" toast

---

### Story 5.4: Dirty-Session Flag & Crash Recovery

As a user,
I want the app to recover cleanly from crashes without losing data or requiring manual cleanup,
So that I can trust the app even if something goes wrong.

**Acceptance Criteria:**

**Given** a sync operation begins
**When** the engine starts processing
**Then** a dirty-session flag is set in the StateDB (e.g., `PRAGMA user_version` metadata or a `session_state` table entry)

**Given** a sync operation completes normally
**When** the operation finishes
**Then** the dirty-session flag is cleared

**Given** the engine starts and detects a dirty-session flag
**When** initialization runs
**Then** the engine scans for incomplete `.dl-tmp-*` files at sync pair paths
**And** any found `.dl-tmp-*` files are deleted (they are incomplete downloads)
**And** the dirty-session flag is cleared
**And** crash recovery is resolved before the first sync operation begins (NFR16)

**Given** crash recovery completes
**When** the UI is informed
**Then** a transient toast notification is shown: "Recovered from unexpected shutdown — sync resuming" (FR44)
**And** no user action is required — recovery is automatic

**Given** the crash recovery process
**When** inspecting sync state after recovery
**Then** sync pairs are intact, token is present, last-known mtimes are preserved in SQLite, no partial files at destination paths (NFR16)

---

### Story 5.5: Actionable Error - Disk Full

As a user,
I want a clear message when sync fails because my disk is full,
So that I know exactly what to do to fix it.

**Acceptance Criteria:**

**Given** the sync engine encounters a disk full error during file write
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "DISK_FULL", message: "Free up space on [drive] to continue syncing", pair_id}`

**Given** the UI receives a `DISK_FULL` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card (non-fatal — not an app-level banner)
**And** the error message identifies the cause and provides one actionable next step

---

### Story 5.6: Actionable Error - Permission Denied

As a user,
I want a clear message when sync fails due to folder permissions,
So that I can fix the permissions and resume syncing.

**Acceptance Criteria:**

**Given** the sync engine encounters a permission denied error when reading/writing a file
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "PERMISSION_DENIED", message: "Check folder permissions for [path]", pair_id}`

**Given** the UI receives a `PERMISSION_DENIED` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card

---

### Story 5.7: Actionable Error - inotify Limit Exceeded

As a user,
I want a clear message when the system can't watch all my files,
So that I understand the limitation and know how to fix it.

**Acceptance Criteria:**

**Given** the inotify watcher encounters `ENOSPC` (watch limit exceeded)
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "INOTIFY_LIMIT", message: "Too many files to watch — close other apps or increase system inotify limit", pair_id}`

**Given** the UI receives an `INOTIFY_LIMIT` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card
**And** the watcher continues operating on already-registered directories — no crash

---

### Story 5.8: Actionable Error - File Locked

As a user,
I want to know when a file can't sync because it's in use by another program,
So that I understand the sync will retry automatically.

**Acceptance Criteria:**

**Given** the sync engine encounters a file locked error (EBUSY or similar)
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "FILE_LOCKED", message: "[file] is in use — sync will retry when it's released", pair_id}`

**Given** the UI receives a `FILE_LOCKED` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card
**And** the engine retries the file on the next sync cycle

---

### Story 5.9: Actionable Error - SDK/API Error & Error State Components

As a user,
I want a clear message for unexpected sync errors,
So that I have a starting point for troubleshooting.

**Acceptance Criteria:**

**Given** the sync engine encounters an SDK or API error not covered by other error categories
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "SDK_ERROR", message: "Sync error [code] — try again or check ProtonDrive status", pair_id}`

**Given** the UI receives any non-fatal error event with a `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a red dot with accessible label "[pair name] — error"
**And** the `StatusFooterBar` shows "Sync error in [pair name]" with a red dot
**And** the error priority is highest: Error > Conflict > Syncing > Offline > All synced

**Given** a fatal error (engine crash — socket close without `shutdown` command)
**When** the UI detects it
**Then** an app-level error banner with a restart button is shown — NOT the inline pair card error

**Given** the error state components
**When** a screen reader reads the sidebar and footer
**Then** pair error state is announced: "[pair name] — error"
**And** footer announces "Sync error in [pair name]"

---

## Epic 6: Multi-Pair Management & Validation

User can confidently manage multiple sync pairs — add subsequent pairs from the main window without re-running the wizard, remove pairs with explicit no-delete confirmation, and trust that nesting/overlap validation prevents configuration errors. Missing local folders are detected and recoverable.

### Story 6.1: Add Subsequent Sync Pair

As a user,
I want to add more sync pairs from the main window at any time,
So that I can sync multiple folders without re-running the setup wizard.

**Acceptance Criteria:**

**Given** the main window is displaying with at least one existing sync pair
**When** the user clicks "[+ Add Pair]" pinned at the bottom of the sidebar
**Then** a lightweight add-pair flow opens — no wizard chrome (FR9)
**And** it shows the XDG File Chooser portal for local folder selection, then the RemoteFolderPicker for remote folder selection

**Given** the user confirms the new pair
**When** the `add_pair` IPC command is sent
**Then** the engine generates a new `pair_id` (UUID v4), stores the pair in SQLite, and returns it in `add_pair_result`
**And** the pair is added to `config.yaml`
**And** the new pair appears in the sidebar immediately and sync starts

**Given** the user has multiple sync pairs configured
**When** managing them
**Then** at least 5 independent sync pairs can operate simultaneously (FR10)
**And** each pair syncs independently — an error in one pair does not affect others

**Given** the add-pair flow
**When** navigating via keyboard
**Then** all inputs and buttons are reachable via Tab and actionable via Enter/Space

---

### Story 6.2: Nesting & Overlap Validation

As a user,
I want the app to prevent me from creating sync pairs that overlap or nest inside each other,
So that I don't accidentally cause duplicate syncing or file conflicts.

**Acceptance Criteria:**

**Given** the user attempts to add a new sync pair
**When** the new local path is inside an existing pair's local path
**Then** the pair is rejected with inline error: "This folder is inside your '[existing pair name]' sync pair — syncing a subfolder separately would cause duplicate files" (UX-DR14)

**Given** the user attempts to add a new sync pair
**When** an existing pair's local path is inside the new local path
**Then** the pair is rejected with inline error naming the conflicting pair and explaining the overlap risk

**Given** the user attempts to add a new sync pair
**When** the new remote path is inside an existing pair's remote path
**Then** the pair is rejected with inline error naming the conflicting pair

**Given** the user attempts to add a new sync pair
**When** the new remote path points to the same remote folder as an existing pair
**Then** the pair is rejected with inline error: "Already in use by [pair name]"

**Given** validation errors
**When** they are displayed
**Then** errors are shown inline below the relevant field — never a separate error dialog
**And** errors name the specific conflicting pair and suggest a resolution

**Given** all four validation checks
**When** they run
**Then** they execute at confirmation time, not on every keystroke

---

### Story 6.3: Remove Sync Pair with Confirmation

As a user,
I want to remove a sync pair with a clear confirmation that no files will be deleted,
So that I can reorganize my sync setup without fear of data loss.

**Acceptance Criteria:**

**Given** the user clicks "Remove pair" in the detail panel
**When** the confirmation dialog appears
**Then** it is an `AdwAlertDialog` with heading "Stop syncing this folder pair?" and body: "Local files in `[local path]` will not be affected. Remote files in `ProtonDrive/[remote path]` will not be affected. Sync will simply stop." (FR12, UX-DR15)
**And** two buttons: "Cancel" (default/escape, suggested-action style) and "Remove" (destructive-action style)

**Given** the user confirms removal
**When** the removal is processed
**Then** the `remove_pair` IPC command is sent with `{pair_id}`
**And** the pair is removed from SQLite and `config.yaml`
**And** local files remain untouched (FR11)
**And** remote files remain untouched
**And** the pair disappears from the sidebar

**Given** the "Remove pair" button
**When** inspecting its position relative to other buttons
**Then** it is never adjacent to a primary (suggested-action) button — always separated by distance or a divider (UX-DR17)

**Given** only one pair exists and is removed
**When** the sidebar is empty
**Then** the detail area shows the `AdwStatusPage` empty state: "Add your first sync pair to start syncing"

---

### Story 6.4: Local Folder Missing Detection & Recovery

As a user,
I want the app to detect when my synced local folder has been moved or deleted,
So that I can fix the issue instead of the pair silently failing.

**Acceptance Criteria:**

**Given** a sync pair's local folder path no longer exists on the filesystem
**When** the engine detects this (at startup or during a sync cycle)
**Then** the affected pair shows a dedicated error state in the sidebar — not a global error (FR45)

**Given** the missing folder error state
**When** the detail panel renders for the affected pair
**Then** it displays: "Local folder not found at `[path]`. Was it moved?" with two action buttons: "Update path" and "Remove pair"

**Given** the user clicks "Update path"
**When** the action is triggered
**Then** the XDG File Chooser portal opens for the user to select a new local folder
**And** on selection, the pair's `local_path` is updated in both SQLite and `config.yaml`
**And** sync resumes with the new path

**Given** the user clicks "Remove pair"
**When** the action is triggered
**Then** the standard removal confirmation dialog from Story 6.3 is shown

**Given** a missing folder
**When** the pair is displayed in the sidebar
**Then** the `SyncPairRow` shows a dedicated error indicator (distinct from sync errors)
**And** the pair is never silently dropped from the list

---

## Epic 7: Packaging & Distribution

User can install from Flathub with one click. AppStream metainfo, desktop file, CI/CD pipelines, and Flatpak manifest with justified permissions are complete and pass Flathub quality review.

### Story 7.1: Flatpak Manifest & Permission Justifications

As a user,
I want the app to have correct Flatpak permissions with clear justifications,
So that the app passes Flathub review and I can understand why each permission is needed.

**Acceptance Criteria:**

**Given** the Flatpak manifest at `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** inspecting `finish-args`
**Then** `--share=network` is declared (required for ProtonDrive API access)
**And** `--filesystem=home` is declared (inotify requires direct filesystem access; portal FUSE does not fire inotify events — confirmed upstream bug xdg-desktop-portal #567)
**And** Secret portal access is declared for credential storage
**And** no `--talk-name=org.freedesktop.secrets` (insecure — grants cross-app secret access)

**Given** the finish-args justification
**When** a document is prepared
**Then** a plain-language justification explains the `--filesystem=home` permission: the platform limitation in terms both Flathub reviewers and end users can understand
**And** the justification is included as comments in the manifest and as a separate document

**Given** FR40 (proxy support)
**When** evaluating proxy implementation
**Then** either system proxy settings are respected (`http_proxy`/`https_proxy` and GNOME proxy settings) OR proxy support is explicitly documented as unsupported in v1 with a filed GitHub issue

---

### Story 7.2: AppStream Metainfo & Desktop File

As a user,
I want the app to appear correctly in GNOME Software / KDE Discover with proper metadata,
So that I can discover the app and understand what it does before installing.

**Acceptance Criteria:**

**Given** `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
**When** inspecting the AppStream metainfo
**Then** it includes: app ID (`io.github.ronki2304.ProtonDriveLinuxClient`), display name ("ProtonDrive Linux Client"), summary ("Unofficial open-source sync client for ProtonDrive on Linux"), description, developer info, screenshots, release notes, and OARS content rating (`oars-1.1`, all fields `none`)
**And** release notes are treated as first-class user-facing content (FR41)
**And** MIT license is referenced

**Given** `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.desktop`
**When** inspecting the desktop file
**Then** `Categories=Network;FileTransfer;` is set
**And** `Keywords=sync;proton;drive;cloud;` is set
**And** correct Flatpak `Exec=` line is configured
**And** `StartupNotify=true` is set

**Given** the project README
**When** `README.md` is created at the project root
**Then** it includes: what the project is, Flathub install badge, screenshot of the main window, what makes it different (official SDK, solved WebKitGTK auth), link to Flatpak manifest permissions with justification summary, link to CONTRIBUTING.md, MIT license badge
**And** the README is the GitHub front door — written for r/linux and r/ProtonMail readers who arrive skeptical

**Given** the AppStream metainfo
**When** validated with `appstream-util validate`
**Then** validation passes with no errors

---

### Story 7.3: CI/CD Pipelines

As a developer,
I want automated CI/CD pipelines for testing and releasing,
So that every PR is tested and releases are built reproducibly.

**Acceptance Criteria:**

**Given** `.github/workflows/ci.yml`
**When** a PR is opened or updated
**Then** the pipeline runs both test suites: `meson test -C builddir` (UI/Python) AND `node --import tsx --test engine/src/**/*.test.ts` (engine/TypeScript)
**And** both must pass for the PR to be mergeable

**Given** `.github/workflows/release.yml`
**When** a `v*` tag is pushed
**Then** the pipeline builds the Flatpak bundle
**And** creates a GitHub Release with the built artifact
**And** the build is reproducible — no manual release steps (FR42)

**Given** the CI pipeline
**When** inspecting the test commands
**Then** engine tests use `--import tsx` loader (without it, Node 22 cannot parse TypeScript imports)
**And** UI tests run via `meson test` (not raw `python -m pytest` — Meson compiles Blueprint and GSettings first)

**Given** the release pipeline
**When** inspecting the build
**Then** `better-sqlite3` native addon is compiled from source
**And** the build uses `org.gnome.Platform//50` runtime

**Given** the project CONTRIBUTING.md
**When** `CONTRIBUTING.md` is created at the project root
**Then** it documents: development setup (two-terminal launch), integration test token workflow (manual auth → `secret-tool lookup` → env vars → `node --test`), token expiry behaviour, test commands for both UI (`meson test`) and engine (`node --import tsx --test`), branch naming conventions, commit message conventions
**And** it covers the architecture doc's explicit requirement: "integration test prerequisite documented in CONTRIBUTING.md"

---

### Story 7.4: End-to-End MVP Validation & Manual Test Protocol

As a developer,
I want a manual validation checklist that walks through all 5 user journeys on the target distro matrix,
So that the MVP is verified as a complete, working product before Flathub submission.

**Acceptance Criteria:**

**Given** the MVP is feature-complete (all stories in Epics 1-6 done)
**When** manual validation is performed
**Then** all 5 PRD user journeys are executed end-to-end:

1. **First Run (Journey 1):** Install from Flatpak → authenticate → set up first sync pair → see files sync with progress → verify "Last synced X seconds ago"
2. **Conflict (Journey 2):** Edit same file locally and remotely while app is closed → open app → verify conflict copy created → verify conflict notification → "Reveal in Files" works
3. **Token Expiry (Journey 3):** Force token expiry → verify re-auth modal with queued change count → re-authenticate → verify queued changes replay without false conflicts
4. **Contributor (Journey 4):** Verify SDK boundary in source → verify Flatpak permission justifications → verify credential storage error handling on non-GNOME desktop
5. **Sync Pair Removal (Journey 5):** Remove a sync pair → verify confirmation dialog copy → verify files untouched on both sides

**Given** the target distro matrix
**When** validation is performed
**Then** all 5 journeys pass on: Fedora 43, Ubuntu 24/25, Bazzite, Arch
**And** auth specifically succeeds on the distros where DonnieDice fails

**Given** the manual test protocol
**When** it is documented
**Then** a `TESTING.md` file exists in the project root with step-by-step instructions for each journey
**And** integration test prerequisites are documented (manual auth flow for `PROTON_TEST_TOKEN`)
**And** known limitations are listed (no automated integration tests due to CAPTCHA)

**Given** accessibility validation
**When** performed as part of E2E
**Then** all 3 critical journeys (first run, conflict handling, re-auth) are completed using keyboard only
**And** Orca screen reader correctly announces all interactive elements, status changes, and error states
