# Story 3.3: `download` Command

Status: done

## Story

As a user,
I want to run `protondrive download <remote> <local>` to retrieve a file or directory from ProtonDrive,
so that I can pull encrypted files to my local machine from the command line.

## Tasks / Subtasks

- [x] Implement `src/commands/download.ts` (AC: 1, 2, 3, 4, 5, 6)
  - [x] Replace stub from Story 1.2
  - [x] Atomic download: `<local>.protondrive-tmp` → `fs.renameSync` on success; unlink on failure
  - [x] `getSessionToken()` + `DriveClient`
  - [x] JSON output: `{ "ok": true, "data": { "transferred": N, "path": local } }`
  - [x] Error handling: NO_SESSION, NETWORK_ERROR, REMOTE_NOT_FOUND

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### File List
- `src/commands/download.ts` (modified — full implementation)
- `src/commands/download.test.ts` (new)

### Change Log
- 2026-04-02: Story 3.3 implemented — download command with atomic write pattern (temp + rename).

### Review Findings

- [x] [Review][Patch] Directory download flattens subdirectory structure — `path.basename(item.remotePath)` discards subdirectory path; files with identical base names overwrite each other silently [src/commands/download.ts:58]
- [x] [Review][Patch] Error re-wrapping uses fragile `.message.includes("not found")` — case-sensitive string match; SDK may use different phrasing; unrelated errors matching the substring get mis-classified as REMOTE_NOT_FOUND [src/commands/download.ts:72-78]
- [x] [Review][Patch] Missing test for REMOTE_NOT_FOUND error case — AC requires REMOTE_NOT_FOUND handling; no test exercises this path [src/commands/download.test.ts]
- [x] [Review][Patch] test monkey-patch of process.stdout/stderr occurs before try block — same issue as 3-2; finally may not restore if sync code throws before try [src/commands/download.test.ts:37-40]
