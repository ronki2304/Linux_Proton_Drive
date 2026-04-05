# Story 4.1: Conflict Detection Logic

Status: done

## Tasks / Subtasks

- [x] Implement `src/core/conflict.ts`
  - [x] `detectConflict(localMtime, remoteMtime, lastSyncMtime): boolean` — true iff both sides changed
  - [x] `buildConflictCopyName(filename, date): string` — `filename.conflict-YYYY-MM-DD`
  - [x] `createConflictCopy(originalPath, date): ConflictRecord` — copyFileSync, returns record
- [x] Write unit tests in `src/core/conflict.test.ts`
  - [x] Both sides changed → true; one side → false; neither → false
  - [x] `buildConflictCopyName` with/without extension, existing conflict suffix, zero-padded dates
  - [x] `createConflictCopy` creates copy, does not modify original

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### File List
- `src/core/conflict.ts` (new)
- `src/core/conflict.test.ts` (new)

### Change Log
- 2026-04-02: Story 4.1 implemented — conflict detection and copy naming logic.

### Review Findings

- [x] [Review][Patch] buildConflictCopyName uses local-time date fields (getFullYear/getMonth/getDate) — sync-engine uses `new Date().toISOString().slice(0,10)` (UTC) for remote path; mismatch near midnight in non-UTC timezones corrupts StateDB path record [src/core/conflict.ts:14-17]
