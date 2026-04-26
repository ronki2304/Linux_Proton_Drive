# Sprint Change Proposal — Targeted drainQueue Lookups
**Date:** 2026-04-26  
**Scope:** Minor — engine optimization, no IPC/UI changes  
**Epic:** 8 — SDK Compliance & Incremental Sync  

---

## Section 1: Issue Summary

**Problem statement:**  
`drainQueue` performs a full `walkRemoteTree` for every pair that has queue items, regardless of how many items exist or whether their remote node IDs are already known. Even a single stale queue entry (e.g. from a NodeUpdated remote event for a file we just uploaded) forces a complete recursive traversal of the remote folder tree — which for large pairs like Pictures can generate 1,000+ API calls.

**When discovered:**  
Observed during Epic 8 live testing (2026-04-26). After fixing the `.reconcile-trigger` and stale-entry bugs, user still sees what looks like a reconciliation on every startup with pending queue items, because `drainQueue`'s per-pair `walkRemoteTree` is the dominant cost.

**Evidence:**  
Wake MCP log for session id:387 showed 1,021 API calls in 2m22s at startup — entirely `walkRemoteTree` folder traversals triggered by 3 pending change_queue items. Story 8-1's checkpoint correctly skipped `reconcileAndEnqueue`, but `drainQueue` ran its own full walk anyway.

---

## Section 2: Impact Analysis

**Epic Impact:** Epic 8 only. Stories 8-1 through 8-6 are done and unaffected.

**Story Impact:** New story required — Story 8-7. No existing story covers this optimization.

**Artifact Conflicts:**  
- `epic-8-sdk-compliance-incremental-sync.md` — add Story 8-7 entry  
- `sprint-status.yaml` — add `8-7-targeted-drain-queue-lookups: backlog`

**Technical Impact:**  
- `engine/src/sync-engine.ts` — `drainQueue` method refactored  
- `engine/src/sdk.ts` — `getRemoteNode` already exists, no new SDK methods needed  
- `engine/src/state-db.ts` — `findSyncStateByRemoteNodeId` already exists  
- No IPC protocol changes  
- No UI changes  

---

## Section 3: Recommended Approach

**Direct Adjustment** — add Story 8-7 to Epic 8 backlog. Implement after current sync stabilises.

**Rationale:** The three bugfixes already committed (NodeDeleted targeted handling, stale-entry skip, `.reconcile-trigger` cleanup) resolve the correctness issues. This story addresses the remaining performance concern: the `walkRemoteTree` that `drainQueue` does is legitimate for new files but unnecessary for files already tracked in `sync_state`.

**Effort estimate:** Medium (half-day). The `drainQueue` refactor is self-contained; no protocol or UI surface changes.  
**Risk:** Low. `walkRemoteTree` fallback path preserved for all cases where targeted lookup is insufficient.  
**Timeline impact:** None to current sprint. Slot after 8-4b or as the final Epic 8 story.

---

## Section 4: Detailed Change Proposals

### Story Addition — Epic 8 file

```
Story: [8-7] Targeted drainQueue Lookups
Section: New story appended to epic-8-sdk-compliance-incremental-sync.md

ADD:
---
## Story 8-7: Targeted drainQueue Lookups

As a user,
I want the sync engine to perform minimal API calls when draining a small queue,
So that restarting the app does not trigger a full remote tree traversal for a handful of pending files.

[Full story text — see Section 5 below]

Rationale: drainQueue currently does walkRemoteTree once per pair that has queue items.
For entries with a known remote_node_id in sync_state, a single getRemoteNode call
is sufficient. walkRemoteTree is only needed when remote_node_id is unknown (new files).
```

### sprint-status.yaml addition

```
OLD:
  8-6-sdk-client-identification: done

NEW:
  8-6-sdk-client-identification: done
  8-7-targeted-drain-queue-lookups: backlog
```

---

## Section 5: Story 8-7 Full Text

See `epic-8-sdk-compliance-incremental-sync.md` — Story 8-7 is the authoritative source.

**Design summary:**  
Add a `sync_folder` table `(pair_id, relative_path, remote_node_id)` to persist the remote folder IDs that `reconcilePair` already discovers but discards. Keep it current via:
- `reconcilePair` — upsert all folders after each walk; upsert immediately on folder creation
- `drainEventQueue` — upsert on `NodeCreated` (folder), remove on `NodeDeleted`

`drainQueue` then resolves parent folder IDs from `sync_folder` and file remote state via `getRemoteNode` — no `walkRemoteTree` in steady state. Fallback to `walkRemoteTree` only when `sync_folder` is incomplete, and populate it from that walk so subsequent drains are zero-API-call overhead.

---

## Section 6: Implementation Handoff

**Scope classification:** Minor — direct implementation by dev team.  
**Handoff:** Dev agent (Claude Code), Epic 8 sprint, after current sync stabilises.  
**Success criteria:** On restart with 1–3 pending queue items for tracked files, zero `walkRemoteTree` calls. API call count proportional to queue size, not folder tree depth.
