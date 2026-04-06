---
title: "Product Brief: ProtonDrive Linux Client"
status: "complete"
created: "2026-04-06"
updated: "2026-04-06"
inputs: ["product-brief-ProtonDrive-LinuxClient.md (prior iteration)", "product-brief-ProtonDrive-LinuxClient-distillate.md", "research/technical-linux-packaging-formats-research-2026-04-01.md", "lessons-learned-cli-iteration.md", "docs/project-overview.md", "docs/architecture.md", "web research - competitive landscape 2026", "web research - Flathub market data 2026"]
---

# Product Brief: ProtonDrive Linux Client

## Executive Summary

Over 100 million people trust Proton with their most sensitive files. On Windows and macOS, that trust comes with a desktop client — background sync, conflict handling, peace of mind. On Linux, it comes with nothing. The browser is the only option, rclone's ProtonDrive backend broke in September 2025 and was delisted in February 2026, and the one community GUI attempt ships with WebKitGTK login failures on mainstream distros and no sync engine. Proton's own UserVoice tracker shows 5,700+ votes for a Linux client — the second-most-requested feature in the company's history. Linux users are cancelling subscriptions and moving to pCloud.

ProtonDrive Linux Client is an open-source GTK4/Libadwaita desktop application built for people who chose Proton precisely because they verify everything — for the first time, you can audit the code that moves your encrypted files. Select your folders, authenticate once, and your files stay in sync. It distributes on Flathub — the canonical app store for immutable Linux distros like Bazzite, Silverblue, and SteamOS — and is built on Proton's own official SDK, not a reversed private API. It is the first maintained ProtonDrive GUI sync client available on Flathub.

The window is open today. Celeste — the only prior multi-cloud sync Flatpak with ProtonDrive support — was archived in November 2025. Proton has announced a CLI for Q2 2026 but made no GUI or Flatpak commitment. This project ships before that window closes.

## The Problem

Linux users who pay for ProtonDrive cannot sync their files. The gap is not a minor inconvenience — it is a platform exclusion:

- **rclone** broke in September 2025 when Proton introduced per-block verification tokens. It was delisted as a supported backend in February 2026 with no committed fix timeline. Sysadmins had it in production; those pipelines are now broken.
- **The browser** provides no sync, no offline access, and no background operation. It is useful for retrieving a file; it is useless as a sync client.
- **DonnieDice/protondrive-linux** — a Tauri-based GUI released January 2026 — received a warm community welcome but ships with WebKitGTK authentication failures on Fedora and Ubuntu, has no sync engine, and is not available on Flathub.
- **pCloud** has a native Linux GUI client. Users are citing this directly as a reason to cancel Proton subscriptions.

The contradiction is pointed and users say so loudly: a company whose entire brand rests on privacy and trustworthiness provides the most privacy-conscious operating system with no way to sync files. Linux is not a niche — Steam's Linux share hit 5.33% in March 2026, an all-time high, driven by Bazzite, SteamOS, and immutable desktops that rely entirely on Flatpak for third-party apps.

## The Solution

A focused GTK4/Libadwaita desktop application that does one thing well: sync selected folders between the user's machine and ProtonDrive.

