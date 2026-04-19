# Story 5.9: Actionable Error — SDK/API Error & Error State Components

Status: done

## Story

As a user,
I want a clear message for unexpected sync errors and reliable error state display,
so that I have a starting point for troubleshooting and can always see the real sync status.

## Acceptance Criteria

### AC1 — SDK_ERROR emitted for non-specific errors in reconcilePair

**Given** the sync engine encounters an error in `reconcilePair` not classified by `isAuthExpired`, `isDiskFull`, `isPermissionDenied`, or `isFileLocked`
**When** the error is processed
**Then** an `error` push event is emitted with:
  - `code: "SDK_ERROR"`
  - `message: "Sync error <errCode> — try again or check ProtonDrive status"` (where `<errCode>` is `(err as NodeJS.ErrnoException).code` if present, else omit and use `"Sync error — try again or check ProtonDrive status"`)
  - `pair_id: <affected pair's pair_id>`

### AC2 — SDK_ERROR emitted for non-specific errors in processQueueEntry

**Given** the sync engine encounters an error in `processQueueEntry` not classified by `isAuthExpired` or `isDiskFull`, `isPermissionDenied`, or `isFileLocked`
**When** the error is processed
**Then** an `error` push event is emitted with `code: "SDK_ERROR"` and the same message format as AC1

### AC3 — Error state components: priority, persistence, multi-pair

**Given** the UI receives any non-fatal `error` event with a `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a **red dot** and `status_label` "Sync error" (already done in 5-5)
**And** the accessible label is `"[pair name] — error"` (already done in 5-5)
**And** the `StatusFooterBar` shows `"Sync error in [pair name]"` with a red dot
**And** the error priority is highest: **Error > Conflict > Syncing > Offline > All synced**
**And** the error persists across `on_online` (going back online does NOT clear error state)
**And** the error persists across `on_sync_complete` until a full sync cycle completes with no new errors for that pair
**And** when two or more pairs have errors, the footer shows `"Sync error in N pairs"` (not just the last-received pair name)

### AC4 — Fatal error: engine crash shows app-level banner with restart button

**Given** the engine crashes (socket closed without a `shutdown` command — `fatal=True` in `_on_engine_error`)
**When** the UI detects it
**Then** an app-level `Adw.Banner` labelled `"Sync engine stopped — restart to resume"` is shown with a `"Restart"` button
**And** this is NOT the inline pair card error — no `SyncPairRow` state changes
**And** the `session_expired_banner` is unaffected
**And** clicking "Restart" calls `app._engine.restart()` and hides the banner

### AC5 — Screen-reader flood prevention

**Given** multiple `error` events arrive in the same sync cycle (e.g., multiple locked files)
**When** the `StatusFooterBar` is already in error state
**Then** the `self.announce()` call fires only on the **first transition** into error state, not on subsequent `set_error()` calls while already in error

### AC6 — Accessibility: screen reader reads error state

**Given** the error state components
**When** a screen reader reads the sidebar and footer
**Then** pair error state is announced: `"[pair name] — error"`
**And** footer announces `"Sync error in [pair name]"` (already done; guard: no flood)

---

## Developer Context

### Architecture Overview — READ THIS FIRST

This is the final Story 5 story. It delivers two parallel tracks:

**Track A — Engine (TypeScript/Bun):** Replace all remaining generic error codes (`sync_file_error`, `queue_replay_failed`) with `SDK_ERROR`. This is a pure rename across 10 emit sites — no new helper function, no control flow changes.

**Track B — UI (Python/GTK4):** Complete the error state component work deferred from Stories 5-5 through 5-8:
1. Fatal error banner (new `AdwBanner engine_crashed_banner` in `window.blp` + wiring)
2. Error state tracking (`_error_pair_ids`, `_error_pending_cycle` sets in `window.py`)
3. `on_online` fix — preserve error-state rows when back online
4. `on_sync_complete` fix — cycle-based error clearing
5. Multi-pair footer — show "Sync error in N pairs" correctly
6. Screen-reader flood fix — `StatusFooterBar.set_error()` announces only on first error transition

**Prerequisites:** Stories 5-6, 5-7, and 5-8 must be complete before implementing 5-9 (the engine tests reference `isPermissionDenied` and `isFileLocked` helpers added in those stories). Run baseline tests first to confirm.

---

### Track A: Engine Changes (`engine/src/sync-engine.ts`)

No new helper function is needed. SDK_ERROR is the catch-all fallback — it fires when none of the specific classifiers match.

#### Message format (use at ALL 10 sites)

```ts
const errCode = (err as NodeJS.ErrnoException).code;
const message = errCode
  ? `Sync error ${errCode} — try again or check ProtonDrive status`
  : "Sync error — try again or check ProtonDrive status";
