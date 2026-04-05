---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/architecture.md"
---

# ProtonDrive-LinuxClient - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for ProtonDrive-LinuxClient, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: User can authenticate interactively with Proton credentials via SRP protocol
FR2: System stores the session token in OS keychain (libsecret/GNOME Keyring/KWallet) after successful authentication
FR3: System uses the cached session token for all subsequent commands without requiring user interaction
FR4: System falls back to libsecret local file storage when no keychain daemon is available (headless server environments)
FR5: User can log out, revoking and clearing the cached session token
FR6: User can trigger a two-way sync of all configured sync pairs with a single command
FR7: System detects files modified on either the local or remote side since the last sync
FR8: System transfers only changed files during sync (delta sync — not a full re-upload of unchanged content)
FR9: System detects when the same file has been modified on both sides since the last sync (conflict)
FR10: System creates a conflict copy with a deterministic naming convention on conflict (e.g., `filename.conflict-YYYY-MM-DD`)
FR11: System syncs both the original file and the conflict copy to the remote after conflict detection
FR12: System reports all conflicts detected during a sync operation in both human-readable and JSON output
FR13: User can upload a local file or directory to a specified remote path
FR14: User can download a remote file or directory to a specified local path
FR15: User can view the current sync state of all configured sync pairs
FR16: User can view the last successful sync timestamp for each configured sync pair
FR17: System exits with a non-zero exit code on any error condition
FR18: System writes operational progress and results to stdout; errors and warnings to stderr
FR19: User can request machine-readable JSON output from any command via a `--json` flag
FR20: JSON sync output includes: files transferred, conflicts detected, conflict copy paths, errors
FR21: JSON status output includes: sync pairs, last sync timestamps, current state per pair
FR22: User defines sync pairs and options in a YAML configuration file
FR23: System reads configuration from a well-known default path (`~/.config/protondrive/config.yaml`)
FR24: Configuration file never contains authentication credentials or session tokens
FR25: Configuration file is safe to commit to version control and share in dotfiles repositories
FR26: User can run the CLI on a system with no Node.js runtime installed (self-contained binary)
FR27: User can install and manage the CLI via a Nix flake
FR28: User can install and manage the CLI via AUR PKGBUILD
FR29: User can run the CLI via AppImage without system installation
FR30: User can view all configured sync pairs and their current sync status in a desktop window (v2)
FR31: User can view live sync progress within the GUI (v2)
FR32: GUI reads the same YAML configuration file as the CLI (v2)
FR33: GUI performs two-way sync with the same conflict copy behavior as the CLI (v2)
FR34: User can install the GUI via Flathub (v2)

### NonFunctional Requirements

NFR1: `protondrive sync` startup to first file transfer completes within 5 seconds on a typical broadband connection (excluding transfer time)
NFR2: `protondrive status` returns output within 2 seconds with no network calls required (reads local state only)
NFR3: Repeat syncs of an unchanged folder complete in under 3 seconds regardless of folder size (delta-only transfer)
NFR4: Binary cold-start time does not exceed 500ms on supported distros
NFR5: Session token is never written to disk in plaintext — stored exclusively via libsecret (keychain or local encrypted fallback)
NFR6: Session token is never included in log output, JSON output, error messages, or the config file
NFR7: Config file contains no secrets; token storage is architecturally separate, enforced by design
NFR8: All communication with ProtonDrive uses the official SDK's encryption — no plaintext data transmission, no custom crypto
NFR9: Headless credential fallback file has file permissions set to `0600`
NFR10: No file is silently overwritten or deleted during sync — every destructive action is reported to the user
NFR11: A failed or interrupted sync leaves the filesystem in a consistent state — partial transfers do not corrupt existing files
NFR12: All error conditions produce a non-zero exit code and a human-readable error message on stderr
NFR13: Sync does not proceed if the config file is missing or malformed — fails fast with a clear error
NFR14: `protondrive sync` is idempotent — running it multiple times on an already-synced folder produces no unintended side effects
NFR15: Self-contained binary runs on Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Fedora 40+, and Arch Linux with no runtime dependencies beyond glibc
NFR16: Nix flake builds and runs correctly on NixOS and nix-on-any-distro (home-manager compatible)
NFR17: AppImage runs on any x86_64 Linux distribution with FUSE support and glibc ≥ 2.17
NFR18: CLI operates correctly when invoked from a non-interactive shell (no TTY) for all subcommands except `auth login`

### Additional Requirements

