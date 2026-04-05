---
stepsCompleted: ["step-01-document-discovery", "step-02-prd-analysis", "step-03-epic-coverage-validation", "step-04-ux-alignment", "step-05-epic-quality-review", "step-06-final-assessment"]
documentsInventoried:
  prd: "_bmad-output/planning-artifacts/prd.md"
  architecture: "_bmad-output/planning-artifacts/architecture.md"
  epics: "_bmad-output/planning-artifacts/epics.md"
  ux: null
---

# Implementation Readiness Assessment Report

**Date:** 2026-04-01
**Project:** ProtonDrive-LinuxClient

## Document Inventory

| Type | File | Size | Modified | Status |
|------|------|------|----------|--------|
| PRD | `prd.md` | 21K | Apr 1 23:04 | ✅ Found |
| Architecture | `architecture.md` | 30K | Apr 1 23:21 | ✅ Found |
| Epics & Stories | `epics.md` | 40K | Apr 1 23:33 | ✅ Found |
| UX Design | — | — | — | ⚠️ Not found |

**Notes:** No duplicate conflicts. UX document absent — proceeding without it.

---

## PRD Analysis

### Functional Requirements

**Authentication & Session Management**
- FR1: User can authenticate interactively with Proton credentials via SRP protocol
- FR2: System stores the session token in OS keychain (libsecret/GNOME Keyring/KWallet) after successful authentication
- FR3: System uses the cached session token for all subsequent commands without requiring user interaction
- FR4: System falls back to libsecret local file storage when no keychain daemon is available (headless server environments)
- FR5: User can log out, revoking and clearing the cached session token

**File Synchronization**
- FR6: User can trigger a two-way sync of all configured sync pairs with a single command
- FR7: System detects files modified on either the local or remote side since the last sync
- FR8: System transfers only changed files during sync (delta sync — not a full re-upload of unchanged content)
- FR9: System detects when the same file has been modified on both sides since the last sync (conflict)
- FR10: System creates a conflict copy with a deterministic naming convention on conflict (e.g., `filename.conflict-YYYY-MM-DD`)
- FR11: System syncs both the original file and the conflict copy to the remote after conflict detection
- FR12: System reports all conflicts detected during a sync operation in both human-readable and JSON output

**File Transfer**
- FR13: User can upload a local file or directory to a specified remote path
- FR14: User can download a remote file or directory to a specified local path

**Status & Observability**
- FR15: User can view the current sync state of all configured sync pairs
- FR16: User can view the last successful sync timestamp for each configured sync pair
- FR17: System exits with a non-zero exit code on any error condition
- FR18: System writes operational progress and results to stdout; errors and warnings to stderr
- FR19: User can request machine-readable JSON output from any command via a `--json` flag
- FR20: JSON sync output includes: files transferred, conflicts detected, conflict copy paths, errors
- FR21: JSON status output includes: sync pairs, last sync timestamps, current state per pair

**Configuration Management**
- FR22: User defines sync pairs and options in a YAML configuration file
- FR23: System reads configuration from a well-known default path (`~/.config/protondrive/config.yaml`)
- FR24: Configuration file never contains authentication credentials or session tokens
- FR25: Configuration file is safe to commit to version control and share in dotfiles repositories

**Distribution & Installation**
- FR26: User can run the CLI on a system with no Node.js runtime installed (self-contained binary)
- FR27: User can install and manage the CLI via a Nix flake
- FR28: User can install and manage the CLI via AUR PKGBUILD
- FR29: User can run the CLI via AppImage without system installation

**GUI Sync Interface (v2)**
- FR30: User can view all configured sync pairs and their current sync status in a desktop window
- FR31: User can view live sync progress within the GUI
- FR32: GUI reads the same YAML configuration file as the CLI
- FR33: GUI performs two-way sync with the same conflict copy behavior as the CLI
- FR34: User can install the GUI via Flathub

**Total FRs: 34** (FR1–FR34; FR1–FR29 are v1 CLI scope; FR30–FR34 are v2 GUI scope)

---

### Non-Functional Requirements

