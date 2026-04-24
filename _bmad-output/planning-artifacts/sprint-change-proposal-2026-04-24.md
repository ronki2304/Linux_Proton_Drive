# Sprint Change Proposal — 2026-04-24

**Scope:** Minor
**Status:** Approved

---

## Section 1: Issue Summary

Story 7-4 (End-to-End MVP Validation & Manual Test Protocol) is a two-phase story. Phase 1 (TESTING.md creation, Tasks 1–5) was completed by the dev agent on 2026-04-23. Phase 2 (Task 6 — cross-distro execution of all 5 user journeys across Fedora 43, Ubuntu 24, Ubuntu 25, Bazzite, and Arch) is a human-only task that cannot be performed by a dev agent and requires Jeremy's time on hardware.

Rather than blocking Epic 8 (SDK Compliance & Incremental Sync) while waiting for Jeremy's hardware testing window, the team will proceed with Epic 8 development and return to 7-4 Phase 2 afterward.

## Section 2: Impact Analysis

- **Epic 7:** Stays `in-progress`. Story 7-4 stays `in-progress`. No status or scope changes.
- **Epic 8:** Unaffected. Proceeds to story creation as next active epic.
- **PRD:** No change. Validation requirement remains in scope — this is a timing deferral, not scope reduction.
- **Architecture / UX / CI/CD:** No impact.
- **sprint-status.yaml:** No changes required — current state already reflects the correct picture.

## Section 3: Recommended Approach

**Option 1 — Direct Adjustment (selected)**

Proceed immediately to Epic 8 story creation. Story 7-4 Phase 2 is parked as `in-progress` until Jeremy completes the cross-distro runs. No rollback, no MVP scope reduction required.

- Effort: Low
- Risk: Low
- Timeline impact: None — Epic 8 was always next; this change simply makes the sequencing explicit.

## Section 4: Detailed Change Proposals

No artifact changes required. The sprint-status.yaml, story file, and epic files all already reflect the correct state.

## Section 5: Implementation Handoff

**Scope: Minor** — handled directly by SM + Dev.

| Step | Who | Action |
|------|-----|--------|
| 1 | SM (Bob) | Create first story for Epic 8 via `bmad-create-story` |
| 2 | Dev (Amelia) | Implement Epic 8 stories in sequence |
| 3 | Jeremy | When hardware window opens: execute 7-4 Task 6 across 5 distros, mark story `review` |
| 4 | Dev (Amelia) | Code review pass on 7-4 (documentation-only, will be quick) |
| 5 | SM (Bob) | Close epic-7, run retrospective |

**Success criteria:** Epic 8 stories created and in-progress; 7-4 Phase 2 completed and marked `done` before Flathub submission.