- **Starter template: Commander + Bun compile** — Architecture mandates `bun init -y`, then `bun add commander @protontech/drive-sdk @napi-rs/keyring`. First story must be a Bun + SDK compatibility validation spike before any feature work.
- **Bun + SDK spike is a hard gate** — run `bun build --compile` on a hello-world that imports the ProtonDriveApps SDK to confirm no incompatibilities. If `@napi-rs/keyring` cannot be embedded, evaluate pure-JS D-Bus fallback (`dbus-next`).
- **SRP implementation from scratch** — no npm SRP library matches Proton's SRP-B variant; implement in `src/auth/srp.ts`, referencing henrybear327/Proton-API-Bridge and rclone's SRP port. Must be validated against real Proton auth endpoint before other feature work.
- **DriveClient SDK abstraction boundary** — all ProtonDriveApps SDK imports must live exclusively in `src/sdk/client.ts`; no other file may import from `@protontech/drive-sdk`.
- **bun:sqlite for sync state** — use Bun's built-in SQLite (zero extra dependency) for sync state persistence at `~/.local/share/protondrive/state.db`. Schema: `sync_state(sync_pair_id, local_path, remote_path, last_sync_mtime, last_sync_hash, state)`.
- **Atomic file writes (NFR11)** — downloads written to `<filename>.protondrive-tmp` in same directory, renamed atomically on success; temp file deleted on failure. No partial writes touch live file paths.
- **Delta detection algorithm** — mtime-first, hash-on-change: compare `last_sync_mtime` first; if mtime differs, compute SHA-256 to confirm actual change. State DB stores both `last_sync_mtime` (ISO TEXT) and `last_sync_hash` (SHA-256 hex).
- **2FA surface behavior** — `srp.ts` must throw `AuthError` with code `TWO_FACTOR_REQUIRED` when Proton returns a 2FA challenge; human output: `"error: 2FA is not supported in v1 — disable 2FA on your Proton account to use this tool."` Must not hang.
- **XDG base dir compliance** — config path: `${XDG_CONFIG_HOME ?? '~/.config'}/protondrive/config.yaml`; state DB + credentials: `${XDG_DATA_HOME ?? '~/.local/share'}/protondrive/`.
- **Error class hierarchy** — `ProtonDriveError` base → `AuthError | SyncError | NetworkError | ConfigError`; exit codes: 0 = success, 1 = operational error, 2 = config/usage error.
- **JSON output schema is a public contract** — all `--json` output uses `{ ok: true, data: {...} }` / `{ ok: false, error: { code, message } }` wrapper; never deviate.
- **Retry policy** — network calls via DriveClient retry up to 3 times with exponential backoff (1s, 2s, 4s) on `NetworkError` only; `AuthError` and `ConfigError` fail immediately; retry logic lives in `src/sdk/client.ts`.
- **CI/CD: GitHub Actions on `v*` tag** — build `bun build --compile --target=bun-linux-x64`, package AppImage via `appimagetool`, attach binary + AppImage to GitHub Release. AUR PKGBUILD and Nix flake are source-based, updated post-release.
- **One-way dependency rules** — `src/commands/` → `src/core/` → `src/sdk/`; `src/auth/` is called by commands; `src/core/` never imports from `src/commands/`; `process.exit()` only in `src/commands/`.
- **v1 packaging priority** — Nix flake ships at launch (primary audience); AUR PKGBUILD ships at launch; AppImage ships at launch via GitHub Releases; Flathub deferred to v2.

### UX Design Requirements

No UX design document exists for this project (v1 CLI only — no GUI in scope).

### FR Coverage Map

FR1: Epic 2 — Interactive SRP login
FR2: Epic 2 — Session token stored in keychain
FR3: Epic 2 — Headless token reuse
FR4: Epic 2 — libsecret fallback for headless servers
FR5: Epic 2 — Logout / revoke token
FR6: Epic 4 — Two-way sync command
FR7: Epic 4 — Delta change detection
FR8: Epic 4 — Transfer only changed files
FR9: Epic 4 — Conflict detection
FR10: Epic 4 — Conflict copy naming
FR11: Epic 4 — Sync both original + conflict copy
FR12: Epic 4 — Report conflicts in output
FR13: Epic 3 — Upload local file/dir to remote
FR14: Epic 3 — Download remote file/dir to local
FR15: Epic 5 — View sync state of all pairs
FR16: Epic 5 — View last sync timestamp per pair
FR17: Epic 1 — Non-zero exit on error (infrastructure)
FR18: Epic 1 — stdout/stderr separation (infrastructure)
FR19: Epic 1 — `--json` flag infrastructure
FR20: Epic 4 — Sync JSON output schema
FR21: Epic 5 — Status JSON output schema
FR22: Epic 1 — YAML config file
FR23: Epic 1 — Default config path
FR24: Epic 1 — No secrets in config
FR25: Epic 1 — Config safe for version control
FR26: Epic 6 — Self-contained binary
FR27: Epic 6 — Nix flake
FR28: Epic 6 — AUR PKGBUILD
FR29: Epic 6 — AppImage
FR30–FR34: Deferred — v2 GUI (out of scope for v1)

### Epic 7 FR Coverage Map

FR1–FR21: Epic 7 — End-to-end validation layer (does not own these FRs, validates their implementation)

## Epic List

### Epic 1: Foundation — Validated Project Skeleton
Developer has a compiling, testable project with working toolchain, configuration loading, output infrastructure, and sync state schema. All subsequent epics build on this foundation.
**FRs covered:** FR17, FR18, FR19, FR22, FR23, FR24, FR25
**NFRs addressed:** NFR13
**Arch requirements:** Bun+SDK compatibility spike (hard gate), Commander wiring, error class hierarchy (`ProtonDriveError` → `AuthError | SyncError | NetworkError | ConfigError`), JSON/human output formatters, bun:sqlite state schema, YAML config loader, XDG path resolution