**Performance**
- NFR1: `protondrive sync` startup to first file transfer completes within 5 seconds on a typical broadband connection (excluding transfer time)
- NFR2: `protondrive status` returns output within 2 seconds with no network calls required (reads local state only)
- NFR3: Repeat syncs of an unchanged folder complete in under 3 seconds regardless of folder size (delta-only transfer)
- NFR4: Binary cold-start time does not exceed 500ms on supported distros

**Security**
- NFR5: Session token is never written to disk in plaintext — stored exclusively via libsecret (keychain or local encrypted fallback)
- NFR6: Session token is never included in log output, JSON output, error messages, or the config file
- NFR7: Config file contains no secrets; token storage is architecturally separate, enforced by design
- NFR8: All communication with ProtonDrive uses the official SDK's encryption — no plaintext data transmission, no custom crypto
- NFR9: Headless credential fallback file (`libsecret ≥ 0.20` local path) has file permissions set to `0600`

**Reliability**
- NFR10: No file is silently overwritten or deleted during sync — every destructive action is reported to the user
- NFR11: A failed or interrupted sync leaves the filesystem in a consistent state — partial transfers do not corrupt existing files
- NFR12: All error conditions produce a non-zero exit code and a human-readable error message on stderr
- NFR13: Sync does not proceed if the config file is missing or malformed — fails fast with a clear error
- NFR14: `protondrive sync` is idempotent — running it multiple times on an already-synced folder produces no unintended side effects

**Compatibility**
- NFR15: Self-contained binary runs on Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Fedora 40+, and Arch Linux with no runtime dependencies beyond glibc
- NFR16: Nix flake builds and runs correctly on NixOS and nix-on-any-distro (home-manager compatible)
- NFR17: AppImage runs on any x86_64 Linux distribution with FUSE support and glibc ≥ 2.17
- NFR18: CLI operates correctly when invoked from a non-interactive shell (no TTY) for all subcommands except `auth login`

**Total NFRs: 18** (NFR1–NFR18)

---

### Additional Requirements & Constraints

- **SRP auth from scratch:** ProtonDriveApps SDK ships no auth module; SRP must be implemented independently
- **2FA blocked:** SDK issue #6 closed out of scope by Proton — documented v1 limitation; users with 2FA cannot authenticate
- **SDK version pinning forbidden:** Proton's crypto migration in 2026 requires architecture to accommodate SDK updates without hard pins
- **inotify constraints:** Not recursive; Flatpak FUSE layer does not fire inotify events (upstream bug); fanotify requires `CAP_SYS_ADMIN` — not viable for v1
- **v1 file watching:** On-demand sync only; daemon-based watching is explicitly post-v1
- **Distribution packaging constraints:** AppImage via GitHub Releases; Flatpak requires static `--filesystem=` permissions and StatusNotifierWatcher tray workaround; FUSE/VFS blocked in Flatpak sandbox; Nix flake ships at v1 launch; AUR has no sandbox constraints

---

### PRD Completeness Assessment

The PRD is well-structured and thorough for a greenfield solo project. Requirements are numbered, categorized, and traceable to user journeys. Scope phasing (v1 CLI / v2 GUI / v3 vision) is clearly delineated.

**Strengths:**
- All 34 FRs are explicit and testable
- NFRs include concrete measurable targets (timing thresholds, file permissions)
- Technical constraints (SDK, inotify, packaging) are documented in the PRD itself
- Phase boundaries are clear

**Gaps / Observations:**
- No explicit FR for `auth logout` confirmation behavior (FR5 states it revokes token but UX detail is absent)
- No NFR covering usability/accessibility for the v2 GUI
- No explicit NFR for maximum supported sync tree size or file count before inotify watch limits become relevant
- No explicit requirement for configuration file path override (`--config` flag or env var) — scripts in non-standard environments may need this *(Note: Story 1.4 AC does include a `--config <path>` flag, so this is implicitly covered at story level despite the PRD omission)*

---

## Epic Coverage Validation

### Coverage Matrix

