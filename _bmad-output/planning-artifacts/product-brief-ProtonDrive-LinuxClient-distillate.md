---
title: "Product Brief Distillate: ProtonDrive-LinuxClient"
type: llm-distillate
source: "product-brief-ProtonDrive-LinuxClient.md"
created: "2026-04-01"
purpose: "Token-efficient context for downstream PRD creation"
---

## Project Identity

- Name: ProtonDrive Linux Client
- License: MIT
- Model: Community open-source, hosted on GitHub
- Language: English
- SDK: ProtonDriveApps/sdk (TypeScript, MIT-licensed) — official Proton SDK, same code powering official apps
- Delivery: Self-contained bundled binary (no Node.js runtime required for end users)

## Shipping Sequence

- v1: CLI tool (`protondrive`) — ships first, targets displaced rclone users
- v2: GUI app (`protondrive-sync`) — follows, targets desktop power users
- Rationale for CLI-first: rclone broke Feb 2026, Proton's own CLI announced Q2 2026 — must capture market before Proton does; CLI is also simpler to build and ship

## Users

- **Primary v1**: Developers and sysadmins — had rclone in production scripts, those scripts are now broken, need a drop-in replacement with scripting/CI/cron support
- **Primary v2**: Privacy-conscious Linux desktop users — want Windows-equivalent background sync experience, chose ProtonDrive for E2EE + Swiss jurisdiction
- Both groups overlap; often the same person using CLI at work, GUI at home

## CLI Design Decisions

- Subcommand pattern modeled on git: `protondrive auth login`, `protondrive sync`, `protondrive upload`, `protondrive download`, `protondrive status`
- Config file is **mandatory** — no flags-only usage; enables version control, deployment, dotfiles sharing
- Auth model: one-time interactive `auth login` caches session token; all subsequent calls (cron, CI, scripts) run headlessly using cached token
- Conflict resolution: **create conflict copy** (not last-write-wins) — safe default for E2EE storage where recovery is harder
- rclone config migration guide ships as a v1 launch artifact (one-command migration)

## GUI Design Decisions

- Single focused window: list of configured sync pairs + live status — not a file manager
- Reads the same config file as the CLI (shared config layer is a core architectural decision)
- Two-way sync with conflict copy behavior (same as CLI)
- No tray daemon in v1 — deferred to post-v1

## SDK Architecture Constraints (critical for PRD)

- **The ProtonDriveApps SDK ships NO auth module** — auth is explicitly out of scope in the SDK; must be implemented from scratch using Proton's SRP (Secure Remote Password) protocol
- Headless auth is possible only via session token caching after one-time interactive login — no API tokens or service accounts exist
- **2FA is completely unsupported** — SDK issue #6 was closed as "out of scope, not a bug"; users with 2FA enabled cannot authenticate in v1; resolution depends entirely on Proton's roadmap
- **Breaking cryptographic model migration coming in 2026** — Proton is migrating all Drive apps to a new crypto model; v1 architecture must not hard-pin the SDK version; migration path must be designed in
- Credential storage security must be decided before v1 ships: options are OS keychain, encrypted config file, or plaintext (plaintext is unacceptable for this audience)

## Competitive Intelligence

- **rclone ProtonDrive backend**: Broke Sep 2025 (Proton added per-block verification tokens); delisted Feb 2026; no committed fix timeline; this is the primary pain that creates the market
- **DonnieDice/protondrive-linux**: Tauri GUI, Jan 2026; praised by community but has WebKitGTK login failures on Fedora/Ubuntu DEB packages; no sync engine; no CLI; single maintainer; validates demand but doesn't fill it
- **henrybear327/Proton-API-Bridge**: Go library, reverse-engineers private API (not official SDK); library-only, no end-user product; used as rclone underpinning; fragile to Proton API changes
- **Proton official CLI**: Announced Q2 2026 (April–June); direct competitive threat for the CLI v1; must ship before or immediately after Proton to capture mindshare
- **Browser**: No sync, no offline, no automation — not viable for any power user workflow
- **Nextcloud/Syncthing**: Not ProtonDrive-compatible; different product category

## Packaging Strategy

- v1 targets: AppImage (broadest compatibility), AUR PKGBUILD (Arch/Manjaro), Nix flake (highest-signal for primary audience — NixOS community is disproportionately the exact target demographic)
- Flathub: listed as v1 or early v2 target
- nixpkgs: post-Nix-flake milestone
- Packaging velocity in first 90 days post-launch matters more than feature completeness — packaging is a passive acquisition flywheel

## Growth and Distribution Signals

- Dotfiles viral loop: config-file-first design means public dotfiles repos referencing `protondrive` become organic acquisition; document and encourage dotfiles-style config sharing
- rclone migration guide as launch artifact: captures displaced rclone user base at peak urgency, converts them to word-of-mouth advocates
- Privacy media outreach: PrivacyGuides, DistroTube, The Linux Experiment covered rclone breakage — they are primed for a solution announcement; coordinate early beta access for a review-day launch
- "Most upvoted feature request on Proton's own forum" — use this line in README, Reddit posts, HN launch; it's the strongest third-party validation available

## Proton Relationship Strategy

- Project is positioned as an "SDK stress test and community feedback loop" — surfaces breaking changes before they hit end users; gives Proton institutional reason to engage and bless the project
- Contributing upstream SDK fixes and surfacing migration friction early is the path to Proton acknowledgment
- Do not position as competing with Proton's planned official client — position as complementary and community-maintained

## Rejected Ideas / Out of Scope

- **FUSE virtual filesystem**: Deferred to post-v2; strategically important long-term but too complex for v1/v2
- **Windows/macOS support**: Explicitly out of scope; Linux-only is the identity of this project
- **Selective sync at file granularity**: Folder-level sync only for v1; file-level selective sync is post-v1
- **Tray daemon / background daemon**: Post-v1 for GUI; not relevant to CLI
- **Flags-only CLI usage**: Rejected — config file is mandatory; flags-only would undermine scriptability and version-control benefits
- **Last-write-wins conflict resolution**: Rejected in favor of conflict copy — data safety priority for E2EE audience
- **Reverse-engineering private API**: Rejected — the entire trust argument depends on using the official SDK

## Open Questions for PRD

- What SRP auth library or implementation will be used? (Build from scratch vs. adapt henrybear327/Proton-API-Bridge's approach vs. port rclone's implementation)
- Credential storage decision: OS keychain (libsecret/kwallet) vs. encrypted file — what's the fallback for headless servers with no keychain?
- What is the GUI framework for v2? (Tauri was tried by DonnieDice and has WebKitGTK issues; GTK4, Qt6, or Electron are alternatives — each has tradeoffs for the target distros)
- What is the minimum distro support matrix for v1 CLI? (Ubuntu LTS, Fedora, Arch — what about musl-based distros like Alpine for server use cases?)
- How does the project handle the SDK crypto migration mid-development if Proton ships it before v1 is stable?
- Will the project engage Proton's developer relations before launch to seek blessing, or launch and seek acknowledgment after?