### Epic 2: Secure Authentication
A user can authenticate once with Proton credentials via SRP, session is cached securely in the OS keychain, all subsequent commands run headlessly from cron/CI without user interaction, and the user can log out.
**FRs covered:** FR1, FR2, FR3, FR4, FR5
**NFRs addressed:** NFR5, NFR6, NFR7, NFR9, NFR18

### Epic 3: Manual File Operations
A user can upload a local file or directory to a specified ProtonDrive path, or download a remote file or directory to a local path, proving SDK integration end-to-end.
**FRs covered:** FR13, FR14
**NFRs addressed:** NFR8, NFR12

### Epic 4: Two-Way Sync with Conflict Safety
A user can sync all configured pairs in both directions with a single command; only changed files are transferred; conflicts produce a named conflict copy instead of a silent overwrite; an interrupted sync never corrupts the filesystem.
**FRs covered:** FR6, FR7, FR8, FR9, FR10, FR11, FR12, FR20
**NFRs addressed:** NFR1, NFR3, NFR10, NFR11, NFR14
**Arch requirements:** Atomic writes pattern, mtime+SHA-256 delta detection, conflict copy naming convention, retry policy in DriveClient

### Epic 5: Status & Observability
A user can inspect sync state and last-sync timestamps for all configured pairs; all commands support `--json` for machine-readable output suitable for scripting and monitoring integration.
**FRs covered:** FR15, FR16, FR21
**NFRs addressed:** NFR2

### Epic 6: Packaging & Distribution
A user can install the CLI via Nix flake, AUR PKGBUILD, or AppImage on any supported Linux distribution with no Node.js runtime required; a GitHub Actions pipeline builds and publishes releases automatically on version tags.
**FRs covered:** FR26, FR27, FR28, FR29
**NFRs addressed:** NFR4, NFR15, NFR16, NFR17
**Arch requirements:** CI/CD release pipeline (`v*` tag → binary + AppImage), cross-compilation target, AppImage build script, AUR PKGBUILD, Nix flake

### Epic 7: End-to-End Test Suite
The compiled binary and full user journeys are validated end-to-end — both via process-spawning CLI tests (no live network) and live integration tests against real ProtonDrive.
**FRs covered:** FR1–FR21 (validation layer across all implemented FRs)
**NFRs addressed:** NFR10, NFR11, NFR12, NFR14

---

## Epic 1: Foundation — Validated Project Skeleton

Developer has a compiling, testable project with working toolchain, configuration loading, output infrastructure, and sync state schema. All subsequent epics build on this foundation.

### Story 1.1: Project Initialization & SDK Compatibility Spike

As a developer,
I want a validated project skeleton where `bun build --compile` successfully produces a binary that imports the ProtonDriveApps SDK,
So that I have a proven foundation to build all subsequent features on without undiscovered toolchain blockers.

**Acceptance Criteria:**

**Given** a fresh checkout,
**When** `bun install` is run,
**Then** all dependencies resolve without errors.

**Given** the project is initialized,
**When** `bun build --compile src/cli.ts --outfile dist/protondrive` is run,
**Then** it produces a single executable binary at `dist/protondrive`.

**Given** the compiled binary,
**When** it is executed on Ubuntu 22.04 LTS, Fedora 40+, and Arch Linux,
**Then** it runs without requiring a Node.js runtime on the host.

**Given** the ProtonDriveApps SDK is imported in `src/sdk/client.ts`,
**When** the binary is compiled,
**Then** SDK imports resolve without bundling errors.

**Given** `@napi-rs/keyring` is added as a dependency,
**When** the binary is compiled,
**Then** the co-location approach for the `.node` native addon is validated and documented (bundled cleanly OR fallback to `dbus-next` pure-JS D-Bus client is decided).

**Given** the spike is complete,
**Then** a decision note is appended to `architecture.md` confirming either: (a) `@napi-rs/keyring` bundles cleanly, or (b) the `dbus-next` fallback is adopted with rationale.

---

### Story 1.2: Commander CLI Scaffold & Error Class Hierarchy

As a developer,
I want a fully wired Commander program with all command stubs and a typed error hierarchy,
So that all subsequent stories can register commands and throw typed errors without restructuring the entry point.

**Acceptance Criteria:**

**Given** the CLI is run with `--help`,
**Then** it lists all subcommands: `auth login`, `auth logout`, `sync`, `upload`, `download`, `status`.

**Given** an unrecognized command is run,
**When** the top-level handler processes it,
**Then** it exits with code 2 and a helpful error message on stderr.

**Given** `src/errors.ts` exists,
**Then** it exports `ProtonDriveError`, `AuthError`, `SyncError`, `NetworkError`, and `ConfigError` as typed classes.

**Given** any command throws a `ConfigError`,
**When** the top-level handler in `src/cli.ts` catches it,
**Then** it exits with code 2 and writes the error message to stderr.

**Given** any command throws any other `ProtonDriveError` subclass,
**When** the top-level handler catches it,
**Then** it exits with code 1 and writes the error message to stderr.

**Given** `src/types.ts` exists,
**Then** it exports the shared types: `SyncPair`, `SyncState`, `ConflictRecord`, `SyncPairStatus`.

**Given** `bun test` is run,
**Then** error class hierarchy unit tests pass.

---

### Story 1.3: Output Infrastructure (Human + JSON)

As a developer,
I want a shared output module that formats all command results as human-readable or structured JSON,
So that every command produces consistent output without duplicating formatting logic and the `--json` contract is enforced from day one.

