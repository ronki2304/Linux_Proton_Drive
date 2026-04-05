# Story 2.4: TOTP 2FA Support

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user with 2FA enabled on my Proton account,
I want `protondrive auth login` to prompt me for my TOTP code after entering my credentials,
so that I can authenticate without disabling 2FA on my account.

## Acceptance Criteria

1. **Given** a user with TOTP 2FA enabled, **When** `protondrive auth login` is run and credentials are entered correctly, **Then** the CLI prompts for a 6-digit TOTP code after the password.
2. **Given** the TOTP prompt is displayed, **When** the correct code is entered, **Then** authentication completes, the session token is stored via `CredentialStore`, and a success message is written to stdout (same as non-2FA login).
3. **Given** the TOTP prompt is displayed, **When** an incorrect code is entered, **Then** it exits with code 1 and a clear error message on stderr.
4. **Given** `auth login` is run with `--json` and 2FA is required, **Then** the TOTP prompt is still written to stdout (not stderr), and the final success/error output respects the JSON contract `{ "ok": true/false, ... }`.
5. **Given** no TTY is attached (cron/CI), **When** `auth login` is run and the account has 2FA, **Then** it exits with code 1 and a clear message: `"2FA required but no TTY available — run 'protondrive auth login' interactively first."`
6. **Given** `src/auth/srp.test.ts` and `src/commands/auth-login.test.ts`, **Then** all existing tests continue to pass and new TOTP tests are added covering: correct code → SessionToken, incorrect code → AuthError, no-TTY → AuthError.

## Tasks / Subtasks

- [x] Add `TwoFactorRequiredError` to `src/errors.ts` (AC: 1, 2, 3, 5)
  - [x] `class TwoFactorRequiredError extends AuthError` with `readonly challenge: SessionToken`
  - [x] Constructor sets message `"2FA is required — enter your authenticator app code."`, code `TWO_FACTOR_REQUIRED`
  - [x] Export from `src/errors.ts`
- [x] Update `src/auth/srp.ts` — 2FA detection and TOTP verification (AC: 1, 2, 3)
  - [x] In `authenticate()`: when `auth.TwoFactor !== undefined` AND `auth.AccessToken` + `auth.RefreshToken` + `auth.UID` are present, throw `TwoFactorRequiredError` with `challenge = { accessToken, refreshToken, uid }`
  - [x] When `auth.Code === CODE_2FA_REQUIRED` (9001) AND tokens absent: keep existing `AuthError(TWO_FACTOR_REQUIRED)` with message `"2FA required — could not obtain partial session from Proton API."`
  - [x] Add exported `verifyTotp(challenge: SessionToken, totpCode: string): Promise<SessionToken>`
    - POST `/auth/v4/2fa` with `Authorization: Bearer <challenge.accessToken>`, `x-pm-uid: <challenge.uid>`, `x-pm-appversion: Other`, body `{ "TwoFactorCode": totpCode }`
    - On Code 1000: return `challenge` (same tokens, now full scope)
    - On Code 8002 or non-1000: throw `AuthError("Invalid 2FA code — check your authenticator app.", "TOTP_INVALID")`
    - Network failures: `NetworkError` (via `fetchJson`, retry logic already in place)
    - NEVER log `totpCode` in any error message or log
- [x] Update `src/commands/auth-login.ts` — catch and handle 2FA (AC: 1, 2, 4, 5)
  - [x] Add `promptTotp()` function: writes `"2FA code: "` to stdout, reads 6-char input from TTY using same raw-mode pattern as `promptPassword()` (but without echo suppression — TOTP codes are visible)
  - [x] In `register` action: catch `TwoFactorRequiredError`, check `process.stdin.isTTY`
    - If no TTY: `formatError(new AuthError("2FA required but no TTY available — run 'protondrive auth login' interactively first.", "TOTP_NO_TTY"), { json })` then `process.exit(1)`
    - If TTY: prompt for TOTP code, call `verifyTotp(err.challenge, totpCode)`, store token on success
  - [x] Validate totpCode is 6 digits before calling `verifyTotp` (client-side guard); on invalid format: `AuthError("TOTP code must be 6 digits.", "TOTP_INVALID_FORMAT")`
