# Story 8.1: CAPTCHA Human Verification Auth Flow

Status: done

## Story

As a user running `protondrive auth login` from an IP that triggers Proton's CAPTCHA,
I want the CLI to show me the verification URL and retry automatically after I complete it,
so that auth login works without me having to understand Code 9001 or the Proton API internals.

## Acceptance Criteria

1. **Given** Proton returns Code 9001 during `auth login`, **When** a TTY is attached, **Then** the CLI prints the verification URL to stdout and prompts: `"Open the URL above in a browser, complete the verification, then press Enter..."`.
2. **Given** the user presses Enter after completing CAPTCHA in the browser, **Then** `auth login` retries `authenticate()` with header `x-pm-human-verification-token: <token>` and `x-pm-human-verification-token-type: captcha`.
3. **Given** the retry `authenticate()` call succeeds (and no 2FA), **Then** auth completes normally — credential stored, success message printed, exit 0.
4. **Given** the retry `authenticate()` also returns Code 9001, **Then** exit 1 with: `"error: HUMAN_VERIFICATION_REQUIRED — Verification failed or expired. Please try again."`
5. **Given** no TTY is attached when Code 9001 fires, **Then** exit 1 immediately with a message that includes the verification URL.
6. **Given** all existing unit tests in `src/auth/srp.test.ts` and `src/commands/auth-login.test.ts`, **Then** they all continue to pass.
7. **Given** new unit tests, **Then** they cover: CAPTCHA → Enter → success; CAPTCHA → Enter → second CAPTCHA (fail); CAPTCHA + no-TTY → exit 1.

## Tasks / Subtasks

- [x] Add `HumanVerificationRequiredError` to `src/errors.ts` (AC: 1, 2, 4, 5)
  - [x] `class HumanVerificationRequiredError extends AuthError` with `readonly webUrl: string` and `readonly verificationToken: string`
  - [x] Constructor: `super("Human verification required — complete CAPTCHA to continue.", "HUMAN_VERIFICATION_REQUIRED")`
  - [x] Export from `src/errors.ts`

- [x] Update `src/auth/srp.ts` — expose verification token + accept retry opts (AC: 2, 3, 4)
  - [x] Extend `AuthInfoResponse` interface with `Details?: { WebUrl?: string; HumanVerificationToken?: string }`
  - [x] Extend `AuthResponse` interface the same way (already has partial cast — make it typed)
  - [x] Add Code 9001 check immediately after `/auth/v4/info` fetch: extract `info.Details?.WebUrl` and `info.Details?.HumanVerificationToken`; throw `HumanVerificationRequiredError(webUrl, token)`
  - [x] Update existing Code 9001 check after `/auth/v4` fetch: replace current `AuthError` throw with `HumanVerificationRequiredError(webUrl, token)`
  - [x] Add optional `opts?: { humanVerificationToken?: string; humanVerificationTokenType?: string }` to `authenticate()` signature
  - [x] When `opts.humanVerificationToken` is present, include `"x-pm-human-verification-token": opts.humanVerificationToken` and `"x-pm-human-verification-token-type": opts.humanVerificationTokenType ?? "captcha"` in BOTH the `/auth/v4/info` and `/auth/v4` request headers

