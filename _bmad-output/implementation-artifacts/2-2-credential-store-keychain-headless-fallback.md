# Story 2.2: Credential Store (Keychain + Headless Fallback)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want my session token stored securely in the OS keychain with an automatic fallback for headless servers,
so that my credentials are never on disk in plaintext whether I'm on a desktop or a server.

## Acceptance Criteria

1. **Given** `src/auth/credentials.ts` exports a `CredentialStore` interface, **Then** it defines `get(key): Promise<string | null>`, `set(key, value): Promise<void>`, and `delete(key): Promise<void>`.
2. **Given** a desktop environment with GNOME Keyring or KWallet available, **When** `CredentialStore.set('protondrive', token)` is called, **Then** the token is stored in the OS keychain via `KeyringStore`.
3. **Given** no keychain daemon is available (headless server), **When** `CredentialStore.set('protondrive', token)` is called, **Then** it falls back to `FileStore` writing to `$XDG_DATA_HOME/protondrive/credentials.{key}` with permissions `0600`.
4. **Given** the fallback credentials file, **When** it is created, **Then** parent directories are created with appropriate permissions if they do not exist.
5. **Given** `CredentialStore.get('protondrive')` is called when no token has been stored, **Then** it returns `null` without error.
6. **Given** `bun test` is run, **Then** credential store unit tests pass for both `KeyringStore` and `FileStore` paths.

## Tasks / Subtasks

- [x] Create `src/auth/credentials.ts` — interface + runtime selector (AC: 1)
  - [x] Define `CredentialStore` interface: `get`, `set`, `delete`
  - [x] Implement `createCredentialStore()` factory with probe → fallback to `FileStore`
- [x] Create `src/auth/keyring-store.ts` — OS keychain via `@napi-rs/keyring` (AC: 2)
  - [x] Only file importing `@napi-rs/keyring`
  - [x] Implements `CredentialStore`
  - [x] `probe()` method to detect daemon availability
- [x] Create `src/auth/file-store.ts` — headless file fallback (AC: 3, 4)
  - [x] `$XDG_DATA_HOME/protondrive/credentials.{key}`
  - [x] `set`: write with mode `0o600`; creates parent dirs
  - [x] `get`: read or return null
  - [x] `delete`: unlink silently
- [x] Write unit tests (AC: 6)
  - [x] `src/auth/keyring-store.test.ts`: contract tests via test double
  - [x] `src/auth/file-store.test.ts`: temp dir, get/set/delete, 0600 perms, null on missing
  - [x] `src/auth/credentials.test.ts`: factory fallback logic tests

## Dev Notes

- Decision from Story 1.1: `@napi-rs/keyring` adopted (bundles cleanly). No `dbus-next` needed.
- `KeyringStore` probe: calls `getPassword` on `__probe__` key — throws if daemon unavailable, caught by factory.
- File per key: `credentials.session`, `credentials.refresh` — separate files for each key name.
- Token never logged in any path.

### File List

- `src/auth/credentials.ts` (new)
- `src/auth/keyring-store.ts` (new)
- `src/auth/file-store.ts` (new)
- `src/auth/keyring-store.test.ts` (new)
- `src/auth/file-store.test.ts` (new)
- `src/auth/credentials.test.ts` (new)

### Change Log

- 2026-04-02: Story 2.2 implemented — keyring + file-store credential abstraction with 0600 fallback.

### Review Findings

- [x] [Review][Patch] `FileStore`: key parameter not sanitized against path traversal — fixed: `validateKey()` function added, rejects keys not matching `^[a-zA-Z0-9_-]+$` [src/auth/file-store.ts]
- [x] [Review][Patch] `FileStore` uses `node:fs` sync calls — fixed: `get()` now uses `Bun.file().text()`; `writeFileSync` retained for `set()` to preserve `0o600` mode (no Bun.write mode option) [src/auth/file-store.ts]
- [x] [Review][Defer] `createCredentialStore`: if FileStore constructor also throws (no HOME), error is uncaught at call site [src/auth/credentials.ts:11-19] — deferred, pre-existing; requires HOME-less environment, extremely unlikely
- [x] [Review][Defer] Only `accessToken` stored; `refreshToken` and `uid` discarded — deferred, pre-existing; intentional v1 design per Story 2.3 task spec ("store accessToken under session key")
