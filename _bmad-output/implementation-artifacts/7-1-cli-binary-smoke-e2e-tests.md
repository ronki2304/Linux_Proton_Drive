# Story 7.1: CLI Binary Smoke & E2E Tests

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a suite of e2e tests that spawn the compiled `dist/protondrive` binary and exercise all subcommands with expected responses,
so that CLI-layer regressions are caught before release without requiring live Proton credentials.

## Acceptance Criteria

1. **Given** `dist/protondrive` binary is compiled, **When** `bun test src/__e2e__/` is run, **Then** tests spawn the binary as a child process and assert stdout, stderr, and exit codes.
2. **Given** `protondrive --help` is run via the binary, **Then** it exits 0 and stdout contains all subcommand names (`auth`, `sync`, `upload`, `download`, `status`).
3. **Given** `protondrive sync` is run with a missing config file, **Then** it exits 2 and stderr contains a human-readable config error (not a stack trace).
4. **Given** `protondrive sync` is run with a valid config but no cached credentials, **Then** it exits 1 and stderr contains a readable auth error (not a crash/stack trace).
5. **Given** `protondrive status --json` is run with a valid config and no prior syncs, **Then** it exits 0 and stdout is valid JSON matching `{ ok: true, data: { pairs: [...] } }`.
6. **Given** `protondrive upload /nonexistent /remote` is run, **Then** it exits 1 and stderr contains a readable error message.
7. **Given** `bun test src/__e2e__/` is run, **Then** all smoke tests pass against the compiled binary (binary must be pre-built before running).

## Tasks / Subtasks

- [x] Create `src/__e2e__/` directory and `cli.e2e.test.ts` with all smoke tests (AC: 1, 2, 3, 4, 5, 6, 7)
  - [x] Add binary pre-flight check: skip all tests with a clear message if `dist/protondrive` does not exist (prevents confusing failures)
  - [x] Write helper `run(args, opts)` that calls `spawnSync(BINARY, args, { encoding: 'utf8', env: { ...process.env, ...opts.env } })`
  - [x] Write `beforeAll` that creates a temp dir and writes a valid config YAML fixture to `<tempDir>/config.yaml`; set `XDG_DATA_HOME` to `<tempDir>` for all spawns so state DB is isolated from the developer's real `~/.local/share/protondrive/state.db`
  - [x] Test: `--help` exits 0 and stdout contains `auth`, `sync`, `upload`, `download`, `status` (AC: 2)
  - [x] Test: `sync` with `--config /nonexistent/path` exits 2 and stderr matches `error: CONFIG_NOT_FOUND —` (no stack trace) (AC: 3)
  - [x] Test: `sync --config <validConfig>` with no stored credentials exits 1 and stderr matches `error: NO_SESSION —` (AC: 4)
  - [x] Test: `status --json --config <validConfig>` exits 0 and stdout parses as `{ ok: true, data: { pairs: [...], last_sync: null } }` (AC: 5)
  - [x] Test: `upload /nonexistent /remote` exits 1 and stderr contains `error:` prefix (readable, not stack trace) (AC: 6)
  - [x] Write `afterAll` that removes the temp dir created in `beforeAll`

## Dev Notes

### Critical Implementation Facts

**Binary location:** `dist/protondrive` (relative to project root). Must be pre-built via:
```bash
bun build --compile src/cli.ts --outfile dist/protondrive
```
Tests MUST skip (not fail) if binary does not exist — use a `beforeAll` guard with `existsSync`.

**Test file location:** `src/__e2e__/cli.e2e.test.ts` (architecture-mandated; co-located with source)
- E2e tests live in `src/__e2e__/` — NOT `tests/`, NOT `__tests__/`
- Run with: `bun test src/__e2e__/` (excluded from default `bun test`)

**Binary spawning pattern** — established in `src/cli.test.ts`:
```typescript
import { spawnSync } from "child_process";
const result = spawnSync(BINARY, args, { encoding: "utf8", env: { ...process.env, ...extraEnv } });
// result.status — exit code
// result.stdout — stdout string
// result.stderr — stderr string
```

### Test Isolation (Critical)