**Acceptance Criteria:**

**Given** `src/core/output.ts` exists and `--json` flag is active,
**When** `formatSuccess(data, { json: true })` is called,
**Then** it writes `{ "ok": true, "data": { ... } }` to stdout.

**Given** an error condition and `--json` flag,
**When** `formatError(err, { json: true })` is called,
**Then** it writes `{ "ok": false, "error": { "code": "...", "message": "..." } }` to stderr.

**Given** no `--json` flag,
**When** `formatSuccess` is called with a string message,
**Then** it writes human-readable output to stdout with no JSON wrapper.

**Given** an error and no `--json` flag,
**When** `formatError` is called,
**Then** it writes `error: CODE — message` to stderr.

**Given** a progress callback `onProgress(msg)` is passed to a core function,
**When** invoked in human mode,
**Then** it writes `[command] msg` to stdout.
**And** in JSON mode it is a no-op (no partial output before the final result).

**Given** `bun test` is run,
**Then** all output formatter unit tests pass.

---

### Story 1.4: YAML Config Loader

As a user,
I want to define sync pairs in a YAML config file at a well-known path,
So that all commands share a consistent, version-control-safe configuration with no credentials.

**Acceptance Criteria:**

**Given** `~/.config/protondrive/config.yaml` exists with valid content,
**When** `loadConfig()` is called,
**Then** it returns a parsed `Config` object containing `sync_pairs` and `options`.

**Given** `XDG_CONFIG_HOME` is set to a custom path,
**When** `loadConfig()` is called,
**Then** it resolves the config path to `$XDG_CONFIG_HOME/protondrive/config.yaml`.

**Given** the config file does not exist,
**When** `loadConfig()` is called,
**Then** it throws a `ConfigError` with a clear, actionable message on stderr.

**Given** the config file contains malformed YAML,
**When** `loadConfig()` is called,
**Then** it throws a `ConfigError` identifying the parse failure — sync does not proceed.

**Given** a valid config file,
**When** it is parsed,
**Then** no session token or credentials are present in the returned object.

**Given** a `--config <path>` flag is passed,
**When** any command is run,
**Then** it reads config from the specified path instead of the default.

**Given** `bun test` is run,
**Then** all config loader unit tests pass, including: missing file, malformed YAML, XDG override, and custom `--config` path.

---

### Story 1.5: Sync State Database

As a developer,
I want a bun:sqlite-backed state store that persists per-file sync metadata,
So that delta detection, idempotent sync, and status queries have a reliable local source of truth.

**Acceptance Criteria:**

**Given** `src/core/state-db.ts` exists,
**When** `StateDB.init()` is called,
**Then** it creates `~/.local/share/protondrive/state.db` if it does not exist.

**Given** `XDG_DATA_HOME` is set,
**When** `StateDB.init()` is called,
**Then** it resolves the DB path to `$XDG_DATA_HOME/protondrive/state.db`.

**Given** the DB is initialized,
**When** the schema is applied,
**Then** a `sync_state` table exists with columns: `sync_pair_id TEXT`, `local_path TEXT`, `remote_path TEXT`, `last_sync_mtime TEXT` (ISO 8601), `last_sync_hash TEXT` (SHA-256 hex), `state TEXT` (values: `synced | conflict | error | pending`).

**Given** a file record is written via `StateDB.upsert()`,
**When** `StateDB.get(localPath)` is called for the same path,
**Then** the stored record is returned with all fields intact.

**Given** a sync pair ID,
**When** `StateDB.getLastSync(syncPairId)` is called,
**Then** it returns the most recent `last_sync_mtime` for that pair, or `null` if never synced.

**Given** `bun test` is run,
**Then** all state DB unit tests pass.

---

## Epic 2: Secure Authentication

A user can authenticate once with Proton credentials via SRP, session is cached securely in the OS keychain, all subsequent commands run headlessly from cron/CI, and the user can log out.

### Story 2.1: SRP Authentication Implementation

As a developer,
I want an SRP-B implementation that authenticates against Proton's auth API and returns a session token,
So that the auth login command has a cryptographically correct foundation that works against real Proton accounts.

**Acceptance Criteria:**

**Given** `src/auth/srp.ts` exists,
**When** `srp.authenticate(username, password)` is called with valid Proton credentials,
**Then** it returns a `SessionToken` without requiring user interaction beyond the initial call.

**Given** a user has 2FA enabled on their Proton account,
**When** `srp.authenticate()` is called,
**Then** it throws an `AuthError` with code `TWO_FACTOR_REQUIRED`.
**And** the error message reads: `"2FA is not supported in v1 — disable 2FA on your Proton account to use this tool."` (does not hang or produce a cryptic failure).

**Given** invalid credentials,
**When** `srp.authenticate()` is called,
**Then** it throws an `AuthError` with code `AUTH_FAILED` and a clear message on stderr.

**Given** a network failure during authentication,
**When** `srp.authenticate()` is called,
**Then** it throws a `NetworkError` (not a timeout hang) after the retry policy is exhausted.

**Given** `srp.ts` is implemented,
**Then** no session token or intermediate SRP secrets appear in any log output, JSON output, or error messages.

