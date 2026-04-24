# Sprint Change Proposal — 2026-04-25

**Scope:** Minor
**Status:** Approved

---

## Section 1: Issue Summary

The project declares `MIT` license throughout (root `LICENSE`, `engine/package.json`, `metainfo.xml` `<project_license>`, `README.md` badge), but bundles `@protontech/drive-sdk@0.14.3` which is **GPL-3.0**. Since `bun build --compile` embeds the SDK into the distributed Flatpak binary, the combined work is a GPL-3.0 derivative. MIT cannot satisfy GPL-3.0 copyleft requirements. Flathub review will reject this.

**Secondary finding:** `openpgp@6.3.0` is **LGPL-3.0+** — compatible with GPL-3.0; no remediation needed beyond documentation.

**Discovery context:** Identified pre-submission by Jeremy during sprint 8. Story 8-0 (Amelia, in-progress) is unaffected — no license-touching files overlap.

**npm dependency audit result:** All 56 bundled packages checked. Clean:
- MIT: bcryptjs, js-yaml, undici (and transitive deps)
- LGPL-3.0+: openpgp (compatible with GPL-3.0)
- GPL-3.0: @protontech/drive-sdk (trigger)
- No proprietary, AGPL, or GPL-incompatible licenses found.

---

## Section 2: Impact Analysis

| Area | Impact |
|------|--------|
| **Epic 8** | Add Story 8-5. Existing stories 8-0 through 8-4 unchanged. |
| **Epic 7 (in-progress)** | Story 7-2 output (`metainfo.xml`) needs a license field correction — handled in 8-5, not a reopen of 7-2. |
| **PRD** | Any reference to "MIT license" should be updated to "GPL-3.0-only". Low impact on scope. |
| **Architecture / UX / CI** | No impact. |
| **sprint-status.yaml** | Add `8-5-license-alignment: backlog`. |

---

## Section 3: Recommended Approach

**Option 1 — Direct Adjustment (selected)**

Add Story 8-5 to Epic 8. All changes are declaration/documentation only — no code logic, no architecture, no feature scope change.

- Effort: **Low** (5 files, all text edits)
- Risk: **Low** (no behavioral changes)
- Timeline: No impact on 8-0 through 8-4; can be implemented in parallel or sequentially.

---

## Section 4: Detailed Change Proposals

### Story 8-5: License Alignment (GPL-3.0)

**Change 1 — Root `LICENSE` file**
```
OLD: MIT License
NEW: GNU General Public License v3.0
```
Rationale: Combined work distributes GPL-3.0 `@protontech/drive-sdk`; copyleft requires GPL-3.0 for the distributed binary.

**Change 2 — `engine/package.json`**
```json
OLD: "license": "MIT"
NEW: "license": "GPL-3.0-only"
```

**Change 3 — `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`**
```xml
OLD: <project_license>MIT</project_license>
NEW: <project_license>GPL-3.0-only</project_license>
```

**Change 4 — `README.md`** (two occurrences)
```
OLD: [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
     MIT — see [LICENSE](./LICENSE).
NEW: [![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)
     GPL-3.0-only — see [LICENSE](./LICENSE). Bundles @protontech/drive-sdk (GPL-3.0).
```

**Change 5 — `_bmad-output/planning-artifacts/epics/epic-8-sdk-compliance-incremental-sync.md`**

Add Story 8.5 section with acceptance criteria for all of the above changes plus npm dep audit documentation.

---

## Section 5: Implementation Handoff

**Scope: Minor** — routed directly to dev team.

| Step | Who | Action |
|------|-----|--------|
| 1 | SM (Bob) | Add Story 8-5 to epic-8.md; update sprint-status.yaml; create story file |
| 2 | Dev (Amelia) | Implement 8-5 (no dependency on 8-0; can run in parallel) |
| 3 | Jeremy | Verify Flatpak build passes and `appstream-util validate` succeeds after merge |

**Success criteria:** `appstream-util validate` passes with `GPL-3.0-only`; Flatpak build succeeds; no MIT references remain in distributed artifacts (LICENSE, metainfo, package.json, README).