| FR | PRD Requirement (summary) | Epic Coverage | Status |
|----|--------------------------|---------------|--------|
| FR1 | Interactive SRP authentication | Epic 2 / Story 2.1, 2.3 | ✓ Covered |
| FR2 | Session token to OS keychain | Epic 2 / Story 2.2 | ✓ Covered |
| FR3 | Headless token reuse | Epic 2 / Story 2.3 | ✓ Covered |
| FR4 | libsecret headless fallback | Epic 2 / Story 2.2 | ✓ Covered |
| FR5 | `auth logout` / revoke token | Epic 2 / Story 2.3 | ✓ Covered |
| FR6 | Two-way sync via single command | Epic 4 / Story 4.3 | ✓ Covered |
| FR7 | Detect changes on both sides | Epic 4 / Story 4.2 | ✓ Covered |
| FR8 | Delta sync (changed files only) | Epic 4 / Story 4.2 | ✓ Covered |
| FR9 | Conflict detection | Epic 4 / Story 4.1, 4.2 | ✓ Covered |
| FR10 | Conflict copy deterministic naming | Epic 4 / Story 4.1 | ✓ Covered |
| FR11 | Sync original + conflict copy | Epic 4 / Story 4.2 | ✓ Covered |
| FR12 | Report conflicts in output | Epic 4 / Story 4.3 | ✓ Covered |
| FR13 | `upload` command | Epic 3 / Story 3.2 | ✓ Covered |
| FR14 | `download` command | Epic 3 / Story 3.3 | ✓ Covered |
| FR15 | View sync state of all pairs | Epic 5 / Story 5.1 | ✓ Covered |
| FR16 | View last sync timestamp per pair | Epic 5 / Story 5.1 | ✓ Covered |
| FR17 | Non-zero exit on error | Epic 1 / Story 1.2 | ✓ Covered |
| FR18 | stdout/stderr separation | Epic 1 / Story 1.3 | ✓ Covered |
| FR19 | `--json` flag on all commands | Epic 1 / Story 1.3 | ✓ Covered |
| FR20 | Sync JSON output schema | Epic 4 / Story 4.3 | ✓ Covered |
| FR21 | Status JSON output schema | Epic 5 / Story 5.1 | ✓ Covered |
| FR22 | YAML config file | Epic 1 / Story 1.4 | ✓ Covered |
| FR23 | Default config path | Epic 1 / Story 1.4 | ✓ Covered |
| FR24 | No credentials in config | Epic 1 / Story 1.4 | ✓ Covered |
| FR25 | Config safe for version control | Epic 1 / Story 1.4 | ✓ Covered |
| FR26 | Self-contained binary (no Node.js) | Epic 6 / Story 6.1 | ✓ Covered |
| FR27 | Nix flake | Epic 6 / Story 6.2 | ✓ Covered |
| FR28 | AUR PKGBUILD | Epic 6 / Story 6.3 | ✓ Covered |
| FR29 | AppImage | Epic 6 / Story 6.1 | ✓ Covered |
| FR30 | GUI sync pairs window | Deferred — v2 | ⏭ Out of v1 scope |
| FR31 | GUI live sync progress | Deferred — v2 | ⏭ Out of v1 scope |
| FR32 | GUI reads shared YAML config | Deferred — v2 | ⏭ Out of v1 scope |
| FR33 | GUI two-way sync + conflict copy | Deferred — v2 | ⏭ Out of v1 scope |
| FR34 | GUI via Flathub | Deferred — v2 | ⏭ Out of v1 scope |

### NFR Coverage Summary