```

#### Sites in `reconcilePair` — change `code: "sync_file_error"` → `code: "SDK_ERROR"` (6 sites)

After all preceding checks (`isAuthExpired`, `isDiskFull`, `isPermissionDenied` added by 5-6, `isFileLocked` added by 5-8), the final fallback in each catch block currently emits `sync_file_error`. Replace with `SDK_ERROR` and use the message format above.

| Site | ~Line (pre-5-6) | Context | emitEvent pattern |
|------|------------|---------|-------------------|
| R1 | ~316 | conflict copy `copyFile`/`rename` catch | `continue` (after isFileLocked block) |
| R2 | ~357 | `conflict_update` download catch | `continue` |
| R3 | ~380 | collision rename catch | `continue` |
| R4 | ~421 | collision download catch | `continue` |
| R5 | ~436 | `delete_local` `unlink` catch | `continue` — **no** isPermissionDenied/isFileLocked check precedes this; insert just before existing `emitEvent` |
| R6 | ~507 | main download loop catch | `continue` |

> **R5 note:** The `delete_local` catch was explicitly excluded from `isPermissionDenied` in 5-6 and from `isFileLocked` in 5-8 (both stories noted "unlink EACCES/EBUSY out of scope"). In 5-9, just rename the existing `sync_file_error` code to `SDK_ERROR` — do NOT add isPermissionDenied/isFileLocked checks here.

After applying message format at R5, also delete the old `msg` variable since only the debug log and the new `message` variable are needed:
```ts
// Before 5-9 (R5):
const msg = err instanceof Error ? err.message : "unknown";
debugLog(`sync-engine: delete_local failed for ${item.relativePath}: ${msg}`);
this.emitEvent({ type: "error", payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id } });

// After 5-9 (R5):
const errMsg = err instanceof Error ? err.message : "unknown";
const errCode = (err as NodeJS.ErrnoException).code;
const message = errCode
  ? `Sync error ${errCode} — try again or check ProtonDrive status`
  : "Sync error — try again or check ProtonDrive status";
debugLog(`sync-engine: delete_local failed for ${item.relativePath}: ${errMsg}`);
this.emitEvent({ type: "error", payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id } });
```

At R6 (~507), there is a `process.stderr.write(...)` debug line above the existing emit — leave that line intact, it's a debug diagnostic.

#### Sites in `processQueueEntry` — change `code: "queue_replay_failed"` → `code: "SDK_ERROR"` (4 sites)

| Site | ~Line | Context |
|------|-------|---------|
| Q1 | ~612 | `walkRemoteTree` failure — emits in a `for` loop over all `pairQueue` entries |
| Q2 | ~753 | Remote parent folder not found during upload |
| Q3 | ~785 | `stat()` failure for local file (non-ENOENT) |
| Q4 | ~884 | `processQueueEntry` outer catch — after isDiskFull, isPermissionDenied, isFileLocked checks |

**Q1 pattern** (loop, keep the `for` loop structure, just change code+message):
```ts
// Before:
this.emitEvent({
  type: "error",
  payload: {
    code: "queue_replay_failed",
    message: msg,
    pair_id: pair.pair_id,
    relative_path: entry.relative_path,
  },
});
// After — compute message before the loop, use same errCode pattern:
const errCode = (err as NodeJS.ErrnoException).code;
const message = errCode
  ? `Sync error ${errCode} — try again or check ProtonDrive status`
  : "Sync error — try again or check ProtonDrive status";
// then inside the loop:
this.emitEvent({
  type: "error",
  payload: {
    code: "SDK_ERROR",
    message,
    pair_id: pair.pair_id,
    relative_path: entry.relative_path,
  },
});
```

**Q2 pattern** (hardcoded "remote parent folder not found" message → replace with standard):
```ts
// Before: message: "remote parent folder not found"
// After: compute and use standard message (no err.code for this case → generic message)
const message = "Sync error — try again or check ProtonDrive status";
this.emitEvent({ type: "error", payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id, relative_path: entry.relative_path } });
```

**Q3 pattern** (stat failure — has err, has err.code, pattern same as R1-R6):
```ts
const errCode = (err as NodeJS.ErrnoException).code;
const message = errCode
  ? `Sync error ${errCode} — try again or check ProtonDrive status`
  : "Sync error — try again or check ProtonDrive status";
this.emitEvent({ type: "error", payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id, relative_path: entry.relative_path } });
```

**Q4 pattern** (outer catch — after isPermissionDenied, isFileLocked checks from 5-6/5-8, same as R1-R6):
```ts
const errCode = (err as NodeJS.ErrnoException).code;
const message = errCode
  ? `Sync error ${errCode} — try again or check ProtonDrive status`
  : "Sync error — try again or check ProtonDrive status";
