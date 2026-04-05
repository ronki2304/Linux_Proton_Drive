# Story 3.2: `upload` Command

Status: done

## Story

As a user,
I want to run `protondrive upload <local> <remote>` to transfer a file or directory to ProtonDrive,
so that I can move files to my encrypted drive from the command line without a browser.

## Tasks / Subtasks

- [x] Implement `src/commands/upload.ts` (AC: 1, 2, 3, 4, 5, 6)
  - [x] Replace stub from Story 1.2
  - [x] `getSessionToken()` for auth, `DriveClient` for upload
  - [x] Single file and recursive directory upload
  - [x] JSON output: `{ "ok": true, "data": { "transferred": N, "path": remote } }`
  - [x] Error handling: FILE_NOT_FOUND, NO_SESSION, NETWORK_ERROR
- [x] Tests in `src/commands/upload.test.ts`
  - [x] Single file upload success (human + JSON)
  - [x] Directory recursive upload (3 files)
  - [x] Local path not found → exit 1
  - [x] No session → exit 1
  - [x] Network failure → exit 1

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### File List
- `src/commands/upload.ts` (modified — full implementation)
- `src/commands/upload.test.ts` (new)

### Change Log
- 2026-04-02: Story 3.2 implemented — upload command with single file and recursive directory support.

### Review Findings

- [x] [Review][Patch] collectFiles fs.statSync TOCTOU — file deleted between readdirSync and statSync throws uncaught ENOENT, bypasses formatError, exposes raw OS error to user [src/commands/upload.ts:15]
- [x] [Review][Patch] test monkey-patch of process.stdout/stderr occurs before try block — if assignment or sync code throws before try, finally never runs and write functions remain patched for all subsequent tests [src/commands/upload.test.ts:19-22]
