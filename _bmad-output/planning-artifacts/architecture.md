---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-04-01'
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient.md"
  - "_bmad-output/planning-artifacts/product-brief-ProtonDrive-LinuxClient-distillate.md"
  - "_bmad-output/planning-artifacts/research/technical-linux-packaging-formats-research-2026-04-01.md"
workflowType: 'architecture'
project_name: 'ProtonDrive-LinuxClient'
user_name: 'Jeremy'
date: '2026-04-01'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (34 total):**
- Auth & Session Management (FR1–FR5): Interactive SRP login, keychain token storage, headless re-use, fallback for servers, logout
- File Synchronization (FR6–FR12): Two-way sync, delta detection, conflict copy, conflict reporting
- File Transfer (FR13–FR14): Upload and download primitives
- Status & Observability (FR15–FR21): Sync state display, timestamps, exit codes, stdout/stderr separation, JSON output
- Configuration Management (FR22–FR25): YAML config, well-known path, no secrets in config
- Distribution & Installation (FR26–FR29): Self-contained binary, Nix flake, AUR, AppImage
- GUI Sync Interface v2 (FR30–FR34): Sync pairs window, live status, shared config, Flathub

**Non-Functional Requirements (18 total):**
- Performance: 5s to first transfer, 500ms cold-start, 2s status (local-only), 3s repeat sync of unchanged folder
- Security: Token never plaintext anywhere — not in logs, config, or stderr; 0600 on fallback file
- Reliability: Idempotent sync, consistent state on interrupted transfer, no silent overwrites, fail-fast on bad config
- Compatibility: Ubuntu 22.04 LTS / 24.04 LTS, Fedora 40+, Arch; NixOS / home-manager; headless (no TTY) for all subcommands except `auth login`

**Scale & Complexity:**
- Primary domain: CLI tooling / system integration / cloud sync
- Complexity level: Medium
- Estimated architectural components: 6 (SRP auth, credential store, sync engine, state tracker, config layer, CLI dispatcher)

### Technical Constraints & Dependencies

- **SDK lock-in without version pinning**: ProtonDriveApps SDK (TypeScript, MIT) — must abstract SDK boundary to accommodate 2026 crypto migration
- **No SRP library in SDK**: Must implement from scratch; henrybear327/Proton-API-Bridge and rclone's SRP port are the primary references
- **2FA hard block**: Users with 2FA cannot authenticate — v1 documented limitation, not a fixable bug
- **Self-contained binary**: Node.js runtime must be fully bundled; glibc ≥ 2.17 compatibility floor for AppImage
- **inotify is not recursive**: v1 uses on-demand sync (no daemon), so not an immediate constraint; becomes critical in v2/v3 daemon design
- **Flatpak (v2)**: inotify requires static `--filesystem=`, FUSE blocked, tray needs `--talk-name=org.kde.StatusNotifierWatcher`, Secret portal GNOME-only

### Cross-Cutting Concerns Identified

1. **Binary bundling strategy** — toolchain selection (esbuild/pkg/bun) affects cold-start (NFR4), glibc floor (NFR15/NFR17), and build reproducibility
2. **Credential storage** — two runtime paths (keychain / libsecret local fallback) must be explicit, tested, and architecturally isolated from config
3. **Sync state persistence** — delta detection and idempotency require a local state store (per-file last-sync metadata); design must be explicit
4. **SDK version isolation** — abstraction layer between sync engine and SDK prevents migration-forced rewrites
5. **Error propagation + exit codes** — non-zero exit on any error (NFR12/FR17) must be a consistent policy across all command paths, not per-command logic
6. **JSON output** — `--json` flag on all subcommands; output schema must be designed as a first-class contract, not retrofitted
7. **Shared engine between CLI and GUI** — sync engine and config layer must be independently consumable by both the CLI dispatcher and the v2 GUI

## Starter Template Evaluation

### Primary Technology Domain

TypeScript CLI tool targeting self-contained binary distribution. No off-the-shelf integrated starter exists — decision is choosing CLI framework + binary compiler combination.

### Starter Options Considered

| Option | CLI Framework | Binary Compiler | Verdict |
|--------|--------------|-----------------|---------|
| Commander + Bun compile | Commander v12 | `bun build --compile` | **Selected** |
| Commander + Node SEA | Commander v12 | `node --build-sea` (Node 25.5) | Safe fallback |
| oclif generator | oclif | esbuild + Node SEA | Overkill for 5 subcommands; 70–100ms startup penalty |