The user opens the app, authenticates via an embedded browser (handling Proton's CAPTCHA and 2FA flows natively), selects one or more local folders mapped to ProtonDrive folders, and sync begins. The app displays live sync status — files transferring, conflicts resolved, last sync timestamp. Two-way sync runs continuously while the app is open. On conflict, the app creates a conflict copy rather than silently overwriting — the safe default for files protected by end-to-end encryption with no easy recovery path.

The app looks and feels native. GTK4/Libadwaita means it inherits the GNOME design language that Bazzite, Silverblue, and Fedora users live in daily. KDE/Plasma users can run the app but the Libadwaita design language will not match their desktop theme — full KDE integration is a v2 consideration. Distributed exclusively via Flathub for v1 — no manual installation steps, no terminal required, one click from the app store.

V1 syncs while the app is open. Background sync — running silently after the window is closed — requires a daemon architecture and is a deliberate v2 feature. This is honest scope: a foreground sync client that works reliably is more valuable to users than a background client that works sometimes.

## What Makes This Different

**The only maintained GUI sync client on Flathub.** Celeste was archived in November 2025. There is no maintained alternative. This is not a crowded field — it is a vacant slot in a growing platform.

**Official SDK, not reverse engineering.** Every community workaround — rclone, DonnieDice, henrybear327/Proton-API-Bridge — reverse-engineers a private API. Proton can change it at any time. This project is built on the same SDK that powers Proton's own official applications, MIT-licensed and published by Proton. It surfaces breaking changes before they hit end users and aligns with Proton's own development roadmap. When Proton changes their infrastructure, this client changes with it — not breaks.

**Solved auth — the problem DonnieDice couldn't fix.** DonnieDice's Tauri-based client fails at login on virtually every mainstream distro (Fedora, Ubuntu, Bazzite, Arch). The root cause is documented: Tauri serves its frontend via a custom `tauri://` URI scheme, and WebKitGTK blocks Web Workers from non-`http/https` origins — Proton's auth flow uses Workers for SRP cryptography, so login never completes. Tauri does not expose the API needed to fix this. A native GTK4 app serves the auth flow over `http://127.0.0.1`, which WebKitGTK treats as a fully trusted origin. Workers load, SRP completes, login works. This is not a workaround — it is the correct embedding approach that Tauri's architecture prevented.

**Flatpak-first, immutable-distro ready.** Bazzite users cannot install arbitrary software without containerization. This project's Flatpak packaging is not an afterthought — it is the primary delivery mechanism, designed to work correctly within sandbox constraints (static filesystem permissions for inotify, Background Portal for autostart).

**Open-source as a trust requirement, not a marketing claim.** ProtonDrive's value is that the user's data is encrypted before it leaves their machine. An open-source client is the only kind that a serious privacy-conscious user can audit line-by-line. Closed-source sync clients are a contradiction for this audience — you cannot verify what a closed binary does with your keys.

## Who This Serves

**Primary: Linux desktop users who pay for ProtonDrive and expect sync to work.** They installed Linux for privacy, convenience, or both. They use GNOME or a GNOME-derived desktop. They are comfortable installing apps from Flathub. They do not want to configure a CLI tool — they want to open an app, pick their folders, and have their files synced. This is the mainstream of the underserved Proton Linux audience: not power users, not sysadmins, people who just want it to work.

**Secondary: Immutable distro users (Bazzite, Silverblue, SteamOS).** These users have no alternative to Flatpak for third-party apps. The Flathub listing is the only way to reach them. This cohort is the fastest-growing segment of the Linux desktop market and is disproportionately the exact audience that chose Proton for privacy reasons.

## Success Criteria

- **Flathub listing** — published and passing Flathub quality review at v1 launch; this is the primary distribution gate
- **1,000 Flathub installs** within 3 months of stable release; validates organic discovery through the platform
- **500 GitHub stars** within 6 months; community trust signal and contributor magnet
- **Community answer shift** — active presence established on r/ProtonMail, r/linux, and Proton community forum within launch week; project linked from at least one Proton-official knowledge base or status page within 6 months
- **Zero critical data loss reports** — conflict copy behavior must be verified in real-world sync scenarios before stable release

## Scope

**V1 (GUI — Flathub) In Scope:**
- GTK4/Libadwaita desktop application
- Authentication via embedded WebKitGTK browser (handles CAPTCHA and 2FA)
- One or more user-selected folder pairs (local ↔ ProtonDrive)
- Two-way continuous sync while app is open
- Conflict copy on sync conflicts (no silent overwrite)
- Live sync status display (in-progress, last sync, conflict log)
- Flatpak packaging with correct sandbox permissions
- Flathub submission and quality review compliance
- MIT license

**V2 and Beyond:**
- Background sync daemon (systemd user service)
- System tray integration
- Desktop notifications
- CLI companion tool
- FUSE/virtual filesystem mount

**Out of Scope (V1):**
- Windows or macOS support
- File manager overlay icons (sandbox limitation; deferred)
- Selective sync at file granularity (folder-level only)
- Snap or AppImage packaging (Flathub first)

**Known constraints:**
- The ProtonDrive SDK has no built-in auth module; authentication uses Proton's SRP protocol, implemented by this project
- Flatpak inotify requires static `--filesystem` permission; portal FUSE does not fire inotify events (confirmed upstream bug)
- Background autostart in v1 requires Flatpak Background Portal user approval; no silent systemd registration
- Proton crypto migration expected in 2026; SDK wrapper layer must accommodate version transitions

## Vision

If this lands, ProtonDrive Linux Client becomes what Proton points to when asked "how do I use ProtonDrive on Linux" — the community answer, the Flathub listing Proton eventually blesses, the project that surfaces SDK breaking changes before they hit users. Because it tracks the official SDK, it is genuinely useful to Proton's developer relations, not just to the community.

In 2-3 years: background sync daemon, FUSE mount, desktop notifications, and a Proton-acknowledged integration. The longer arc: establish this as the reference implementation for open-source, SDK-native Linux cloud sync — a pattern that others can follow for privacy-first cloud storage on Linux as the platform continues to grow.
