# Story 4.3: `sync` Command

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want to run `protondrive sync` to sync all configured pairs in both directions,
so that my local and remote files stay in agreement with a single command, usable from cron or CI.

## Acceptance Criteria

1. **Given** a valid config with sync pairs and a cached session token, **When** `protondrive sync` is run, **Then** the sync engine runs for all configured pairs, progress lines written to stdout as `[sync] Uploading path/to/file...`, and a summary written on completion.
2. **Given** `protondrive sync` runs with `--json`, **When** it completes, **Then** stdout contains `{ "ok": true, "data": { "transferred": N, "conflicts": [...], "errors": [] } }` with no progress lines interspersed.
3. **Given** a conflict detected during sync in human mode, **Then** a conflict notice written to stdout as `[conflict] notes.md → notes.md.conflict-2026-04-01`.
4. **Given** a conflict detected during sync with `--json`, **Then** the `conflicts` array contains `{ "original": "...", "conflictCopy": "..." }` records.
5. **Given** `protondrive sync` is run from a non-interactive shell with no TTY, **When** a valid cached token exists, **Then** it completes without any prompt or interactive input.
6. **Given** startup-to-first-transfer is measured on a typical broadband connection, **Then** it completes within 5 seconds excluding actual transfer time (NFR1).
7. **Given** `protondrive sync` is run with no config file, **Then** it exits with code 2 and a clear error before any network call.
8. **Given** any error occurs during sync, **Then** it exits with a non-zero exit code and the error is written to stderr — no error is silently swallowed.

## Tasks / Subtasks

- [x] Implement `src/commands/sync.ts` (AC: 1–8)
  - [x] Replace stub from Story 1.2
  - [x] Register: `protondrive sync` with `--json` option (no positional args)
  - [x] Load config via `loadConfig()` — `ConfigError` exits with code 2 before any network call (AC: 7)
  - [x] Retrieve token via `getSessionToken()` — `AuthError` exits code 1
  - [x] Instantiate `DriveClient(token, { onProgress: onProgressFn })`
  - [x] Instantiate `SyncEngine(stateDb)` where `stateDb = await StateDB.init()`
  - [x] Progress function:
    - [x] Human mode: `makeProgressCallback('sync', opts)` for regular progress
    - [x] Conflict notices in human mode: `process.stdout.write('[conflict] original → conflictCopy\n')`
    - [x] JSON mode: all progress is no-op
  - [x] Call `syncEngine.run(config.sync_pairs, token, driveClient, { onProgress })`
  - [x] On success (human): print `"Sync complete: N file(s) transferred, M conflict(s) detected."`
  - [x] On success (JSON): `{ "ok": true, "data": { "transferred": N, "conflicts": [...], "errors": [] } }`
  - [x] On any error: `formatError(err, opts)`, exit 1 (or 2 for ConfigError)
  - [x] Wrap in top-level try/catch per command action pattern

## Dev Notes

- **Prerequisite**: Stories 4.1 (conflict) and 4.2 (sync engine) must be complete.
- **Config-first, fail-fast** (NFR13): Load and validate config BEFORE any network call. `ConfigError` → exit 2. This ensures `protondrive sync` never starts a network operation with a bad config.
- **Non-interactive** (NFR18, FR3): The sync command must work with no TTY. `getSessionToken()` reads from `CredentialStore` without prompting. The only interactive command is `auth login`.
- **JSON mode — no progress lines**: In `--json` mode, `makeProgressCallback` returns a no-op. Conflict notices also suppressed. Final JSON object is the only stdout output. [Source: architecture.md#Format Patterns]
- **Conflict output format** (human mode): `[conflict] notes.md → notes.md.conflict-2026-04-01` — use `process.stdout.write` directly (not `console.log`) or via a dedicated conflict progress line.
- **JSON conflicts array**: Each element is `{ "original": string, "conflictCopy": string }` matching `ConflictRecord` type.
- **NFR1 startup performance**: The command should initialize `StateDB`, load config, and authenticate within 5 seconds before first transfer. Avoid any expensive operations (no directory scans, no network calls) before instantiating the sync engine.
- **Error handling**: `SyncEngine.run()` may throw. Wrap in try/catch. Per command pattern: `ConfigError` → exit 2, all others → exit 1.
- **`StateDB.init()`**: Called once per `sync` invocation. Close the DB after sync completes.
- **No direct SDK imports** in `sync.ts` — uses `DriveClient` via `src/sdk/client.ts`.

### Project Structure Notes

- `src/commands/sync.ts` — replaces stub
- Orchestrates: `loadConfig()`, `getSessionToken()`, `DriveClient`, `StateDB`, `SyncEngine`
- No business logic in command file — delegates entirely to `src/core/sync-engine.ts`

### References

- JSON sync output schema [Source: architecture.md#Format Patterns]
- NFR1: 5s startup [Source: epics.md#NonFunctional Requirements]
- NFR13: fail-fast on bad config [Source: epics.md#NonFunctional Requirements]
- NFR18: non-interactive [Source: epics.md#NonFunctional Requirements]
- Conflict notice format [Source: epics.md#Story 4.3]
- Command action pattern [Source: architecture.md#Structure Patterns]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- 2026-04-02: Story 4.3 implemented — sync command orchestrates loadConfig (fail-fast), getSessionToken, DriveClient, StateDB, SyncEngine; human mode prints progress+conflict notices+summary; JSON mode outputs single object; ConfigError→exit 2, others→exit 1; StateDB closed in finally.
- 14 unit tests covering human/JSON output, conflict notices, partial errors, ConfigError/AuthError/SyncEngine throws, and NFR13 (config checked before token call).

### File List

- `src/commands/sync.ts` (replaced stub)
- `src/commands/sync.test.ts` (new)

### Review Findings

- [x] [Review][Patch] JSON mode exits 0 on partial sync errors — when result.errors is non-empty, human mode correctly exits 1 but JSON mode calls formatSuccess and exits 0; violates AC8 and breaks CI/script error detection [src/commands/sync.ts:45-67]