### Selected Approach: Commander + Bun

**Rationale:**
- Commander is the minimal-overhead choice (~35ms, 0 dependencies) appropriate for a 5-subcommand CLI
- `bun build --compile` produces a single self-contained binary with best-in-class startup performance — directly addresses NFR4 (≤500ms cold-start)
- Bun handles TypeScript natively — no separate tsc/esbuild step required
- Integrated toolchain: one tool for runtime, bundling, test running, and binary compilation
- Claude Code itself ships as a Bun binary — production validation of the approach for TypeScript tooling
- Fallback path: if ProtonDriveApps SDK surfaces Bun incompatibilities, swap `bun build --compile` for `esbuild + node --build-sea` without changing Commander or project structure

**Validation spike required (first implementation story):** Run `bun build --compile` on a hello-world that `import`s the ProtonDriveApps SDK to confirm no native addon or Node.js built-in incompatibilities before building on this foundation.

**Initialization Command:**

```bash
mkdir protondrive && cd protondrive
bun init -y
bun add commander
bun add -d @types/node typescript
```

**Architectural Decisions Established by This Choice:**

**Language & Runtime:**
- TypeScript, executed and compiled by Bun (no separate tsc invocation)
- Target: Bun-compatible CommonJS/ESM bundle → single executable

**CLI Structure:**
- Commander program with nested subcommands: `auth login`, `sync`, `upload`, `download`, `status`
- Each subcommand in its own module; program wired in `src/cli.ts` entry point

**Build Tooling:**
- `bun build --compile src/cli.ts --outfile dist/protondrive` — produces self-contained binary
- Cross-compilation via `--target=bun-linux-x64` for CI release builds
- No separate minifier or bundler step required

**Testing Framework:**
- Bun's built-in test runner (`bun test`) — zero additional dependency

**Code Organization:**
```
src/
  cli.ts           # Commander program wiring + entry point
  commands/        # One file per subcommand (auth.ts, sync.ts, etc.)
  core/            # Sync engine, state tracker, config layer (shared with GUI v2)
  auth/            # SRP implementation + credential store
  sdk/             # SDK abstraction layer (isolates ProtonDriveApps SDK version)
dist/
  protondrive      # Self-contained binary output
```

**Development Experience:**
- `bun run src/cli.ts` — run directly without compilation step
- `bun test` — test runner
- Hot reload via `bun --hot` during development

**Note:** Project initialization and SDK compatibility validation using this setup should be the first implementation story.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical (block implementation):**
- Sync state store: bun:sqlite
- Credential storage: @napi-rs/keyring with FileStore fallback
- SRP auth: implement from scratch (Proton-API-Bridge as reference)
- SDK abstraction: DriveClient service class

**Important (shape architecture):**
- Error class hierarchy + universal exit code policy
- CI/CD: GitHub Actions release pipeline

**Deferred (post-MVP):**
- Daemon-based file watching (inotify)
- GUI framework for v2 (Tauri/GTK4/Qt6 — separate architecture decision)

### Data Architecture

**Sync State Store: bun:sqlite (built-in)**
- Rationale: Built into Bun runtime (zero extra dependency), reliable atomic writes for interrupted-sync recovery (NFR11), queryable for status/reporting
- Schema: `sync_state(sync_pair_id, local_path, remote_path, last_sync_mtime, last_sync_hash, state)`
- State values: `synced | conflict | error | pending`
- Location: `~/.local/share/protondrive/state.db`

### Authentication & Security

**SRP Implementation: Build from scratch in `src/auth/srp.ts`**
- Rationale: No npm SRP library matches Proton's SRP-B variant; the PRD explicitly identifies this path
- Reference implementations: henrybear327/Proton-API-Bridge (Go), rclone's SRP port
- Interface: `srp.authenticate(username, password): Promise<SessionToken>`
- Validated against actual Proton auth endpoint before any other feature work

**Credential Storage: `@napi-rs/keyring` + FileStore fallback**
- Rationale: NAPI-RS packages bundle cleanly into Bun self-contained binary; avoids keytar's native addon bundling complexity
- Abstracted behind `CredentialStore` interface in `src/auth/credentials.ts`
- `KeyringStore`: OS keychain (libsecret/GNOME Keyring/KWallet) — default
- `FileStore`: libsecret ≥0.20 local encrypted file at `~/.local/share/protondrive/credentials` with `0600` permissions — headless server fallback (NFR9)
- Runtime selection: attempt KeyringStore, fall back to FileStore if no keychain daemon available
- Token NEVER written to config file or log output (NFR5–NFR7)

