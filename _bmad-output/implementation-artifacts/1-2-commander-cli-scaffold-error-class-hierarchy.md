# Story 1.2: Commander CLI Scaffold & Error Class Hierarchy

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a fully wired Commander program with all command stubs and a typed error hierarchy,
so that all subsequent stories can register commands and throw typed errors without restructuring the entry point.

## Acceptance Criteria

1. **Given** the CLI is run with `--help`, **Then** it lists all subcommands: `auth login`, `auth logout`, `sync`, `upload`, `download`, `status`.
2. **Given** an unrecognized command is run, **When** the top-level handler processes it, **Then** it exits with code 2 and a helpful error message on stderr.
3. **Given** `src/errors.ts` exists, **Then** it exports `ProtonDriveError`, `AuthError`, `SyncError`, `NetworkError`, and `ConfigError` as typed classes.
4. **Given** any command throws a `ConfigError`, **When** the top-level handler in `src/cli.ts` catches it, **Then** it exits with code 2 and writes the error message to stderr.
5. **Given** any command throws any other `ProtonDriveError` subclass, **When** the top-level handler catches it, **Then** it exits with code 1 and writes the error message to stderr.
6. **Given** `src/types.ts` exists, **Then** it exports the shared types: `SyncPair`, `SyncState`, `ConflictRecord`, `SyncPairStatus`.
7. **Given** `bun test` is run, **Then** error class hierarchy unit tests pass.

## Tasks / Subtasks

- [x] Create `src/errors.ts` with full error hierarchy (AC: 3)
  - [x] Define `ProtonDriveError` base class (extends `Error`) with `code: string` field
  - [x] Define `AuthError extends ProtonDriveError`
  - [x] Define `SyncError extends ProtonDriveError`
  - [x] Define `NetworkError extends ProtonDriveError`
  - [x] Define `ConfigError extends ProtonDriveError`
  - [x] Export all classes
- [x] Create `src/types.ts` with shared types (AC: 6)
  - [x] `SyncPair`: `{ local: string; remote: string; id: string }`
  - [x] `SyncState`: `{ syncPairId: string; localPath: string; remotePath: string; lastSyncMtime: string; lastSyncHash: string; state: 'synced' | 'conflict' | 'error' | 'pending' }`
  - [x] `ConflictRecord`: `{ original: string; conflictCopy: string }`
  - [x] `SyncPairStatus`: `{ syncPair: SyncPair; state: SyncState['state']; lastSyncMtime: string | null }`
- [x] Wire Commander program in `src/cli.ts` (AC: 1, 2, 4, 5)
  - [x] Create `auth` subcommand group with `login` and `logout` stubs
  - [x] Create `sync`, `upload`, `download`, `status` subcommand stubs
  - [x] Add `--version` option reading from `package.json`
  - [x] Add top-level `.parseAsync()` wrapped in try/catch
  - [x] In catch: `ConfigError` → stderr + `process.exit(2)`; all other `ProtonDriveError` → stderr + `process.exit(1)`; unknown errors → rethrow
  - [x] Wire Commander's unknown command handler → `process.exit(2)`
- [x] Create command stub files in `src/commands/` (AC: 1)
  - [x] `src/commands/auth-login.ts` — exports `register(program: Command): void`
  - [x] `src/commands/auth-logout.ts` — exports `register(program: Command): void`
  - [x] `src/commands/sync.ts` — exports `register(program: Command): void`
  - [x] `src/commands/upload.ts` — exports `register(program: Command): void`
  - [x] `src/commands/download.ts` — exports `register(program: Command): void`
  - [x] `src/commands/status.ts` — exports `register(program: Command): void`
- [x] Write unit tests for error hierarchy (AC: 7)
  - [x] `src/errors.test.ts`: assert each subclass `instanceof ProtonDriveError`
  - [x] Assert `code` field is set correctly on each error type
  - [x] Run `bun test` and confirm pass

## Dev Notes