| NFR | Requirement | Epic Coverage | Status |
|-----|-------------|---------------|--------|
| NFR1 | Sync startup ≤5s | Epic 4 / Story 4.3 AC | ✓ Covered |
| NFR2 | Status ≤2s (no network) | Epic 5 / Story 5.1 AC | ✓ Covered |
| NFR3 | Unchanged folder sync ≤3s | Epic 4 / Story 4.2 AC | ✓ Covered |
| NFR4 | Binary cold-start ≤500ms | Epic 6 / Story 6.1 | ✓ Covered |
| NFR5 | Token never plaintext on disk | Epic 2 / Story 2.2 | ✓ Covered |
| NFR6 | Token never in logs/output | Epic 2 / Story 2.1 AC | ✓ Covered |
| NFR7 | Config has no secrets | Epic 1 / Story 1.4 | ✓ Covered |
| NFR8 | SDK E2E encryption | Epic 3 / Story 3.1, 3.2 | ✓ Covered |
| NFR9 | Credentials file perms 0600 | Epic 2 / Story 2.2 AC | ✓ Covered |
| NFR10 | No silent overwrites | Epic 4 / Story 4.2 | ✓ Covered |
| NFR11 | Atomic writes, no partial corruption | Epic 4 / Story 4.2 AC | ✓ Covered |
| NFR12 | All errors → non-zero + stderr | Epic 3 / Story 3.2, 3.3 | ✓ Covered |
| NFR13 | Missing/malformed config fails fast | Epic 1 / Story 1.4 AC | ✓ Covered |
| NFR14 | Idempotent sync | Epic 4 / Story 4.2 AC | ✓ Covered |
| NFR15 | Binary runs on Ubuntu/Fedora/Arch | Epic 6 / Story 6.1 AC | ✓ Covered |
| NFR16 | Nix flake NixOS + nix-on-distro | Epic 6 / Story 6.2 AC | ✓ Covered |
| NFR17 | AppImage on x86_64 + FUSE + glibc | Epic 6 / Story 6.1 AC | ✓ Covered |
| NFR18 | Headless operation (no TTY needed) | Epic 2 / Story 2.3 AC | ✓ Covered |

### Missing Requirements

None. All 29 v1 FRs are covered. FR30–FR34 are explicitly deferred to v2 by design — this is intentional, not a gap.

### Coverage Statistics

- **Total PRD FRs (all phases):** 34
- **v1 FRs in scope:** 29 (FR1–FR29)
- **v1 FRs covered in epics:** 29
- **v1 FR coverage:** 100%
- **Total PRD NFRs:** 18
- **NFRs addressed in epics:** 18
- **NFR coverage:** 100%

---

## UX Alignment Assessment

### UX Document Status

Not found. No UX design document exists in planning artifacts.

### UX Implied Assessment

**v1 (CLI):** No UX document required. v1 is a CLI-only tool — user interaction is limited to terminal output. The "UX" of the CLI is defined entirely through:
- Output format requirements (FR17–FR21, NFR10–NFR12) in the PRD
- Story 1.3 (Output Infrastructure) specifying exact human-readable and JSON output formats
- The epics document explicitly notes: *"No UX design document exists for this project (v1 CLI only — no GUI in scope)."*

The CLI output behavior is treated as a public contract (JSON schema), which is a deliberate architectural decision documented in the epics Additional Requirements.

**v2 (GUI — `protondrive-sync`):** A desktop GUI is planned but explicitly deferred to v2. No UX design document exists for v2, which is expected given v2 has not yet entered planning. FR30–FR34 capture high-level GUI requirements, but no detailed UX specification is warranted at this stage.

### Alignment Issues

None. The absence of a UX document is intentional and appropriate for the current v1 CLI scope.

### Warnings

- ⚠️ **INFO:** When v2 GUI work begins, a UX document should be created before architecture/epics are written for that phase. The v2 epics (FR30–FR34) are currently too high-level to drive implementation without UX detail.

---

## Epic Quality Review

### Best Practices Compliance by Epic

#### Epic 1: Foundation — Validated Project Skeleton

| Check | Result |
|-------|--------|
| Delivers user value | ⚠️ Technical milestone — no standalone user value |
| Epic independence | ✅ Stands alone, no external dependencies |
| Story sizing | ✅ Stories are appropriately scoped |
| Forward dependencies | ✅ None within Epic 1 |
| Greenfield project setup | ✅ Story 1.1 is the initial project setup spike |
| FR traceability | ✅ FR17–FR25 traced |

**Concern:** Epic 1 is a technical foundation epic — a user cannot perform any meaningful operation after completing it alone. However, the step's own greenfield guidance requires "initial project setup story" and "development environment configuration," which Epic 1 provides. This is accepted as a necessary structural pattern for greenfield projects, not a defect.

**State DB timing note:** Story 1.5 creates `state.db` schema in Epic 1, but the DB is first consumed in Epic 4 (sync engine). Per best practices, each story should create the tables it needs. This is a minor violation — the schema could belong in Story 4.1 or 4.2 where it's first used. Counterargument: creating it in Epic 1 lets the schema be validated and types finalized before the sync engine references it.