this.emitEvent({
  type: "error",
  payload: { code: "SDK_ERROR", message, pair_id: pair.pair_id, relative_path: entry.relative_path },
});
return "failed";
```

#### What NOT to change in sync-engine.ts

- `code: "sync_cycle_error"` (~line 452, `trash_remote` catch) — this is a distinct operation with its own code; leave unchanged
- `code: "DISK_FULL"`, `code: "PERMISSION_DENIED"`, `code: "FILE_LOCKED"` — specific codes from 5-5/5-6/5-8; do NOT change
- The `isFetchFailure` check after Q4 (~line 892) — leave intact; it triggers offline detection for network failures
- `isAuthExpired` checks — always remain first in every catch block
- `debugLog` lines — rename `msg` to `errMsg` only where the variable conflict with the new `message` variable arises

#### Update existing tests that assert old error codes

> ⚠️ **CRITICAL:** Existing tests assert `sync_file_error` and `queue_replay_failed` codes. These will FAIL after renaming. Update them before running the new test suite.

In `engine/src/sync-engine.test.ts`, find and update:
- All `expect(...).toBe("sync_file_error")` → `expect(...).toBe("SDK_ERROR")`
- All `expect(...).toBe("queue_replay_failed")` → `expect(...).toBe("SDK_ERROR")`
- Test descriptions referencing "sync_file_error" or "queue_replay_failed" — update to "SDK_ERROR" for clarity

Known test lines to update (line numbers from 5-5-baseline; may shift with 5-6/5-8 additions):
- ~338: test `"rename fails → sync_file_error emitted"` — update name + assertion
- ~367/369: assertion `code === "sync_file_error"` — update to `"SDK_ERROR"`
- ~1381/1386: assertion `.toBe("queue_replay_failed")` — update to `"SDK_ERROR"`
- ~1883: test `"delete_local EPERM failure → sync_file_error"` — update name + assertion
- ~1907: `expect(...).toBe("sync_file_error")` — update
- ~2017/2055/2058: `"conflict copy creation fails → sync_file_error"` — update name + assertion
- ~2243: `"non-ENOSPC error in processQueueEntry → queue_replay_failed emitted"` — update both name and assertion
- ~2269: assertion for `queue_replay_failed` — update

Also update the negative-assertion tests:
- ~2205/2238: `"ENOSPC via processQueueEntry → DISK_FULL emitted, queue_replay_failed NOT emitted"` → update to confirm DISK_FULL emitted and SDK_ERROR NOT emitted

---

### Track B: UI Changes

#### 1. `ui/data/ui/window.blp` — add `engine_crashed_banner`

Add a second `[top]` `Adw.Banner` in the sidebar's `Adw.ToolbarView`, immediately after `session_expired_banner`:

```blp
[top]
Adw.Banner engine_crashed_banner {
  title: _("Sync engine stopped — restart to resume");
  revealed: false;
  button-label: _("Restart");
  styles ["error"]
}
```

The full `[top]` section in the ToolbarView becomes:
```blp
[top]
Adw.HeaderBar {}

[top]
Adw.Banner session_expired_banner {
  title: _("Session expired — sign in to resume sync");
  revealed: false;
  button-label: _("Sign in");
  styles ["error"]
}

[top]
Adw.Banner engine_crashed_banner {
  title: _("Sync engine stopped — restart to resume");
  revealed: false;
  button-label: _("Restart");
  styles ["error"]
}
```

> **Blueprint rule:** All widget structure lives in `.blp`, never in Python. The banner must be declared here, not created dynamically in Python.

#### 2. `ui/src/protondrive/window.py` — error state tracking + banner wiring

**New Template.Child:**
```python
engine_crashed_banner: Adw.Banner = Gtk.Template.Child()
```

Add alongside `session_expired_banner` in the class body.

**New instance variables** (add to `__init__` after `_conflict_pending_count`):
```python
# Error state tracking (Story 5-9).
# _error_pair_ids: pairs currently in error state (persists until cleared)
# _error_pending_cycle: pairs that received an error event in the current sync cycle
# Used to clear error state only when a full cycle completes with no new errors.
self._error_pair_ids: set[str] = set()
self._error_pending_cycle: set[str] = set()
```

**Connect button-clicked** (add to `__init__` after session_expired_banner.connect):
```python
self.engine_crashed_banner.connect(
    "button-clicked", self._on_engine_crashed_banner_clicked
)
```

**New methods:**
```python
def show_engine_crashed_banner(self) -> None:
    """Show engine crash banner with restart button (Story 5-9 AC4)."""
    self.engine_crashed_banner.set_revealed(True)

def hide_engine_crashed_banner(self) -> None:
    """Hide engine crash banner."""
    self.engine_crashed_banner.set_revealed(False)

def _on_engine_crashed_banner_clicked(self, _banner: Adw.Banner) -> None:
    """Restart the sync engine on banner button click."""
    self.hide_engine_crashed_banner()
    app = self.get_application()
    if app is not None and hasattr(app, "_engine") and app._engine is not None:
        app._engine.restart()

def _update_footer_error_state(self) -> None:
    """Update footer to show error state for one or more pairs (Story 5-9 AC3, AC5)."""
    count = len(self._error_pair_ids)
    if count == 0:
        return
    if count == 1:
        pair_id = next(iter(self._error_pair_ids))
        self.status_footer_bar.set_error(self._get_pair_name(pair_id))
    else:
        self.status_footer_bar.set_error(f"{count} pairs")
```

**Update `clear_session`** — add to the existing clearing block:
```python
self._error_pair_ids = set()
self._error_pending_cycle = set()
self.hide_engine_crashed_banner()
```

**Update `on_pair_error`** — replace current implementation:
```python
def on_pair_error(self, pair_id: str, _message: str) -> None:
    """Handle engine error for a specific sync pair (Story 5-5 AC3, AC4; 5-9 AC3, AC5)."""
    row = self._sync_pair_rows.get(pair_id)
    if row is None:
        return
    row.set_state("error")
    self._error_pair_ids.add(pair_id)
    self._error_pending_cycle.add(pair_id)
    self._update_footer_error_state()
