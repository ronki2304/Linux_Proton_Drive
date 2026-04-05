# Sprint Change Proposal: CAPTCHA Human Verification Interactive Flow

**Project:** ProtonDrive-LinuxClient
**Date:** 2026-04-05
**Author:** John (Product Manager)
**Status:** Approved

---

## Section 1: Issue Summary

Two issues discovered during the live authentication bug-fix session (2026-04-05):

**Issue A — CAPTCHA blocks `auth login` completely.**
Proton's API returns Code 9001 (`HUMAN_VERIFICATION_REQUIRED`) when it detects automated
access. This fires *before* the SRP proof is evaluated — the user never reaches a password
failure or 2FA prompt; auth dies immediately. The response includes a `WebUrl`
(e.g. `https://verify.proton.me/?methods=captcha&token=...`) and a `HumanVerificationToken`.
Correct recovery flow: surface the URL to the user, wait for them to complete the CAPTCHA
in a browser, then retry the SRP auth with `x-pm-human-verification-token: <token>` and
`x-pm-human-verification-token-type: captcha` headers.

**Issue B — PRD and Architecture contain stale 2FA language.**
Both documents say 2FA is "completely blocked" and a "hard limitation." That was true at
architecture time. During the sprint, 2FA support was implemented (`TwoFactorRequiredError`,
`promptTotp`, `verifyTotp`). The stale text is a misleading contract for future contributors.

**Discovery context:** Live integration test run post-auth-bug-fix sprint (2026-04-05).
Confirmed via debug log showing the full Code 9001 response body with `HumanVerificationMethods: ["captcha"]`.

---

## Section 2: Impact Analysis

**Epic Impact:**

| Epic | Impact |
|------|--------|
| Epic 2: Secure Authentication | Done. CAPTCHA story is additive — no rollback or changes to existing done stories. |
| All other epics | Unaffected. |

**Story Impact:**

| Story/Area | Impact |
|---|---|
| 2.3 auth login/logout | No code change needed — already throws `TwoFactorRequiredError` correctly. |
| `src/auth/srp.ts` | New retry loop: detect Code 9001, surface URL, accept Enter, re-call auth with verification token headers. |
| Integration tests | Already updated. No further story impact. |
| Sprint-status.yaml | New story entry needed under new Epic 8. |

**PRD Impact:**

| Section | Change Needed |
|---|---|
| Domain-Specific Requirements → Auth & Security | Replace stale "2FA is completely blocked" text with accurate 2FA + CAPTCHA handling descriptions. |
| Functional Requirements | Add FR35 for interactive CAPTCHA handling in `auth login`. |

**Architecture Impact:**

| Section | Change Needed |
|---|---|
| Gap Analysis → Item #4 | Update 2FA surface behavior text — reflects current implementation. Add new item 4b for CAPTCHA retry pattern. |

**UX/UI Impact:** N/A — CLI only. New interactive prompt follows existing `promptTotp` pattern.

---

## Section 3: Recommended Approach

**Selected: Option 1 — Direct Adjustment**

Add one new story. Update PRD and Architecture in-place (documentation fixes only).
No rollback, no scope reduction, no new epics strictly required (story can live as a
standalone or under a new "Epic 8: Auth Hardening").

**Rationale:** Contained change. The CAPTCHA flow is structurally identical to the 2FA
prompt already implemented — detect special condition, print to stdout, wait for input,
retry. All patterns exist. Effort: Low. Risk: Low. No timeline impact to v1 epics.

---

## Section 4: Detailed Change Proposals

### 4.1 — PRD: Domain-Specific Requirements Update

**File:** `_bmad-output/planning-artifacts/prd.md`
**Section:** Authentication & Security Constraints

```
OLD:
- 2FA is completely blocked (SDK issue #6 closed as out of scope by Proton) —
  documented limitation for v1; users with 2FA enabled cannot authenticate

NEW:
- 2FA is supported in v1 via TOTP prompt during `auth login`. Users with 2FA
  enabled are prompted for their 6-digit authenticator code after SRP auth succeeds.

- Proton may require human verification (CAPTCHA, Code 9001) during `auth login`
  in automated or suspicious-IP contexts. The CLI handles this by surfacing the
  verification URL, waiting for the user to complete the CAPTCHA in a browser, then
  retrying authentication with the `x-pm-human-verification-token` header.
  Non-interactive (no TTY) invocations surface the URL in an error message and exit 1.
```

### 4.2 — PRD: New Functional Requirement

**Add to Functional Requirements list:**

```
FR35: When Proton requires human verification during `auth login`, the CLI surfaces the
verification URL to stdout, prompts the user to complete the CAPTCHA in a browser and
press Enter, then retries authentication automatically with the verification token.
Non-TTY invocations print the URL and exit 1 with code HUMAN_VERIFICATION_REQUIRED.
```

