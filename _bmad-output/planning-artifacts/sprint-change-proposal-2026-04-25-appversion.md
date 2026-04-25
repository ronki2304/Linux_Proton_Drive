# Sprint Change Proposal — 2026-04-25 (x-pm-appversion Compliance)

**Scope:** Minor
**Status:** Approved

---

## Section 1: Issue Summary

All Proton API requests made by `ProtonHTTPClient` in `engine/src/sdk.ts` currently inject:

```
x-pm-appversion: web-drive@5.0.0.0
```

This is the **Proton web client's identity**. Proton's API policy requires external clients to accurately identify themselves using the format `{client-id}@{version}` and explicitly prohibits spoofing or falsifying this value.

The correct identity for this application is:

```
x-pm-appversion: ronki230-ProtonDriveLinuxClient@{version}
```

**Discovery context:** Compliance requirement surfaced externally during Epic 8 sprint execution. No specific story triggered it — it is a new API policy requirement from Proton.

**Evidence:** `engine/src/sdk.ts:917` (fetchJson path) and `:949` (fetchBlob Proton-host path) both contain the hardcoded string `"web-drive@5.0.0.0"`.

---

## Section 2: Impact Analysis

| Area | Impact |
|------|--------|
| **Epic 8 (in-progress)** | Add Story 8-6. Stories 8-0 through 8-5 unchanged. |
| **Epic 7 (in-progress)** | None — Story 7-4 unaffected. |
| **Epics 1–6** | None — all done. |
| **PRD** | None — PRD security section delegates all network I/O to the SDK; this change is our HTTP adapter, within that boundary. |
| **Architecture** | None — change correctly scoped to `sdk.ts` (the SDK boundary). |
| **UX / CI** | None. |
| **sprint-status.yaml** | Add `8-6-sdk-client-identification: backlog`. |

---

## Section 3: Recommended Approach

**Option 1 — Direct Adjustment (selected)**

Add Story 8-6 to Epic 8. All changes confined to `engine/src/sdk.ts` and its test file. Version string is sourced from `engine/package.json` — already managed by `bump-version.sh` (Story 8-4). One source of truth, no drift.

- Effort: **Low** (2 lines changed, 1 constant added, 3 tests)
- Risk: **Low** (no behavioral changes beyond the header value; storage-host exclusion path unchanged)
- Timeline: No impact on any in-progress work.

---

## Section 4: Detailed Change Proposals

### Change 1 — `engine/src/sdk.ts`: `ProtonHTTPClient` constructor

**Section:** `ProtonHTTPClient` class (~line 910)

```
OLD:
class ProtonHTTPClient implements ProtonDriveHTTPClient {
  constructor(private readonly token: string, private readonly uid?: string) {}
  ...
  // Lines 917, 949:
  headers.set("x-pm-appversion", "web-drive@5.0.0.0");

NEW:
class ProtonHTTPClient implements ProtonDriveHTTPClient {
  constructor(
    private readonly token: string,
    private readonly appVersion: string,
    private readonly uid?: string
  ) {}
  ...
  // Lines 917, 949:
  headers.set("x-pm-appversion", this.appVersion);
```

Rationale: Removes hardcoded web-client identity. Makes version injectable — no more spoofing.

---

### Change 2 — `engine/src/sdk.ts`: `DriveClient` construction site

```
OLD:
new ProtonHTTPClient(token, uid)

NEW:
import pkg from "../package.json" with { type: "json" };

const APP_VERSION = `ronki230-ProtonDriveLinuxClient@${pkg.version}`;

...

new ProtonHTTPClient(token, APP_VERSION, uid)
```

Rationale: `package.json` is the single version source of truth. JSON import assertion pattern matches project conventions (`project-context.md`). Module-level constant — evaluated once at startup.

---

### Change 3 — `engine/src/sdk.test.ts`: Test coverage

```
NEW tests:
- "ProtonHTTPClient injects correct x-pm-appversion on fetchJson"
    Construct with known appVersion, mock fetch, assert header value

- "ProtonHTTPClient injects correct x-pm-appversion on fetchBlob (Proton API host)"
    URL: proton.me/drive — assert header present with correct value

- "ProtonHTTPClient does NOT inject x-pm-appversion on fetchBlob (storage host)"
    URL: fra-storage.proton.me — assert header absent
```

Rationale: Storage-host exclusion is a security boundary (wrong headers cause storage servers to reject uploads). All three paths require explicit coverage.

---

### Change 4 — Epic 8 + `sprint-status.yaml`: Add Story 8-6

**epic-8-sdk-compliance-incremental-sync.md** — append:

```markdown
## Story 8-6: SDK Client Identification — x-pm-appversion Header

As a maintainer,
I want all Proton API requests to carry the correct x-pm-appversion header,
So that the app accurately identifies itself and does not spoof another Proton client.

**Background:** ProtonHTTPClient in sdk.ts previously injected "web-drive@5.0.0.0" —
the web client's identity. Proton's API policy requires external clients to use the
format {client-id}@{version} and prohibits spoofing. This app's correct identity is
ronki230-ProtonDriveLinuxClient@{version}.

**Acceptance Criteria:**

Given any Proton API request (fetchJson or fetchBlob to a proton.me/drive or
protonmail.com host)
When the engine makes an API call
Then the x-pm-appversion header is set to ronki230-ProtonDriveLinuxClient@{version}
And {version} matches the "version" field in engine/package.json

Given a fetchBlob request to a storage host (e.g. fra-storage.proton.me)
When the engine uploads a file block
Then x-pm-appversion is NOT set (storage servers reject Proton API headers)

Given the test suite
When this story is complete
Then tests cover: fetchJson header injection, fetchBlob Proton-host injection,
  fetchBlob storage-host exclusion
```

**sprint-status.yaml** — add after `8-5-license-alignment: done`:
```yaml
8-6-sdk-client-identification: backlog
```

---

## Section 5: Implementation Handoff

**Scope: Minor** — routed directly to dev team.

| Step | Who | Action |
|------|-----|--------|
| 1 | SM (Bob) | Add Story 8-6 to `epic-8.md`; update `sprint-status.yaml`; create story file |
| 2 | Dev | Implement Changes 1–3 in `engine/src/sdk.ts` and `sdk.test.ts` |
| 3 | Jeremy | Verify `bun test` passes; confirm header value in debug log (`PROTONDRIVE_DEBUG=1`) |

**Success criteria:**
- `bun test` passes with 3 new SDK header tests
- `x-pm-appversion: ronki230-ProtonDriveLinuxClient@0.1.0` appears in Proton API requests
- `x-pm-appversion` absent from storage-host requests
- No `"web-drive@5.0.0.0"` string remains in the codebase