```

**Update `on_online`** — preserve error-state rows when coming back online:
```python
def on_online(self) -> None:
    """Return all pair rows and footer bar to synced state."""
    for pair_id, row in self._sync_pair_rows.items():
        if pair_id in self._error_pair_ids:
            continue  # preserve error state — on_online must not clear it (Story 5-9 AC3)
        pair_conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        if pair_conflict_count > 0:
            row.set_state("conflict", conflict_count=pair_conflict_count)
        else:
            row.set_state("synced")
    # Footer: Error > conflict > synced
    if self._error_pair_ids:
        self._update_footer_error_state()
        return
    if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
        return
    any_syncing = any(r.state == "syncing" for r in self._sync_pair_rows.values())
    if not any_syncing:
        self.status_footer_bar.update_all_synced()
```

**Update `on_sync_complete`** — cycle-based error clearing + footer priority:

In the row state update block, add the error-state guard:
```python
row = self._sync_pair_rows.get(pair_id)
if row is not None and row.state != "offline":
    if pair_id in self._error_pair_ids:
        # Cycle-based error clearing: if no new error arrived this cycle for this pair,
        # clear error state. If error arrived again this cycle, keep it and reset the flag.
        if pair_id in self._error_pending_cycle:
            self._error_pending_cycle.discard(pair_id)  # reset for next cycle; keep error
        else:
            self._error_pair_ids.discard(pair_id)  # clean cycle — clear error
            if pair_conflict_count > 0:
                row.set_state("conflict", conflict_count=pair_conflict_count)
            else:
                row.set_state("synced")
    elif pair_conflict_count > 0:
        row.set_state("conflict", conflict_count=pair_conflict_count)
    else:
        row.set_state("synced")
```

In the footer update block at the end of `on_sync_complete`, replace:
```python
# Footer update — Error > Conflict > _conflict_pending > all-synced (Story 5-9 AC3)
if self._error_pair_ids:
    self._update_footer_error_state()
    return
total_conflicts = self._total_active_conflicts()
if total_conflicts > 0:
    self.status_footer_bar.set_conflicts(total_conflicts)
    return
if self._conflict_pending_count > 0:
    return
if self._sync_pair_rows and all(
    r.state == "synced" for r in self._sync_pair_rows.values()
):
    self.status_footer_bar.update_all_synced()
```

**Update `on_sync_progress`** — Error > Syncing in footer:
```python
# Conflict > Syncing: only update footer to "syncing" if no active conflicts or errors.
if self._total_active_conflicts() == 0 and not self._error_pair_ids:
    self.status_footer_bar.set_syncing(pair_name, files_done, files_total)
```

**Update `on_watcher_status`** — add error check to 'ready' branch:
```python
elif status == "ready":
    if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
        return
    if self._error_pair_ids:  # Story 5-9: error > synced
        return
    any_syncing = any(r.state == "syncing" for r in self._sync_pair_rows.values())
    any_offline = any(r.state == "offline" for r in self._sync_pair_rows.values())
    if not any_syncing and not any_offline:
        self.status_footer_bar.update_all_synced()
```

**Update `on_queue_replay_complete`** — add error check to `update_all_synced` path:
```python
elif had_pending_before:
    if not self._error_pair_ids:  # don't override error state
        self.status_footer_bar.update_all_synced()
```
(The `skipped > 0` branch can stay as-is; `set_conflict_pending` doesn't override error priority since it only fires when skipped > 0, and in that case showing conflict-pending is appropriate.)

#### 3. `ui/src/protondrive/main.py` — fatal error routing

**Update `_on_engine_error`**:
```python
def _on_engine_error(self, message: str, fatal: bool, pair_id: str | None = None) -> None:
    """Dispatch engine errors to appropriate UI surface (Story 5-5; 5-9 AC4)."""
    if fatal:
        if self._window is not None:
            self._window.show_engine_crashed_banner()
        return
    if pair_id is not None and self._window is not None:
        self._window.on_pair_error(pair_id, message)
```

#### 4. `ui/src/protondrive/widgets/status_footer_bar.py` — screen-reader flood fix

**Update `set_error`** — announce only on first transition into error state:
```python
def set_error(self, label: str) -> None:
    """Show sync error state for one or more pairs (Story 5-5; 5-9 AC5)."""
    text = f"Sync error in {label}"
    self.footer_label.set_text(text)
    already_error = self._dot_state == "error"
    self._set_dot_state("error")
    self.update_property([Gtk.AccessibleProperty.LABEL], [text])
    if not already_error:
        # Announce only on first transition to error state — prevents screen-reader
        # flood when multiple error events arrive in the same sync cycle (Story 5-9 AC5).
        self.announce(text, Gtk.AccessibleAnnouncementPriority.HIGH)