The `status` command opens `state.db` at `${XDG_DATA_HOME}/protondrive/state.db`. The `config` command resolves to `${XDG_CONFIG_HOME}/protondrive/config.yaml`. Set environment variables in every spawn to avoid touching the developer's real data:
- `XDG_DATA_HOME` → `<tempDir>` (isolates state DB)
- Pass config via `--config <tempDir>/config.yaml` flag (don't set `XDG_CONFIG_HOME`)

Use `os.mkdtemp()` or `fs.mkdtempSync(path.join(os.tmpdir(), 'protondrive-e2e-'))` for the temp dir. Clean up in `afterAll`.

### Valid Config Fixture

`status --json` (AC5) requires a valid config with at least one sync pair. The config YAML must pass all validation in `src/core/config.ts` (sync_pairs array, each pair has id/local/remote strings):

```yaml
sync_pairs:
  - id: test-pair
    local: /tmp/local
    remote: /test-remote
```

Write this to `<tempDir>/config.yaml` in `beforeAll`.

### Exit Code Mapping

From `src/cli.ts` and each command's `.action()` catch block:
- `0` — success
- `1` — `ProtonDriveError` (including `AuthError`, `SyncError`, `NetworkError`)
- `2` — `ConfigError` only

### Error Message Format

From `src/core/output.ts` `formatError()`:
```
error: <CODE> — <message>\n     (to stderr, human mode)
```
- Missing config → `error: CONFIG_NOT_FOUND — Config file not found: ...`
- No session → `error: NO_SESSION — No session found — run 'protondrive auth login' first.`
- File not found in upload → auth check runs FIRST in `upload.ts` (before file existence check), so `upload /nonexistent /remote` with no credentials exits 1 with `NO_SESSION` error (not `FILE_NOT_FOUND`)

### JSON Output Format

From `src/core/output.ts` `formatSuccess()`:
```json
{ "ok": true, "data": { ... } }
```
`status --json` data shape (from `src/commands/status.ts`):
```json
{
  "pairs": [{ "id": "...", "local": "...", "remote": "...", "state": "pending", "last_sync_mtime": null }],
  "last_sync": null
}
```
Empty state DB (no prior syncs) → `aggregateState([])` returns `"pending"`, `getLastSync()` returns `null`.

### Forbidden Patterns

- Do NOT call `process.exit()` or anything that terminates the test process
- Do NOT import from `src/` modules — e2e tests treat the binary as a black box
- Do NOT use real Proton credentials or make network calls
- Do NOT modify existing `src/cli.test.ts` — it tests project structure, not the binary behaviors covered here

### Project Structure Notes

- New directory: `src/__e2e__/` (create it)
- New file: `src/__e2e__/cli.e2e.test.ts`
- `src/cli.test.ts` already uses `spawnSync` for binary compilation — the e2e file MUST NOT duplicate those tests
- Binary `dist/protondrive` is gitignored (`dist/` in `.gitignore`); tests must build it or skip

### References

- E2e test location: `src/__e2e__/` [Source: architecture.md#Test File Location]
- Binary build command: `bun build --compile src/cli.ts --outfile dist/protondrive` [Source: architecture.md#Build Tooling]
- Exit code policy: 0/1/2 [Source: architecture.md#Error Handling]
- JSON output schema `{ ok, data/error }` [Source: architecture.md#JSON Output Schema]
- `spawnSync` binary spawn pattern [Source: src/cli.test.ts:57-65]
- `XDG_DATA_HOME` for state DB path [Source: src/core/state-db.ts:7-11]
- `--config` flag for config path override [Source: src/cli.ts:20, src/core/config.ts:42-43]
- `formatError` output format [Source: src/core/output.ts:17-28]
- Auth check before file check in upload [Source: src/commands/upload.ts:31-35]
- `aggregateState([])` returns `"pending"` [Source: src/commands/status.ts:17-22]

### Review Findings

- [x] [Review][Patch] Pre-flight test hard-fails instead of skipping when binary absent [`src/__e2e__/cli.e2e.test.ts:47`]
- [x] [Review][Patch] `tempDir` undefined when binary absent — `baseEnv()` returns `{XDG_DATA_HOME: undefined}` poisoning env [`src/__e2e__/cli.e2e.test.ts:24-28,41`]
- [x] [Review][Patch] `parsed!` non-null assertion after `.not.toThrow()` wrapper — parse failure leaves subsequent assertions unguarded [`src/__e2e__/cli.e2e.test.ts:85-99`]
- [x] [Review][Patch] Missing `timeout` on all `spawnSync` calls — binary can hang indefinitely in CI [`src/__e2e__/cli.e2e.test.ts:18-21`]
- [x] [Review][Patch] AC4 test sensitive to system keyring containing a live session — `XDG_DATA_HOME` isolation does not cover OS keychain [`src/__e2e__/cli.e2e.test.ts:75-82`]
- [x] [Review][Patch] `run()` signature uses flat `extraEnv` instead of spec-prescribed `opts` object pattern [`src/__e2e__/cli.e2e.test.ts:17`]
- [x] [Review][Patch] AC6 missing `--config` flag — exit path depends on default config resolution, non-deterministic [`src/__e2e__/cli.e2e.test.ts:113`]
- [x] [Review][Patch] AC6 test title "nonexistent local path" never exercises that path — misleading label [`src/__e2e__/cli.e2e.test.ts:102`]
- [x] [Review][Defer] `run()` spreads full `process.env` — could forward live credentials in developer envs [`src/__e2e__/cli.e2e.test.ts:18-21`] — deferred, pre-existing

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- 2026-04-05: Story 7.1 implemented. Created `src/__e2e__/cli.e2e.test.ts` with 6 smoke tests covering all 7 ACs. Binary pre-flight check skips suite if `dist/protondrive` absent. `XDG_DATA_HOME` isolation prevents DB pollution. Binary was stale at test time (compiled with earlier stubs) — rebuilt before green run. Pre-existing failure in `src/cli.test.ts` (`spawnSync("bun",...)` PATH issue from Story 1.1) confirmed unrelated to this story. All 6 new tests pass; 0 regressions introduced.

### File List

- `src/__e2e__/cli.e2e.test.ts` (new)