- [x] Update `src/auth/srp.test.ts` (AC: 6)
  - [x] Update existing 2FA tests to distinguish TwoFactorRequiredError from AuthError
  - [x] Add: TwoFactor field + tokens present → throws `TwoFactorRequiredError` with correct challenge shape
  - [x] Add: Code 9001 + no tokens → throws `AuthError(TWO_FACTOR_REQUIRED)` (legacy path, unchanged behavior)
  - [x] Add: `verifyTotp` — correct TOTP → returns SessionToken
  - [x] Add: `verifyTotp` — Code 8002 → throws `AuthError(TOTP_INVALID)`
  - [x] Add: `verifyTotp` — network failure → throws `NetworkError`
- [x] Update `src/commands/auth-login.test.ts` (AC: 6)
  - [x] Add: `TwoFactorRequiredError` caught → TOTP prompt shown (check stdout)
  - [x] Add: no-TTY path → TOTP_NO_TTY error on stderr
  - [x] Add: invalid TOTP format → TOTP_INVALID_FORMAT error

### Review Findings

- [x] [Review][Patch] CRLF terminal input corrupts TOTP code — promptTotp accumulates input without stripping `\r`; on CRLF terminals the chunk `"123456\r"` arrives before `"\n"` terminates, producing `"123456\r"` which fails `/^\d{6}$/` [src/commands/auth-login.ts:89-99]
- [x] [Review][Patch] TwoFactor present with partial tokens silently maps to AUTH_FAILED — when `auth.TwoFactor !== undefined` but only some tokens are present, both 2FA guards are skipped and the user sees "wrong username/password" instead of a 2FA-specific error [src/auth/srp.ts:295-307]
- [x] [Review][Patch] promptTotp rejection propagates as plain Error not AuthError — if stdin closes before TOTP entry, `reject(new Error(...))` produces a non-AuthError that causes malformed JSON output in `--json` mode [src/commands/auth-login.ts:102-104]
- [x] [Review][Patch] formatSuccess may output spurious `{}` before success message in non-JSON mode — confirmed: `formatSuccess({}, { json: false })` hits the `else` branch writing `{}\n`; fixed to emit only "Logged in successfully.\n" in non-JSON mode [src/commands/auth-login.ts:146]
- [x] [Review][Patch] AC6 gap: no auth-login.test.ts test for correct TOTP → credential stored — the integration path TwoFactorRequiredError → verifyTotp success → credStore.set is only tested in srp.test.ts in isolation, not through the command action [src/commands/auth-login.test.ts]
- [x] [Review][Patch] AC6 gap: no auth-login.test.ts test for incorrect TOTP → exit code 1 — no test wires bad TOTP through the command action and asserts process.exit(1) + stderr error output [src/commands/auth-login.test.ts]
- [x] [Review][Defer] Server proof verification is optional not enforced — `if (auth.ServerProof)` guard means an attacker stripping the field voids mutual auth; TODO comment present [src/auth/srp.ts:325] — deferred, pre-existing
- [x] [Review][Defer] bcrypt 72-byte input truncation — `expandPassword` produces ~88 base64 chars but bcrypt silently truncates at 72; last 16 chars ignored [src/auth/srp.ts:98-126] — deferred, pre-existing
- [x] [Review][Defer] Password not zeroed in JS strings — `password` param held in immutable JS string; can't be zeroed; heap dump or crash dump exposure risk [src/auth/srp.ts:217] — deferred, pre-existing
- [x] [Review][Defer] `_handle?.setRawMode` uses undocumented internal Node.js/Bun API — public API is `process.stdin.setRawMode()`; silent failure leaves password echoed to screen [src/commands/auth-login.ts:27] — deferred, pre-existing
- [x] [Review][Defer] fetchJson treats HTTP 422 as success — non-ok 422 responses are parsed as type T; application-level errors in 422 bodies surface only as AUTH_FAILED [src/auth/srp.ts:195] — deferred, pre-existing
- [x] [Review][Defer] SRP exponent `(a + u*x) % (N-1n)` — needs verification against Proton's own clients to confirm this matches server-side computation [src/auth/srp.ts:269] — deferred, pre-existing
- [x] [Review][Defer] Modulus field received but ignored — intentional (hardcoded N used instead), but lack of comment could cause confusion for future maintainers [src/auth/srp.ts:231] — deferred, pre-existing
- [x] [Review][Defer] promptUsername (readline) and promptPassword (raw data listener) use incompatible stdin interfaces — readline may buffer-ahead and cause data loss for promptPassword [src/commands/auth-login.ts:8-19] — deferred, pre-existing