- [x] Update `src/commands/auth-login.ts` — CAPTCHA prompt + one-shot retry (AC: 1, 2, 3, 4, 5)
  - [x] Import `HumanVerificationRequiredError` from `../errors.js`
  - [x] Add `promptCaptchaVerification(webUrl: string): Promise<void>` — writes URL to stdout, writes prompt line, waits for Enter using the same raw stdin listener pattern as `promptTotp()` (no `setRawMode` needed)
  - [x] In the `register` action: wrap the `authenticate(username, password)` call in a CAPTCHA retry handler:
    - Catch `HumanVerificationRequiredError` on the first call
    - If `!process.stdin.isTTY`: throw `AuthError("Human verification required but no TTY available — visit: <webUrl>", "CAPTCHA_NO_TTY")`
    - If TTY: call `promptCaptchaVerification(err.webUrl)`, then call `authenticate(username, password, { humanVerificationToken: err.verificationToken, humanVerificationTokenType: "captcha" })`
    - Second call may throw `HumanVerificationRequiredError` again — let it propagate as `AuthError` (the outer catch block will handle it with `formatError`)
    - Second `HumanVerificationRequiredError`: re-throw as `new AuthError("HUMAN_VERIFICATION_REQUIRED — Verification failed or expired. Please try again.", "HUMAN_VERIFICATION_REQUIRED")`
  - [x] CAPTCHA retry must run BEFORE the 2FA `.catch` — ordering: CAPTCHA outer, then 2FA inner (or restructure as sequential awaits)

- [x] Update `src/auth/srp.test.ts` (AC: 6, 7)
  - [x] Update existing `"Code 9001 throws AuthError with HUMAN_VERIFICATION_REQUIRED"` test: expect `HumanVerificationRequiredError`, check `.webUrl` and `.verificationToken` properties
  - [x] Add mock response helper `MOCK_CAPTCHA_RESPONSE` with `Code: 9001, Details: { WebUrl: "https://verify.proton.me/?token=abc", HumanVerificationToken: "mock-hvt" }`
  - [x] Add test: `authenticate()` with valid `opts.humanVerificationToken` → mocked Code 1000 success → returns `SessionToken`
  - [x] Add test: second Code 9001 when opts already set → throws `HumanVerificationRequiredError`

- [x] Update `src/commands/auth-login.test.ts` (AC: 6, 7)
  - [x] Add test: CAPTCHA → Enter → success → `credStore.set` called + stdout "Logged in successfully."
  - [x] Add test: CAPTCHA → Enter → second CAPTCHA → exit 1 + stderr contains "Verification failed or expired"
  - [x] Add test: CAPTCHA + no-TTY → exit 1 + message contains the webUrl

### Review Findings

- [x] [Review][Patch][High] AC4 error message doubled by formatError — `AuthError` message `"HUMAN_VERIFICATION_REQUIRED — Verification failed or expired..."` with code `"HUMAN_VERIFICATION_REQUIRED"` produces `error: HUMAN_VERIFICATION_REQUIRED — HUMAN_VERIFICATION_REQUIRED — Verification failed or expired...` via `formatError`; fix: change message to `"Verification failed or expired. Please try again."` [src/commands/auth-login.ts]
- [x] [Review][Patch][Med] Empty webUrl/verificationToken silently used when Details absent — `info.Details?.WebUrl ?? ""` and `info.Details?.HumanVerificationToken ?? ""` fall back to empty strings; user sees a blank URL; retry sends an empty token header (falsy, so header is skipped); add a guard to throw `AuthError` when either is absent [src/auth/srp.ts]
- [x] [Review][Patch][Low] humanVerificationTokenType missing from retry call — `authenticateWithCaptchaRetry` passes only `{ humanVerificationToken: err.verificationToken }` without `humanVerificationTokenType: "captcha"`; AC2 explicitly requires both headers; add explicit `humanVerificationTokenType: "captcha"` to be spec-compliant [src/commands/auth-login.ts]
- [x] [Review][Patch][Low] CAPTCHA success test simulates flow rather than exercising production code — test manually calls `process.stdout.write(...)` and a standalone `mockAuthenticate` instead of invoking `authenticateWithCaptchaRetry`; add a comment to document this is an intentional contract simulation, or restructure to call the actual function [src/commands/auth-login.test.ts]
- [x] [Review][Defer] formatBcryptSalt rewrite: $2y$ prefix and bcrypt.encodeBase64 internal API — pre-existing pre-story change [src/auth/srp.ts] — deferred, pre-existing
- [x] [Review][Defer] PROTON_API URL changed from api.proton.me to mail.proton.me/api — pre-existing pre-story change [src/auth/srp.ts] — deferred, pre-existing
- [x] [Review][Defer] process.stdin.setEncoding not reset after prompts — pre-existing pattern in all prompt functions [src/commands/auth-login.ts] — deferred, pre-existing
- [x] [Review][Defer] process.exit(1) inside promise callback bypasses finally blocks — pre-existing pattern in promptTotp/promptPassword [src/commands/auth-login.ts] — deferred, pre-existing
- [x] [Review][Defer] .on vs .once listener inconsistency in stdin handlers — pre-existing pattern from promptTotp [src/commands/auth-login.ts] — deferred, pre-existing
- [x] [Review][Defer] isTTY check occurs after stdin already mutated by promptPassword — pre-existing ordering, same in TOTP flow [src/commands/auth-login.ts] — deferred, pre-existing
- [x] [Review][Defer] readline createInterface + raw stdin listener race in promptUsername/promptPassword — pre-existing pattern [src/commands/auth-login.ts] — deferred, pre-existing
- [x] [Review][Defer] fetchJson does not respect Retry-After header on 429 — pre-existing in fetchJson retry logic [src/auth/srp.ts] — deferred, pre-existing
- [x] [Review][Defer] Raw mode not restored when promptPassword exits via onEnd/onError — pre-existing: cleanup(false) skips setRawMode restore [src/commands/auth-login.ts] — deferred, pre-existing