### API & Communication Patterns

**SDK Abstraction: `DriveClient` service class**
- Rationale: All SDK imports isolated in `src/sdk/client.ts` — SDK version migration updates one file, not the entire codebase
- All sync engine, auth, and command code talks to `DriveClient` only
- Never import from `@protontech/drive-sdk` outside `src/sdk/`

**Error Handling: Custom error class hierarchy + universal exit code policy**
- `ProtonDriveError` base class → `AuthError | SyncError | NetworkError | ConfigError`
- Top-level handler in `src/cli.ts` catches all errors, formats for human/JSON output
- Exit code policy (constant, not per-command): 0 = success, 1 = operational error, 2 = config/usage error
- All errors surface to stderr; JSON output includes `error` key on non-zero exit (FR17–FR19, NFR12)

### Infrastructure & Deployment

**CI/CD: GitHub Actions on `v*` tag**
- Build: `bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/protondrive`
- Package: AppImage via `appimagetool` in CI
- Release: GitHub Release with binary + AppImage attached
- AUR PKGBUILD + Nix flake: source-based, updated to new tag tarball post-release (separate PR/commit)

### Decision Impact Analysis

**Implementation Sequence:**
1. Bun + SDK compatibility validation spike (before anything else)
2. SRP auth implementation + credential store
3. Config file parser + validation
4. Sync state DB schema + bun:sqlite layer
5. DriveClient SDK wrapper
6. Sync engine (delta detection, conflict copy)
7. CLI commands wired via Commander
8. JSON output + exit code policy applied uniformly
9. CI/CD release pipeline

**Cross-Component Dependencies:**
- Sync engine depends on: DriveClient, sync state DB, config layer
- All commands depend on: credential store (for token), config layer
- Auth command depends on: SRP impl, credential store
- JSON output + exit codes are a cross-cutting concern applied at the Commander command handler level

## Implementation Patterns & Consistency Rules

### Critical Conflict Points Identified

7 areas where AI agents could make different, incompatible choices: file naming, export patterns, error handling, JSON output schema, async patterns, test location, and SQLite column naming.

### Naming Patterns

**File Naming: kebab-case for all source files**
- ✅ `src/commands/auth-login.ts`, `src/core/sync-engine.ts`
- ❌ `src/commands/AuthLogin.ts`, `src/core/syncEngine.ts`
- Exception: index files are always `index.ts`

**TypeScript Naming Conventions:**
- Functions and variables: `camelCase`
- Classes and interfaces: `PascalCase` (no `I` prefix on interfaces)
- Constants (module-level, fixed values): `UPPER_SNAKE_CASE`
- Type aliases: `PascalCase`
- Examples:
  - ✅ `const MAX_RETRY_COUNT = 3`
  - ✅ `interface CredentialStore`, `class KeyringStore`
  - ❌ `interface ICredentialStore`, `const maxRetryCount = 3`

**SQLite Column Naming: snake_case**
- ✅ `sync_pair_id`, `last_sync_mtime`, `local_path`
- ❌ `syncPairId`, `lastSyncMtime`, `localPath`
- Table names: singular snake_case (`sync_state`, `sync_pair`)

**Config YAML Keys: snake_case (matches PRD schema)**
- ✅ `sync_pairs`, `conflict_strategy`, `local`, `remote`
- ❌ `syncPairs`, `conflictStrategy`

### Structure Patterns

**Command Module Pattern:**
Each subcommand is a file in `src/commands/` that exports a single `register(program: Command): void` function. No business logic in command files — delegate immediately to `src/core/`.

```typescript
// src/commands/sync.ts
export function register(program: Command): void {
  program
    .command('sync')
    .description('Two-way sync of all configured pairs')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      // thin wrapper only — call core, handle output, set exit code
    });
}
```

**Core vs Commands boundary:**
- `src/commands/` — CLI wiring, output formatting, exit codes only
- `src/core/` — all business logic; no Commander imports; no process.exit()
- `src/auth/` — SRP, credential store only; no Commander imports
- `src/sdk/` — DriveClient only; no Commander imports; no process.exit()

