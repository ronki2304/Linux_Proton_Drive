# Sprint Change Proposal: Proton API HTTP 400 on Auth Request

**Project:** ProtonDrive-LinuxClient
**Date:** 2026-04-05
**Author:** John (Product Manager)
**Status:** Approved

---

## Section 1: Issue Summary

Story 7.2 (Live ProtonDrive Integration Tests) re-validation run — the first live API test
run after the auth-bugs sprint change proposal was implemented — reveals that both
`auth.integration.test.ts` and `sync.integration.test.ts` fail with **HTTP 400 Bad Request**
from Proton's API. The 400 fires at the first network call (`POST /auth/v4/info`) before any
SRP logic executes, confirming the request itself is malformed.

Credentials are confirmed valid. The URL (`mail.proton.me/api`) is confirmed correct. The
`x-pm-appversion: linux-drive@1.0.0+protondrive-cli` header is the primary suspect — Proton
validates app identifiers and rejects unrecognized values with 400. Secondary suspects include
new required headers added to Proton's API since the SRP implementation was written.

A compounding factor: `fetchJson` discards the 400 response body, making the exact rejection
reason invisible. Any fix without first reading that body is a guess.

**Discovery context:** Re-validation run of Story 7.2 post-auth-bugs sprint change proposal
(2026-04-05). First time the auth code has successfully reached Proton's servers.

---

## Section 2: Impact Analysis

**Epic Impact:**

| Epic | Impact |
|------|--------|
| Epic 7 (Integration Testing & Packaging) | Story 7.2 remains `done (re-validation required)` until fixed |
| Epic 2 (Secure Authentication) | Root cause lives here — `authenticate()` / `fetchJson` in `src/auth/srp.ts` |
| Epics 1, 3–6, 8 | Unaffected |

**Story Impact:**

| Story | Impact |
|-------|--------|
| 7.2 Live integration tests | Remains `done (re-validation required)` — re-run required after fix |
| All other stories | Unaffected |

**PRD Impact:** None. No requirement text changes needed.

**Architecture Impact:** Minor doc gap — required Proton HTTP headers not documented.
One-line note recommended post-fix. Not blocking.

**UX/UI Impact:** None — CLI output paths unaffected.

---

## Section 3: Recommended Approach

**Selected: Option 1 — Direct Adjustment**

One new story (`9-1-fix-proton-api-400-auth-request`) with two sequential sub-tasks:
(1) capture the 400 response body in `fetchJson` to make the rejection reason visible,
(2) run integration tests to read the body, then apply the targeted fix.

No rollback, no scope reduction, no resequencing. Effort: Low. Risk: Low-Medium (exact fix
unknown until body is read, but the diagnostic step is cheap and deterministic).
Timeline impact: zero — no other work depends on this.

---

## Section 4: Detailed Change Proposals

### 4.1 — `src/auth/srp.ts` — `fetchJson` body capture

**File:** `src/auth/srp.ts`
**Section:** `fetchJson` non-OK branch, lines 185–194

```typescript
// OLD
if (!response.ok && response.status !== 422) {
  const error = new NetworkError(
    `HTTP ${response.status} from Proton API`,
    "NETWORK_HTTP_ERROR",
  );
  if (!isRetryableStatus(response.status)) {
    throw error;
  }
  lastError = error;
  continue;
}

// NEW
if (!response.ok && response.status !== 422) {
  let body = "";
  try { body = await response.text(); } catch { /* ignore */ }
  const detail = body ? ` — ${body.slice(0, 300)}` : "";
  const error = new NetworkError(
    `HTTP ${response.status} from Proton API${detail}`,
    "NETWORK_HTTP_ERROR",
  );
  if (!isRetryableStatus(response.status)) {
    throw error;
  }
  lastError = error;
  continue;
}
```

**Rationale:** Proton returns a JSON body on 400 describing the exact rejection reason.
Without reading it, every diagnosis is a guess. Body capped at 300 chars to avoid flooding
output; tokens are never present in error responses at this stage of auth.

### 4.2 — New Story File

**File:** `_bmad-output/implementation-artifacts/9-1-fix-proton-api-400-auth-request.md`

Full story content — see story file (created as part of this proposal).

### 4.3 — Story 7.2 Status

Remains `done (re-validation required)` until Story 9.1 AC3 passes (all integration tests
green against live Proton credentials).

---

## Section 5: Implementation Handoff

**Scope classification: Minor** — one story, one source file modified, one new story file.
Direct implementation by dev team.

**Recommended sequencing:**
1. Create story file for 9.1 (`bmad-create-story` or manual)
2. Dev agent implements story 9.1 (`/bmad-dev-story`)
3. Run `bun test src/__integration__/` — capture 400 body, apply header fix
4. Re-run integration tests — confirm 0 failures
5. Update Story 7.2 status to `done`
6. Add one-line Proton required-headers note to `architecture.md` (optional, 5 min)

**Success criteria:**
- `bun test src/__integration__/` passes with 0 failures against live Proton credentials
- Story 7.2 status updated to `done`
- `NetworkError` on any future Proton 400 includes the response body for immediate diagnosis
- Story 9.1 unit tests pass (body capture does not break existing srp unit tests)
