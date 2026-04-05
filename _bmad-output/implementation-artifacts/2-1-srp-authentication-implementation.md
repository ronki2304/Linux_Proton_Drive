# Story 2.1: SRP Authentication Implementation

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want an SRP-B implementation that authenticates against Proton's auth API and returns a session token,
so that the auth login command has a cryptographically correct foundation that works against real Proton accounts.

## Acceptance Criteria

1. **Given** `src/auth/srp.ts` exists, **When** `srp.authenticate(username, password)` is called with valid Proton credentials, **Then** it returns a `SessionToken` without requiring user interaction beyond the initial call.
2. **Given** a user has 2FA enabled on their Proton account, **When** `srp.authenticate()` is called, **Then** it throws an `AuthError` with code `TWO_FACTOR_REQUIRED`. **And** the error message reads: `"2FA is not supported in v1 — disable 2FA on your Proton account to use this tool."` (does not hang).
3. **Given** invalid credentials, **When** `srp.authenticate()` is called, **Then** it throws an `AuthError` with code `AUTH_FAILED` and a clear message on stderr.
4. **Given** a network failure during authentication, **When** `srp.authenticate()` is called, **Then** it throws a `NetworkError` after the retry policy is exhausted.
5. **Given** `srp.ts` is implemented, **Then** no session token or intermediate SRP secrets appear in any log output, JSON output, or error messages.
6. **Given** `src/__integration__/auth.integration.test.ts` exists, **When** run with real Proton credentials (excluded from default `bun test`), **Then** it confirms `srp.authenticate()` succeeds against the live Proton auth endpoint.

## Tasks / Subtasks

- [x] Define `SessionToken` type in `src/types.ts`
  - [x] `type SessionToken = { accessToken: string; refreshToken: string; uid: string }`
- [x] Implement `src/auth/srp.ts` (AC: 1, 2, 3, 4, 5)
  - [x] Implement Proton auth flow (POST /auth/v4/info → SRP proof → POST /auth/v4)
  - [x] Handle 2FA challenge (Code 9001 or TwoFactor field) → throw AuthError TWO_FACTOR_REQUIRED
  - [x] Handle invalid credentials → throw AuthError AUTH_FAILED
  - [x] Handle network failures → throw NetworkError
  - [x] NEVER log accessToken, refreshToken, clientProof, or SRP intermediate values
- [x] Write unit tests in `src/auth/srp.test.ts`
  - [x] Test: 2FA Code 9001 → AuthError with TWO_FACTOR_REQUIRED and exact message
  - [x] Test: 2FA TwoFactor field → AuthError with TWO_FACTOR_REQUIRED
  - [x] Test: invalid credentials → AuthError AUTH_FAILED
  - [x] Test: network failure → NetworkError
  - [x] Mock HTTP calls — no live Proton API in unit tests
- [x] Create `src/__integration__/auth.integration.test.ts` (AC: 6)
  - [x] Read credentials from PROTON_USERNAME, PROTON_PASSWORD env vars
  - [x] Skip guard when env vars not set
  - [x] Assert authenticate() returns SessionToken with non-empty accessToken

## Dev Notes

- **NO SRP npm library** — Proton's SRP-B variant is non-standard. Implemented from scratch using BigInt arithmetic.
- **Reference implementations**: henrybear327/Proton-API-Bridge (Go), rclone SRP port
- **Proton API**: `POST /auth/v4/info` then `POST /auth/v4`
- **HTTP client**: `fetch` (Bun built-in) — no axios/node-fetch
- **bcryptjs added**: Required for Proton's password expansion (v3/v4) — `$2y$10$` salt format

### Project Structure Notes

- File: `src/auth/srp.ts`
- Test: `src/auth/srp.test.ts` (co-located)
- Integration test: `src/__integration__/auth.integration.test.ts`

### References

- SRP implementation from scratch [Source: architecture.md#Authentication & Security]
- 2FA surface behavior [Source: epics.md#Additional Requirements]
- NFR5–NFR7: token never in logs [Source: epics.md#NonFunctional Requirements]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Unit test initially called `authenticate` twice with a single `mockFetch` setup, causing the second call to receive exhausted mock responses (info.Salt = undefined). Restructured tests to call `authenticate` once per test case.
- Decision: Added `bcryptjs@3.0.3` for Proton's password expansion — `Bun.password.hash()` does not support providing a custom salt string required by the Proton SRP variant.

### Completion Notes List

- `src/types.ts`: added `SessionToken` type.
- `src/auth/srp.ts`: full Proton SRP-6a implementation — RFC5054 2048-bit group, bcrypt password hashing (v3/v4), BigInt modular arithmetic, 2FA/auth-fail/network error handling. No token/secret logging.
- `src/auth/srp.test.ts`: 8 unit tests with mocked fetch covering all AC error cases + success.
- `src/__integration__/auth.integration.test.ts`: skips when credentials absent; validates live API when present.
- 71 unit tests pass, 1 integration test skipped (expected).

### File List

- `src/auth/srp.ts` (new)
- `src/auth/srp.test.ts` (new)
- `src/__integration__/auth.integration.test.ts` (new)
- `src/types.ts` (modified — added SessionToken)
- `package.json` (modified — added bcryptjs, @types/bcryptjs)
- `bun.lock` (updated)

### Change Log

- 2026-04-02: Story 2.1 implemented — Proton SRP-6a auth, bcrypt password hashing, 2FA detection, typed error handling.

### Review Findings

- [x] [Review][Decision] Retry policy missing — resolved: implemented inline retry (3 attempts, exponential backoff, retry on 429/5xx/network errors) in `fetchJson`
- [x] [Review][Decision] `hashPassword` version < 3 returns plaintext password — resolved: now throws `AuthError(UNSUPPORTED_VERSION)` for version < 3
- [x] [Review][Patch] `formatBcryptSalt` `/` replacement is a no-op — fixed: now encodes raw salt bytes directly using bcrypt's custom base64 alphabet [src/auth/srp.ts]
- [x] [Review][Patch] `info.Salt`/`info.ServerEphemeral`/`info.SRPSession` not validated before use — fixed: validation added, throws `AUTH_INFO_INVALID` [src/auth/srp.ts]
- [x] [Review][Patch] `info.Version` missing/undefined not validated — fixed: typeof check added, throws `AUTH_INFO_INVALID` [src/auth/srp.ts]
- [x] [Review][Patch] SRP: `B ≡ 0 (mod N)` not checked — fixed: check added before SRP computation [src/auth/srp.ts]
- [x] [Review][Patch] SRP: `A ≡ 0 (mod N)` not checked — fixed: check added after generating A [src/auth/srp.ts]
- [x] [Review][Patch] SRP: `u = 0` not checked — fixed: check added after computing u [src/auth/srp.ts]
- [x] [Review][Patch] Server proof M2 not verified — fixed: M2 verified when ServerProof is present; throws `SRP_INVALID_SERVER_PROOF` on mismatch; TODO to make required [src/auth/srp.ts]
- [x] [Review][Patch] `response.json()` unhandled SyntaxError — fixed: wrapped in try/catch, throws `NetworkError(NETWORK_PARSE_ERROR)` [src/auth/srp.ts]
- [x] [Review][Patch] Integration test only asserts `accessToken` — fixed: refreshToken and uid now asserted [src/__integration__/auth.integration.test.ts]
- [x] [Review][Defer] `expandPassword` silently truncates passwords > 64 UTF-8 bytes [src/auth/srp.ts:93-99] — deferred, pre-existing; intentional per Proton SRP spec
