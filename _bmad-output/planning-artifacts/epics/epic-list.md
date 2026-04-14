# Epic List

## Epic 1: App Foundation & Authentication

User can launch the app, authenticate with Proton via embedded browser, and see their account overview (name, storage, plan). Credentials persist via libsecret or fallback. The engine spawns, connects, and validates protocol. This is the "it actually works" moment — the trust-building milestone.

**FRs covered:** FR1, FR2, FR3, FR6, FR7, FR34, FR35, FR36, FR37, FR43
**UX-DRs:** UX-DR1, UX-DR2, UX-DR3, UX-DR5, UX-DR11, UX-DR12, UX-DR13
**NFRs as acceptance constraints:** NFR1 (3s launch), NFR2 (200ms UI response), NFR6 (token never in output), NFR7 (0600 credential file), NFR8 (localhost-only auth server), NFR10 (no HTTP outside SDK)

**Includes:** Project scaffolding (UI via GNOME Builder template + engine via npm init/tsconfig), IPC foundation (Unix socket server, MessageReader with mandatory edge case tests, protocol types, 4-byte length-prefixed framing), SQLite state DB init (WAL mode, schema versioning), typed error hierarchy (errors.ts), auth flow (localhost HTTP server, WebKitGTK embedded browser, libsecret + fallback credential store), account header component (AccountHeaderBar), mandatory dark theme (ADW_COLOR_SCHEME_FORCE_DARK), teal accent (#0D9488 via AdwAccentColor), main window shell (AdwNavigationSplitView), settings page (account info, storage bar, log out).

**Sizing note:** This is the largest epic (~12-15 stories). Consider splitting into two phases during sprint planning: Phase A (scaffolding + IPC + engine spawn) and Phase B (auth + credentials + account UI).

## Epic 2: First Sync Pair & File Sync

User can set up their first sync pair via the setup wizard, see files sync in both directions with live progress (file count, bytes, ETA), and see "Last synced X seconds ago." Window state persists between sessions. The app builds and runs as a Flatpak from this epic onwards to catch sandbox issues early.

**FRs covered:** FR8, FR13, FR14, FR15, FR18, FR19, FR38, FR39
**UX-DRs:** UX-DR4, UX-DR6 (synced + syncing states only), UX-DR7 (synced + syncing states only), UX-DR8, UX-DR9, UX-DR16
**NFRs as acceptance constraints:** NFR2 (200ms UI), NFR3 (5s inotify detection), NFR3a (async watch init), NFR4 (concurrent transfer cap), NFR5 (150MB RSS), NFR12 (atomic writes), NFR15 (sync state in SQLite)

**Includes:** 3-step setup wizard (Sign In → Choose Folder → You're Syncing), wizard resume on interrupted first-run, remote folder picker (MVP text+autocomplete), sync engine core (two-way sync orchestration), inotify file watcher with debouncing, SyncPairRow (synced/syncing states — additional states added by later epics), StatusFooterBar (synced/syncing states), SyncProgressCard, empty states (AdwStatusPage), basic per-pair and global status display, XDG file chooser portal, window state persistence, Flatpak build validation (app builds and runs in sandbox).

**Progressive component states:** SyncPairRow and StatusFooterBar are built with synced (green) and syncing (teal) states. Conflict (amber), error (red), and offline (grey) states are added by Epics 3, 4, and 5 respectively as those behaviours are implemented.

## Epic 3: Offline Resilience & Network Handling

User always knows when they're offline, changes queue automatically and persist to disk, and sync resumes without user action when network returns. Rate limiting is surfaced visibly. The app never appears frozen or broken during network disruptions.

**FRs covered:** FR16, FR17, FR20, FR21, FR22, FR23
**UX-DRs:** UX-DR6 (adds offline grey state), UX-DR7 (adds offline + rate-limited states), UX-DR16 (offline empty state)
**NFRs as acceptance constraints:** NFR14 (persistent change queue), NFR15 (sync state in SQLite)

**Includes:** Offline change queue (persisted to SQLite, survives crashes), queue replay with remote-state diffing (no false conflicts), offline/online detection and indicators, rate-limit UI ("Sync paused — resuming in Xs"), SyncPairRow offline state (grey dot), StatusFooterBar offline state.

## Epic 4: Conflict Detection & Resolution

User's files are never silently overwritten. Conflicts create date-stamped copies, trigger both in-app and desktop notifications, and are discoverable via the conflict log with "Reveal in Files." Both file versions are always preserved.

**FRs covered:** FR25, FR25a, FR26, FR27, FR27a, FR28, FR29
**UX-DRs:** UX-DR6 (adds conflict amber state), UX-DR7 (adds conflict state), UX-DR10
**NFRs as acceptance constraints:** NFR11 (zero data loss), NFR12 (atomic writes)

**Includes:** Conflict detection for existing files (mtime comparison + content hash fallback — separate story from FR25a), new-file collision detection (FR25a — separate story), conflict copy creation (filename.ext.conflict-YYYY-MM-DD), in-app notification banner (AdwBanner), desktop notification (foreground only), conflict log panel, ConflictLogRow component (unresolved/resolved states), "Reveal in Files" via org.freedesktop.portal.OpenURI, SyncPairRow conflict state (amber dot), StatusFooterBar conflict state.

**Accessibility story:** Verify ConflictLogRow AT-SPI2 tree, keyboard navigation through conflict log, Orca announces conflict filenames and "Reveal in Files" action.

## Epic 5: Token Expiry & Error Recovery

User can recover from expired sessions with zero data loss — queued changes are preserved and replayed without false conflicts. Crash recovery is automatic with an informational toast. Sync errors are actionable with specific resolution guidance.

**FRs covered:** FR4, FR5, FR24, FR44
**UX-DRs:** UX-DR6 (adds error red state), UX-DR7 (adds error state), UX-DR15 (re-auth modal), UX-DR18 (feedback patterns)
**NFRs as acceptance constraints:** NFR14 (persistent queue), NFR16 (crash recovery), NFR17 (401 detection)

**Includes:** Re-auth modal with queued change count (AdwAlertDialog), 401 detection and immediate sync halt, change queue replay without false conflicts, dirty-session flag mechanism in StateDB, crash recovery cleanup (.dl-tmp-* files), crash recovery toast notification, actionable error messages — separate stories per category: (a) disk full, (b) permission denied, (c) inotify limit exceeded, (d) file locked, (e) SDK/API error. SyncPairRow error state (red dot), StatusFooterBar error state.

**Dependency note:** Dirty-session flag and tmp file cleanup stories must be implemented before crash recovery can be tested (per NFR16).

## Epic 6: Multi-Pair Management & Validation

User can confidently manage multiple sync pairs — add subsequent pairs from the main window without re-running the wizard, remove pairs with explicit no-delete confirmation, and trust that nesting/overlap validation prevents configuration errors. Missing local folders are detected and recoverable.

**FRs covered:** FR9, FR10, FR11, FR12, FR45
**UX-DRs:** UX-DR14, UX-DR15, UX-DR17

**Includes:** Add-subsequent-pair flow (lightweight — no wizard chrome), remove pair confirmation dialog (AdwAlertDialog with explicit "will/won't" copy), nesting/overlap validation (4 checks: local nesting, local overlap, remote nesting, remote overlap — specific error copy naming conflicting pair), local folder missing detection with "Update path" (XDG file chooser) and "Remove pair" options, button hierarchy enforcement (one primary per screen, destructive never adjacent).

**Accessibility story:** Verify all dialog AT-SPI2 trees, keyboard navigation for add/remove flows, Orca announces validation errors and confirmation copy.

## Epic 7: Packaging & Distribution

User can install from Flathub with one click. AppStream metainfo, desktop file, CI/CD pipelines, and Flatpak manifest with justified permissions are complete and pass Flathub quality review.

**FRs covered:** FR40, FR41, FR42
**UX-DRs:** None (infrastructure epic)

**Includes:** Flatpak manifest with finish-args and plain-language justification document (--filesystem=home for inotify, --share=network, Secret portal), AppStream metainfo XML (app ID, name, summary, description, screenshots, release notes, developer info, OARS oars-1.1 all fields none), desktop file (Categories=Network;FileTransfer;, Keywords, correct Exec, StartupNotify=true), CI/CD pipelines (ci.yml PR gate: meson test + node --test; release.yml tag-triggered Flatpak build + GitHub Release), MIT license, FR40 proxy support (document as unsupported in v1 with filed issue, or implement if SDK supports it).

**Note:** Flatpak build validation starts in Epic 2 (the app builds and runs in sandbox from that point). This epic covers the submission-quality artifacts and CI/CD automation.

---
