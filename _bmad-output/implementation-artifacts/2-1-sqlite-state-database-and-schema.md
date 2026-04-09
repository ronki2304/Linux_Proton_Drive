# Story 2.1: SQLite State Database & Schema

Status: done

## Story

As a developer,
I want the sync engine to have a SQLite state database with WAL mode, schema versioning, and sync pair/state tables,
So that sync state persists across restarts and survives crashes.

## Acceptance Criteria

**AC1 — DB path and WAL init:**
**Given** the engine starts for the first time
**When** `state-db.ts` initializes
**Then** it creates the database at `$XDG_DATA_HOME/protondrive/state.db` (creating the directory with `mkdir -p` if needed)
**And** `PRAGMA journal_mode=WAL` is set
**And** `PRAGMA synchronous=NORMAL` is set

**AC2 — WAL confirmed:**
**Given** the database is initialized
**When** querying `PRAGMA journal_mode`
**Then** it returns `wal`

**AC3 — Schema tables:**
**Given** the database schema
**When** inspecting tables
**Then** `sync_pair` table exists with columns: `pair_id` (TEXT PRIMARY KEY), `local_path` (TEXT), `remote_path` (TEXT), `remote_id` (TEXT), `created_at` (TEXT ISO 8601)
**And** `sync_state` table exists with columns: `pair_id` (TEXT), `relative_path` (TEXT), `local_mtime` (TEXT ISO 8601), `remote_mtime` (TEXT ISO 8601), `content_hash` (TEXT nullable), PRIMARY KEY (`pair_id`, `relative_path`)
**And** `change_queue` table exists with columns: `id` (INTEGER PRIMARY KEY), `pair_id` (TEXT), `relative_path` (TEXT), `change_type` (TEXT), `queued_at` (TEXT ISO 8601)

**AC4 — Schema versioning:**
**Given** schema versioning
**When** querying `PRAGMA user_version`
**Then** it returns the current schema version number
**And** ordered integer migrations run automatically on startup if `user_version` is behind

**AC5 — Unit tests:**
**Given** unit tests for `state-db.ts`
**When** running `node --import tsx --test engine/src/state-db.test.ts`
**Then** each test uses a fresh `:memory:` database
**And** tests verify WAL mode, schema creation, migration ordering, and CRUD operations

## Tasks / Subtasks