- **Prerequisite**: Story 1.1 must be complete — this story builds on the compiled binary foundation.
- **Command module pattern** (mandatory): Each `src/commands/*.ts` file exports a single `register(program: Command): void` function. No business logic in command files — they are thin CLI wiring only. [Source: architecture.md#Command Module Pattern]
- **Error hierarchy rules**:
  - `ProtonDriveError` must have `code: string` — all typed errors use this for JSON output
  - `ConfigError` → exit code 2; everything else → exit code 1
  - `process.exit()` is ONLY allowed in `src/cli.ts` and `src/commands/` — never in `src/core/` or `src/sdk/`
- **Top-level catch pattern** in `src/cli.ts`:
  ```typescript
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`error: ${err.code} — ${err.message}`);
      process.exit(2);
    } else if (err instanceof ProtonDriveError) {
      console.error(`error: ${err.code} — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  ```
- **Naming**: All files in `src/commands/` use kebab-case. TypeScript classes use PascalCase. No `I` prefix on interfaces.
- **`auth` command group**: Commander uses `.command('auth')` as a parent with `.command('login')` and `.command('logout')` as children. Stubs just `throw new Error('not implemented')` for now.
- **No `--json` handling yet** — that comes in Story 1.3. Stubs do not need JSON output.

### Project Structure Notes

- `src/errors.ts` and `src/types.ts` are root-level shared modules — no subdirectory.
- `src/commands/` must contain one file per subcommand.
- `src/cli.ts` is the sole location of `process.exit()` calls at the program level.
- Do not add business logic to command stubs — they will be filled in later stories.

### References

- Error class hierarchy [Source: architecture.md#Error Handling]
- Command module pattern [Source: architecture.md#Structure Patterns]
- Exit code policy [Source: architecture.md#Error Handling]
- Shared types [Source: epics.md#Story 1.2 Acceptance Criteria]
- One-way dependency rules [Source: architecture.md#Architectural Boundaries]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- `package.json` had no `version` field — Commander v14's `.version(undefined)` silently skips adding the `-V, --version` option. Fixed by adding `"version": "0.1.0"` to `package.json`.
- `createRequire` from `module` doesn't resolve relative paths inside compiled Bun binaries (`$bunfs/root/`). Replaced with `import pkg from "../package.json" with { type: "json" }` which Bun embeds correctly at compile time.

### Completion Notes List

- `src/errors.ts`: `ProtonDriveError` base + `AuthError`, `SyncError`, `NetworkError`, `ConfigError` subclasses, each with default codes and `Object.setPrototypeOf` for correct `instanceof` across compilation boundaries.
- `src/types.ts`: `SyncPair`, `SyncState`, `ConflictRecord`, `SyncPairStatus` interfaces.
- `src/cli.ts`: Commander wired with `auth` group, 5 top-level commands, JSON import for version, top-level catch with exit code policy.
- `src/commands/`: 6 stub files (`auth-login`, `auth-logout`, `sync`, `upload`, `download`, `status`) each exporting `register(program)`.
- 18 unit tests added in `src/errors.test.ts`; all 28 tests pass (10 from story 1.1 + 18 new).
- `package.json` updated with `"version": "0.1.0"`.

### File List

- `src/cli.ts` (modified)
- `src/errors.ts` (new)
- `src/types.ts` (new)
- `src/errors.test.ts` (new)
- `src/commands/auth-login.ts` (new)
- `src/commands/auth-logout.ts` (new)
- `src/commands/sync.ts` (new)
- `src/commands/upload.ts` (new)
- `src/commands/download.ts` (new)
- `src/commands/status.ts` (new)
- `package.json` (modified — added version field)

### Review Findings

- [x] [Review][Decision] `--help` at root shows `auth` not `auth login`/`auth logout` — accepted as-is; Commander nested subcommand display is standard idiom. `protondrive auth --help` shows login/logout. AC 1.2.1 interpreted accordingly.
- [x] [Review][Patch] `parseAsync` can reject with a non-`Error` value — fixed: added `else if (err instanceof Error)` branch before re-throw [src/cli.ts]
- [x] [Review][Patch] `command:*` handler: `program.args.join(" ")` is empty string when no args present — fixed: falls back to `"<empty>"` [src/cli.ts]

### Change Log

- 2026-04-02: Story 1.2 implemented — Commander scaffold, error hierarchy, shared types, command stubs.