```

> Note: `_set_dot_state("error")` doesn't add a CSS class (no `sync-dot-error` class exists); the red dot color is handled by `_on_dot_draw` via `_dot_state == "error"`. This is correct — do NOT add a CSS class for error.

---

### Critical behavioral notes

#### Why cycle-based error clearing (not persistent until restart)

Simply persisting error state until `clear_session()` is too aggressive — FILE_LOCKED errors are transient. The cycle-based approach:
- `_error_pending_cycle` tracks pairs that received an error event in the current sync cycle
- `on_sync_complete` fires after a drain/reconcile cycle completes for a pair
- If `pair_id` is in `_error_pending_cycle` when `on_sync_complete` fires → errors are ongoing → keep error state, clear the pending flag for next cycle
- If `pair_id` is NOT in `_error_pending_cycle` → clean cycle → clear error state, row returns to synced/conflict

This correctly handles:
- FILE_LOCKED (transient): clears after first clean cycle
- PERMISSION_DENIED (persistent): re-emits each cycle → stays in error
- DISK_FULL: `processQueueEntry` returns `"disk_full"` → `drainQueue` aborts before `sync_complete` fires for the pair → error state persists

#### Why `on_online` must not clear error state

The current `on_online` resets ALL rows to "synced" (for non-conflict pairs). This incorrectly clears error state set by PERMISSION_DENIED or DISK_FULL. The engine does NOT re-emit the error on reconnect — it only emits it when the specific operation fails. So clearing on `on_online` silently hides active errors.

#### Why error is > conflict in footer priority

A sync error blocks ALL file operations for the affected pair. Showing "N conflicts" while files can't sync at all is misleading. The user must address the error before conflicts matter.

#### Why fatal error uses a separate banner (not the session-expired banner)

The `session_expired_banner` has "Sign in" button logic wired to the re-auth flow. A fatal crash needs "Restart" logic wired to `engine.restart()`. Reusing the same banner would require conditional logic that violates the widget isolation rule. Two separate banners is correct.

---

### Previous story learnings (5-5 through 5-8)

- **5-8**: `isFileLocked` added after `isPermissionDenied` at Sites R1-R5, Q4 — insert SDK_ERROR check (actually just rename the existing fallback) after `isFileLocked` block. No ordering change needed since SDK_ERROR is always the LAST check.
- **5-7**: No sync-engine.ts changes — watcher only. Line numbers in sync-engine.ts unchanged by 5-7.
- **5-6**: `isPermissionDenied` added — Sites R1-R5, Q4 now have 3 specific checks before the generic fallback. Do NOT add `isPermissionDenied`/`isFileLocked` to the `delete_local` catch (R5) — this was explicitly excluded in 5-6 and 5-8.
- **5-5**: The ~117 pre-existing test failures (`bun test engine/`) are unrelated; run targeted files only.
- **5-5**: `_on_engine_error(message, fatal=True)` currently returns without doing anything (comment: "Fatal error display deferred to Story 5-9"). Story 5-9 fills this in.
- **5-5**: `on_pair_error()` currently calls `row.set_state("error")` + `status_footer_bar.set_error(row.pair_name)` — replace the whole implementation (not just extend it).
- **5-1**: `SyncEngine` constructor takes 6 params — always pass all 6 when constructing in tests.
- **Python testing**: Always run `meson compile -C builddir` before `.venv/bin/pytest ui/tests/` — raw pytest without compile step breaks `@Gtk.Template` wiring.

### Test baseline (after 5-6, 5-7, 5-8 implementations)

Run first to confirm actual baseline before implementing:
```bash
bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts
```
Expected: ≥117 pass (101 from 5-5 + 7 from 5-6 + 9 from 5-8), 0 fail

```bash
bun test engine/src/watcher.test.ts
```
Expected: ≥17 pass (from 5-7), 0 fail

```bash
.venv/bin/pytest ui/tests/
```
Expected: 572 passed, 0 fail

---

## Tasks / Subtasks

- [x] **Task 1: Engine — rename sync_file_error → SDK_ERROR (reconcilePair, 6 sites)**  (AC: #1)
  - [x] 1.1 Sites R1–R5: apply standard `errCode`/`message` pattern; keep `continue` flow control
  - [x] 1.2 Site R5 (`delete_local` catch ~436): rename only — no isPermissionDenied/isFileLocked added here
  - [x] 1.3 Site R6 (main download loop catch ~507): apply standard pattern; keep stderr debug line above it
  - [x] 1.4 Confirm `code: "sync_cycle_error"` (~452, trash_remote) is NOT changed

- [x] **Task 2: Engine — rename queue_replay_failed → SDK_ERROR (processQueueEntry, 4 sites)** (AC: #2)
  - [x] 2.1 Site Q1 (walkRemoteTree catch ~612): compute `errCode`/`message` before the `for` loop; use inside loop; preserve `relative_path` in payload
  - [x] 2.2 Site Q2 (remote parent not found ~753): use generic message (no err code available here); preserve `relative_path` in payload
  - [x] 2.3 Site Q3 (stat failure ~785): apply standard `errCode`/`message` pattern; preserve `relative_path` in payload
  - [x] 2.4 Site Q4 (processQueueEntry outer catch ~884): apply standard pattern; `return "failed"` (NOT `"disk_full"`); keep `isFetchFailure` check after the emitEvent
  - [x] 2.5 `bunx tsc --noEmit` from `engine/` — zero type errors

- [x] **Task 3: Engine — update existing tests asserting old codes** (regression safety)
  - [x] 3.1 Find all test assertions referencing `"sync_file_error"` — update to `"SDK_ERROR"` and update test descriptions
  - [x] 3.2 Find all test assertions referencing `"queue_replay_failed"` — update to `"SDK_ERROR"` and update test descriptions
  - [x] 3.3 Update negative-assertion test: `"ENOSPC → DISK_FULL, queue_replay_failed NOT emitted"` → `"ENOSPC → DISK_FULL, SDK_ERROR NOT emitted"` — confirm DISK_FULL IS emitted and SDK_ERROR IS NOT emitted

- [x] **Task 4: Engine — add new SDK_ERROR tests** (AC: #1, #2)
  - [x] 4.1 `engine/src/sync-engine.test.ts` — add describe block `"SyncEngine — SDK_ERROR (Story 5-9)"`:
    - processQueueEntry: unknown error (no `.code`) → emits SDK_ERROR, message = `"Sync error — try again or check ProtonDrive status"`
    - processQueueEntry: error with `.code = "ETIMEDOUT"` → emits SDK_ERROR, message = `"Sync error ETIMEDOUT — try again or check ProtonDrive status"`
    - processQueueEntry: SDK_ERROR returns `"failed"` (NOT `"disk_full"`)
    - Regression: ENOSPC → still DISK_FULL, not SDK_ERROR
    - Regression: EACCES → still PERMISSION_DENIED, not SDK_ERROR
    - Regression: EBUSY → still FILE_LOCKED, not SDK_ERROR

- [x] **Task 5: UI — window.blp fatal error banner** (AC: #4)
  - [x] 5.1 Add `engine_crashed_banner` Adw.Banner after `session_expired_banner` in the sidebar ToolbarView
  - [x] 5.2 Set `revealed: false`, `button-label: _("Restart")`, `styles ["error"]`
  - [x] 5.3 `meson compile -C builddir` — zero compile errors (confirms Blueprint valid)

- [x] **Task 6: UI — window.py error state tracking + banner wiring** (AC: #3, #4, #5)
  - [x] 6.1 Add `engine_crashed_banner: Adw.Banner = Gtk.Template.Child()` to class body
  - [x] 6.2 Add `_error_pair_ids: set[str]` and `_error_pending_cycle: set[str]` to `__init__`
  - [x] 6.3 Connect `engine_crashed_banner.button-clicked` → `_on_engine_crashed_banner_clicked`
  - [x] 6.4 Add `show_engine_crashed_banner()`, `hide_engine_crashed_banner()`, `_on_engine_crashed_banner_clicked()`, `_update_footer_error_state()` methods
  - [x] 6.5 Update `on_pair_error()` — add to `_error_pair_ids`, `_error_pending_cycle`, call `_update_footer_error_state()`
  - [x] 6.6 Update `on_online()` — skip rows in `_error_pair_ids`; add error check to footer path
  - [x] 6.7 Update `on_sync_complete()` — cycle-based error clearing; Error > Conflict > conflict_pending priority in footer
  - [x] 6.8 Update `on_sync_progress()` — add `not self._error_pair_ids` check before `set_syncing()`
  - [x] 6.9 Update `on_watcher_status()` — add error check to 'ready' path
  - [x] 6.10 Update `on_queue_replay_complete()` — add error check to `update_all_synced` path
  - [x] 6.11 Update `clear_session()` — clear `_error_pair_ids`, `_error_pending_cycle`, call `hide_engine_crashed_banner()`

- [x] **Task 7: UI — main.py fatal error routing** (AC: #4)
  - [x] 7.1 Update `_on_engine_error()` — `fatal=True` → `self._window.show_engine_crashed_banner()`; remove `return` stub comment

- [x] **Task 8: UI — StatusFooterBar screen-reader flood fix** (AC: #5, #6)
  - [x] 8.1 Update `set_error()` — capture `already_error = self._dot_state == "error"` before `_set_dot_state()`; only call `self.announce()` if `not already_error`

- [x] **Task 9: UI — tests** (all UI ACs)
  - [x] 9.1 `ui/tests/test_main.py` — update `_on_engine_error(fatal=True)` test: assert `window.show_engine_crashed_banner` called (not just `on_pair_error` not called)
  - [x] 9.2 `ui/tests/test_window_routing.py` — add tests:
    - `on_pair_error` then `on_online` → row stays in "error" state (NOT reset to "synced")
    - `on_pair_error` then `on_sync_complete` (no new errors this cycle) → error cleared, row returns to "synced"
    - `on_pair_error` then `on_pair_error` (same pair, same cycle) then `on_sync_complete` → error persists (pending flag kept error alive)
    - Two `on_pair_error` calls (pair1, pair2) → `status_footer_bar.set_error` called with label containing "2 pairs"
  - [x] 9.3 `ui/tests/test_status_footer_bar.py` — add tests:
    - `set_error("Docs")` first call → `announce()` called once with HIGH priority
    - `set_error("Docs")` second call (still in error state) → `announce()` NOT called again
    - `set_error("2 pairs")` → footer shows "Sync error in 2 pairs"
  - [x] 9.4 Confirm NO changes to `test_sync_pair_row.py` — row error state is complete from 5-5

- [x] **Task 10: Final validation**
  - [x] 10.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 10.2 `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` — 122 pass (116 baseline + 6 new), 0 fail
  - [x] 10.3 `bun test engine/src/watcher.test.ts` — 17 pass, 0 fail (no regressions)
  - [x] 10.4 `meson compile -C ui/builddir` — zero errors (Blueprint valid)
  - [x] 10.5 `.venv/bin/pytest ui/tests/` — 579 pass (572 baseline + 7 new), 0 fail
  - [x] 10.6 Set story Status to `review`

### Review Findings

- [x] [Review][Defer] `_error_pending_cycle` persists one extra cycle after offline→online boundary [ui/src/protondrive/window.py] — deferred, pre-existing design edge case. When an error arrives then the device goes offline→online, the `_error_pending_cycle` flag is still set from before offline. On first clean `on_sync_complete` it is consumed (discarding the flag, keeping error); on the SECOND clean cycle the error finally clears. Effect: error lingers one extra cycle after the underlying issue is fixed + reconnect. Same applies if `queue_replay_complete` fires without a subsequent `sync_complete` for the affected pair. Very low real-world impact (reconcile cycle always follows queue drain in practice). Fix would require clearing `_error_pending_cycle` in `on_offline()` and/or `on_queue_replay_complete()`, which needs a design decision.

---

## Dev Notes

### §1 — Why `sync_file_error` and `queue_replay_failed` → `SDK_ERROR` (not individual checks)

Each of the 4 previous error stories (5-5 through 5-8) added one specific classifier for a common filesystem error. The remaining errors are:
- SDK API failures (network errors, rate-limit edge cases, SDK internal errors)
- Rare filesystem errors (EIO, ELOOP, etc.) not worth specific handling
- Unknown errors

All of these fall under "SDK or API error not covered by other categories". A unified `SDK_ERROR` code signals to the UI that something unexpected happened, and the message "try again or check ProtonDrive status" is appropriate for all of them. Keeping `sync_file_error` vs `queue_replay_failed` as distinct codes provided no user-facing value — they both showed "Sync error" in the UI.

### §2 — Why include `errCode` in the message

SDK/API errors often have an `err.code` (ETIMEDOUT, ECONNRESET, ERR_CERT_AUTHORITY_INVALID, etc.) that gives a technically-savvy user a starting point for troubleshooting. Filesystem errors also have codes (EIO, ELOOP). Including it in the message when available is strictly better than hiding it. When no code is available (SDK exception types that don't set `.code`), the generic fallback is appropriate.

### §3 — Why cycle-based clearing over persistent error state

Persistent-until-restart is wrong for FILE_LOCKED (transient) and PERMISSION_DENIED (fixable by user). Never-clear-until-user-action requires a "dismiss error" affordance we don't have. Cycle-based clearing is the correct middle ground: the error clears after the first sync cycle that completes without that error recurring.

The `_error_pending_cycle` set acts as a "did we see this error in the current cycle" signal. It's set by `on_pair_error` and consumed/cleared by `on_sync_complete`. This is safe because both handlers run on the GTK main loop (single-threaded) — no race conditions.

### §4 — Why `delete_local` catch (R5) is NOT getting isPermissionDenied/isFileLocked

Explicitly decided in 5-6 and 5-8: `unlink()` EACCES/EBUSY is excluded from those stories to keep scope tight. For 5-9, we just rename the existing fallback. Adding the specific checks would be scope creep and isn't validated by ACs.

### §5 — `sync_cycle_error` (trash_remote) left unchanged

The `trash_remote` operation uses `sync_cycle_error` as its error code. This operation is logically distinct from file download/upload. Renaming it would require finding and updating any existing tests that assert `sync_cycle_error`. Since the epic does not mention this code and it wasn't called out as needing renaming, leave it as-is.

### §6 — Fatal banner coexists with session-expired banner

Both `Adw.Banner` widgets can be `revealed: true` simultaneously — GTK stacks `[top]` items in the toolbar. If the engine crashes while the session-expired banner is visible (unlikely but possible), both banners show. This is acceptable; each has a distinct action (Restart vs Sign in).

### §7 — Deferred from 5-5/5-6/5-7/5-8 — all resolved in this story

From Story 5-5 review:
- ✅ Multi-pair error footer overwrite → `_update_footer_error_state()` with count
- ✅ `on_online` clears error state → `_error_pair_ids` guard in `on_online`
- ✅ Screen-reader flood → `already_error` check in `set_error()`

Additionally addressed (logical completeness):
- ✅ `on_sync_complete` clears error state → cycle-based clearing
- ✅ `on_sync_progress` overrides error in footer → `not self._error_pair_ids` guard
- ✅ `on_watcher_status` overrides error → guard added
- ✅ Fatal error banner → new `engine_crashed_banner` widget

### Project Structure Notes

**Files to modify (engine):**
- `engine/src/sync-engine.ts` — rename error codes at 10 sites + update message format
- `engine/src/sync-engine.test.ts` — update ~8 existing assertions + add ~6 new tests

**Files to modify (UI):**
- `ui/data/ui/window.blp` — add `engine_crashed_banner` Banner widget
- `ui/src/protondrive/window.py` — error tracking, banner wiring, priority fixes
- `ui/src/protondrive/main.py` — fatal error routing in `_on_engine_error`
- `ui/src/protondrive/widgets/status_footer_bar.py` — `set_error()` debounce

**Files to create:** none

**Do NOT modify:**
- `engine/src/ipc.ts` — `IpcPushEvent` type uses `string`; no update needed
- `engine/src/errors.ts` — SDK_ERROR is an IPC event payload code, not a thrown TypeScript error
- `engine/src/watcher.ts` — no changes; INOTIFY_LIMIT (5-7) complete
- `engine/src/state-db.ts` — no schema changes
- `ui/src/protondrive/widgets/sync_pair_row.py` — error state complete from 5-5
- `ui/data/ui/sync-pair-row.blp` — no changes
- `ui/data/ui/status-footer-bar.blp` — no changes

---

### References

- Epic 5 story 5.9: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.9`
- Story 5-8 (immediate predecessor, isFileLocked + 6-site pattern): `_bmad-output/implementation-artifacts/5-8-actionable-error-file-locked.md`
- Story 5-5 (established UI error pipeline): `_bmad-output/implementation-artifacts/5-5-actionable-error-disk-full.md`
- Story 5-6 (isPermissionDenied + excluded sites): `_bmad-output/implementation-artifacts/5-6-actionable-error-permission-denied.md`
- `isDiskFull` / `isPermissionDenied` / `isFileLocked` helpers: `engine/src/sync-engine.ts` (top of file)
- All 10 emit sites: `engine/src/sync-engine.ts:~316, ~357, ~380, ~421, ~436, ~507, ~612, ~753, ~785, ~884`
- `sync_cycle_error` (trash_remote — NOT changed): `engine/src/sync-engine.ts:~452`
- `_on_engine_error` stub (fatal=True, deferred): `ui/src/protondrive/main.py:507-510`
- `on_pair_error` (established in 5-5): `ui/src/protondrive/window.py:474`
- `StatusFooterBar.set_error()`: `ui/src/protondrive/widgets/status_footer_bar.py:117`
- `SyncPairRow.set_state("error")` (complete): `ui/src/protondrive/widgets/sync_pair_row.py:84`
- `EngineClient.restart()`: `ui/src/protondrive/engine.py:575`
- `engine_crashed_banner` pattern after: `session_expired_banner` in `ui/data/ui/window.blp`
- Project context (naming, test commands, architecture rules): `_bmad-output/project-context.md`

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Null safety: used `?.code` (optional chaining) on all `errCode` computations — `err` can be `null` when tests throw `null` directly.
- Q3 (stat failure): existing `const code = (err as NodeJS.ErrnoException)?.code` already in scope; used `code` directly in message format instead of declaring redundant `errCode`.
- Tests that previously asserted `"sync_file_error"` on EACCES paths (R1, R3 rename/conflict copy) were already updated to PERMISSION_DENIED in 5-6 — only renamed the test descriptions in 5-9.