---

#### Epic 2: Secure Authentication

| Check | Result |
|-------|--------|
| Delivers user value | ✅ User can authenticate and run headless commands |
| Epic independence | ✅ Uses only Epic 1 output |
| Story sizing | ✅ Three focused stories (SRP impl, credential store, commands) |
| Forward dependencies | ✅ None |
| FR traceability | ✅ FR1–FR5, NFR5–NFR7, NFR9, NFR18 |

No violations.

---

#### Epic 3: Manual File Operations

| Check | Result |
|-------|--------|
| Delivers user value | ✅ User can upload and download files end-to-end |
| Epic independence | ⚠️ Depends on Epic 2 (`SessionToken`, `CredentialStore`) |
| Story sizing | ✅ SDK wrapper + upload + download cleanly separated |
| Forward dependencies | ✅ None |
| FR traceability | ✅ FR13, FR14, NFR8, NFR12 |

**Concern:** Epic 3 requires Epic 2 to have been completed — Story 3.2 and 3.3 ACs both test "Given no cached session token exists" behavior, directly depending on `CredentialStore` from Epic 2. This is a backward dependency (correct direction), not a forward one. However, the `SessionToken` type is defined in `src/auth/srp.ts` (Epic 2, Story 2.1) but `src/types.ts` (Story 1.2) does not export it. Story 3.1 (DriveClient) references `SessionToken` as a parameter type — if the type isn't in shared types, Story 3.1 has a hidden type-level dependency on Epic 2.

**Recommendation:** `SessionToken` should be added to `src/types.ts` in Story 1.2 so that Epic 3 can be developed against a type contract without requiring Epic 2 to be complete first.