**Given** `src/__integration__/auth.integration.test.ts` exists,
**When** run with real Proton credentials (excluded from default `bun test`),
**Then** it confirms `srp.authenticate()` succeeds against the live Proton auth endpoint.

---

### Story 2.2: Credential Store (Keychain + Headless Fallback)

As a user,
I want my session token stored securely in the OS keychain with an automatic fallback for headless servers,
So that my credentials are never on disk in plaintext whether I'm on a desktop or a server.

**Acceptance Criteria:**

**Given** `src/auth/credentials.ts` exports a `CredentialStore` interface,
**Then** it defines `get(key): Promise<string | null>`, `set(key, value): Promise<void>`, and `delete(key): Promise<void>`.

**Given** a desktop environment with GNOME Keyring or KWallet available,
**When** `CredentialStore.set('protondrive', token)` is called,
**Then** the token is stored in the OS keychain via `KeyringStore` (`src/auth/keyring-store.ts`).
**And** the token is never written to disk in plaintext.

**Given** no keychain daemon is available (headless server),
**When** `CredentialStore.set('protondrive', token)` is called,
**Then** it falls back to `FileStore` (`src/auth/file-store.ts`) and writes the token to `$XDG_DATA_HOME/protondrive/credentials`.
**And** the credentials file has permissions `0600`.

**Given** the fallback credentials file,
**When** it is created,
**Then** parent directories are created with appropriate permissions if they do not exist.

**Given** `CredentialStore.get('protondrive')` is called when no token has been stored,
**Then** it returns `null` without error.

**Given** `bun test` is run,
**Then** credential store unit tests pass for both `KeyringStore` and `FileStore` paths.

---

### Story 2.3: `auth login` and `auth logout` Commands

As a user,
I want to run `protondrive auth login` once to authenticate and `protondrive auth logout` to revoke my session,
So that all subsequent commands run headlessly using my cached token and I can cleanly end sessions.

**Acceptance Criteria:**

**Given** valid Proton credentials are entered interactively,
**When** `protondrive auth login` is run,
**Then** SRP authentication completes, the session token is stored via `CredentialStore`, and a success message is written to stdout.

**Given** `protondrive auth login` succeeds,
**When** any subsequent command is run,
**Then** it retrieves the cached token from `CredentialStore` without prompting the user.

**Given** no TTY is attached (cron/CI context),
**When** any command other than `auth login` is run,
**Then** it runs headlessly using the cached token without requiring interactive input.

**Given** `protondrive auth login` is run with `--json`,
**Then** on success it outputs `{ "ok": true, "data": {} }` to stdout with no token in the output.

**Given** `protondrive auth logout` is run with a valid token cached,
**Then** the token is deleted from `CredentialStore` and a success message is written to stdout.

**Given** `protondrive auth logout` is run when no token is cached,
**Then** it exits with code 0 and a message indicating no active session.

**Given** `protondrive auth login` is run when a 2FA account is detected,
**Then** it exits with code 1 and the `TWO_FACTOR_REQUIRED` error message on stderr.

---

## Epic 3: Manual File Operations

A user can upload a local file or directory to a specified ProtonDrive path, or download a remote file or directory to a local path — proving the SDK integration end-to-end.

### Story 3.1: DriveClient SDK Wrapper & Retry Policy

As a developer,
I want a `DriveClient` class that is the sole import point for the ProtonDriveApps SDK and encapsulates the retry policy,
So that all Drive API calls go through one place and SDK version migrations only require changes in `src/sdk/client.ts`.

**Acceptance Criteria:**

**Given** `src/sdk/client.ts` exists,
**Then** it is the only file in the project that imports from `@protontech/drive-sdk` — no other source file may import the SDK directly.

**Given** `DriveClient` is instantiated with a `SessionToken`,
**When** a Drive API method is called,
**Then** it uses the session token to authorize the request.

**Given** a Drive API call fails with a transient network error,
**When** `DriveClient` handles the failure,
**Then** it retries up to 3 times with exponential backoff (1s, 2s, 4s) before throwing a `NetworkError`.

**Given** a Drive API call fails with an `AuthError` or `ConfigError`,
**When** `DriveClient` handles the failure,
**Then** it fails immediately without retrying.

**Given** `DriveClient` methods produce progress events,
**When** an `onProgress` callback is provided,
**Then** it is called with descriptive messages; no `console.log` calls exist in `src/sdk/client.ts`.

**Given** `bun test` is run,
**Then** DriveClient unit tests covering retry logic and error propagation pass.

---

### Story 3.2: `upload` Command

As a user,
I want to run `protondrive upload <local> <remote>` to transfer a file or directory to ProtonDrive,
So that I can move files to my encrypted drive from the command line without a browser.

**Acceptance Criteria:**

**Given** a valid local file path and remote destination,
**When** `protondrive upload ~/file.txt /Documents/file.txt` is run,
**Then** the file is uploaded to ProtonDrive at the specified remote path and a success message is written to stdout.

**Given** a local directory path,
**When** `protondrive upload ~/Projects/backups /Backups/projects` is run,
**Then** all files in the directory are uploaded recursively and the count is reported to stdout.

**Given** the upload runs with `--json`,
**When** it completes successfully,
**Then** stdout contains `{ "ok": true, "data": { "transferred": N, "path": "/remote/path" } }`.

