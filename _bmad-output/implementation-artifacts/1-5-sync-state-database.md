# Story 1.5: Sync State Database

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a bun:sqlite-backed state store that persists per-file sync metadata,
so that delta detection, idempotent sync, and status queries have a reliable local source of truth.

## Acceptance Criteria

1. **Given** `src/core/state-db.ts` exists, **When** `StateDB.init()` is called, **Then** it creates `~/.local/share/protondrive/state.db` if it does not exist.
2. **Given** `XDG_DATA_HOME` is set, **When** `StateDB.init()` is called, **Then** it resolves the DB path to `$XDG_DATA_HOME/protondrive/state.db`.
3. **Given** the DB is initialized, **When** the schema is applied, **Then** a `sync_state` table exists with columns: `sync_pair_id TEXT`, `local_path TEXT`, `remote_path TEXT`, `last_sync_mtime TEXT` (ISO 8601), `last_sync_hash TEXT` (SHA-256 hex), `state TEXT`.
4. **Given** a file record is written via `StateDB.upsert()`, **When** `StateDB.get(localPath)` is called for the same path, **Then** the stored record is returned with all fields intact.
5. **Given** a sync pair ID, **When** `StateDB.getLastSync(syncPairId)` is called, **Then** it returns the most recent `last_sync_mtime` for that pair, or `null` if never synced.
6. **Given** `bun test` is run, **Then** all state DB unit tests pass.

## Tasks / Subtasks

- [x] Create `src/core/state-db.ts` (AC: 1, 2, 3, 4, 5)
  - [x] Implement `getDbPath(): string`
    - [x] `${process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share')}/protondrive/state.db`
  - [x] Implement `StateDB` class with:
    - [x] `static async init(): Promise<StateDB>` — creates parent dirs, opens DB, runs schema migration
    - [x] Schema DDL with CHECK constraint on state values
    - [x] `upsert(record: SyncStateRecord): void` — INSERT OR REPLACE
    - [x] `get(localPath: string): SyncStateRecord | null`
    - [x] `getLastSync(syncPairId: string): string | null` — MAX(last_sync_mtime) for pair
    - [x] `getAll(syncPairId: string): SyncStateRecord[]`
    - [x] `close(): void`
- [x] Define `SyncStateRecord` type in `src/types.ts` (if not already covered by `SyncState`)
  - [x] Added as type alias: `export type SyncStateRecord = SyncState`
- [x] Write unit tests in `src/core/state-db.test.ts` (AC: 6)
  - [x] Test: `init()` creates DB file at resolved path
  - [x] Test: `XDG_DATA_HOME` override resolves correct DB path
  - [x] Test: `upsert` + `get` round-trip preserves all fields
  - [x] Test: `getLastSync` returns `null` for never-synced pair
  - [x] Test: `getLastSync` returns most recent mtime after multiple upserts
  - [x] Use temp-file DB in tests (not `~/.local/share/`)

## Dev Notes

- **bun:sqlite** is Bun's built-in SQLite driver — import with `import { Database } from 'bun:sqlite'`. Do NOT add `better-sqlite3`, `sqlite3`, or any other SQLite npm package. [Source: architecture.md#Data Architecture]
- **XDG_DATA_HOME compliance** (mandatory): DB path must use `${XDG_DATA_HOME ?? '~/.local/share'}/protondrive/state.db`. [Source: architecture.md#Additional Requirements]
- **SQLite column naming**: ALL columns use `snake_case` (e.g., `sync_pair_id`, `last_sync_mtime`). Never use camelCase for SQLite columns. [Source: architecture.md#Naming Patterns]
- **State values** (exact): `'synced' | 'conflict' | 'error' | 'pending'` — enforced by CHECK constraint in schema.
- **Timestamps**: `last_sync_mtime` stored as ISO 8601 TEXT (e.g., `2026-04-01T14:30:00.000Z`). NOT as Unix epoch integers.
- **Parent directory creation**: Use `fs.mkdirSync(dir, { recursive: true })` before opening DB — the `~/.local/share/protondrive/` directory may not exist on first run.

### Project Structure Notes

- File: `src/core/state-db.ts`
- Test: `src/core/state-db.test.ts` (co-located)
- DB location: `~/.local/share/protondrive/state.db` (XDG_DATA_HOME aware)
- No ORM — raw `bun:sqlite` SQL only

### References

- `bun:sqlite` for sync state (zero extra dependency) [Source: architecture.md#Data Architecture]
- XDG_DATA_HOME compliance [Source: architecture.md#Additional Requirements]
- Snake_case column naming [Source: architecture.md#Naming Patterns]
- State values: synced|conflict|error|pending [Source: architecture.md#Data Architecture]
- Schema fields [Source: epics.md#Story 1.5 Acceptance Criteria]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- `src/core/state-db.ts`: `StateDB` class with `init()`, `upsert()`, `get()`, `getLastSync()`, `getAll()`, `close()`; XDG_DATA_HOME-aware `getDbPath()`; schema with CHECK constraint on state.
- `src/types.ts`: added `SyncStateRecord = SyncState` type alias (fields were identical).
- 11 unit tests in `src/core/state-db.test.ts` using temp-file DB; all 62 tests pass.

### File List

- `src/core/state-db.ts` (new)
- `src/core/state-db.test.ts` (new)
- `src/types.ts` (modified — added SyncStateRecord alias)

### Review Findings

- [x] [Review][Patch] `StateDB.init()` errors were uncaught — fixed: each of mkdirSync, new Database(), and db.run(SCHEMA) now individually try/caught with contextual error messages including the DB path [src/core/state-db.ts]

### Change Log

- 2026-04-02: Story 1.5 implemented — bun:sqlite state DB with XDG compliance, schema, upsert/get/getLastSync/getAll.