**Story 3.1 placement:** This story is a pure developer story (SDK wrapper / retry policy) with no direct user value. It is a technical prerequisite for Stories 3.2 and 3.3. Arguably it belongs in Epic 1 (Foundation). Placing it in Epic 3 is pragmatic (it's only needed by Epic 3+) but it means Epic 3 doesn't begin from a user story — it begins from an infrastructure story.

---

#### Epic 4: Two-Way Sync with Conflict Safety

| Check | Result |
|-------|--------|
| Delivers user value | ✅ Core user value — two-way sync with conflict safety |
| Epic independence | ✅ Depends on Epics 1–3 (backward dependencies only) |
| Story sizing | ✅ Conflict logic / sync engine / sync command cleanly separated |
| Forward dependencies | ✅ None (4.1 → 4.2 → 4.3 is correct sequential ordering) |
| FR traceability | ✅ FR6–FR12, FR20, NFR1, NFR3, NFR10, NFR11, NFR14 |

**Observation:** Stories 4.1 → 4.2 → 4.3 must be completed in order (sync engine depends on conflict module; sync command depends on sync engine). This sequential dependency is explicitly documented and acceptable — they are within the same epic.

**State DB:** Story 4.2 references `StateDB` from Story 1.5. This works because it's a backward dependency on Epic 1.

No critical violations.

---

#### Epic 5: Status & Observability

| Check | Result |
|-------|--------|
| Delivers user value | ✅ User can inspect sync state without triggering a sync |
| Epic independence | ✅ Depends on Epics 1–4 (backward dependencies only) |
| Story sizing | ✅ Single focused story — appropriately scoped |
| Forward dependencies | ✅ None |
| FR traceability | ✅ FR15, FR16, FR21, NFR2 |

**Concern:** FR19 (`--json` flag) is listed as covered in Epic 1 (infrastructure), but the JSON output schemas for individual commands (FR20 for sync, FR21 for status) are validated in Epics 4 and 5 respectively. This traceability split is correct and intentional — no violation.

No violations.

---

#### Epic 6: Packaging & Distribution

| Check | Result |
|-------|--------|
| Delivers user value | ✅ Users can install and run the tool on their system |
| Epic independence | ✅ Depends on all prior epics (compilable binary exists) |
| Story sizing | ✅ CI/Release pipeline + Nix flake + AUR cleanly separated |
| Forward dependencies | ✅ None |
| FR traceability | ✅ FR26–FR29, NFR4, NFR15–NFR17 |

**Concern:** CI pipeline (Story 6.1) is the final epic. This means test automation gates (`bun test` in CI) are not enforced during development of Epics 1–5. All stories throughout the epics include `bun test` ACs but these run locally only — no CI gate exists until Epic 6. For a solo developer this is an accepted risk, but it is a process gap.

**Recommendation:** Consider adding a minimal CI stub (just `bun test` on PR) as part of Story 1.1 or 1.2 so tests are gated from the start. The full release pipeline (binary + AppImage + GitHub Releases) can remain in Epic 6.

---

### Cross-Epic Issues

#### 🔴 Critical Violations
None identified.

#### 🟠 Major Issues

1. **`SessionToken` type not in shared types** — `src/types.ts` (Story 1.2) exports `SyncPair`, `SyncState`, `ConflictRecord`, `SyncPairStatus` but not `SessionToken`. Story 3.1 (DriveClient) and Story 2.3 (`auth login` command) both use `SessionToken`. Without it in shared types, there is an implicit type-level dependency from Epic 3 on Epic 2 being complete.
   - **Remediation:** Add `SessionToken` to Story 1.2 AC: `src/types.ts` exports `SessionToken` type.

2. **Auth token expiry not addressed** — No story covers what happens when a cached session token expires between runs. Story 2.3 covers logout and headless use, but not mid-session expiry or re-auth flow.
   - **Remediation:** Add an AC to Story 2.3 or a new Story 2.4: "Given a cached session token is expired or revoked, When any command other than `auth login` is run, Then it exits with code 1 and an `AuthError` message instructing the user to run `auth login` again."

3. **CI/CD deferred to Epic 6** — No automated test gate during development of Epics 1–5.
   - **Remediation:** Add a CI stub (`.github/workflows/ci.yml` with `bun test`) to Story 1.1 or 1.2, keeping release pipeline in Epic 6.

#### 🟡 Minor Concerns

1. **State DB in Epic 1 (Story 1.5) vs. Epic 4** — Per best practices, the state DB should be created in the story that first uses it (Story 4.2). Moving Story 1.5 to Epic 4 as Story 4.0 (prerequisite) would better align with "create tables when needed." However, this is architecturally intentional to validate schema design early — acceptable as-is.

2. **Story 3.1 (DriveClient) is a technical story** — It has developer value but no direct user value. It arguably belongs in Epic 1 (Foundation). Its placement in Epic 3 means the "Manual File Operations" epic doesn't open with user value.

3. **Story 1.1 pivot path underspecified** — The spike AC says "a decision note is appended to `architecture.md`" for the `@napi-rs/keyring` vs `dbus-next` decision, but there are no ACs defining what "fallback adopted" means in terms of follow-on work. If the fallback is needed, is there a follow-on story? The pivot path should be better specified.

4. **`protondrive sync` — no story for the "first run" pre-check across all commands** — The pattern "exits with code 1 and tells user to run auth login first" appears in Stories 3.2 and 3.3, but is not explicitly AC'd in Story 4.3 (sync) or 5.1 (status). Consistent handling should be explicit in each command story.

---

### Summary

| Epic | User Value | Independence | Story Quality | Dependencies | Verdict |
|------|-----------|-------------|---------------|-------------|---------|
| 1 — Foundation | ⚠️ Technical | ✅ | ✅ | ✅ | Accepted (greenfield pattern) |
| 2 — Auth | ✅ | ✅ | ✅ | ✅ | Pass |
| 3 — File Ops | ✅ | ⚠️ Minor | ⚠️ Infra story first | ✅ | Pass with notes |
| 4 — Sync | ✅ | ✅ | ✅ | ✅ | Pass |
| 5 — Status | ✅ | ✅ | ✅ | ✅ | Pass |
| 6 — Packaging | ✅ | ✅ | ✅ | ⚠️ Late CI | Pass with notes |

**Overall quality:** High. The epics are well-structured, stories are appropriately sized, ACs are BDD-formatted and testable. Issues found are minor to moderate — none are blocking defects that would prevent implementation from starting.

---

## Summary and Recommendations

**Assessor:** Winston (BMAD Architecture Review)
**Assessment Date:** 2026-04-01
**Project:** ProtonDrive-LinuxClient

---

### Overall Readiness Status

## ✅ READY — with minor pre-implementation fixes recommended

The planning artifacts are in strong shape. FR/NFR coverage is complete, epics are logically sequenced, stories have testable BDD acceptance criteria, and the architecture/epics/PRD are mutually consistent. No blocking defects were found. The issues below should be addressed before implementation begins, but none require re-planning.

---

### Critical Issues Requiring Immediate Action

None. There are no blockers.

---

### Recommended Next Steps

**Before writing the first line of implementation code:**

1. **Add `SessionToken` to shared types (Story 1.2)** — Add `SessionToken` to the exported types in `src/types.ts`. This removes an implicit type-level dependency from Epic 3 on Epic 2's internals. Cost: 5 minutes. Risk if skipped: Epic 3 development may inadvertently couple to Epic 2 implementation details.

2. **Add token-expiry AC to Story 2.3** — Add an explicit acceptance criterion: "Given a cached session token is expired or revoked by the server, When any command other than `auth login` is run, Then it exits with code 1 with a clear error instructing the user to re-authenticate." Cost: Add one AC. Risk if skipped: Expiry behaviour becomes an implicit assumption, likely discovered only when first encountered in testing.

3. **Add minimal CI stub to Story 1.1 or 1.2** — Add a `.github/workflows/ci.yml` that runs `bun test` on every PR as part of the first or second foundation story. Reserve the full release pipeline (binary build, AppImage, GitHub Release) for Epic 6. Cost: Small. Benefit: Test gate from day one. Risk if skipped: Tests exist but go unrun in CI until Epic 6 is shipped.

**Lower priority (can be deferred to backlog review after Epic 1):**

4. **Specify the `auth login` pre-check pattern consistently** — Stories 3.2 and 3.3 have ACs for "no cached session token" behaviour but Stories 4.3 (`sync`) and 5.1 (`status`) do not. Add this AC to both to prevent inconsistent error handling across commands.

5. **Clarify spike pivot path in Story 1.1** — The `@napi-rs/keyring` fallback to `dbus-next` is mentioned but the pivot path is underspecified. Add one sentence: "If fallback adopted, create a follow-on spike story before Story 2.2 to validate the `dbus-next` D-Bus approach against real keychain environments before building the credential store."

---

### Findings Summary

| Category | Finding | Severity | Status |
|----------|---------|----------|--------|
| FR Coverage | All 29 v1 FRs covered across 6 epics | — | ✅ Complete |
| NFR Coverage | All 18 NFRs addressed | — | ✅ Complete |
| UX Alignment | No UX doc — correct for v1 CLI | — | ✅ Accepted |
| Epic structure | Epic 1 is a technical foundation epic | 🟡 Minor | Accepted (greenfield pattern) |
| Shared types | `SessionToken` missing from `src/types.ts` | 🟠 Major | Fix before Epic 3 |
| Auth flow | Token expiry case unaddressed | 🟠 Major | Add AC to Story 2.3 |
| CI/CD | Test automation gate deferred to Epic 6 | 🟠 Major | Add CI stub to Epic 1 |
| State DB timing | `state.db` schema in Epic 1, first used in Epic 4 | 🟡 Minor | Accepted (intentional) |
| Story 3.1 | DriveClient is a technical story in Epic 3 | 🟡 Minor | Accepted |
| Story 1.1 | Spike pivot path underspecified | 🟡 Minor | Clarify before development |
| Auth pre-check | Missing "no token" AC in Stories 4.3 and 5.1 | 🟡 Minor | Add ACs |

**Total issues: 8** (0 critical, 3 major, 5 minor)

---

### Final Note

This assessment identified **8 issues** across **4 categories** (coverage, shared types, auth flow, CI/CD). The 3 major issues are quick fixes that can be resolved by amending existing stories — no re-architecture or re-planning required. The project is ready for implementation to begin once those amendments are made.

The planning work is genuinely solid for a greenfield solo project. The PRD is clear and scoped correctly, the architecture is grounded in real technical constraints, and the epics + stories provide a well-sequenced path from zero to a shippable v1 CLI.