**Test File Location: three-tier model**
- **Unit tests** — co-located `*.test.ts` alongside source files; always run via `bun test`
  - ✅ `src/core/sync-engine.test.ts`
  - ❌ `__tests__/sync-engine.test.ts` or `tests/core/sync-engine.test.ts`
- **E2e/binary tests** — `src/__e2e__/`; spawn compiled `dist/protondrive` binary; run via `bun test src/__e2e__/`; requires pre-built binary; no live network
- **Integration tests** — `src/__integration__/`; require real Proton credentials; excluded from default `bun test`; run via `bun test src/__integration__/` in `e2e.yml` CI

### Format Patterns

**JSON Output Schema — first-class contract:**

All `--json` output follows this wrapper:

```typescript
// Success
{ "ok": true, "data": { ...command-specific payload } }

// Error
{ "ok": false, "error": { "code": "AUTH_FAILED", "message": "..." } }
```

- `ok` field always present — agents must never omit it
- `data` schema per command:
  - `sync`: `{ transferred: number, conflicts: ConflictRecord[], errors: string[] }`
  - `status`: `{ pairs: SyncPairStatus[], last_sync: string | null }`
  - `upload`/`download`: `{ transferred: number, path: string }`
  - `auth login`: `{ ok: true }` on success only (no token in output)

**Human Output Format:**
- Progress lines to stdout: `[sync] Uploading Documents/notes.md...`
- Conflict notice to stdout: `[conflict] notes.md → notes.md.conflict-2026-04-01`
- Errors to stderr: `error: AUTH_FAILED — invalid credentials`
- Prefix format: `[command]` tag for progress, bare `error:` for errors

**Date/Time Serialization:**
- All timestamps in ISO 8601 format: `2026-04-01T14:30:00.000Z`
- Conflict copy suffix: `YYYY-MM-DD` (local date) e.g. `.conflict-2026-04-01`
- SQLite stores timestamps as ISO strings (TEXT column, not INTEGER epoch)

### Process Patterns

**Async Pattern: async/await everywhere**
- No raw `.then()/.catch()` chains in application code
- No callbacks outside of Commander's `.action()` wrapper
- ✅ `const token = await credStore.get('protondrive')`
- ❌ `credStore.get('protondrive').then(token => ...)`

**Error Handling: throw, never return errors**
- All error conditions throw a typed subclass of `ProtonDriveError`
- Never return `{ error: ... }` objects from core functions
- Never catch-and-swallow in core — let errors propagate to the command handler
- Single top-level catch in each command's `.action()` handler

```typescript
// Top-level pattern in every command action:
.action(async (opts) => {
  try {
    const result = await core.doThing();
    output(result, opts.json);
  } catch (err) {
    outputError(err, opts.json);
    process.exit(err instanceof ConfigError ? 2 : 1);
  }
})
```

**Progress Reporting: callback injection**
- Core functions that produce progress accept an optional `onProgress: (msg: string) => void` callback
- Commands pass a `console.log` writer (human mode) or no-op (JSON mode)
- Core never calls `console.log` directly

**Retry Pattern:**
- Network calls via DriveClient retry up to 3 times with exponential backoff (1s, 2s, 4s) on transient errors only (`NetworkError` subclass)
- Non-retryable errors (`AuthError`, `ConfigError`) fail immediately
- Retry logic lives in `src/sdk/client.ts`, not in individual commands

### Enforcement Guidelines

**All AI Agents MUST:**
- Never import from `@protontech/drive-sdk` outside `src/sdk/client.ts`
- Never call `process.exit()` outside `src/commands/`
- Never call `console.log/error` outside `src/commands/` (use callback injection)
- Always use the `{ ok, data/error }` JSON wrapper — never bare objects
- Always throw `ProtonDriveError` subclasses, never plain `Error` or strings
- Always name SQLite columns in `snake_case`
- Always co-locate test files as `*.test.ts`

**Anti-Patterns:**
- ❌ `import { DriveFS } from '@protontech/drive-sdk'` in `sync-engine.ts`
- ❌ `process.exit(1)` in `src/core/sync-engine.ts`
- ❌ Returning `null` to signal "not found" — throw a typed error
- ❌ `{ error: "message" }` JSON (missing `ok` field)
- ❌ Catching errors in core and logging them silently

## Project Structure & Boundaries

### Complete Project Directory Structure

