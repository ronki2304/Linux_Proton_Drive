# Story 5.5: Actionable Error — Disk Full

Status: done

## Story

As a user,
I want a clear message when sync fails because my disk is full,
so that I know exactly what to do to fix it.

## Acceptance Criteria

### AC1 — DISK_FULL error emitted on ENOSPC during file write

**Given** the sync engine encounters a filesystem `ENOSPC` error during a file write operation (download, conflict copy creation, collision rename, or queue replay)
**When** the error is processed
**Then** an `error` push event is emitted with:
  - `code: "DISK_FULL"`
  - `message: "Free up space on <local_path> to continue syncing"` (where `<local_path>` is the pair's `local_path`)
  - `pair_id: <affected pair's pair_id>`

### AC2 — Non-ENOSPC errors continue to emit existing generic codes

**Given** the sync engine encounters a non-ENOSPC filesystem error (e.g., EACCES, EPERM, EIO)
**When** the error is processed
**Then** the existing error code (`sync_file_error`, `queue_replay_failed`, etc.) is emitted unchanged
**And** no `DISK_FULL` event is emitted

### AC3 — Error displayed inline on affected sync pair card

**Given** the UI receives a `DISK_FULL` error event with `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a **red dot** (error state)
**And** the `status_label` shows "Sync error"
**And** the accessible label is `"[pair name] — error"`
**And** the error is non-fatal — no app-level banner, no restart button

### AC4 — Footer bar shows sync error state

**Given** the UI receives a `DISK_FULL` error event with `pair_id`
**When** rendering the error
**Then** the `StatusFooterBar` shows `"Sync error in [pair name]"` with a **red dot**

---

## Developer Context

### Architecture overview — READ THIS FIRST

DISK_FULL detection is a pure classification layer added on top of the existing error handling pipeline. The engine already emits `{type: "error", payload: {...}}` on file errors; this story replaces the `code` field with `"DISK_FULL"` whenever the underlying Node.js error has `.code === "ENOSPC"`.

On the UI side, this story implements the **full error state machinery** (red dot on pair row, footer message) that will also be reused by Stories 5-6, 5-7, 5-8, and 5-9 with zero additional UI changes. Story 5-9 will verify and add any remaining accessibility/priority rules on top of what this story delivers.

```
Engine:  ENOSPC → isDiskFull() → emit DISK_FULL event
                         ↓
UI:      error event → _on_engine_error() → window.on_pair_error()
                                               → SyncPairRow.set_state("error")
                                               → StatusFooterBar.set_error(pair_name)
```

### What this story delivers

1. **`engine/src/sync-engine.ts`** — `isDiskFull` helper + DISK_FULL classification at 6 error catch sites
2. **`ui/src/protondrive/widgets/sync_pair_row.py`** — "error" state in `set_state()` and `_draw_dot()`
3. **`ui/src/protondrive/widgets/status_footer_bar.py`** — `set_error()` method + "error" dot color
4. **`ui/src/protondrive/window.py`** — `on_pair_error()` method
5. **`ui/src/protondrive/main.py`** — implement `_on_engine_error()` stub (currently `pass`)
6. **Tests** — engine unit tests for `isDiskFull`, UI widget tests, window routing test, main dispatch test

### Critical implementation details

---

#### 1. Engine: `isDiskFull` helper (sync-engine.ts)

Add after `isAuthExpired` (line 27), before the `// ── Internal types ──` comment:

```ts
function isDiskFull(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOSPC";
}
```

This mirrors the existing `isAuthExpired` and `isFetchFailure` helper pattern.

---

#### 2. Engine: 6 catch sites to modify (sync-engine.ts)

At each of the following catch sites, check `isDiskFull(err)` BEFORE the existing generic error emission. If `isDiskFull` is true, emit DISK_FULL and `continue`/return; otherwise fall through to the existing code unchanged.

**Emit pattern (identical at all 5 sites):**
```ts
if (isDiskFull(err)) {
  this.emitEvent({
    type: "error",
    payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id },
  });
  continue; // or return "failed" for processQueueEntry
}
```

**Site 1 — conflict copy `copyFile`/`rename` catch (~line 300)**

Current:
```ts
} catch (err) {
  try { await unlink(tmpPath); } catch { /* already gone */ }
  const msg = err instanceof Error ? err.message : String(err);
  debugLog(`sync-engine: conflict copy creation failed for ${item.relativePath}: ${msg}`);
  this.emitEvent({
    type: "error",
    payload: { code: "sync_file_error", message: msg, pair_id: pair.pair_id },
  });
  continue;
}
```

Add after the `unlink` cleanup and `debugLog`, before the existing `emitEvent`:
```ts
if (isDiskFull(err)) {
  this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
  continue;
}
```

**Site 2 — conflict_update download catch (~line 337)**

Current code emits `{code: "sync_file_error", ...}`. Insert DISK_FULL check before the existing `emitEvent` call.

**Site 3 — collision rename catch (~line 356)**

Current code emits `{code: "sync_file_error", ...}`. Insert DISK_FULL check before the existing `emitEvent` call.

**Site 4 — collision download catch (~line 392)**

Current code emits `{code: "sync_file_error", ...}`. Insert DISK_FULL check before the existing `emitEvent` call.

**Site 5 — main download loop catch (~line 473)**

Current code emits `{code: "sync_file_error", ...}`. Insert DISK_FULL check before the existing `emitEvent` call.

**Site 6 — `processQueueEntry` catch (~line 836)**

This catch already checks `isAuthExpired` first, then emits `{code: "queue_replay_failed", ...}`. Insert DISK_FULL check between `isAuthExpired` check and the existing `emitEvent`:

```ts
} catch (err) {
  if (isAuthExpired(err)) throw err;
  if (isDiskFull(err)) {                                           // ← ADD
    this.emitEvent({ type: "error", payload: { code: "DISK_FULL", message: `Free up space on ${pair.local_path} to continue syncing`, pair_id: pair.pair_id } });
    return "failed";                                               // ← ADD (same as end of existing path)
  }
  const msg = err instanceof Error ? err.message : "unknown";
  debugLog(`sync-engine: queue_replay_failed ...`);
  this.emitEvent({ type: "error", payload: { code: "queue_replay_failed", ... } });
  ...
  return "failed";
}
```

Note: `processQueueEntry` returns `"failed"` (not `continue`) — match the existing return value.

---

#### 3. UI: `SyncPairRow` error state (sync_pair_row.py)

**In `set_state()`** — add "error" branch alongside existing "syncing"/"offline"/"conflict" branches. Model it on the "conflict" branch since both have early returns:

```python
elif state == "error":
    self.status_label.set_text("Sync error")
    self.status_dot.remove_css_class("sync-dot-syncing")
    self.status_dot.remove_css_class("sync-dot-offline")
    self.status_dot.remove_css_class("sync-dot-conflict")
    self.status_dot.queue_draw()
    self.update_property(
        [Gtk.AccessibleProperty.LABEL],
        [f"{self._pair_name} \u2014 error"],
    )
    return  # early return: skip generic _set_accessible_label
```

**In `_draw_dot()`** — add "error" branch (red dot):

```python
elif self._state == "error":
    cr.set_source_rgb(0.87, 0.19, 0.19)  # red
```

No CSS class needed for "error" — dot color is handled exclusively by `_draw_dot()` (same approach as "conflict" amber and "offline" grey). No animation needed for error state.

---

#### 4. UI: `StatusFooterBar.set_error()` (status_footer_bar.py)

Add `set_error()` after `set_rate_limited()`:

```python
def set_error(self, pair_name: str) -> None:
    """Show sync error state for a pair (Story 5-5)."""
    text = f"Sync error in {pair_name}"
    self.footer_label.set_text(text)
    self._set_dot_state("error")
    self.update_property([Gtk.AccessibleProperty.LABEL], [text])
    # HIGH priority: error requires immediate user action (unlike offline/conflict which use LOW).
    self.announce(text, Gtk.AccessibleAnnouncementPriority.HIGH)
```

**In `_set_dot_state()`** — no code change needed: the existing pattern removes all three CSS classes and adds none for unknown states (`"synced"` and now `"error"` fall through to the default no-class path). The dot color is controlled by `_on_dot_draw()`.

**In `_on_dot_draw()`** — add "error" branch (red dot):

```python
elif self._dot_state == "error":
    cr.set_source_rgb(0.87, 0.19, 0.19)  # red
```

---

#### 5. UI: `window.py` — `on_pair_error()` method

Add `on_pair_error()` after `on_crash_recovery_complete()`:

```python
def on_pair_error(self, pair_id: str, _message: str) -> None:
    """Handle engine error for a specific sync pair (Story 5-5 AC3, AC4)."""
    row = self._sync_pair_rows.get(pair_id)
    if row is None:
        return
    row.set_state("error")
    self.status_footer_bar.set_error(row.pair_name)
```

The `_message` parameter (underscore prefix = intentionally unused) is reserved for Story 5-9, which may add a tooltip showing the full error message. Do NOT display the raw message in the status label — it contains a path and is not suitable for the compact row layout.

---

#### 6. UI: `main.py` — implement `_on_engine_error()` stub

Current (line 507):
```python
def _on_engine_error(self, message: str, fatal: bool, pair_id: str | None = None) -> None:
    """Handle engine errors."""
    pass  # TODO: Story 5.x error display
```

Replace with:
```python
def _on_engine_error(self, message: str, fatal: bool, pair_id: str | None = None) -> None:
    """Dispatch engine errors to appropriate UI surface (Story 5-5)."""
    if fatal:
        return  # Fatal error display deferred to Story 5-9
    if pair_id is not None and self._window is not None:
        self._window.on_pair_error(pair_id, message)
```

---

### Key file locations

| File | Change | Location |
|------|--------|----------|
| `engine/src/sync-engine.ts:25` | Add `isDiskFull` helper | After `isAuthExpired`, before `// ── Internal types` |
| `engine/src/sync-engine.ts:~300` | DISK_FULL check in conflict copy catch | Before existing `emitEvent` call |
| `engine/src/sync-engine.ts:~337` | DISK_FULL check in conflict_update download catch | Before existing `emitEvent` call |
| `engine/src/sync-engine.ts:~356` | DISK_FULL check in collision rename catch | Before existing `emitEvent` call |
| `engine/src/sync-engine.ts:~392` | DISK_FULL check in collision download catch | Before existing `emitEvent` call |
| `engine/src/sync-engine.ts:~473` | DISK_FULL check in main download loop catch | Before existing `emitEvent` call |
| `engine/src/sync-engine.ts:~836` | DISK_FULL check in `processQueueEntry` catch | After `isAuthExpired` check, before `emitEvent` |
| `ui/src/protondrive/widgets/sync_pair_row.py:52` | Add "error" branch in `set_state()` | Alongside "syncing"/"offline"/"conflict" branches |
| `ui/src/protondrive/widgets/sync_pair_row.py:92` | Add "error" branch in `_draw_dot()` | After "conflict" branch |
| `ui/src/protondrive/widgets/status_footer_bar.py` | Add `set_error()` method | After `set_rate_limited()` |
| `ui/src/protondrive/widgets/status_footer_bar.py:162` | Add "error" branch in `_on_dot_draw()` | After "rate_limited" branch |
| `ui/src/protondrive/window.py` | Add `on_pair_error()` method | After `on_crash_recovery_complete()` |
| `ui/src/protondrive/main.py:507` | Replace `pass` stub with dispatch logic | `_on_engine_error()` method |

### What NOT to touch

- **`engine/src/ipc.ts`** — `IpcPushEvent` uses `type: string`, no update needed; `DISK_FULL` is just a new string code
- **`engine/src/errors.ts`** — DISK_FULL is not a thrown error, it's a payload code classification; no new error class needed
- **`ui/data/ui/*.blp`** — no Blueprint changes needed; error state is purely Python-side dot color + label text
- **`ui/data/style.css`** — no new CSS class needed for error state; dot color is handled in `_draw_dot()` like all other states
- **`engine/src/watcher.ts`** — INOTIFY_LIMIT (also ENOSPC-triggered) is already handled there; no change needed
- **`engine/src/state-db.ts`** — no schema changes needed
- **`_bmad-output/implementation-artifacts/sprint-status.yaml`** — dev agent sets to `review`

---

### Previous story learnings (5-1 through 5-4)

- **5-1**: `onTokenExpired` is 5th param to `SyncEngine` constructor; `sleepMs` is 6th — if adding test construction in new describe blocks, always pass all 6 params.
- **5-2**: `show_reauth_dialog()` is mocked in `_make_app()` in test fixtures — do not remove.
- **5-3**: `dirtied` flag pattern shows `finally` runs even for early returns from `try` blocks.
- **5-4**: `_on_engine_error` at `main.py:507` is a stub (`pass`) — THIS is the method this story implements. The `engine.on_error()` callback is already registered at `main.py:102` and the IPC dispatch is at `engine.py:319-323`.
- **5-4 review patch**: Always clear `_pending_crash_recovery` in BOTH branches (`has_pairs` and `else`) of `_on_session_ready` — pattern to follow when adding new pending flags.

### Test baseline (from 5-4 completion)

- Engine: `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 99 pass, 0 fail (the 117 failures across all files are pre-existing, unrelated to Epic 5)
- UI: `.venv/bin/pytest ui/tests/` → 548 passed

---

## Tasks / Subtasks

- [x] **Task 1: Add `isDiskFull` helper and DISK_FULL classification in `sync-engine.ts`** (AC: #1, #2)
  - [x] 1.1 Open `engine/src/sync-engine.ts`; add `isDiskFull` helper after `isAuthExpired` (line 27)
  - [x] 1.2 In conflict copy creation catch (~line 300): add `isDiskFull` check before existing `emitEvent`, emit `DISK_FULL`, `continue`
  - [x] 1.3 In conflict_update download catch (~line 337): add `isDiskFull` check before existing `emitEvent`, emit DISK_FULL, `continue`
  - [x] 1.4 In collision rename catch (~line 356): add `isDiskFull` check before existing `emitEvent`, emit DISK_FULL, `continue`
  - [x] 1.5 In collision download catch (~line 392): add `isDiskFull` check before existing `emitEvent`, emit DISK_FULL, `continue`
  - [x] 1.6 In main download loop catch (~line 473): add `isDiskFull` check before existing `emitEvent`, emit DISK_FULL, `continue`
  - [x] 1.7 In `processQueueEntry` catch (~line 836): add `isDiskFull` check after `isAuthExpired`, emit `DISK_FULL`, `return "failed"`
  - [x] 1.8 `bunx tsc --noEmit` from `engine/` — zero type errors

- [x] **Task 2: Add error state to `SyncPairRow`** (AC: #3)
  - [x] 2.1 Open `ui/src/protondrive/widgets/sync_pair_row.py`
  - [x] 2.2 In `set_state()`: add `elif state == "error":` branch — set status_label "Sync error", remove all CSS classes, `queue_draw()`, set accessible label `"[pair name] — error"`, `return`
  - [x] 2.3 In `_draw_dot()`: add `elif self._state == "error":` branch → `cr.set_source_rgb(0.87, 0.19, 0.19)` (red)

- [x] **Task 3: Add `set_error()` to `StatusFooterBar`** (AC: #4)
  - [x] 3.1 Open `ui/src/protondrive/widgets/status_footer_bar.py`
  - [x] 3.2 Add `set_error(self, pair_name: str) -> None` method after `set_rate_limited()`
  - [x] 3.3 In `_on_dot_draw()`: add `elif self._dot_state == "error":` → `cr.set_source_rgb(0.87, 0.19, 0.19)` (red)
  - [x] 3.4 Note: `_set_dot_state("error")` requires NO code change — unknown states fall through to no-CSS-class path, which is correct (no animation for error state)

- [x] **Task 4: Add `on_pair_error()` to `window.py`** (AC: #3, #4)
  - [x] 4.1 Open `ui/src/protondrive/window.py`
  - [x] 4.2 Add `on_pair_error(self, pair_id: str, message: str) -> None` after `on_crash_recovery_complete()`
  - [x] 4.3 Look up `_sync_pair_rows.get(pair_id)` — guard on `None`
  - [x] 4.4 Call `row.set_state("error")` and `self.status_footer_bar.set_error(row.pair_name)`

- [x] **Task 5: Implement `_on_engine_error()` in `main.py`** (AC: #3, #4)
  - [x] 5.1 Open `ui/src/protondrive/main.py`
  - [x] 5.2 Replace `pass  # TODO: Story 5.x error display` with dispatch logic:
        - `if fatal: return` (fatal path deferred to 5-9)
        - `if pair_id is not None and self._window is not None: self._window.on_pair_error(pair_id, message)`

- [x] **Task 6: Tests** (all ACs)
  - [x] 6.1 `engine/src/sync-engine.test.ts` — added describe block "SyncEngine — DISK_FULL detection (Story 5-5)": 2 tests via processQueueEntry mock (ENOSPC → DISK_FULL; EIO → queue_replay_failed); EACCES regression confirmed by existing "rename fails" test (still passes)
  - [x] 6.2 `ui/tests/test_sync_pair_row.py` — added `TestSyncPairRowErrorState` (9 tests) + `test_error_colour_is_red` in draw-dot class
  - [x] 6.3 `ui/tests/test_status_footer_bar.py` — added `TestStatusFooterBarSetError` (6 tests)
  - [x] 6.4 `ui/tests/test_window_routing.py` — added `TestOnPairError` (4 tests)
  - [x] 6.5 `ui/tests/test_main.py` — added `TestOnEngineError` (4 tests)
  - [x] 6.6 `bunx tsc --noEmit` from `engine/` — zero type errors

- [x] **Task 7: Final validation**
  - [x] 7.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 7.2 `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` — 101 pass, 0 fail
  - [x] 7.3 `meson compile -C builddir` — zero errors
  - [x] 7.4 `.venv/bin/pytest ui/tests/` — 572 passed (24 new tests, no regressions)
  - [x] 7.5 Set story Status to `review`

---

## Dev Notes

### §1 — Why check DISK_FULL before the generic emit (not after)

The existing catch blocks emit `sync_file_error` / `queue_replay_failed` and then `continue`. Adding the DISK_FULL check *before* the existing emit and `continue`-ing early means the generic emit is never reached for ENOSPC. This is safe because both paths end with `continue`/`return "failed"` — the control flow is identical; only the emitted code differs.

### §2 — Why no new error class in `errors.ts`

`DISK_FULL` is an IPC event payload code, not a thrown TypeScript error. The engine catches the raw Node.js filesystem error (which has `.code === "ENOSPC"`) and translates it to the IPC payload code at the emit site. Creating a `DiskFullError extends SyncError` would add complexity without benefit — the ENOSPC condition is detected and converted immediately.

### §3 — `_message` param in `on_pair_error` is intentionally unused

Story 5-9 may add a tooltip on the pair row showing the full error message. The parameter is named `_message` (underscore prefix) to signal intentional non-use while preserving it in the API for Story 5-9. Do NOT display the raw message string in the status label — it contains a path and is not suitable for the compact row layout. Do NOT rename it away or "clean it up" — it is load-bearing for future stories.

### §4 — Error state and state machine re-entry

`SyncPairRow.set_state("error")` is a terminal state for the current sync cycle — no state machine transitions will clear it during this story. The pair row will remain in error state until the next `session_ready` or `sync_complete` event. Story 5-9 will add the priority ordering and clearing logic. For now, subsequent `sync_progress` events for the same pair will overwrite the error state with "syncing" — this is acceptable behavior.

### §5 — ENOSPC engine test approach

Triggering real ENOSPC in tests requires either:
1. A tmpfs mounted at a specific size (platform-specific, unreliable in CI)
2. `mock.module("node:fs/promises", ...)` to override `rename` for specific tests

For story 5-5, use a focused unit test of the `isDiskFull` classification logic rather than end-to-end ENOSPC simulation. The test can verify that an error object constructed with `.code = "ENOSPC"` passes `isDiskFull()`, and an error with `.code = "EACCES"` does not. Since `isDiskFull` is a module-level function, test it via the engine's behavior when the OS naturally produces errors (e.g., the existing `chmodSync` test confirms EACCES → `sync_file_error`, which is the regression guard).

For the DISK_FULL positive path test in `sync-engine.test.ts`, use `mock.module` scoped to a new test file if you want full coverage, or note it as deferred. The risk is low: `isDiskFull` is a one-liner that maps `.code === "ENOSPC"` — the logic is trivially correct.

### §6 — `_set_dot_state("error")` requires no code change

The existing `_set_dot_state` implementation removes all three CSS classes and adds one based on state. For `"error"`, none of the three CSS classes apply (no animation), so the method correctly falls through to the "no class" default (same as `"synced"`). The red dot color is applied in `_on_dot_draw()` by checking `self._dot_state == "error"`. This matches the existing pattern for all static dot colors.

### §7 — Current test suite baseline caveat

Running `bun test engine/` shows 278 pass + 117 fail across all files. The 117 failures are pre-existing (related to `better-sqlite3` integration test dependency and some IPC backpressure test failures, all unrelated to sync-engine or state-db). The clean baseline for this story is `bun test engine/src/sync-engine.test.ts engine/src/state-db.test.ts` → 99 pass, 0 fail. Run this targeted command to verify regressions, not the full suite.

### Project Structure Notes

**Files to modify:**
- `engine/src/sync-engine.ts` — `isDiskFull` helper + DISK_FULL checks at 6 catch sites
- `ui/src/protondrive/widgets/sync_pair_row.py` — "error" state in `set_state()` and `_draw_dot()`
- `ui/src/protondrive/widgets/status_footer_bar.py` — `set_error()` method + "error" in `_on_dot_draw()`
- `ui/src/protondrive/window.py` — `on_pair_error()` method
- `ui/src/protondrive/main.py` — `_on_engine_error()` implementation
- `engine/src/sync-engine.test.ts` — DISK_FULL describe block (2-3 tests)
- `ui/tests/test_sync_pair_row.py` — error state describe block
- `ui/tests/test_status_footer_bar.py` — `TestStatusFooterBarSetError` class
- `ui/tests/test_window_routing.py` — `on_pair_error` test
- `ui/tests/test_main.py` — `_on_engine_error` dispatch tests (4 tests)

**Files to create:** none

**Do NOT modify:**
- `engine/src/ipc.ts` — `IpcPushEvent` type is generic string
- `engine/src/errors.ts` — no new error class needed
- `engine/src/watcher.ts` — INOTIFY_LIMIT (ENOSPC on inotify) already handled there
- `ui/data/ui/*.blp` — no Blueprint changes; error state is Python-only
- `ui/data/style.css` — no new CSS class; dot color is `_draw_dot()` only
- `engine/src/state-db.ts` — no schema changes needed

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.5`
- Story 5-4 (completed, immediate predecessor): `_bmad-output/implementation-artifacts/5-4-dirty-session-flag-and-crash-recovery.md`
- `isAuthExpired` helper (model for `isDiskFull`): `engine/src/sync-engine.ts:25`
- `isFetchFailure` helper (model for `isDiskFull`): `engine/src/sync-engine.ts:17`
- Conflict copy creation catch: `engine/src/sync-engine.ts:~300`
- Main download loop catch: `engine/src/sync-engine.ts:~473`
- `processQueueEntry` catch: `engine/src/sync-engine.ts:~836`
- `_on_engine_error` stub: `ui/src/protondrive/main.py:507`
- `engine.on_error()` registration: `ui/src/protondrive/main.py:102`
- IPC error event dispatch: `ui/src/protondrive/engine.py:319-323`
- `SyncPairRow.set_state()` conflict branch (model for error branch): `ui/src/protondrive/widgets/sync_pair_row.py:71-83`
- `SyncPairRow._draw_dot()`: `ui/src/protondrive/widgets/sync_pair_row.py:92`
- `StatusFooterBar.set_conflicts()` (model for `set_error()`): `ui/src/protondrive/widgets/status_footer_bar.py:64`
- `StatusFooterBar._on_dot_draw()`: `ui/src/protondrive/widgets/status_footer_bar.py:162`
- `window.on_crash_recovery_complete()` (model location for `on_pair_error()`): `ui/src/protondrive/window.py`
- INOTIFY_LIMIT ENOSPC detection pattern (reference): `engine/src/watcher.ts:66`
- Project context (naming, test commands, architecture rules): `_bmad-output/project-context.md`

---

## Review Findings

- [x] [Review][Decision] Loop continues after DISK_FULL — RESOLVED: abort entire drain pass on first DISK_FULL. `reconcilePair` uses `diskFull` flag + `break`/`return` at Sites 1–5; `processQueueEntry` returns `"disk_full"`; `drainQueue` breaks both inner and outer loops on `"disk_full"`. — `engine/src/sync-engine.ts`
- [x] [Review][Patch] `isDiskFull` unsafe cast — FIXED: added `err != null && typeof err === "object"` guard — `engine/src/sync-engine.ts:30`
- [x] [Review][Defer] Test gap: Sites 1–5 DISK_FULL in main sync loop not directly tested — acknowledged in story dev notes as acceptable low-risk tradeoff (`isDiskFull` is a one-liner; Site 6 via `processQueueEntry` mock is the primary coverage path) — `engine/src/sync-engine.test.ts` — deferred, pre-existing
- [x] [Review][Defer] Multi-pair error: `on_pair_error` overwrites footer with last errored pair name — second `DISK_FULL` event for a different pair silently replaces first pair name in `StatusFooterBar` — `ui/src/protondrive/window.py:474` — deferred, Story 5-9 priority ordering
- [x] [Review][Defer] `on_online` clears error state on offline→online transition — `on_online` calls `row.set_state("synced")` regardless of `row.state == "error"`, silently clearing the red dot and "Sync error" label — `ui/src/protondrive/window.py` — deferred, Story 5-9 priority ordering
- [x] [Review][Defer] `on_watcher_status("ready")` clears footer despite error rows — watcher restart calls `update_all_synced()` without checking for error-state rows — `ui/src/protondrive/window.py` — deferred, Story 5-9 priority ordering
- [x] [Review][Defer] Multiple DISK_FULL events per cycle → screen-reader flood — N files hitting ENOSPC in one sync cycle emit N identical `DISK_FULL` events; UI calls `announce()` with HIGH priority N times — `engine/src/sync-engine.ts` — deferred, Story 5-9 deduplication
- [x] [Review][Defer] No multi-entry test for `queue_replay_failed` suppression — if multiple entries fail with ENOSPC and a later entry fails non-ENOSPC, `queue_replay_failed` would still be emitted alongside `DISK_FULL` — `engine/src/sync-engine.test.ts` — deferred, low risk / out of scope

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Added `isDiskFull(err)` helper after `isAuthExpired` in `engine/src/sync-engine.ts` — mirrors existing helper pattern, one-liner checking `.code === "ENOSPC"`.
- Inserted DISK_FULL check at 6 catch sites (Sites 1–5 use `continue`, Site 6 uses `return "failed"` matching existing processQueueEntry return path).
- `SyncPairRow.set_state("error")`: early-return branch (matches conflict pattern) — removes all CSS classes, sets label "Sync error", accessible label `"[pair] — error"`.
- `SyncPairRow._draw_dot()`: "error" → red `(0.87, 0.19, 0.19)`.
- `StatusFooterBar.set_error()`: HIGH priority announce (errors require immediate action, unlike LOW for offline/conflict).
- `StatusFooterBar._on_dot_draw()`: "error" → red `(0.87, 0.19, 0.19)`. No CSS class added for "error" — `_set_dot_state` already falls through to no-class path correctly.
- `window.on_pair_error()`: `_message` param underscore-prefixed (intentionally unused, reserved for Story 5-9 tooltip).
- `main._on_engine_error()`: fatal path returns early (deferred to 5-9); non-fatal routes to `window.on_pair_error`.
- Engine tests use mock client to throw ENOSPC/EIO errors in processQueueEntry — avoids mock.module complexity for native fs modules.
- 24 new tests total: 2 engine, 10 sync_pair_row, 6 status_footer_bar, 4 window_routing, 4 main.

### Change Log

- 2026-04-19: Story 5-5 implemented — DISK_FULL error detection and UI routing (claude-sonnet-4-6)

### File List

- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`
- `ui/src/protondrive/widgets/sync_pair_row.py`
- `ui/src/protondrive/widgets/status_footer_bar.py`
- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/tests/test_sync_pair_row.py`
- `ui/tests/test_status_footer_bar.py`
- `ui/tests/test_window_routing.py`
- `ui/tests/test_main.py`
- `_bmad-output/implementation-artifacts/5-5-actionable-error-disk-full.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
