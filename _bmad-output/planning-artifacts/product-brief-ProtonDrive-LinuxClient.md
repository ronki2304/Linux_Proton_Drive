---
title: "Product Brief: ProtonDrive Linux Client"
status: "final"
created: "2026-04-01"
updated: "2026-04-01"
inputs: ["user interviews", "web research - competitive landscape", "ProtonDrive SDK auth research"]
---

# Product Brief: ProtonDrive Linux Client

## Executive Summary

Linux users who pay for ProtonDrive have no working way to sync their files. rclone — the de facto workaround — broke in September 2025 when Proton introduced per-block verification tokens, and was effectively delisted as a supported backend in February 2026. Proton's own desktop clients exist only for Windows and macOS. The gap is real, the frustration is loud, and a native Linux client is the most upvoted feature request on Proton's own feedback forum.

ProtonDrive Linux Client is an MIT-licensed open-source project delivering two composable tools: a scriptable CLI with git-style subcommands (shipping first), and a GUI app for two-way folder sync (following). Both are built on Proton's official SDK and share a single config file. The CLI ships as a self-contained binary — no runtime required — and targets the displaced rclone user base directly, before Proton's own announced Q2 2026 CLI can capture that audience.

Built on the official ProtonDriveApps SDK (MIT-licensed, TypeScript), this project inherits production-grade end-to-end encryption rather than reverse-engineering a private API — making it auditable, maintainable, and aligned with Proton's own roadmap.

## The Problem

ProtonDrive's Linux users are effectively second-class customers. The Windows and macOS clients provide seamless background sync, tray integration, and selective folder sync. On Linux, users have three options — none of them good:

- **rclone** — broken since September 2025, delisted February 2026. The community patch backlog has no committed resolution timeline. Sysadmins had it in production scripts; those scripts are now broken.
- **Browser** — no sync, no offline access, no automation. Fine for occasional file retrieval, useless for anyone with real workflows.
- **DonnieDice/protondrive-linux** — a Tauri GUI released January 2026 that the community welcomed warmly, but which has critical WebKitGTK login failures on mainstream distros, no sync engine, and no scripting interface.

The result: Linux users who chose ProtonDrive for its privacy guarantees are reverting to OneDrive and Google Drive — not because they want to, but because they have no viable alternative. Users voting with their own hands, on Proton's own platform, made this the most-requested feature in Proton's history.

## The Solution

Two tools, one project, one config file. CLI ships first.

**`protondrive` — Scriptable CLI (v1)**
A command-line tool modeled on git's subcommand pattern, immediately familiar to developers and sysadmins:

```
protondrive auth login        # one-time interactive login; session token cached
protondrive sync              # two-way sync per config file
protondrive upload <local> <remote>
protondrive download <remote> <local>
protondrive status
```

Authentication is handled once interactively (`auth login`); the session token is cached securely, enabling all subsequent invocations — cron, CI pipelines, shell scripts — to run headlessly without user interaction. Configuration is mandatory and file-based. Ships as a self-contained binary with no Node.js runtime dependency.

**`protondrive-sync` — GUI Sync App (v2)**
A desktop application presenting a clean, focused window showing all configured sync pairs and their live status. Users configure local folders mapped to ProtonDrive folders; the app handles two-way sync, conflict detection, and progress display. No bloat — not a full file manager. Reads the same config file as the CLI.

## What Makes This Different

**Official SDK, not reverse engineering.** The existing community workarounds reverse-engineer a private API — fragile by definition. This project uses Proton's own published SDK, the same code powering their official apps. Both are MIT-licensed, removing any barrier to enterprise adoption, internal deployment, or downstream packaging.

**The rclone successor, not a stopgap.** rclone users with a ProtonDrive backend have nowhere to go. This project is the explicit migration target. A one-command migration path from rclone config is a v1 launch artifact — capturing the displaced rclone user base at peak urgency.

**Open-source as a trust signal.** ProtonDrive's entire value rests on trustworthiness — E2EE, Swiss jurisdiction, no surveillance. An open-source client that any user can audit line-by-line is the only kind of client a serious privacy user should accept. Closed-source cloud sync tools are a contradiction in terms for this audience.

**Shared config as infrastructure-grade reproducibility.** The GUI and CLI share one config file. A sysadmin defines sync pairs in a text file, commits it to version control, deploys it to N machines — the GUI on each just works. Config files in dotfiles repos become organic distribution: every public dotfiles repo that references `protondrive` is an acquisition channel.

**Conflict handling that protects data.** On two-way sync conflicts, the tool creates a conflict copy rather than silently overwriting — the safe default for a privacy-first audience that cannot easily recover lost files from a surveillance-free storage provider.

## Who This Serves

**Primary: Developers and sysadmins** — Linux power users who automate everything. They need ProtonDrive to behave like any other infrastructure component: configurable, scriptable, reliable. They had rclone in production scripts; those scripts are now broken. They are the most urgently underserved audience and the first target.

**Primary: Privacy-conscious power users** — Linux desktop users who chose ProtonDrive for end-to-end encryption and Swiss jurisdiction. They want the same experience Windows users get: background sync, peace of mind, no browser required. They are the GUI app's audience and the project's long-term growth base.

Both groups overlap significantly and share the same toolchain. The CLI user and the GUI user are often the same person.

## Success Criteria

- **GitHub stars** — 500 within 6 months of first stable CLI release; community trust signal
- **Distro packaging** — AUR, Flathub, or nixpkgs within 3 months of stable release; a Nix flake at CLI launch targets the primary audience directly
- **Proton acknowledgment** — mentioned or linked by Proton's official Reddit presence or community channels
- **Community answer shift** — the top answer on the three most-trafficked ProtonDrive/Linux threads links to this project within 6 months of stable release

## Scope

**v1 (CLI) In Scope:**
- `auth login` with session token caching for headless subsequent use
- `upload`, `download`, `sync`, `status` subcommands
- Mandatory config-file-based sync pair configuration
- Conflict copy on two-way sync conflicts
- Self-contained binary distribution (AppImage + AUR PKGBUILD + Nix flake)
- MIT license
- rclone config migration guide as launch artifact

**v2 (GUI) In Scope:**
- Two-way folder sync window with live status
- Shared config file with CLI
- Linux-native packaging

**Out of Scope (both versions):**
- Virtual filesystem / FUSE mount (post-v2)
- Windows or macOS support
- Selective sync at file-granularity (folder-level only for v1)
- Notifications / tray daemon (post-v1)
- 2FA support (blocked on upstream SDK — tracked as ProtonDriveApps/sdk issue #6)

**Known constraints:**
- The ProtonDriveApps SDK ships no auth module — authentication must be implemented by this project using Proton's SRP protocol. Session token caching enables headless use after one-time login.
- The SDK has a planned breaking cryptographic model migration in 2026. v1 architecture must accommodate this migration path.
- Credential storage security (OS keychain vs. encrypted config) must be defined before v1 ships — this is an explicit trust requirement for the target audience.

## Vision

If this succeeds, ProtonDrive Linux Client becomes the canonical answer to "how do I use ProtonDrive on Linux" — the project Proton points to, ships Flatpak updates for, and eventually blesses with early SDK access. Because this project tracks the official SDK, it surfaces breaking changes and migration friction before they hit end users — making it genuinely useful to Proton's developer relations, not just to the community.

In 2-3 years: daemon-based background sync, FUSE mount support, desktop notifications, and a Proton-blessed integration. The longer play: establish this as the reference implementation for a privacy-respecting, SDK-native Linux cloud client — a template others can follow for Proton Mail, Proton Calendar, and beyond.