### 4.3 — Architecture: Gap Item #4 Update

**File:** `_bmad-output/planning-artifacts/architecture.md`
**Section:** Gap Analysis & Resolutions → Item #4

```
OLD:
4. 2FA surface behavior: `srp.ts` must throw `AuthError` with code `TWO_FACTOR_REQUIRED`
   when Proton returns the 2FA challenge. Human output: "error: 2FA is not supported in
   v1 — disable 2FA on your Proton account to use this tool."

NEW:
4. 2FA: Implemented in Sprint 2. `srp.ts` throws `TwoFactorRequiredError` (AuthError
   subclass) carrying partial session tokens. `auth-login.ts` catches it, calls
   `promptTotp()`, and calls `verifyTotp()`. TTY-required; non-TTY throws TOTP_NO_TTY.

4b. CAPTCHA (Human Verification): `srp.ts` throws `AuthError(HUMAN_VERIFICATION_REQUIRED)`
    on Code 9001, with the WebUrl embedded in the message. `auth-login.ts` catches it,
    prints the URL, prompts "press Enter when done", then retries `authenticate()` with
    `opts.humanVerificationToken` and `opts.humanVerificationTokenType: "captcha"`.
    One-shot retry — second Code 9001 exits 1. Non-TTY: print URL and exit 1.
    `fetchJson` passes the token pair as additional request headers when provided.
```

### 4.4 — New Story: 8-1-captcha-human-verification-auth-flow

**Story key:** `8-1-captcha-human-verification-auth-flow`
**Suggested home:** New Epic 8 (Auth Hardening) in sprint-status.yaml, or as a standalone
post-sprint patch story.

**User Story:**
> As a user running `protondrive auth login` from an IP that triggers Proton's CAPTCHA,
> I want the CLI to show me the verification URL and retry automatically after I complete it,
> so that auth login works without me having to understand Code 9001 or the Proton API internals.

**Acceptance Criteria:**

1. When `authenticate()` throws `HUMAN_VERIFICATION_REQUIRED`, `auth login` prints the
   verify URL to stdout and prompts:
   `"Open the URL above in a browser, complete the verification, then press Enter..."`
2. After Enter, `auth login` retries `authenticate()` with `x-pm-human-verification-token`
   set to the original `HumanVerificationToken` value, and
   `x-pm-human-verification-token-type: captcha`.
3. If the retry succeeds (and no 2FA), auth completes normally.
4. If the retry also returns Code 9001, exit 1 with:
   `"error: HUMAN_VERIFICATION_REQUIRED — Verification failed or expired. Please try again."`
5. If no TTY: exit 1 immediately with the URL included in the error message (no prompt).
6. All existing unit tests for `authenticate()` continue to pass.
7. New unit tests: CAPTCHA → Enter → success; CAPTCHA → Enter → CAPTCHA again (fail);
   CAPTCHA non-TTY exit 1.

**Technical implementation notes:**
- `authenticate()` gains optional `opts?: { humanVerificationToken?: string; humanVerificationTokenType?: string }` forwarded as extra headers in `/auth/v4/info` and `/auth/v4` requests.
- `AuthError(HUMAN_VERIFICATION_REQUIRED)` message already includes the WebUrl (current implementation). Extract the URL from the error message in `auth-login.ts` for the prompt, OR extend `AuthError` with an optional `detail` field.
- The CAPTCHA token from the *first* 9001 response is reused on retry — not re-fetched.
- Non-TTY check: same `process.stdin.isTTY` pattern as existing `TOTP_NO_TTY` guard.

---

## Section 5: Implementation Handoff

**Scope classification: Minor** — one new story, two documentation patches. Direct
implementation by dev team.

**Recommended sequencing:**
1. Update PRD (sections 4.1, 4.2 above) — documentation fix, 5 min
2. Update Architecture (section 4.3 above) — documentation fix, 5 min
3. Update sprint-status.yaml — add Epic 8 + story 8-1 in backlog
4. Dev agent implements story 8-1 (create story file first via create-story)
5. Manual test: `./protondrive auth login` on a CAPTCHA-triggering request
6. Integration test update if needed (CAPTCHA is non-deterministic — unit tests are primary)

**Success criteria:**
- `protondrive auth login` on a CAPTCHA-triggering IP shows the verify URL, waits for
  Enter, and completes authentication after browser verification
- Non-TTY invocation exits 1 with a clear message including the URL
- PRD and Architecture no longer contain stale "2FA blocked" language
- Story 8-1 unit tests pass (3 new test cases minimum)