**Given** the local path does not exist,
**When** `protondrive upload` is run,
**Then** it exits with code 1 and writes a clear error to stderr.

**Given** no cached session token exists,
**When** `protondrive upload` is run,
**Then** it exits with code 1 and tells the user to run `auth login` first.

**Given** a network error occurs mid-upload,
**When** the DriveClient retry policy is exhausted,
**Then** it exits with code 1 and reports the failure on stderr — no partial file is left silently at the remote path.

**Given** all SDK communication goes through `DriveClient`,
**Then** all data in transit uses the SDK's end-to-end encryption.

---

### Story 3.3: `download` Command

As a user,
I want to run `protondrive download <remote> <local>` to retrieve a file or directory from ProtonDrive,
So that I can pull encrypted files to my local machine from the command line.

**Acceptance Criteria:**

**Given** a valid remote path and local destination,
**When** `protondrive download /Documents/file.txt ~/file.txt` is run,
**Then** the file is downloaded and written to the local path, and a success message is written to stdout.

**Given** a remote directory path,
**When** `protondrive download /Backups/projects ~/Projects/backups` is run,
**Then** all files in the remote directory are downloaded recursively and the count is reported.

**Given** the download runs with `--json`,
**When** it completes successfully,
**Then** stdout contains `{ "ok": true, "data": { "transferred": N, "path": "/local/path" } }`.

**Given** the remote path does not exist,
**When** `protondrive download` is run,
**Then** it exits with code 1 and writes a clear error to stderr.

**Given** no cached session token exists,
**When** `protondrive download` is run,
**Then** it exits with code 1 and tells the user to run `auth login` first.

**Given** a download is interrupted mid-transfer,
**When** the failure occurs,
**Then** the partially downloaded file is cleaned up and the original local path (if it existed) is not overwritten — no corrupted file remains.

---

## Epic 4: Two-Way Sync with Conflict Safety

A user can sync all configured pairs in both directions with a single command; only changed files are transferred; conflicts produce a named conflict copy instead of a silent overwrite; an interrupted sync never corrupts the filesystem.

### Story 4.1: Conflict Detection Logic

As a developer,
I want a conflict detection module that identifies divergent edits and produces a deterministically named conflict copy,
So that the sync engine never silently overwrites a file and users always retain both versions.

**Acceptance Criteria:**

**Given** `src/core/conflict.ts` exists,
**When** `detectConflict(localMtime, remoteMtime, lastSyncMtime)` is called with a file modified on both sides since last sync,
**Then** it returns `true` (conflict detected).

**Given** a file only modified on one side since last sync,
**When** `detectConflict()` is called,
**Then** it returns `false`.

**Given** a conflict is detected for `notes.md` on `2026-04-01`,
**When** `buildConflictCopyName('notes.md', date)` is called,
**Then** it returns `notes.md.conflict-2026-04-01`.

**Given** a file with no extension (e.g., `Makefile`) on `2026-04-01`,
**When** `buildConflictCopyName('Makefile', date)` is called,
**Then** it returns `Makefile.conflict-2026-04-01`.

**Given** a conflict is detected,
**When** the conflict copy is written locally,
**Then** the original file at its original path is not modified or deleted.

**Given** `bun test` is run,
**Then** all conflict detection and naming unit tests pass, including edge cases (no extension, same-day conflict, file already has `.conflict-` suffix).

---

### Story 4.2: Delta Detection & Two-Way Sync Engine

As a developer,
I want a sync engine that detects changed files using mtime+hash, syncs both directions atomically, and resolves conflicts without data loss,
So that the `sync` command only transfers what changed and never corrupts local files on interrupted transfers.

**Acceptance Criteria:**

**Given** `src/core/sync-engine.ts` exists,
**When** `syncEngine.run(pairs, token, driveClient, options)` is called,
**Then** it queries `StateDB` for last-sync state of each file in each configured pair.

**Given** a file whose `last_sync_mtime` has not changed,
**When** the sync engine evaluates it,
**Then** it is skipped — no transfer occurs.

**Given** a file whose mtime differs from `last_sync_mtime`,
**When** the sync engine evaluates it,
**Then** it computes a SHA-256 hash to confirm the content actually changed before transferring.

**Given** a file modified only on the local side,
**When** the sync engine runs,
**Then** it uploads the local version to the remote and updates `StateDB` with the new mtime and hash.

**Given** a file modified only on the remote side,
**When** the sync engine runs,
**Then** it downloads to a `.protondrive-tmp` file in the same directory, then atomically renames it to the target path on success — the original file is never touched until the rename completes.

**Given** a download is interrupted before the rename,
**When** the sync engine handles the failure,
**Then** the `.protondrive-tmp` file is deleted and the original local file is unchanged.

**Given** a file modified on both sides since last sync,
**When** the sync engine detects the conflict,
**Then** it creates a conflict copy via `conflict.ts`, syncs both the original and the conflict copy to remote, updates `StateDB` for both, and reports the conflict in the result.

**Given** `syncEngine.run()` completes,
**When** called again immediately on an unchanged folder,
**Then** it transfers nothing and returns a result with 0 transferred files.

**Given** `bun test` is run,
**Then** all sync engine unit tests pass, including: delta skip, local-only change, remote-only change, conflict copy creation, atomic write, and interrupted download cleanup.

