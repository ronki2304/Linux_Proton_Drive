# Project Context Analysis

## Requirements Overview

**Functional Requirements:**
GTK4/Libadwaita desktop app delivering two-way continuous folder sync while the app is open. Core functional areas: embedded WebKitGTK auth over localhost (CAPTCHA + 2FA handled by the browser itself), sync pair management (add/remove, multi-pair), first-sync progress display, live sync status panel, conflict copy creation with in-app notification and log UI, token expiry modal with queued-change replay, offline change queuing with automatic reconnect, window state persistence, Flatpak packaging with AppStream/metainfo and desktop file.

**Non-Functional Requirements:**
- Security: session token never in logs/stdout/stderr; credentials via libsecret Secret portal; localhost auth server bound to 127.0.0.1 only, ephemeral port, closed immediately after callback; crash output sanitised
- Privacy: no telemetry, no analytics, no network I/O outside SDK; SQLite state DB in plaintext (documented); updates via Flathub OSTree only
- Flatpak compliance: static `--filesystem` for inotify, Secret portal for credentials, Background Portal for V1 autostart; App ID propagates to all manifests and XDG paths — must be decided before implementation
- SDK isolation: wrapper layer insulates UI from SDK version churn; openpgp boundary encapsulated in SDK layer; version pinned until V1 ships
- Reliability: conflict copy on any concurrent edit, no silent overwrite, ever; offline queue preserved across restarts; atomic file writes

**Scale & Complexity:**
- Primary domain: Linux desktop application (GTK4/Libadwaita) + cloud sync
- Complexity level: medium-high — constrained rather than at scale; sharp Flatpak/inotify/WebKitGTK constraints are the hard problems
- Estimated architectural components: 5 (GTK4 UI process, Sync Engine subprocess, Unix socket IPC layer, SDK integrated in engine, libsecret credential store)
