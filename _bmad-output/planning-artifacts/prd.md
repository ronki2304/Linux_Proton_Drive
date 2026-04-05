---
stepsCompleted: ["step-01-init", "step-02-discovery", "step-02b-vision", "step-02c-executive-summary", "step-03-success", "step-04-journeys", "step-05-domain", "step-06-innovation", "step-07-project-type", "step-08-scoping", "step-09-functional", "step-10-nonfunctional", "step-11-polish"]
inputDocuments:
  - "_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient.md"
  - "_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient-distillate.md"
  - "_bmad-output/planning-artifacts/research/technical-linux-packaging-formats-research-2026-04-01.md"
briefCount: 2
researchCount: 1
brainstormingCount: 0
projectDocsCount: 0
workflowType: 'prd'
classification:
  projectType: "cli_tool + desktop_app"
  domain: "developer tools / privacy cloud storage"
  complexity: "medium"
  projectContext: "greenfield"
---

# Product Requirements Document - ProtonDrive Linux Client

**Author:** Jeremy
**Date:** 2026-04-01

## Executive Summary

ProtonDrive Linux Client is an MIT-licensed open-source project that gives Linux users what they've lacked since rclone's ProtonDrive backend broke in September 2025: a reliable, two-way sync tool built on Proton's official SDK. Two tools, one config file — a scriptable CLI (`protondrive`) shipping first, followed by a focused GUI sync app (`protondrive-sync`). The CLI targets developers and sysadmins whose production scripts broke with rclone's delisting; the GUI targets privacy-conscious Linux desktop users who want the same background sync experience Windows users get today.

Built on the ProtonDriveApps SDK (TypeScript, MIT) — the same code powering Proton's official apps — this project inherits production-grade end-to-end encryption without reverse-engineering a private API.

### What Makes This Special

The delight moment: files sync in both directions and the data is where it should be. No manual uploads, no browser workarounds, no broken scripts.

The core architectural decision is a mandatory config file shared by both tools. This enables version control, dotfiles distribution, and deployment across multiple machines — making ProtonDrive behave like infrastructure rather than a consumer app.

Built for personal need first. This project solves a real, immediate problem for its own author. Community adoption and a public audience are welcome stretch goals, not requirements.

## Project Classification

- **Project Type:** CLI tool (v1) + Desktop app (v2)
- **Domain:** Developer tools / privacy cloud storage
- **Complexity:** Medium
- **Project Context:** Greenfield

## Success Criteria

### User Success

- A developer or sysadmin can run `protondrive sync` from a cron job, CI pipeline, or shell script and find their files synced correctly — no manual intervention after initial `auth login`
- Files modified on either side (local or ProtonDrive) appear on the other side after sync completes
- Conflicts produce a conflict copy rather than silent overwrite — the user never loses data due to the tool's decisions
- A displaced rclone user can migrate to `protondrive` and resume their workflow without significant reconfiguration

### Business Success

*Aspirational stretch goals — not requirements for v1 ship decision:*

- 500 GitHub stars within 6 months of first stable CLI release
- Packaged in AUR, Flathub, or nixpkgs within 3 months of stable release; Nix flake ships at launch
- Proton officially mentions or links the project
- Top community answers on high-traffic ProtonDrive/Linux threads reference this project within 6 months

### Technical Success

- Auth session token cached correctly; all subsequent commands run headlessly
- Sync, upload, download, and status subcommands behave correctly across at least: Ubuntu LTS, Fedora current, Arch Linux
- Self-contained binary — no Node.js runtime required on the end-user machine
- Conflict copy created on two-way sync conflict — no silent data overwrite under any tested scenario
- No silent failures — errors surface clearly to the user (non-zero exit codes, readable messages)

### Measurable Outcomes

- Jeremy uses it himself for his own ProtonDrive sync workflow (primary success signal)
- Zero data loss incidents in normal sync and conflict scenarios
- All v1 subcommands (`auth login`, `upload`, `download`, `sync`, `status`) functional and tested

