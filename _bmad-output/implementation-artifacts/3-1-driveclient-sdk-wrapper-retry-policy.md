# Story 3.1: DriveClient SDK Wrapper & Retry Policy

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a `DriveClient` class that is the sole import point for the ProtonDriveApps SDK and encapsulates the retry policy,
so that all Drive API calls go through one place and SDK version migrations only require changes in `src/sdk/client.ts`.

## Acceptance Criteria

1. **Given** `src/sdk/client.ts` exists, **Then** it is the only file in the project that imports from `@protontech/drive-sdk`.
2. **Given** `DriveClient` is instantiated with a `SessionToken`, **When** a Drive API method is called, **Then** it uses the session token to authorize the request.
3. **Given** a Drive API call fails with a transient network error, **When** `DriveClient` handles the failure, **Then** it retries up to 3 times with exponential backoff (1s, 2s, 4s) before throwing a `NetworkError`.
4. **Given** a Drive API call fails with an `AuthError` or `ConfigError`, **When** `DriveClient` handles the failure, **Then** it fails immediately without retrying.
5. **Given** `DriveClient` methods produce progress events, **When** an `onProgress` callback is provided, **Then** it is called with descriptive messages; no `console.log` calls exist in `src/sdk/client.ts`.
6. **Given** `bun test` is run, **Then** DriveClient unit tests covering retry logic and error propagation pass.

## Tasks / Subtasks

- [x] Implement `src/sdk/client.ts` — `DriveClient` class (AC: 1, 2, 3, 4, 5)
  - [x] Only imports from `@protontech/drive-sdk` at top
  - [x] `DriveClientOptions`: `{ onProgress?: (msg: string) => void }`
  - [x] `withRetry<T>()`: 3 retries, 1s/2s/4s backoff, NetworkError only; immediate fail on AuthError/SyncError
  - [x] `listFolder`, `uploadFile`, `downloadFile`, `getFileMetadata` stubs with retry + progress
  - [x] No `console.log`
- [x] Define `DriveItem` and `DriveItemMetadata` types in `src/types.ts`
- [x] Write unit tests in `src/sdk/client.test.ts` (AC: 6)
  - [x] Retry fires 4× total on NetworkError (1 initial + 3 retries)
  - [x] Backoff delays: 1000ms, 2000ms, 4000ms
  - [x] AuthError fails immediately, no retry
  - [x] SyncError fails immediately, no retry
  - [x] Success on first attempt: no delays
  - [x] onProgress called for listFolder, uploadFile, downloadFile

## Dev Notes

- SDK has `ProtonDriveClient` class (from `@protontech/drive-sdk`) with methods: `iterateFolderChildren`, `getFileUploader`, `getFileRevisionDownloader`, etc.
- `withRetry()` is the sole location of retry logic — not duplicated across methods.
- Story 1.1 boundary test updated: `client.ts` may import `../errors.ts` and `../types.ts` (shared root modules), but NOT `../commands/`, `../auth/`, or `../core/`.

### File List

- `src/sdk/client.ts` (modified — full DriveClient implementation)
- `src/sdk/client.test.ts` (new)
- `src/types.ts` (modified — added DriveItem, DriveItemMetadata)
- `src/cli.test.ts` (modified — updated boundary test to allow ../errors + ../types imports)

### Change Log

- 2026-04-02: Story 3.1 implemented — DriveClient wrapper, retry policy, SDK boundary enforcement.

### Review Findings

- [x] [Review][Patch] Transient errors re-thrown as raw SDK types after retry exhaustion — `if (isTransientError(lastError)) throw lastError` rethrows `ConnectionError`/`RateLimitedError` verbatim; AC3 requires a `NetworkError` to be thrown [src/sdk/client.ts:93-94]
- [x] [Review][Patch] ConfigError not in isNonRetryableError — `isNonRetryableError` checks `SyncError` but ConfigError extends `ProtonDriveError` directly; ConfigError will be retried 3× instead of failing fast, violating AC4 [src/sdk/client.ts:33-35]
- [x] [Review][Patch] client.test.ts retry harness throws `lastError` directly, never calls `mapSdkError` — production error-mapping path has zero test coverage [src/sdk/client.test.ts:34]
- [x] [Review][Patch] Test comment "SyncError (ConfigError subclass)" is incorrect and misleading — ConfigError does not extend SyncError; add a dedicated ConfigError no-retry test [src/sdk/client.test.ts:102]