```
protondrive/
├── README.md
├── LICENSE                              # MIT
├── package.json
├── bunfig.toml                          # Bun configuration (test runner, build settings)
├── tsconfig.json
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml                       # Run tests + type-check on PRs
│       └── release.yml                  # Build binary + AppImage, publish GitHub Release on v* tag
├── packaging/
│   ├── appimage/
│   │   ├── protondrive.desktop          # AppImage desktop metadata
│   │   └── build-appimage.sh            # AppImage assembly script (called from release.yml)
│   ├── aur/
│   │   └── PKGBUILD                     # AUR package recipe (source-based, points at GitHub tarball)
│   └── nix/
│       └── flake.nix                    # Nix flake (ships at v1 launch)
├── src/
│   ├── cli.ts                           # Commander program wiring + top-level error handler entry point
│   ├── errors.ts                        # ProtonDriveError → AuthError | SyncError | NetworkError | ConfigError
│   ├── types.ts                         # Shared TypeScript types: SyncPair, SyncState, ConflictRecord, etc.
│   ├── commands/
│   │   ├── auth-login.ts                # FR1–FR4: interactive SRP login, cache token
│   │   ├── auth-logout.ts               # FR5: revoke and clear cached token
│   │   ├── sync.ts                      # FR6–FR12: two-way sync of all configured pairs
│   │   ├── upload.ts                    # FR13: upload local file/directory to remote path
│   │   ├── download.ts                  # FR14: download remote file/directory to local path
│   │   └── status.ts                    # FR15–FR21: display sync pairs, last sync time, current state
│   ├── core/
│   │   ├── sync-engine.ts               # FR6–FR12: delta detection, two-way sync loop, conflict handling
│   │   ├── sync-engine.test.ts
│   │   ├── conflict.ts                  # FR9–FR11: conflict detection logic + naming convention
│   │   ├── conflict.test.ts
│   │   ├── state-db.ts                  # Sync state persistence via bun:sqlite (last_sync_mtime, hash, state)
│   │   ├── state-db.test.ts
│   │   ├── config.ts                    # FR22–FR25: YAML config loader, validator, default path resolution
│   │   ├── config.test.ts
│   │   └── output.ts                    # Human-readable + JSON output formatters (shared by all commands)
│   ├── auth/
│   │   ├── srp.ts                       # SRP-B implementation for Proton's auth protocol
│   │   ├── srp.test.ts
│   │   ├── credentials.ts               # CredentialStore interface + runtime selector (keyring vs file)
│   │   ├── keyring-store.ts             # KeyringStore: @napi-rs/keyring (OS keychain — default)
│   │   └── file-store.ts                # FileStore: libsecret local encrypted file fallback (headless)
│   └── sdk/
│       └── client.ts                    # DriveClient: sole import point for @protontech/drive-sdk
├── src/__e2e__/
│   └── cli.e2e.test.ts                  # Spawns dist/protondrive binary; no live network; requires pre-built binary
├── src/__integration__/
│   ├── auth.integration.test.ts         # Requires live Proton credentials (excluded from default bun test)
│   └── sync.integration.test.ts         # Requires live ProtonDrive + local filesystem
├── dist/                                # gitignored — binary output
│   └── protondrive
└── docs/
    └── rclone-migration.md              # v1 launch artifact: rclone config migration guide
```

### Architectural Boundaries

**External Boundaries:**
- **ProtonDrive API** — `src/sdk/client.ts` is the sole crossing point; nothing outside `src/sdk/` imports the SDK
- **OS Keychain (libsecret/KWallet)** — `src/auth/keyring-store.ts` and `src/auth/file-store.ts` are the sole crossing points
- **Filesystem** — `src/core/sync-engine.ts` owns all local file I/O for sync; commands delegate to it

**Internal Boundaries (one-way dependencies only):**
```
src/commands/ → src/core/    (commands call core, never reverse)
src/commands/ → src/auth/    (commands call auth, never reverse)
src/core/     → src/sdk/     (core calls DriveClient, never reverse)
src/core/     → src/auth/    (core receives token passed in, no direct import)
All modules   → src/errors.ts, src/types.ts  (shared, no business logic)
```

**Forbidden dependencies:**
- `src/core/` must not import from `src/commands/`
- `src/sdk/` must not import from `src/core/` or `src/commands/`
- `src/auth/` must not import from `src/core/` or `src/commands/`

### Requirements to Structure Mapping