## Dev Notes

### Critical: TwoFactorRequiredError carries the partial session

When Proton's `/auth/v4` returns `TwoFactor` field alongside tokens, those tokens have **"2FA scope"** — limited access that only allows calling `/auth/v4/2fa`. After successful TOTP verification, the **same tokens** gain full scope. The `TwoFactorRequiredError.challenge` carries these partial tokens.

```
TwoFactorRequiredError
  .challenge: SessionToken = { accessToken, refreshToken, uid }
                                   ^ partial-scope tokens from /auth/v4
```

### TOTP verification API call

```
POST https://api.proton.me/auth/v4/2fa
Headers:
  Authorization: Bearer <challenge.accessToken>
  x-pm-uid: <challenge.uid>
  x-pm-appversion: Other
  Content-Type: application/json
Body:
  { "TwoFactorCode": "123456" }

Success: { "Code": 1000 }  → return challenge as SessionToken (full scope now)
Failure: { "Code": 8002 }  → throw AuthError(TOTP_INVALID)
```

The `x-pm-uid` header is **required** by Proton's API for authenticated 2FA calls. Without it the API returns 401.

### Two distinct 2FA paths in srp.ts

```
auth.TwoFactor !== undefined AND auth.AccessToken present
  → TwoFactorRequiredError(challenge)     ← HANDLE (new path)

auth.Code === 9001 AND no AccessToken
  → AuthError(TWO_FACTOR_REQUIRED)        ← LEGACY (keep as-is)
```

### promptTotp() implementation

Use the **same raw stdin listener pattern** as `promptPassword()` (from Story 2.3 review fixes):
- Do NOT open a readline interface (conflicts with raw data listener)
- Use `process.stdin.on("data", ...)` with `once("end")` and `once("error")`
- **Do NOT suppress echo** — TOTP codes are visible (no `setRawMode(true)`)
- Accept input until `\n`, `\r`, or `\u0004` (EOT)
- Validate the collected string is exactly 6 ASCII digits before returning

### File structure (src/auth/ dependency rules)

Per architecture: `src/commands/` → `src/auth/` → allowed. `src/auth/` never imports from `src/commands/`.

- `TwoFactorRequiredError` lives in `src/errors.ts` (same as `AuthError`, `NetworkError`)
- `verifyTotp` lives in `src/auth/srp.ts` (alongside `authenticate`)
- `promptTotp` lives in `src/commands/auth-login.ts`

### Security invariant: TOTP code never logged

`totpCode` must not appear in any error message, log output, or JSON output — same invariant as `password` and session tokens.

### fetchJson is already used by verifyTotp

`verifyTotp` calls `fetchJson` (already in `srp.ts`) which includes:
- 3-attempt retry with exponential backoff (500ms, 1500ms)
- Non-retryable 4xx errors thrown immediately (CODE_AUTH_FAILED = 8002 will not be retried)
- JSON parse error wrapping

Pass the Authorization and x-pm-uid headers via the `options.headers` parameter of `fetchJson`.

### AuthResponse interface update