---

### Story 4.3: `sync` Command

As a user,
I want to run `protondrive sync` to sync all configured pairs in both directions,
So that my local and remote files stay in agreement with a single command, usable from cron or CI.

**Acceptance Criteria:**

**Given** a valid config with sync pairs and a cached session token,
**When** `protondrive sync` is run,
**Then** the sync engine runs for all configured pairs, progress lines are written to stdout as `[sync] Uploading path/to/file...`, and a summary is written on completion.

**Given** `protondrive sync` runs with `--json`,
**When** it completes,
**Then** stdout contains `{ "ok": true, "data": { "transferred": N, "conflicts": [...], "errors": [] } }` with no progress lines interspersed.

**Given** a conflict is detected during sync in human mode,
**Then** a conflict notice is written to stdout as `[conflict] notes.md → notes.md.conflict-2026-04-01`.

**Given** a conflict is detected during sync with `--json`,
**Then** the `conflicts` array contains `{ "original": "...", "conflictCopy": "..." }` records for each conflict.

**Given** `protondrive sync` is run from a non-interactive shell with no TTY,
**When** a valid cached token exists,
**Then** it completes without any prompt or interactive input.

**Given** the startup-to-first-transfer time is measured on a typical broadband connection,
**Then** it completes within 5 seconds excluding actual transfer time.

**Given** `protondrive sync` is run with no config file present,
**Then** it exits with code 2 and a clear error before attempting any network call.

**Given** any error occurs during sync,
**Then** it exits with a non-zero exit code and the error is written to stderr — no error is silently swallowed.

---

## Epic 5: Status & Observability

A user can inspect sync state and last-sync timestamps for all configured pairs; all commands support `--json` for machine-readable output suitable for scripting and monitoring integration.

### Story 5.1: `status` Command

As a user,
I want to run `protondrive status` to see the sync state and last-sync time for each configured pair,
So that I can verify my sync is working without triggering a sync or making any network calls.

**Acceptance Criteria:**

**Given** a valid config and at least one prior sync,
**When** `protondrive status` is run,
**Then** it prints each configured sync pair with its current state (`synced | conflict | error | pending`) and last sync timestamp to stdout.

**Given** a sync pair that has never been synced,
**When** `protondrive status` is run,
**Then** it shows that pair with state `pending` and last sync `never`.

**Given** `protondrive status` is run with `--json`,
**When** it completes,
**Then** stdout contains `{ "ok": true, "data": { "pairs": [...], "last_sync": "2026-04-01T14:30:00.000Z" } }` where each pair includes `local`, `remote`, `state`, and `last_sync_mtime`.

**Given** `protondrive status` reads only from `StateDB` (no network calls),
**When** it is run,
**Then** it returns output within 2 seconds regardless of network conditions.

**Given** no config file is present,
**When** `protondrive status` is run,
**Then** it exits with code 2 and a clear error message.

**Given** `bun test` is run,
**Then** status command unit tests pass, covering: never-synced pairs, mixed states, and JSON output format.

---

## Epic 6: Packaging & Distribution

A user can install the CLI via Nix flake, AUR PKGBUILD, or AppImage on any supported Linux distribution with no Node.js runtime required; a GitHub Actions pipeline builds and publishes releases automatically on version tags.

### Story 6.1: GitHub Actions CI & Release Pipeline

As a developer,
I want a CI pipeline that runs tests on every PR and a release pipeline that builds and publishes binaries on version tags,
So that every merge is validated and every release is a single `git tag` away.

**Acceptance Criteria:**

**Given** `.github/workflows/ci.yml` exists,
**When** a pull request is opened or updated,
**Then** `bun test` and TypeScript type-checking run automatically and the PR is blocked on failure.

**Given** `.github/workflows/release.yml` exists,
**When** a `v*` tag is pushed,
**Then** it runs `bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/protondrive` and produces a self-contained binary.

**Given** the release pipeline runs,
**When** the binary is built,
**Then** an AppImage is assembled via `appimagetool` using `packaging/appimage/protondrive.desktop` and `packaging/appimage/build-appimage.sh`.

**Given** the binary and AppImage are built,
**When** the pipeline completes,
**Then** both artifacts are attached to a GitHub Release for the pushed tag.

**Given** the compiled binary,
**When** it is run on Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Fedora 40+, and Arch Linux,
**Then** it executes without requiring a Node.js runtime (NFR15).

**Given** the AppImage,
**When** it is run on any x86_64 Linux distribution with FUSE support and glibc ≥ 2.17,
**Then** it executes without system installation (NFR17).

**Given** `protondrive --version` is run on the released binary,
**Then** it outputs the version matching the release tag.

---

### Story 6.2: Nix Flake

As a user on NixOS or nix-on-any-distro,
I want to install `protondrive` via a Nix flake,
So that I can manage it declaratively in home-manager or NixOS configuration.

**Acceptance Criteria:**

**Given** `packaging/nix/flake.nix` exists,
**When** `nix build .#protondrive` is run from the project root,
**Then** it produces a working `protondrive` binary in the Nix store.

**Given** the Nix flake,
**When** added to a `home-manager` configuration as an input,
**Then** `protondrive` is available in the user's PATH after `home-manager switch`.

