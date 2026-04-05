# Story 1.3: Output Infrastructure (Human + JSON)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a shared output module that formats all command results as human-readable or structured JSON,
so that every command produces consistent output without duplicating formatting logic and the `--json` contract is enforced from day one.

## Acceptance Criteria

1. **Given** `src/core/output.ts` exists and `--json` flag is active, **When** `formatSuccess(data, { json: true })` is called, **Then** it writes `{ "ok": true, "data": { ... } }` to stdout.
2. **Given** an error condition and `--json` flag, **When** `formatError(err, { json: true })` is called, **Then** it writes `{ "ok": false, "error": { "code": "...", "message": "..." } }` to stderr.
3. **Given** no `--json` flag, **When** `formatSuccess` is called with a string message, **Then** it writes human-readable output to stdout with no JSON wrapper.
4. **Given** an error and no `--json` flag, **When** `formatError` is called, **Then** it writes `error: CODE — message` to stderr.
5. **Given** a progress callback `onProgress(msg)` is passed to a core function, **When** invoked in human mode, **Then** it writes `[command] msg` to stdout. **And** in JSON mode it is a no-op.
6. **Given** `bun test` is run, **Then** all output formatter unit tests pass.

## Tasks / Subtasks

- [x] Create `src/core/output.ts` (AC: 1, 2, 3, 4, 5)
  - [x] Define `OutputOptions` type: `{ json?: boolean }`
  - [x] Implement `formatSuccess(data: unknown, opts: OutputOptions): void`
    - [x] JSON mode: `process.stdout.write(JSON.stringify({ ok: true, data }) + '\n')`
    - [x] Human mode: `process.stdout.write(String(data) + '\n')`
  - [x] Implement `formatError(err: unknown, opts: OutputOptions): void`
    - [x] JSON mode: write `{ ok: false, error: { code, message } }` to stderr
    - [x] Human mode: write `error: CODE — message` to stderr
    - [x] Extract `code` from `ProtonDriveError` instances; use `'UNKNOWN'` for plain errors
  - [x] Implement `makeProgressCallback(prefix: string, opts: OutputOptions): (msg: string) => void`
    - [x] Human mode: returns `(msg) => process.stdout.write('[' + prefix + '] ' + msg + '\n')`
    - [x] JSON mode: returns no-op `() => {}`
- [x] Add `--json` global option to Commander in `src/cli.ts`
  - [x] Add `.option('--json', 'Machine-readable JSON output')` to root program
  - [x] Ensure `opts.json` is passed down to command actions
- [x] Write unit tests in `src/core/output.test.ts` (AC: 6)
  - [x] Test `formatSuccess` with `json: true` — assert stdout contains `{"ok":true,"data":...}`
  - [x] Test `formatSuccess` with `json: false` — assert stdout is plain string
  - [x] Test `formatError` with `json: true` — assert stderr contains `{"ok":false,"error":...}`
  - [x] Test `formatError` with `json: false` — assert stderr contains `error: CODE — message`
  - [x] Test `makeProgressCallback` human mode writes `[prefix] msg`
  - [x] Test `makeProgressCallback` JSON mode is a no-op
  - [x] Run `bun test src/core/output.test.ts`

## Dev Notes

- **JSON output schema is a public contract** — never deviate from `{ ok: true, data: {...} }` / `{ ok: false, error: { code, message } }`. This wrapper is used by ALL commands. [Source: architecture.md#JSON Output Schema]
- **`ok` field MUST always be present** — agents must never omit it, even for empty success responses.
- **stdout vs stderr split** (FR18): success output → stdout; errors → stderr. This is enforced in `output.ts`.
- **No `console.log` in `src/core/`** — use `process.stdout.write()` in this module only. All other core modules receive an `onProgress` callback injected by the command layer.
- **Human output format**:
  - Progress: `[sync] Uploading Documents/notes.md...`
  - Errors: `error: AUTH_FAILED — invalid credentials`
- **JSON mode suppresses progress** — in JSON mode, `makeProgressCallback` returns a no-op so no partial output appears before the final result.
- **Error code extraction**: `err instanceof ProtonDriveError ? err.code : 'UNKNOWN'`
- **Import boundary**: `src/core/output.ts` imports from `src/errors.ts` — this is allowed. It must NOT import from `src/commands/` or `src/sdk/`.
- **Test approach**: Use Bun's built-in `mock` to spy on `process.stdout.write` and `process.stderr.write`.

### Project Structure Notes

- `src/core/output.ts` is the only place that writes to stdout/stderr in the core layer.
- All command files in `src/commands/` import `formatSuccess`, `formatError`, `makeProgressCallback` from here.
- Co-locate tests at `src/core/output.test.ts`.

### References

- JSON output schema contract [Source: architecture.md#Format Patterns]
- stdout/stderr separation (FR18) [Source: epics.md#Requirements Inventory]
- Progress reporting via callback injection [Source: architecture.md#Progress Reporting]
- Human output format [Source: architecture.md#Human Output Format]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- `src/core/output.ts`: `OutputOptions`, `formatSuccess`, `formatError`, `makeProgressCallback` — all enforcing the JSON contract and stdout/stderr split.
- `src/cli.ts`: added `--json` global option via `.option("--json", ...)`.
- 11 unit tests in `src/core/output.test.ts` covering all output modes; all 39 tests pass.

### File List

- `src/core/output.ts` (new)
- `src/core/output.test.ts` (new)
- `src/cli.ts` (modified — added --json option)

### Review Findings

- [x] [Review][Patch] `cli.ts` top-level catch block uses `console.error()` directly instead of `formatError()` — fixed: catch block now calls `formatError(err, { json: jsonMode })` with `--json` pre-parsed from argv [src/cli.ts]
- [x] [Review][Patch] `formatSuccess` human mode calls `String(data)` — fixed: strings pass through directly; non-strings use `JSON.stringify(data, null, 2)` for pretty-printed output [src/core/output.ts]

### Change Log

- 2026-04-02: Story 1.3 implemented — output infrastructure with JSON contract, human mode, progress callbacks.
