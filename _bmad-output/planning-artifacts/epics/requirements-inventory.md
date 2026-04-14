# Requirements Inventory

## Functional Requirements

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

## NonFunctional Requirements

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

## Additional Requirements

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

## UX Design Requirements

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

## FR Coverage Map

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