**Given** the Nix flake,
**When** built on NixOS and on nix-on-Fedora/Ubuntu,
**Then** the resulting binary runs correctly on both (NFR16).

**Given** the flake's `devShell` output,
**When** a developer enters it via `nix develop`,
**Then** `bun`, `typescript`, and all project dependencies are available without system-level installation.

---

### Story 6.3: AUR PKGBUILD

As an Arch Linux user,
I want to install `protondrive` via the AUR,
So that I can manage it with `yay`, `paru`, or `makepkg` like any other AUR package.

**Acceptance Criteria:**

**Given** `packaging/aur/PKGBUILD` exists,
**When** `makepkg -si` is run in that directory against a tagged release tarball,
**Then** `protondrive` is installed to `/usr/bin/protondrive` without requiring Node.js at install or runtime.

**Given** the PKGBUILD,
**When** a new version tag is released,
**Then** updating `pkgver` and the source tarball URL is sufficient to produce a valid updated package.

**Given** the installed binary on Arch Linux,
**When** `protondrive --help` is run,
**Then** all subcommands are listed and the binary exits with code 0 (NFR15).

**Given** the PKGBUILD,
**Then** it includes correct `depends`, `makedepends`, `license=('MIT')`, and `sha256sums` fields following AUR packaging guidelines.

---

## Epic 7: End-to-End Test Suite

The compiled binary and full user journeys are validated end-to-end — both via process-spawning CLI tests (no live network) and live integration tests against real ProtonDrive.

**FRs covered:** FR1–FR21 (validation layer across all implemented FRs)
**NFRs addressed:** NFR10, NFR11, NFR12, NFR14

### Story 7.1: CLI Binary Smoke & E2E Tests

As a developer,
I want a suite of e2e tests that spawn the compiled `dist/protondrive` binary and exercise all subcommands with expected responses,
So that CLI-layer regressions are caught before release without requiring live Proton credentials.

**Acceptance Criteria:**

**Given** `dist/protondrive` binary is compiled,
**When** `bun test src/__e2e__/` is run,
**Then** tests spawn the binary as a child process and assert stdout, stderr, and exit codes.

**Given** `protondrive --help` is run via the binary,
**Then** it exits 0 and stdout contains all subcommand names (`auth`, `sync`, `upload`, `download`, `status`).

**Given** `protondrive sync` is run with a missing config file,
**Then** it exits 2 and stderr contains a human-readable config error (not a stack trace).

**Given** `protondrive sync` is run with a valid config but no cached credentials,
**Then** it exits 1 and stderr contains a readable auth error (not a crash/stack trace).

**Given** `protondrive status --json` is run with a valid config and no prior syncs,
**Then** it exits 0 and stdout is valid JSON matching `{ ok: true, data: { pairs: [...] } }`.

**Given** `protondrive upload /nonexistent /remote` is run,
**Then** it exits 1 and stderr contains a readable error message.

**Given** `bun test src/__e2e__/` is run,
**Then** all smoke tests pass against the compiled binary (binary must be pre-built before running).

---

### Story 7.2: Live ProtonDrive Integration Tests

As a developer,
I want live integration tests that run a complete user journey against a real Proton account,
So that auth, encryption, upload, download, sync, and conflict flows are validated against the actual ProtonDrive API.

**Acceptance Criteria:**

**Given** `PROTON_TEST_USER` and `PROTON_TEST_PASS` environment variables are set,
**When** `bun test src/__integration__/` is run,
**Then** all integration tests execute (these are excluded from default `bun test`).

**Given** valid credentials,
**When** `auth.integration.test.ts` runs `srp.authenticate()`,
**Then** it succeeds against the live Proton auth endpoint and returns a valid session token.

**Given** a valid session token,
**When** `sync.integration.test.ts` runs a full upload → remote-verify → download cycle,
**Then** the downloaded file matches the uploaded file byte-for-byte.

**Given** two conflicting local changes,
**When** `sync.integration.test.ts` triggers a sync,
**Then** a conflict copy is created and both files appear in ProtonDrive.

**Given** `bun test src/__integration__/` completes (pass or fail),
**Then** all test data is cleaned up from the test ProtonDrive account (cleanup runs in `afterAll`).

---

### Story 7.3: E2E CI Workflow

As a developer,
I want a GitHub Actions workflow that runs e2e and integration tests on-demand and on release tags,
So that every release is validated beyond unit tests before assets are published.

**Acceptance Criteria:**

**Given** `.github/workflows/e2e.yml` exists,
**When** triggered manually (`workflow_dispatch`) or on push of a `v*` tag,
**Then** it compiles the binary, runs `bun test src/__e2e__/`, and reports results.

**Given** `PROTON_TEST_USER` and `PROTON_TEST_PASS` are configured as GitHub Actions secrets,
**When** `e2e.yml` runs on a `v*` tag,
**Then** it also runs `bun test src/__integration__/` and blocks the workflow on failure.

**Given** the existing `ci.yml`,
**When** a PR is opened,
**Then** `ci.yml` continues to run only `bun test` (unit tests) — no change to PR gate behavior.

**Given** `e2e.yml`,
**When** `bun test src/__e2e__/` or `bun test src/__integration__/` fails,
**Then** the workflow exits non-zero and the failure is visible in the Actions tab.