### Completion Notes List

**Track A — Engine (TypeScript/Bun):**
- Renamed 6 `sync_file_error` → `SDK_ERROR` sites in `reconcilePair` (R1–R6) with standard `errCode`/`message` pattern.
- Renamed 4 `queue_replay_failed` → `SDK_ERROR` sites in `processQueueEntry` (Q1–Q4) with same pattern.
- `sync_cycle_error` (trash_remote, ~line 496) left unchanged per story spec.
- Updated all existing test assertions referencing old codes; added 6 new SDK_ERROR regression tests.
- All `errCode` uses `?.code` (optional chaining) to safely handle `null` error objects.

**Track B — UI (Python/GTK4):**
- Added `engine_crashed_banner` Adw.Banner to `window.blp` after `session_expired_banner`.
- Added `engine_crashed_banner` Template.Child, `_error_pair_ids`/`_error_pending_cycle` sets, banner wiring, and 4 new methods to `window.py`.
- Implemented cycle-based error clearing in `on_sync_complete`, error-priority guards in `on_online`, `on_sync_progress`, `on_watcher_status`, `on_queue_replay_complete`.
- Updated `_on_engine_error` in `main.py` to call `show_engine_crashed_banner()` on fatal crash.
- Fixed screen-reader flood in `StatusFooterBar.set_error()`: announces only on first transition to error state.
- Added 7 new UI tests across `test_main.py`, `test_window_routing.py`, `test_status_footer_bar.py`.

### File List

- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`
- `ui/data/ui/window.blp`
- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/src/protondrive/widgets/status_footer_bar.py`
- `ui/tests/test_main.py`
- `ui/tests/test_window_routing.py`
- `ui/tests/test_status_footer_bar.py`
- `_bmad-output/implementation-artifacts/5-9-actionable-error-sdk-api-error-and-error-state-components.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