## Product Scope & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Problem-solving MVP — ship the smallest thing that makes ProtonDrive usable from the command line on Linux. The success test is personal: Jeremy uses it for his own sync workflow.

**Resource Requirements:** Solo developer. Scope is intentionally constrained to what one person can ship and maintain.

### MVP Feature Set (Phase 1 — v1 CLI)

**Core User Journeys Supported:** Journey 1 (sysadmin headless sync), Journey 2 (conflict recovery), Journey 4 (author's daily use)

**Must-Have Capabilities:**
- `protondrive auth login` — interactive SRP auth, session token cached to libsecret
- `protondrive sync` — two-way sync per YAML config, conflict copy on conflict
- `protondrive upload <local> <remote>`
- `protondrive download <remote> <local>`
- `protondrive status` — sync pairs, last sync time, current state
- `--json` flag on all subcommands
- YAML config file (token never stored in config)
- Distribution: AppImage + AUR PKGBUILD + Nix flake
- MIT license

### Phase 2 — v2 GUI (`protondrive-sync`)

- Focused desktop window: sync pairs list + live status
- Two-way sync with conflict copy (same engine as CLI)
- Reads shared YAML config
- Flathub packaging

### Phase 3 — Vision (post-v2)

- Daemon-based background sync with desktop notifications and tray integration
- FUSE virtual filesystem / on-demand sync
- Shell completion (bash/zsh/fish)
- nixpkgs submission
- Selective sync at file granularity
- Proton-blessed integration / early SDK access

### Risk Mitigation Strategy

**Technical Risks:**
- *SRP auth from scratch* — highest risk item in v1; study henrybear327/Proton-API-Bridge and rclone's SRP port as implementation references before writing auth code
- *Self-contained binary bundling* — choose bundling toolchain (esbuild/pkg/bun) as a day-one decision; validate a hello-world binary ships clean before building on it
- *SDK crypto migration* — do not hard-pin SDK version; monitor Proton's migration branch; treat migration path as a first-class architecture concern

**Market Risks:**
- *Proton's own CLI (announced Q2 2026)* — timing risk only; this project's open-source, MIT-licensed nature is complementary; ship v1 before or concurrent with Proton's announcement to capture mindshare

**Resource Risks:**
- Solo developer — if bandwidth constrained, drop AppImage from v1 launch (AUR + Nix flake serve the primary audience); Flathub submission moves to v2

## User Journeys

### Journey 1: Marcus — The Sysadmin Whose Scripts Broke

**Opening Scene:** Marcus maintains a small home lab and backs up config files and documents to ProtonDrive. In October 2025, his nightly backup cron job silently stops working. rclone's ProtonDrive backend is broken. He spends two evenings on patches from the GitHub issue thread. Nothing works. He considers switching to Nextcloud but won't give up E2EE.

**Rising Action:** He finds `protondrive` through a Reddit post. He runs `protondrive auth login` — it handles the SRP auth interactively and caches the session token. He updates his cron job: `protondrive sync`. He runs it manually once and watches his files appear in ProtonDrive.

**Climax:** The next morning, his cron log shows exit code 0. His files are there. Both ways. No drama.

**Resolution:** Marcus adds `protondrive` to his dotfiles, commits the config file to git. He's back to treating ProtonDrive as infrastructure.

*Capabilities revealed: `auth login` with session caching, `sync` with config file, non-zero exit on failure, clean stdout/stderr separation for scripting.*

### Journey 2: Marcus — Conflict Recovery

**Opening Scene:** Marcus edits a notes file on his laptop while offline. His desktop already modified the same file and synced it. When he runs `protondrive sync` after reconnecting, there's a conflict.

**Rising Action:** The tool detects the divergence and writes `notes.md.conflict-2026-04-01` alongside the original, syncing both versions up.

**Climax:** Marcus opens his ProtonDrive folder, sees both files, diffs them, picks the right version, deletes the conflict copy.

**Resolution:** No data lost. The tool made the safe choice and left resolution to him.

*Capabilities revealed: conflict detection, conflict copy naming convention, both conflict files synced to remote, no silent overwrite.*

### Journey 3: Léa — The Privacy-Conscious Desktop User (v2 Preview)

**Opening Scene:** Léa switched from Dropbox to ProtonDrive for E2EE. On Windows, the sync client just works. She recently moved to Fedora and has been manually uploading files through the browser for three months.

**Rising Action:** She installs `protondrive-sync` from Flathub. She maps her Documents folder to her ProtonDrive Documents folder and clicks sync.

**Climax:** Status changes from "syncing" to "up to date." Her files are there. She closes the app and forgets about it.

**Resolution:** Léa has the same sync experience on Linux she had on Windows.

*Capabilities revealed: GUI sync pairs list, live status display, shared config with CLI, Flathub packaging.*

### Journey 4: Jeremy — First-Time Setup (The Author's Journey)

**Opening Scene:** Jeremy has built the tool and wants to use it himself. He downloads the Nix flake, drops the config file in his dotfiles repo, and runs `protondrive auth login` for the first time.

**Rising Action:** Auth works. `protondrive status` shows his configured sync pairs and last sync time. `protondrive sync` picks up the delta and transfers only changed files.

**Climax:** Everything works. He adds it to his home-manager config.

**Resolution:** The author is also the user. The tool has graduated from project to infrastructure.

*Capabilities revealed: `status` showing sync pair state and last sync time, Nix flake packaging, delta-aware sync.*

### Journey Requirements Summary

| Capability | Revealed By |
|---|---|
| `auth login` with session token caching | Journey 1, 4 |
| Headless re-use of cached token (cron/scripts) | Journey 1 |
| `sync` with config-defined pairs | Journey 1, 2, 4 |
| Conflict copy (not overwrite) on divergence | Journey 2 |
| `status` with sync pair state + last sync time | Journey 4 |
| Non-zero exit on failure, clean stderr | Journey 1 |
| Delta-aware sync (changed files only) | Journey 4 |
| GUI sync pairs window + live status | Journey 3 |
| Flathub / Nix flake packaging | Journey 3, 4 |

## Domain-Specific Requirements

### Authentication & Security Constraints

- SRP (Secure Remote Password) protocol must be implemented from scratch — the ProtonDriveApps SDK ships no auth module
- Credential storage: OS keychain (libsecret/kwallet) preferred; libsecret ≥ 0.20 local file fallback for headless servers; plaintext unacceptable
- 2FA is supported in v1 via TOTP prompt during `auth login`. Users with 2FA enabled are prompted for their 6-digit authenticator code after SRP auth succeeds.
- Proton may require human verification (CAPTCHA, Code 9001) during `auth login` in automated or suspicious-IP contexts. The CLI handles this by surfacing the verification URL, waiting for the user to complete the CAPTCHA in a browser, then retrying authentication with the `x-pm-human-verification-token` header. Non-interactive (no TTY) invocations surface the URL in an error message and exit 1.

### SDK Migration Risk

- Proton is migrating all Drive apps to a new cryptographic model in 2026 — v1 must not hard-pin the SDK version; architecture must accommodate the migration path
- Contributing upstream SDK fixes and surfacing migration friction early is the preferred engagement strategy with Proton

### File Watching Constraints

- inotify is not recursive — requires one watch descriptor per subdirectory; large sync trees can hit `fs.inotify.max_user_watches` kernel limits
- Flatpak: inotify works only with static `--filesystem=` permissions; watches do NOT fire through the portal FUSE layer — confirmed upstream bug
- fanotify requires `CAP_SYS_ADMIN` — not viable for a user-space sync client in v1

### Distribution Constraints

- **AppImage:** No sandbox, maximum cross-distro portability, opt-in delta updates via zsync; distributed via GitHub Releases
- **Flatpak:** Static `--filesystem=` permission required for inotify; tray via `--talk-name=org.kde.StatusNotifierWatcher` workaround; FUSE/VFS blocked by sandbox mount namespace isolation
- **Nix flake:** Ships at v1 launch — primary audience signal; nixpkgs submission is post-launch
- **AUR PKGBUILD:** No sandbox constraints; full system integration

## CLI & Desktop App Requirements

### Command Structure

```
protondrive auth login        # Interactive one-time login; caches session token to secure storage
protondrive sync              # Two-way sync of all configured pairs per config file
protondrive upload <local> <remote>
protondrive download <remote> <local>
protondrive status            # Shows configured sync pairs, last sync time, and current state
```

All subcommands:
- Exit 0 on success, non-zero on any error
- Write progress/info to stdout, errors to stderr
- Support `--json` flag for machine-readable output
- Run headlessly after `auth login` using cached session token

### Output Formats

- **Default:** Human-readable, line-based output suitable for terminal use and log files
- **`--json` flag:** Structured JSON output for all subcommands — enables scripting, piping, and monitoring integration
- `sync` JSON output includes: files transferred, conflicts detected, conflict copy paths, errors
- `status` JSON output includes: sync pairs, last sync timestamps, current state per pair

### Config Schema (YAML)

```yaml
# ~/.config/protondrive/config.yaml
sync_pairs:
  - local: ~/Documents
    remote: /Documents
  - local: ~/Projects/backups
    remote: /Backups/projects

options:
  conflict_strategy: conflict_copy   # only supported value in v1
```

**Critical trust boundary:** Session token is **never stored in the config file**. Stored exclusively in secure storage (libsecret/OS keychain). Config file is safe to commit to version control and dotfiles repos.

### Scripting Support

- All subcommands non-interactive after `auth login`
- `auth login` is the only subcommand requiring a terminal (interactive SRP prompt)
- Cron/CI pattern: `protondrive sync` with cached token — no TTY required
- Exit codes are stable and documented — suitable for `if protondrive sync; then ...` patterns
- Shell completion: post-v1

### System Integration

- **Credential storage:** libsecret → OS keychain (GNOME Keyring / KWallet); libsecret local file fallback for headless servers (libsecret ≥ 0.20)
- **File watching:** v1 uses on-demand sync (no daemon); daemon-based watching is post-v1
- **Flatpak (v2 GUI):** Static `--filesystem=` permission required for inotify; tray via `--talk-name=org.kde.StatusNotifierWatcher` workaround
- **Updates:** Distribution-managed only — no in-app auto-update; GitHub Releases for AppImage users

## Functional Requirements

### Authentication & Session Management

- **FR1:** User can authenticate interactively with Proton credentials via SRP protocol
- **FR2:** System stores the session token in OS keychain (libsecret/GNOME Keyring/KWallet) after successful authentication
- **FR3:** System uses the cached session token for all subsequent commands without requiring user interaction
- **FR4:** System falls back to libsecret local file storage when no keychain daemon is available (headless server environments)
- **FR5:** User can log out, revoking and clearing the cached session token

### File Synchronization

- **FR6:** User can trigger a two-way sync of all configured sync pairs with a single command
- **FR7:** System detects files modified on either the local or remote side since the last sync
- **FR8:** System transfers only changed files during sync (delta sync — not a full re-upload of unchanged content)
- **FR9:** System detects when the same file has been modified on both sides since the last sync (conflict)
- **FR10:** System creates a conflict copy with a deterministic naming convention on conflict (e.g., `filename.conflict-YYYY-MM-DD`)
- **FR11:** System syncs both the original file and the conflict copy to the remote after conflict detection
- **FR12:** System reports all conflicts detected during a sync operation in both human-readable and JSON output

### File Transfer

- **FR13:** User can upload a local file or directory to a specified remote path
- **FR14:** User can download a remote file or directory to a specified local path

### Status & Observability

- **FR15:** User can view the current sync state of all configured sync pairs
- **FR16:** User can view the last successful sync timestamp for each configured sync pair
- **FR17:** System exits with a non-zero exit code on any error condition
- **FR18:** System writes operational progress and results to stdout; errors and warnings to stderr
- **FR19:** User can request machine-readable JSON output from any command via a `--json` flag
- **FR20:** JSON sync output includes: files transferred, conflicts detected, conflict copy paths, errors
- **FR21:** JSON status output includes: sync pairs, last sync timestamps, current state per pair

### Configuration Management

- **FR22:** User defines sync pairs and options in a YAML configuration file
- **FR23:** System reads configuration from a well-known default path (`~/.config/protondrive/config.yaml`)
- **FR24:** Configuration file never contains authentication credentials or session tokens
- **FR25:** Configuration file is safe to commit to version control and share in dotfiles repositories

### Distribution & Installation

- **FR26:** User can run the CLI on a system with no Node.js runtime installed (self-contained binary)
- **FR27:** User can install and manage the CLI via a Nix flake
- **FR28:** User can install and manage the CLI via AUR PKGBUILD
- **FR29:** User can run the CLI via AppImage without system installation

### GUI Sync Interface (v2)

- **FR30:** User can view all configured sync pairs and their current sync status in a desktop window
- **FR31:** User can view live sync progress within the GUI
- **FR32:** GUI reads the same YAML configuration file as the CLI
- **FR33:** GUI performs two-way sync with the same conflict copy behavior as the CLI
- **FR34:** User can install the GUI via Flathub
- **FR35:** When Proton requires human verification during `auth login`, the CLI surfaces the verification URL to stdout, prompts the user to complete the CAPTCHA in a browser and press Enter, then retries authentication automatically with the verification token. Non-TTY invocations print the URL and exit 1 with code HUMAN_VERIFICATION_REQUIRED.

## Non-Functional Requirements

### Performance

- **NFR1:** `protondrive sync` startup to first file transfer completes within 5 seconds on a typical broadband connection (excluding transfer time)
- **NFR2:** `protondrive status` returns output within 2 seconds with no network calls required (reads local state only)
- **NFR3:** Repeat syncs of an unchanged folder complete in under 3 seconds regardless of folder size (delta-only transfer)
- **NFR4:** Binary cold-start time does not exceed 500ms on supported distros

### Security

- **NFR5:** Session token is never written to disk in plaintext — stored exclusively via libsecret (keychain or local encrypted fallback)
- **NFR6:** Session token is never included in log output, JSON output, error messages, or the config file
- **NFR7:** Config file contains no secrets; token storage is architecturally separate, enforced by design
- **NFR8:** All communication with ProtonDrive uses the official SDK's encryption — no plaintext data transmission, no custom crypto
- **NFR9:** Headless credential fallback file (`libsecret ≥ 0.20` local path) has file permissions set to `0600`

### Reliability

- **NFR10:** No file is silently overwritten or deleted during sync — every destructive action is reported to the user
- **NFR11:** A failed or interrupted sync leaves the filesystem in a consistent state — partial transfers do not corrupt existing files
- **NFR12:** All error conditions produce a non-zero exit code and a human-readable error message on stderr
- **NFR13:** Sync does not proceed if the config file is missing or malformed — fails fast with a clear error
- **NFR14:** `protondrive sync` is idempotent — running it multiple times on an already-synced folder produces no unintended side effects

### Compatibility

- **NFR15:** Self-contained binary runs on Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Fedora 40+, and Arch Linux with no runtime dependencies beyond glibc
- **NFR16:** Nix flake builds and runs correctly on NixOS and nix-on-any-distro (home-manager compatible)
- **NFR17:** AppImage runs on any x86_64 Linux distribution with FUSE support and glibc ≥ 2.17
- **NFR18:** CLI operates correctly when invoked from a non-interactive shell (no TTY) for all subcommands except `auth login`