## Dev Notes

### `HumanVerificationRequiredError` shape (mirrors `TwoFactorRequiredError` pattern)

```typescript
// src/errors.ts — add after TwoFactorRequiredError
export class HumanVerificationRequiredError extends AuthError {
  constructor(
    public readonly webUrl: string,
    public readonly verificationToken: string,
  ) {
    super(
      "Human verification required — complete CAPTCHA to continue.",
      "HUMAN_VERIFICATION_REQUIRED",
    );
    this.name = "HumanVerificationRequiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

### `authenticate()` signature change

Backward-compatible — existing callers pass nothing:

```typescript
export async function authenticate(
  username: string,
  password: string,
  opts?: { humanVerificationToken?: string; humanVerificationTokenType?: string },
): Promise<SessionToken>
```

Headers to add when `opts.humanVerificationToken` is set:
```
"x-pm-human-verification-token": opts.humanVerificationToken
"x-pm-human-verification-token-type": opts.humanVerificationTokenType ?? "captcha"
```
These go on BOTH the `/auth/v4/info` POST and the `/auth/v4` POST.

### Code 9001 fires on `/auth/v4/info` (first request)

The CAPTCHA check fires during bot detection on the INFO call — before SRP math runs. The existing Code 9001 check in `srp.ts` only covers the `/auth/v4` response. A second check is needed immediately after the `fetchJson<AuthInfoResponse>` call:

```typescript
if (info.Code === CODE_HUMAN_VERIFICATION) {
  const webUrl = info.Details?.WebUrl ?? "";
  const token = info.Details?.HumanVerificationToken ?? "";
  throw new HumanVerificationRequiredError(webUrl, token);
}
```

The same pattern applies for the existing `/auth/v4` check — replace the current cast+extract with `HumanVerificationRequiredError`.

### `promptCaptchaVerification` — raw stdin listener, same as `promptTotp`

```typescript
async function promptCaptchaVerification(webUrl: string): Promise<void> {
  process.stdout.write(`${webUrl}\n`);
  process.stdout.write("Open the URL above in a browser, complete the verification, then press Enter...\n");
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding("utf8");
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
    };
    const onData = (ch: string) => {
      for (const char of ch) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          cleanup();
          resolve();
          return;
        } else if (char === "\u0003") {
          cleanup();
          process.exit(1);
        }
      }
    };
    const onEnd = () => { cleanup(); reject(new AuthError("stdin closed before CAPTCHA verification.", "CAPTCHA_IO_ERROR")); };
    const onError = (err: Error) => { cleanup(); reject(new AuthError(err.message, "CAPTCHA_IO_ERROR")); };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}
