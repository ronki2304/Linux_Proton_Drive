# Story 5.1: `status` Command

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want to run `protondrive status` to see the sync state and last-sync time for each configured pair,
so that I can verify my sync is working without triggering a sync or making any network calls.

## Acceptance Criteria

1. **Given** a valid config and at least one prior sync, **When** `protondrive status` is run, **Then** it prints each configured sync pair with its current state (`synced | conflict | error | pending`) and last sync timestamp to stdout.
2. **Given** a sync pair that has never been synced, **When** `protondrive status` is run, **Then** it shows that pair with state `pending` and last sync `never`.
3. **Given** `protondrive status` is run with `--json`, **When** it completes, **Then** stdout contains `{ "ok": true, "data": { "pairs": [...], "last_sync": "2026-04-01T14:30:00.000Z" } }` where each pair includes `local`, `remote`, `state`, and `last_sync_mtime`.
4. **Given** `protondrive status` reads only from `StateDB` (no network calls), **When** it is run, **Then** it returns output within 2 seconds regardless of network conditions (NFR2).
5. **Given** no config file is present, **When** `protondrive status` is run, **Then** it exits with code 2 and a clear error message.
6. **Given** `bun test` is run, **Then** status command unit tests pass covering: never-synced pairs, mixed states, and JSON output format.

## Tasks / Subtasks

- [x] Implement `src/commands/status.ts` (AC: 1–5)
  - [x] Replace stub from Story 1.2
  - [x] Register: `protondrive status` with `--json` option
  - [x] Load config via `loadConfig()` — `ConfigError` exits code 2 (AC: 5)
  - [x] Initialize `StateDB` — read-only queries only, NO network calls (AC: 4)
  - [x] For each sync pair in `config.sync_pairs`:
    - [x] Call `stateDb.getLastSync(pair.id)` → `lastSyncMtime | null`
    - [x] Determine aggregate state for the pair (most severe state across all files: `conflict > error > pending > synced`)
    - [x] Build `SyncPairStatus` object
  - [x] **Human output** (AC: 1, 2): `id: local ↔ remote [state] last sync: TS|never`
  - [x] **JSON output** (AC: 3): `{ "ok": true, "data": { "pairs": [...], "last_sync": ISO | null } }`
    - [x] Each pair: `{ "id": string, "local": string, "remote": string, "state": string, "last_sync_mtime": string | null }`
    - [x] `last_sync`: the most recent `last_sync_mtime` across all pairs, or `null`
  - [x] Close `StateDB` after queries complete
- [x] Write unit tests in `src/commands/status.test.ts` (AC: 6)
  - [x] Test: never-synced pair → state `pending`, last sync `never`
  - [x] Test: mixed states across pairs
  - [x] Test: JSON output matches schema exactly
  - [x] Test: missing config → exit 2
  - [x] Mock `StateDB` and `loadConfig`

## Dev Notes

- **NO NETWORK CALLS** (NFR2): `status` reads only from `StateDB`. Do NOT instantiate `DriveClient` or call `getSessionToken()`. Status must return in 2 seconds locally. [Source: epics.md#Story 5.1]
- **No auth required**: `status` does not need a session token — it reads local state only.
- **`StateDB.getLastSync(syncPairId)`** returns the most recent mtime for that pair (Story 1.5). For a never-synced pair, returns `null`.
- **Aggregate pair state logic**: Query `stateDb.getAll(pair.id)` for all file records under a pair. State priority: `conflict > error > pending > synced`. If no records exist → `pending`.
- **`last_sync` in JSON output**: The overall most recent timestamp across ALL pairs. Find the max `last_sync_mtime` across all pairs.
- **Human output format**: Keep it readable — align columns. Pairs side-by-side `local ↔ remote`. State in brackets. Last sync as ISO timestamp or `never`.
- **`SyncPairStatus` type** (from `src/types.ts`, Story 1.2): Use it for the pair data structure.
- **Config must be loaded first** — `ConfigError` → exit 2. The pair IDs come from config.
- **`StateDB.init()` still creates the DB if it doesn't exist** — that's fine. On first run, all queries return `null` / empty.

### Project Structure Notes

- `src/commands/status.ts` — replaces stub
- Only deps: `loadConfig()`, `StateDB` — no `DriveClient`, no `getSessionToken()`
- `src/commands/status.test.ts` — co-located

### References

- NFR2: status returns in 2s, no network [Source: epics.md#NonFunctional Requirements]
- FR15–FR16, FR21: sync state + timestamps + JSON [Source: epics.md#Functional Requirements]
- JSON output schema for status [Source: architecture.md#Format Patterns]
- `SyncPairStatus` type [Source: Story 1.2]
- `StateDB.getLastSync()` [Source: Story 1.5]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- 2026-04-02: Story 5.1 implemented — status command reads config+StateDB only (no network), aggregates pair state with conflict>error>pending>synced priority, human+JSON output, ConfigError→exit 2, StateDB closed in finally.
- 11 unit tests: never-synced, synced, conflict state, mixed pairs, JSON schema, ConfigError→exit 2, JSON error mode.

### File List

- `src/commands/status.ts` (replaced stub)
- `src/commands/status.test.ts` (new)