| FR Category | Primary Location |
|-------------|-----------------|
| Auth & Session Management (FR1–FR5) | `src/auth/`, `src/commands/auth-*.ts` |
| File Synchronization (FR6–FR12) | `src/core/sync-engine.ts`, `src/core/conflict.ts` |
| File Transfer (FR13–FR14) | `src/commands/upload.ts`, `src/commands/download.ts` |
| Status & Observability (FR15–FR21) | `src/commands/status.ts`, `src/core/state-db.ts`, `src/core/output.ts` |
| Configuration Management (FR22–FR25) | `src/core/config.ts` |
| Distribution & Installation (FR26–FR29) | `packaging/`, `.github/workflows/release.yml` |
| GUI v2 (FR30–FR34) | Out of scope for v1 — separate repository or monorepo package |

**Cross-Cutting Concerns:**

| Concern | Location |
|---------|----------|
| Error types | `src/errors.ts` |
| Exit codes + top-level catch | `src/cli.ts` |
| JSON + human output formatting | `src/core/output.ts` |
| Shared types | `src/types.ts` |
| Retry + backoff | `src/sdk/client.ts` |
| Sync state persistence | `src/core/state-db.ts` |

### Integration Points & Data Flow

**Command invocation → result:**
1. User runs `protondrive sync --json`
2. Commander (`src/cli.ts`) routes to `src/commands/sync.ts`
3. Command loads config via `src/core/config.ts`
4. Command retrieves token from `CredentialStore` (`src/auth/credentials.ts`)
5. Command calls `syncEngine.run(pairs, token, driveClient, { onProgress })`
6. Sync engine queries last state from `state-db.ts`
7. Sync engine calls `DriveClient` methods for remote file listing + transfers
8. Sync engine calls `conflict.ts` on divergence, writes conflict copy
9. Sync engine updates `state-db.ts` after each file
10. Sync engine returns `SyncResult` to command
11. Command calls `output.formatSyncResult(result, { json: true })` → stdout
12. On any thrown error: command formats error → stderr, calls `process.exit(1|2)`

**State persistence locations:**
- Sync state DB: `~/.local/share/protondrive/state.db`
- Credentials (keyring): OS keychain service `protondrive`
- Credentials (fallback): `~/.local/share/protondrive/credentials` (0600)
- Config: `~/.config/protondrive/config.yaml`

### Development Workflow

| Task | Command |
|------|---------|
| Run (development) | `bun run src/cli.ts sync` |
| Test (unit) | `bun test` |
| Test (e2e/binary) | `bun test src/__e2e__/` |
| Test (integration) | `bun test src/__integration__/` |
| Build binary | `bun build --compile src/cli.ts --outfile dist/protondrive` |
| Release | Push `v*` tag → GitHub Actions |

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:** All decisions are mutually compatible. Bun runtime is compatible with Commander (pure JS), bun:sqlite (built-in), and the ProtonDriveApps SDK (Node.js compat layer). One noted constraint: `@napi-rs/keyring` native addon cannot be embedded into the bun binary — it is co-located. AppImage bundles this cleanly; other distributions must package the `.node` file alongside the binary. Validate and decide final approach during the Bun+SDK spike.

**Pattern Consistency:** All patterns are internally consistent. kebab-case files, camelCase functions, PascalCase types, snake_case SQLite — no conflicts. One-way dependency rules are compatible with the chosen module structure.

**Structure Alignment:** Project structure fully supports all architectural decisions. Boundary rules are enforceable via TypeScript import restrictions.

### Requirements Coverage Validation ✅

**Functional Requirements:** All 34 FRs are architecturally supported and mapped to specific files. FR30–FR34 (GUI v2) are explicitly deferred.

**Non-Functional Requirements:** All 18 NFRs are addressed. Two gaps were identified and resolved below.

### Gap Analysis & Resolutions

**Critical gaps resolved:**

1. **Atomic file writes (NFR11):** `sync-engine.ts` must write downloads to `<filename>.protondrive-tmp` in the same directory, then rename atomically on success; delete temp file on failure. No partial writes ever touch the live file path.

2. **Native addon bundling (`@napi-rs/keyring`):** `.node` files cannot be embedded in `bun build --compile` output — they are co-located. AppImage bundles both files. AUR/Nix package both files. Validate bundling in the Bun+SDK spike; fallback option is a pure-JS D-Bus Secret Service client (`dbus-next` + `org.freedesktop.secrets`) which eliminates the native addon entirely.