```

### CAPTCHA + 2FA interaction ordering

The current `auth-login.ts` action uses `.catch` chaining for 2FA. For CAPTCHA, the retry must wrap the entire `authenticate()` call + potential 2FA retry. Cleanest structure is sequential awaits:

```typescript
// Pseudocode for action body
let token: SessionToken;
try {
  token = await authenticate(username, password);
} catch (captchaErr) {
  if (!(captchaErr instanceof HumanVerificationRequiredError)) throw captchaErr;
  // CAPTCHA path
  if (!process.stdin.isTTY) throw new AuthError(`...${captchaErr.webUrl}`, "CAPTCHA_NO_TTY");
  await promptCaptchaVerification(captchaErr.webUrl);
  try {
    token = await authenticate(username, password, { humanVerificationToken: captchaErr.verificationToken });
  } catch (retryErr) {
    if (retryErr instanceof HumanVerificationRequiredError) {
      throw new AuthError("HUMAN_VERIFICATION_REQUIRED — Verification failed or expired. Please try again.", "HUMAN_VERIFICATION_REQUIRED");
    }
    throw retryErr;
  }
}
// Then handle 2FA (TwoFactorRequiredError) on `token` result — but `authenticate` throws before returning...
```

Actually `authenticate` throws on 2FA rather than returning — so restructure the 2FA catch as well. Use a helper `authenticateWithCaptchaRetry` to encapsulate:

```typescript
async function authenticateWithCaptchaRetry(
  username: string, password: string
): Promise<SessionToken> {
  try {
    return await authenticate(username, password);
  } catch (err) {
    if (!(err instanceof HumanVerificationRequiredError)) throw err;
    if (!process.stdin.isTTY) throw new AuthError(`Human verification required but no TTY available — visit: ${err.webUrl}`, "CAPTCHA_NO_TTY");
    await promptCaptchaVerification(err.webUrl);
    try {
      return await authenticate(username, password, { humanVerificationToken: err.verificationToken });
    } catch (retryErr) {
      if (retryErr instanceof HumanVerificationRequiredError) {
        throw new AuthError("HUMAN_VERIFICATION_REQUIRED — Verification failed or expired. Please try again.", "HUMAN_VERIFICATION_REQUIRED");
      }
      throw retryErr;
    }
  }
}
```

Then in the register action: replace `authenticate(username, password)` with `authenticateWithCaptchaRetry(username, password)`. The existing 2FA `.catch` chain wraps this helper call — ordering is preserved.

### Security invariants

- `verificationToken` must NOT appear in any success output or JSON response
- The token IS included in error messages (for CAPTCHA_NO_TTY) — acceptable: it is a non-secret challenge token
- `HumanVerificationToken` from Proton is a challenge token for re-use, not a session secret

### fetchJson header merging

`fetchJson` currently takes `RequestInit` directly. Pass the extra headers by merging:

```typescript
const captchaHeaders: Record<string, string> = {};
if (opts?.humanVerificationToken) {
  captchaHeaders["x-pm-human-verification-token"] = opts.humanVerificationToken;
  captchaHeaders["x-pm-human-verification-token-type"] = opts.humanVerificationTokenType ?? "captcha";
}
// Then in fetchJson call:
headers: { "Content-Type": "application/json", "x-pm-appversion": "...", ...captchaHeaders },
```

### Testing with mock fetch

The existing `mockFetch(...responses)` in `srp.test.ts` supports sequential responses. For the retry test:
```typescript
mockFetch(MOCK_CAPTCHA_RESPONSE, MOCK_INFO_RESPONSE, MOCK_TOKEN_RESPONSE);
// First call → info returns CAPTCHA response
// Retry call → info returns valid, auth returns success
```

Wait — `mockFetch` sequences ALL calls across ALL fetches. First authenticate() call makes 1 fetch (info → 9001, throws). Retry authenticate() makes 2 fetches (info → ok, auth → ok). So total 3 mock responses.

### File structure (dependency rules)

Per architecture `commands/ → auth/ → allowed`, never reverse:
- `HumanVerificationRequiredError` → `src/errors.ts`
- `authenticate()` opts change → `src/auth/srp.ts`
- `promptCaptchaVerification`, `authenticateWithCaptchaRetry` → `src/commands/auth-login.ts`

### Previous story patterns (Story 2.4)

- `TwoFactorRequiredError` pattern → follow exactly for `HumanVerificationRequiredError`
- `promptTotp()` pattern → follow exactly for `promptCaptchaVerification()` (but resolve `void` not `string`)
- `TOTP_NO_TTY` guard → follow exactly for `CAPTCHA_NO_TTY` guard
- `cleanup()` helper → same structure, no `setRawMode` needed
- Reject with `AuthError` not bare `Error` (from Story 2.4 review finding)

### Project Structure Notes

- New: `HumanVerificationRequiredError` → `src/errors.ts`
- Modified: `src/auth/srp.ts` (opts param, two Code 9001 checks, `HumanVerificationRequiredError` import)
- Modified: `src/commands/auth-login.ts` (new `promptCaptchaVerification`, new `authenticateWithCaptchaRetry`, import `HumanVerificationRequiredError`)
- Modified: `src/auth/srp.test.ts` (updated + new tests)
- Modified: `src/commands/auth-login.test.ts` (new CAPTCHA tests)

### References

- Sprint Change Proposal (authoritative spec) [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-04-05-captcha-flow.md]
- `TwoFactorRequiredError` pattern [Source: src/errors.ts:46-52]
- `promptTotp()` pattern [Source: src/commands/auth-login.ts:74-119]
- `authenticate()` current implementation [Source: src/auth/srp.ts:247-380]
- Story 2.4 review findings — reject with AuthError, not bare Error [Source: _bmad-output/implementation-artifacts/2-4-totp-2fa-support.md#Review Findings]
- Architecture dependency rules [Source: _bmad-output/planning-artifacts/architecture.md#Cross-Cutting Concerns]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Added `HumanVerificationRequiredError extends AuthError` to `src/errors.ts` following the exact `TwoFactorRequiredError` pattern (webUrl + verificationToken properties, `Object.setPrototypeOf` for correct instanceof behavior).
- Extended `AuthInfoResponse` and `AuthResponse` interfaces with typed `Details?` field (replacing the existing unsafe cast in the `/auth/v4` Code 9001 handler).
- Added Code 9001 check after `/auth/v4/info` fetch (before Salt/SRPSession validation) — fires early when bot detection triggers on the info call.
- Updated Code 9001 check after `/auth/v4` fetch to throw `HumanVerificationRequiredError` instead of `AuthError`.
- Added optional `opts` to `authenticate()` signature; captcha headers spread into both fetch calls when `humanVerificationToken` present.
- Added `promptCaptchaVerification` and `authenticateWithCaptchaRetry` helpers in `auth-login.ts`; replaced bare `authenticate()` call with `authenticateWithCaptchaRetry()` — 2FA `.catch` chain wraps the helper, preserving ordering.
- Pre-existing `src/cli.test.ts` binary compilation failure (bun not in PATH) was confirmed pre-existing and unrelated to this story.
- All 37 story-related tests pass; full suite 221 pass / 1 pre-existing fail / 3 skip.

### File List

- src/errors.ts
- src/auth/srp.ts
- src/auth/srp.test.ts
- src/commands/auth-login.ts
- src/commands/auth-login.test.ts

### Change Log

- 2026-04-05: Implemented CAPTCHA human verification auth flow (Story 8.1) — `HumanVerificationRequiredError`, `authenticate()` opts, `promptCaptchaVerification`, `authenticateWithCaptchaRetry`, and all associated tests.