The `TwoFactor` field in `AuthResponse` needs to be typed more specifically to allow checking for TOTP support:

```typescript
interface AuthResponse {
  // ... existing fields ...
  TwoFactor?: { Enabled: number; TOTP?: number } | Record<string, unknown>;
  // Keep as union to handle API variations
}
```

This change is backward-compatible — existing `auth.TwoFactor !== undefined` check still works.

### Sprint status: this story was NOT in the original epics

Story 2.4 is a new addition not in the original epics.md. It was added post-review because the original AC2 for Story 2.1 ("disable 2FA") is not viable for all users. The sprint-status.yaml entry was added directly.

### Previous story patterns to follow

From Story 2.3 review (auth-login.ts):
- `promptPassword()` pattern: raw stdin listener, `cleanup()` helper restores raw mode, `once("end")` and `once("error")` handlers
- `promptTotp()` should follow the same cleanup pattern but **without** `setRawMode` (TOTP codes are visible input)
- `formatSuccess({}, { json })` for success, `formatError(err, { json })` for errors
- `process.exit(err instanceof ConfigError ? 2 : 1)` in the catch block

### Project Structure Notes

- New: `TwoFactorRequiredError` → `src/errors.ts`
- Modified: `src/auth/srp.ts` (2FA detection logic, new `verifyTotp` export)
- Modified: `src/auth/srp.test.ts` (updated + new tests)
- Modified: `src/commands/auth-login.ts` (new `promptTotp`, catch `TwoFactorRequiredError`)
- Modified: `src/commands/auth-login.test.ts` (new TOTP tests)

### References

- Authentication & Security architecture [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security]
- Error hierarchy [Source: _bmad-output/planning-artifacts/architecture.md#Error Handling]
- Story 2.3 promptPassword pattern [Source: _bmad-output/implementation-artifacts/2-3-auth-login-and-auth-logout-commands.md#Review Findings]
- Story 2.1 srp.ts implementation [Source: _bmad-output/implementation-artifacts/2-1-srp-authentication-implementation.md]
- Dependency rules (commands → auth, never reverse) [Source: _bmad-output/planning-artifacts/architecture.md#Cross-Cutting Concerns]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

(none)

### Completion Notes List

- Added `TwoFactorRequiredError extends AuthError` to `src/errors.ts` carrying the partial-scope `SessionToken` challenge. Requires `import type { SessionToken }` added to errors.ts.
- Split the old single 2FA guard in `srp.ts` into two distinct paths: TwoFactor+tokens → `TwoFactorRequiredError`; Code 9001+no tokens → legacy `AuthError(TWO_FACTOR_REQUIRED)`. Updated `AuthResponse.TwoFactor` type to `{ Enabled: number; TOTP?: number } | Record<string, unknown>`.
- Added `verifyTotp()` export to `srp.ts`: POSTs to `/auth/v4/2fa` with Authorization + x-pm-uid headers, returns challenge on Code 1000, throws `AuthError(TOTP_INVALID)` otherwise. Uses existing `fetchJson` with retry.
- Added `promptTotp()` to `auth-login.ts` using same raw stdin listener pattern as `promptPassword()` but without `setRawMode` (TOTP codes are visible). Added 6-digit regex guard before calling `verifyTotp`.
- All 193 existing tests continue to pass. Added 10 new tests (4 `verifyTotp` in srp.test.ts, 5 TOTP contract tests + 1 `TwoFactorRequiredError` shape test in auth-login.test.ts). The 1 pre-existing failure in cli.test.ts (bun not in PATH for spawnSync) is unrelated.

### File List

- src/errors.ts
- src/auth/srp.ts
- src/commands/auth-login.ts
- src/auth/srp.test.ts
- src/commands/auth-login.test.ts

## Change Log

- Implemented TOTP 2FA support: TwoFactorRequiredError, verifyTotp, promptTotp, no-TTY guard, 6-digit validation (Date: 2026-04-05)
