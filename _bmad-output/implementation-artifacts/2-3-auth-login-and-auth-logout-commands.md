# Story 2.3: `auth login` and `auth logout` Commands

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want to run `protondrive auth login` once to authenticate and `protondrive auth logout` to revoke my session,
so that all subsequent commands run headlessly using my cached token and I can cleanly end sessions.

## Acceptance Criteria

1. **Given** valid Proton credentials are entered interactively, **When** `protondrive auth login` is run, **Then** SRP authentication completes, the session token is stored via `CredentialStore`, and a success message is written to stdout.
2. **Given** `protondrive auth login` succeeds, **When** any subsequent command is run, **Then** it retrieves the cached token from `CredentialStore` without prompting the user.
3. **Given** no TTY is attached (cron/CI context), **When** any command other than `auth login` is run, **Then** it runs headlessly using the cached token without requiring interactive input.
4. **Given** `protondrive auth login` is run with `--json`, **Then** on success it outputs `{ "ok": true, "data": {} }` to stdout with no token in the output.
5. **Given** `protondrive auth logout` is run with a valid token cached, **Then** the token is deleted from `CredentialStore` and a success message is written to stdout.
6. **Given** `protondrive auth logout` is run when no token is cached, **Then** it exits with code 0 and a message indicating no active session.
7. **Given** `protondrive auth login` is run when a 2FA account is detected, **Then** it exits with code 1 and the `TWO_FACTOR_REQUIRED` error message on stderr.

## Tasks / Subtasks

- [x] Implement `src/commands/auth-login.ts` (AC: 1, 2, 3, 4, 7)
  - [x] Interactive username/password prompts via `readline`
  - [x] Password echo suppression on TTY
  - [x] Call `srp.authenticate()`, store `accessToken` under `session` key
  - [x] JSON output: `{ "ok": true, "data": {} }` — no token in output
  - [x] 2FA and other errors → formatError + exit 1
- [x] Implement `src/commands/auth-logout.ts` (AC: 5, 6)
  - [x] No-session path: outputs "No active session." and exits 0
  - [x] Session present: deletes and outputs "Logged out successfully."
- [x] Implement `getSessionToken()` helper in `src/auth/credentials.ts` (AC: 2, 3)
  - [x] Throws `AuthError` NO_SESSION if no cached token
- [x] Write unit tests
  - [x] `src/commands/auth-login.test.ts`: output contract, no-token guarantee, 2FA error format
  - [x] `src/commands/auth-logout.test.ts`: no-session / logout success, JSON mode

## Dev Notes

- `auth login` only command requiring TTY interaction. All others are headless.
- Token never in JSON output — `data: {}` on success.
- `getSessionToken()` pattern established — all subsequent commands (upload, download, sync, status) use this.
- `auth logout` does NOT call Proton API to revoke server-side — v1 limitation.

### File List

- `src/commands/auth-login.ts` (modified — full implementation)
- `src/commands/auth-logout.ts` (modified — full implementation)
- `src/auth/credentials.ts` (modified — added getSessionToken())
- `src/commands/auth-login.test.ts` (new)
- `src/commands/auth-logout.test.ts` (new)

### Change Log

- 2026-04-02: Story 2.3 implemented — auth login/logout commands, getSessionToken helper, tests.

### Review Findings

- [x] [Review][Patch] `promptPassword` creates a conflicting readline interface — fixed: `rl` object removed; now uses only raw stdin data listener with proper cleanup [src/commands/auth-login.ts]
- [x] [Review][Patch] `promptPassword` hangs on stdin EOF without newline — fixed: `stdin.once("end", ...)` handler added, rejects with descriptive error [src/commands/auth-login.ts]
- [x] [Review][Patch] `promptPassword` unhandled stdin error event — fixed: `stdin.once("error", reject)` added [src/commands/auth-login.ts]
- [x] [Review][Patch] `promptPassword` terminal raw mode not restored on error — fixed: `cleanup(restoreRaw)` helper restores raw mode in all exit paths [src/commands/auth-login.ts]
