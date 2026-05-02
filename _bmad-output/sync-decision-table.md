# Sync Decision Table

The `computeWorkList` function in `engine/src/sync-engine.ts` compares local files, remote files, and the sync state database to produce a list of work items for each reconcile cycle.

---

## Decision Flowchart

```mermaid
flowchart TD
    Start([file path]) --> L{local exists?}

    L -- yes --> R{remote exists?}
    L -- no --> RR{remote exists?}

    R -- yes --> D{in DB?}
    R -- no --> E{in DB?}

    RR -- yes --> F{in DB?}
    RR -- no --> CCHECK{in DB?}

    E -- yes --> DEL[delete_local]
    E -- no --> UP_NEW[upload new file]

    F -- yes --> TRASH[trash_remote]
    F -- no --> DL_NEW[download new file]

    CCHECK -- yes --> CLEAR[clear_state]
    CCHECK -- no --> NOTHING[nothing]

    D -- no: bootstrap --> BT{compare mtime + size}
    D -- yes --> CH{what changed?}

    BT -- same mtime-sec + same size --> BM[bootstrap_match\nhash to confirm]
    BT -- remote newer --> DL_REV[download]
    BT -- local newer --> UP_REV[upload revision]
    BT -- same mtime-sec + diff size --> COL[new_file_collision]

    CH -- local only --> UP_REV2[upload revision]
    CH -- remote only --> DL_REV2[download revision]
    CH -- neither --> SKIP[skip]
    CH -- both changed --> CF{same-second ambiguity?}

    CF -- no --> CONF[conflict]
    CF -- yes --> HASH{same hash?}
    HASH -- yes --> SKIP
    HASH -- no --> CONF

    subgraph Legend
        L1[in DB? = does sync_state table have a row for this file?\nAbsent = file was never synced by this pair]
        L2[bootstrap = pair added for first time or re-added\nNo baseline — infer intent from mtime + size]
        L3[bootstrap_match = looks identical — hash to confirm — record state no transfer\nnew_file_collision = same mtime-sec different size — genuine content divergence\nconflict = both sides changed — save remote as .conflict copy — upload local]
    end
```

---

## Work Item Outcomes

| Outcome | Condition | Action |
|---------|-----------|--------|
| `upload` new file | local only, not in DB | New local file — upload to remote |
| `upload` revision | local + remote, in DB, local changed | Local newer than last sync — push revision |
| `download` new file | remote only, not in DB | New remote file — download to local |
| `download` revision | local + remote, in DB, remote changed | Remote newer than last sync — pull revision |
| `delete_local` | local only, in DB | Remote was deleted since last sync — remove local copy |
| `trash_remote` | remote only, in DB | Local was deleted since last sync — trash remote node |
| `bootstrap_match` | local + remote, not in DB, same mtime-sec + same size | Looks identical — hash to confirm — record state, no transfer |
| `upload` revision (bootstrap) | local + remote, not in DB, local newer | Local is ahead — upload revision, pre-seed sync state |
| `download` (bootstrap) | local + remote, not in DB, remote newer | Remote is ahead — download |
| `new_file_collision` | local + remote, not in DB, same mtime-sec + different size | Genuine content divergence — treat as conflict |
| `conflict` | local + remote, in DB, both changed | Save remote as `.conflict-YYYY-MM-DD` copy — upload local to win |
| `clear_state` | not local, not remote, in DB | Both sides deleted — remove stale DB row |
| skip | local + remote, in DB, neither changed | Already in sync — no work item |
| nothing | not local, not remote, not in DB | No footprint on either side — nothing to do |

---

## Sync State (sync_state table)

The engine's memory of what was true at the last successful sync. One row per file per sync pair.

| Column | Meaning |
|--------|---------|
| `pair_id` | Which sync pair |
| `relative_path` | File path relative to local root |
| `local_mtime` | Local mtime at last successful sync |
| `remote_mtime` | Remote mtime at last successful sync |
| `remote_node_id` | Proton Drive node UID |
| `content_hash` | File hash at last sync — used for same-second ambiguity resolution |

**Absent = bootstrap case** — file exists on one or both sides but was never tracked by this pair.