**Important gaps resolved:**

3. **Delta detection algorithm:** mtime-first, hash-on-change. Compare `last_sync_mtime` first; if mtime differs, compute SHA-256 of file content to confirm actual change (avoids false positives from touch/copy). `state-db` stores both `last_sync_mtime` (TEXT/ISO) and `last_sync_hash` (TEXT/SHA-256 hex).

4. **2FA surface behavior:** `srp.ts` must throw `AuthError` with code `TWO_FACTOR_REQUIRED` when Proton returns the 2FA challenge. Human output: `"error: 2FA is not supported in v1 — disable 2FA on your Proton account to use this tool."` Must not hang or produce a cryptic failure.

**Minor gaps resolved:**

5. **XDG base dir compliance:** `config.ts` resolves config path as `${XDG_CONFIG_HOME ?? '~/.config'}/protondrive/config.yaml`. State DB and credentials resolve via `${XDG_DATA_HOME ?? '~/.local/share'}/protondrive/`.

### Architecture Completeness Checklist

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped
- [x] Critical decisions documented
- [x] Technology stack fully specified (Bun, Commander, bun:sqlite, @napi-rs/keyring)
- [x] Integration patterns defined (DriveClient boundary, CredentialStore interface)
- [x] Performance considerations addressed (bun:sqlite for local reads, delta sync)
- [x] Security requirements covered (token isolation, 0600 fallback, no token in output)
- [x] Naming conventions established
- [x] Structure patterns defined with anti-patterns
- [x] Communication patterns specified
- [x] Process patterns documented (async/await, throw-don't-return, progress callbacks, atomic writes)
- [x] Complete directory structure defined
- [x] Component boundaries established with forbidden dependency rules
- [x] Integration points mapped
- [x] Requirements-to-structure mapping complete

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**

**Confidence Level: High**

**Key Strengths:**
- Bun compile eliminates the Node.js runtime bundling problem cleanly
- DriveClient boundary provides real protection against the 2026 SDK migration
- bun:sqlite removes an external dependency for the most critical state
- Error hierarchy + exit code policy prevents the most common AI agent divergence
- Atomic write pattern + conflict copy ensure no data loss under any failure mode

**Areas for Future Enhancement (post-v1):**
- GUI framework decision for v2 (Tauri/GTK4/Qt6) — separate architecture session
- Daemon-based file watching design (inotify recursive + fanotify trade-offs)
- FUSE/VFS architecture (post-v2)
- nixpkgs submission packaging requirements

### Implementation Handoff

**First Implementation Priority:**

```bash
# Story 1: Bun + SDK compatibility spike
mkdir protondrive && cd protondrive
bun init -y
bun add @protontech/drive-sdk @napi-rs/keyring commander
bun add -d typescript @types/node
bun build --compile src/cli.ts --outfile dist/protondrive
# Validate: binary runs, SDK imports resolve, @napi-rs/keyring .node bundles correctly
```

**AI Agent Guidelines:**
- Follow all architectural decisions exactly as documented
- Use Implementation Patterns section for all naming, structure, and format decisions
- Respect the one-way dependency rules — they are load-bearing
- The JSON output schema in Patterns is a public API contract — do not deviate
- Refer to this document before making any technology or structural choice

---

## Keyring Bundling Decision

**Date:** 2026-04-02
**Story:** 1.1 — Project Initialization & SDK Compatibility Spike
**Decision:** `@napi-rs/keyring` — **ADOPTED** (bundles cleanly)

### Validation Results

- **Bun version tested:** 1.3.11
- **Platform:** Linux x86_64 (Fedora 43)
- `bun build --compile` with `@napi-rs/keyring@1.2.0` → **SUCCESS** (no errors)
- Resulting binary executed successfully; `Entry` class available at runtime
- The `.node` native addon is correctly embedded in the compiled binary by Bun 1.3.x

### Outcome

**Option (a): `@napi-rs/keyring` bundles cleanly — ADOPTED.**

The `dbus-next` pure-JS fallback is **not needed** for v1. `@napi-rs/keyring` will be used as the primary credential store in Story 2.2 (`credential-store-keychain-headless-fallback`). The `dbus-next` fallback path documented in the architecture remains a contingency for environments where NAPI-RS addon loading fails at runtime (e.g., heavily sandboxed containers), but is deferred unless a concrete failure is reported.
