# Sprint Change Proposal: Auth Security & API URL Fixes

**Project:** ProtonDrive-LinuxClient
**Date:** 2026-04-05
**Author:** John (Product Manager)
**Status:** Approved

---

## Section 1: Issue Summary

Two bugs discovered during live testing of `protondrive auth login`:

1. **Password displayed in plaintext** — `promptPassword()` in `src/commands/auth-login.ts` suppresses terminal echo via `process.stdin._handle?.setRawMode?.()`, a private internal API that silently no-ops in Bun on Linux. The password is fully visible as typed. Violates NFR5/NFR6.

2. **Wrong Proton API URL** — `src/auth/srp.ts:23` hardcodes `https://api.proton.me`, a domain that does not exist. The correct base URL is `https://mail.proton.me/api`. All SRP auth requests have been failing at the DNS level since Story 2.1 was implemented — the SRP implementation has never successfully connected to Proton's servers.

**Discovery context:** Live testing of the compiled binary post-Epic 7.

---

## Section 2: Impact Analysis

**Epic Impact:** No epics invalidated or restructured. Epics 1, 3–6 unaffected. Epic 2 (Secure Authentication) has two bugs in completed stories. Epic 7 Story 7.2 results are unreliable.

**Story Impact:**

| Story | Impact |
|-------|--------|
| 2.1 SRP implementation | Root cause of URL bug — patch required |
| 2.3 auth login/logout | Root cause of echo bug — patch required |
| 2.4 TOTP 2FA | Uses same `PROTON_API` constant via `verifyTotp()` — fixed by 2.1 patch |
| 7.2 Live integration tests | Results unreliable — re-run required after URL fix |

**PRD Impact:** None. No requirements change.

**Architecture Impact:** None. URL not documented in architecture doc. Arch gate *"Validated against actual Proton auth endpoint before any other feature work"* was not met — called out here for awareness, no doc edit needed.

**UX/UI Impact:** N/A — v1 CLI only.

---

## Section 3: Recommended Approach

**Selected: Option 1 — Direct Adjustment**

Two targeted code fixes, no rollback, no scope reduction, no new epics. Effort: Low. Risk: Low.

---

## Section 4: Detailed Change Proposals

### 4.1 — Password echo fix

**File:** `src/commands/auth-login.ts:26–32`

```typescript
// OLD
type RawStdin = NodeJS.ReadStream & { _handle?: { setRawMode?: (v: boolean) => void } };
const setRawMode = (on: boolean) => {
  if (process.stdin.isTTY) {
    (process.stdin as RawStdin)._handle?.setRawMode?.(on);
  }
};

// NEW
const setRawMode = (on: boolean) => {
  if (process.stdin.isTTY) {
    (process.stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }).setRawMode(on);
  }
};
```

**Rationale:** `_handle.setRawMode` is a private internal API that silently no-ops in Bun on Linux. The public `setRawMode()` method is exposed directly on the TTY ReadStream object. This eliminates the password echo security vulnerability.

### 4.2 — API URL fix

**File:** `src/auth/srp.ts:23`

```typescript
// OLD
const PROTON_API = "https://api.proton.me";

// NEW
const PROTON_API = "https://mail.proton.me/api";
```

**Rationale:** `api.proton.me` does not exist as a DNS record. Proton's v4 auth endpoints are served under `https://mail.proton.me/api`. This fixes the root cause of `NETWORK_FETCH_FAILED`. The corrected endpoints become:
- `POST https://mail.proton.me/api/auth/v4/info`
- `POST https://mail.proton.me/api/auth/v4`
- `POST https://mail.proton.me/api/auth/v4/2fa`

### 4.3 — Story 7.2 re-validation annotation

**File:** `_bmad-output/implementation-artifacts/7-2-live-protondrive-integration-tests.md`

Status updated from `done` to `done (re-validation required)` with explanatory note. Original test run results are unreliable — tests were executed against a non-existent endpoint.

---

## Section 5: Implementation Handoff

**Scope classification: Minor** — two one-line code fixes and one story annotation. Direct implementation by dev team.

**Recommended sequencing:**
1. Apply fix 4.2 (URL) — unblocks all SRP network calls
2. Apply fix 4.1 (echo) — security fix, independent of 4.2
3. Re-run `bun test src/__integration__/` with real Proton credentials to validate Story 7.2

**Success criteria:**
- `protondrive auth login` prompts for password without echoing it to the terminal
- `protondrive auth login` completes successfully against `mail.proton.me/api`
- Story 7.2 integration tests pass with live Proton credentials