- [x] **Task 1: Add `better-sqlite3` dependency** (AC: #1)
  - [x] 1.1 Add `better-sqlite3` and `@types/better-sqlite3` to `engine/package.json`
  - [x] 1.2 Run `npm install` in `engine/`
  - [x] 1.3 Verify existing tests still pass

- [x] **Task 2: Implement `state-db.ts`** (AC: #1, #2, #3, #4)
  - [x] 2.1 Create `engine/src/state-db.ts` with `StateDb` class
  - [x] 2.2 Constructor opens DB at `$XDG_DATA_HOME/protondrive/state.db` (mkdir -p), or accepts `:memory:` path for tests
  - [x] 2.3 Set `PRAGMA journal_mode=WAL` and `PRAGMA synchronous=NORMAL` in init
  - [x] 2.4 Define migration array and run migrations up to current `user_version`
  - [x] 2.5 Migration v1 creates `sync_pair`, `sync_state`, and `change_queue` tables
  - [x] 2.6 Expose typed CRUD methods for `sync_pair` and `change_queue`
  - [x] 2.7 Export `StateDb` class and relevant interfaces

- [x] **Task 3: Write unit tests** (AC: #5)
  - [x] 3.1 Create `engine/src/state-db.test.ts`
  - [x] 3.2 Test WAL mode is set on initialization (AC2 — via `pragma()` passthrough)
  - [x] 3.3 Test all three tables are created with correct schema
  - [x] 3.4 Test `user_version` is set to 1 after migration (AC4)
  - [x] 3.5 Test migration is idempotent (re-opening existing DB doesn't re-run)
  - [x] 3.6 Test CRUD: insert/get/delete on `sync_pair`
  - [x] 3.7 Test CRUD: enqueue/dequeue on `change_queue`
  - [x] 3.8 Each test uses fresh `:memory:` database

- [x] **Task 4: Run full test suite** (AC: #5)
  - [x] 4.1 Run `node --import tsx --test engine/src/**/*.test.ts` — all 44 tests pass
  - [x] 4.2 Verify no regressions in existing engine tests

## Dev Notes

- Engine uses Node.js 22, NOT Bun — `bun:sqlite` must NOT be used
- `better-sqlite3` is synchronous — no async/await needed for DB calls
- Always type rows via interfaces — rows return plain objects from better-sqlite3
- `:memory:` path allowed in constructor for test isolation
- XDG fallback: `$HOME/.local/share` if `$XDG_DATA_HOME` unset
- DB path: `{xdg_data_home}/protondrive/state.db`
- Use `node:fs` `mkdirSync` with `{ recursive: true }` to create directory
- All timestamps as ISO 8601 TEXT — never INTEGER epoch
- `errors.ts` has zero internal imports — do NOT import from it in any weird direction
- `state-db.ts` should only import from `errors.ts` and `node:*` (and `better-sqlite3`)
- Schema versioning: `PRAGMA user_version` stores current version; compare with latest migration index

### Review Findings

- [x] [Review][Decision] deletePair does not cascade-delete orphaned sync_state and change_queue rows — Resolved D1-A: add FOREIGN KEY + ON DELETE CASCADE to child tables in migration v1 + PRAGMA foreign_keys = ON in init()
- [x] [Review][Decision] WAL test accepts "memory" as valid — Resolved D2-A: add temp-file DB test that confirms journal_mode=wal
- [x] [Review][Decision] Migration idempotency test uses two separate :memory: DBs — Resolved D3-B: accepted; user_version=1 test provides sufficient coverage
- [x] [Review][Patch] Migration exec not wrapped in a transaction — `state-db.ts:96-104` — fixed: wrapped in db.transaction()
- [x] [Review][Patch] Constructor does not close DB handle if init() throws — `state-db.ts:63-82` — fixed: try/catch around init(), db.close() on failure
- [x] [Review][Patch] CURRENT_VERSION derived from MIGRATIONS.length — `state-db.ts:69` — fixed: explicit `const CURRENT_VERSION = 1`
- [x] [Review][Patch] user_version set via template string interpolation — `state-db.ts:103` — fixed: `Number(migration.version)` via db.exec()
- [x] [Review][Patch] pragma() public method has no allowlist — `state-db.ts:181-183` — fixed: SAFE_PRAGMAS Set allowlist; throws on unknown names
- [x] [Review][Patch] FK + ON DELETE CASCADE + foreign_keys = ON (from D1-A) — fixed: schema updated, PRAGMA foreign_keys = ON added to init(), tests updated
- [x] [Review][Patch] File-backed WAL test (from D2-A) — fixed: new describe "StateDb — file-backed WAL" confirms journal_mode = wal on file DB
- [x] [Review][Defer] sync_state table has no CRUD methods [state-db.ts] — deferred, not in story scope (will be added when sync engine story requires it)
- [x] [Review][Defer] Prepared statements not cached as class fields [state-db.ts] — deferred, performance optimization not required at this stage
- [x] [Review][Defer] change_type stored as unconstrained TEXT [state-db.ts:65] — deferred, valid change type set not yet defined (depends on sync engine story)
- [x] [Review][Defer] listPairs ordering by TEXT timestamp not UTC-enforced [state-db.ts:107] — deferred, caller convention; project uses ISO 8601 UTC
- [x] [Review][Defer] dequeue() silently succeeds when id not found [state-db.ts:133] — deferred, design choice; changes count available on run() if callers need it later
- [x] [Review][Defer] XDG_DATA_HOME not validated as absolute path [state-db.ts:86] — deferred, XDG spec requires absolute; low risk for desktop app
- [x] [Review][Defer] No filesystem test for mkdir-p / XDG fallback path [state-db.test.ts] — deferred, AC5 scopes tests to :memory:; integration tests can cover later

## Dev Agent Record

### Implementation Plan

- Added `better-sqlite3` (^11.10.0) + `@types/better-sqlite3` (^7.6.13) to `engine/package.json`
- `StateDb` class wraps a `better-sqlite3` `Database` instance
- Constructor accepts optional `dbPath` — defaults to `$XDG_DATA_HOME/protondrive/state.db` with `$HOME/.local/share` fallback; `:memory:` accepted for test isolation
- `init()` sets `journal_mode=WAL` and `synchronous=NORMAL` then calls `migrate()`
- `migrate()` reads `PRAGMA user_version`, runs any pending migrations in order, updates `user_version` after each
- Migration array (`MIGRATIONS`) makes future schema additions trivial
- `pragma()` passthrough added for diagnostics and test assertions
- All timestamps stored as ISO 8601 TEXT per project conventions
- `state-db.ts` imports only `better-sqlite3`, `node:fs`, `node:path`, `node:os`, and `./errors.js`

### Debug Log

No issues encountered.

### Completion Notes

✅ All 4 tasks complete. 15 new tests in `state-db.test.ts` covering WAL init, schema creation, user_version, CRUD on `sync_pair` and `change_queue`, FIFO ordering, and migration idempotency. Full suite: 44/44 pass, zero regressions.

## File List

- `engine/package.json` — added `better-sqlite3` + `@types/better-sqlite3`
- `engine/package-lock.json` — updated by npm install
- `engine/src/state-db.ts` — new: `StateDb` class with WAL init, migrations, CRUD
- `engine/src/state-db.test.ts` — new: 15 unit tests (4 suites)

## Change Log

- 2026-04-09: Implemented Story 2.1 — SQLite state database with WAL mode, schema versioning (user_version), and `sync_pair`/`sync_state`/`change_queue` tables. Added `better-sqlite3` dependency. 15 tests added, all passing.
