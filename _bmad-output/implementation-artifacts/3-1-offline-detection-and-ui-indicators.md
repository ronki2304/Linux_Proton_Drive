# Story 3.1: Offline Detection & UI Indicators

Status: review

## Story

As a user,
I want to clearly see when the app is offline,
so that I understand why sync isn't happening and trust that my changes are safe.

## Acceptance Criteria

### AC1 — Engine emits `offline` push event on network loss

**Given** the engine is running and network connectivity is active
**When** the network drops (TCP connect to probe host fails after retry)
**Then** the engine emits an `offline` push event with empty payload `{}`
**And** no duplicate `offline` events are emitted until the state changes back to online

### AC2 — Engine emits `online` push event on network restoration

**Given** the engine has emitted an `offline` event
**When** the network becomes reachable again (TCP probe succeeds)
**Then** the engine emits an `online` push event with empty payload `{}`
**And** no duplicate `online` events are emitted

### AC3 — `get_status` includes live `online` field

**Given** the engine has a `NetworkMonitor` tracking connectivity
**When** the UI sends `get_status`
**Then** `get_status_result` payload includes `online: boolean` reflecting actual current network state
(Note: currently hardcoded as `true` in main.ts — must read from NetworkMonitor)

### AC4 — UI shows offline state on startup with no network

**Given** the app launches with no network available
**When** `get_status_result` arrives with `online: false`
**Then** the `StatusFooterBar` shows "Offline — changes queued" with a grey dot
**And** each `SyncPairRow` in the sidebar shifts to the offline state: grey dot + status text "Offline · [last synced time]" (e.g. "Offline · 5m ago"), using the `last_synced_text` from the `get_status_result` pairs data
**And** pairs with no prior sync show "Offline · never synced" as the status text
**And** no hanging spinner or blank screen is shown — offline state is immediate

### AC5 — UI shows offline state mid-session

**Given** the app is running and syncing normally
**When** the engine emits an `offline` push event
**Then** each `SyncPairRow` immediately shifts to: grey dot + "Offline · [last synced time]" status text
**And** `StatusFooterBar` shows "Offline — changes queued" with grey dot
**And** each pair's accessible label reads "[pair name] — offline"
**And** the `StatusFooterBar` announces "Offline — changes queued" via AT-SPI2 (polite)

### AC6 — UI clears offline state on network restoration

**Given** the app is showing offline state
**When** the engine emits an `online` push event
**Then** each `SyncPairRow` returns to "synced" (green dot, no status text)
**And** the `StatusFooterBar` returns to "All synced" with green dot

> **Design rationale:** The epic says "pair rows return to their previous states". Returning to "synced" is the correct safe default — the engine immediately restarts sync on reconnect and will push `sync_progress`/`sync_complete` events to drive rows to their accurate state within seconds. Attempting to track and restore pre-offline row states adds complexity for no user-visible benefit.

### AC7 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit per logical group. Branch: `feat/3-1-offline-detection-and-ui-indicators`.

---

## Tasks / Subtasks

- [x] **Task 1: `NetworkMonitor` class in engine** (AC: #1, #2, #3)
  - [x] 1.1 Create `engine/src/network-monitor.ts` — export `NetworkMonitor` class
  - [x] 1.2 Constructor: `(emitEvent: (e: IpcPushEvent) => void, checkFn?: () => Promise<boolean>)`
        Default `checkFn` does TCP connect to `1.1.1.1:443` with 3s timeout using `node:net`
        Initial `isOnline = true` (optimistic default — corrected by first check within ≤3s)
  - [x] 1.3 `start()`: IMMEDIATELY call `this.runCheck()` (async), then schedule next check via `setTimeout`
        Use recursive `setTimeout` (NOT `setInterval`) — this naturally supports different intervals
        per state: 30s when online (low overhead), 5s when offline (fast recovery per FR22)
        `runCheck()` = call `checkFn()`, compare result to `isOnline`, emit event on transition, schedule next
  - [x] 1.4 On state change to offline: emit `{ type: "offline", payload: {} }`; set `isOnline = false`
  - [x] 1.5 On state change to online: emit `{ type: "online", payload: {} }`; set `isOnline = true`
  - [x] 1.6 No duplicate events — only emit on transition; repeated offline checks do NOT re-emit `offline`
  - [x] 1.7 `stop()`: set `stopped = true`; if a `setTimeout` handle is pending, clear it; prevent further emissions
  - [x] 1.8 `get isCurrentlyOnline(): boolean` — returns `isOnline` (starts `true`, corrected by first `runCheck()`)
  - [x] 1.9 Write `engine/src/network-monitor.test.ts` — tests:
        - `start()` fires an IMMEDIATE check — emits `offline` before first poll interval when checkFn returns false
        - `start()` emits `online` after offline state when checkFn resolves true
        - No duplicate `offline` events on repeated failures
        - No duplicate `online` events on repeated successes
        - `stop()` cancels the pending timer and prevents further events
        - `isCurrentlyOnline` reflects last known state correctly
        - `isCurrentlyOnline` is `true` before first check resolves (optimistic default)
  - [x] 1.10 `bun test engine/src/network-monitor.test.ts` — all pass
  - [x] 1.11 `bunx tsc --noEmit` — zero errors

- [x] **Task 2: Wire `NetworkMonitor` into main.ts** (AC: #1, #2, #3)
  - [x] 2.1 Add module-level `networkMonitor: NetworkMonitor | undefined` (alongside existing module vars)
  - [x] 2.2 In `main()`: instantiate `networkMonitor = new NetworkMonitor((e) => server.emitEvent(e))`,
        call `networkMonitor.start()`
  - [x] 2.3 In `handleCommand` for `get_status`: replace hardcoded `online: true` with
        `online: networkMonitor?.isCurrentlyOnline ?? true`
  - [x] 2.4 Add `_setNetworkMonitorForTests()` export (test-only, underscore prefix, consistent with existing pattern)
  - [x] 2.5 `bun test engine/src/main.test.ts` — no regressions

- [x] **Task 3: UI widget offline state — `SyncPairRow`** (AC: #4, #5, #6)
  - [x] 3.1 In `ui/src/protondrive/widgets/sync_pair_row.py` — extend `set_state()` signature:
        `def set_state(self, state: str, last_synced_text: str | None = None) -> None`
  - [x] 3.2 When `state == "offline"`:
        - Status text: `"Offline · {last_synced_text}"` if `last_synced_text` else `"Offline · never synced"`
        - Add CSS class `"sync-dot-offline"` (mirrors existing `"sync-dot-syncing"` pattern)
        - Remove `"sync-dot-syncing"` CSS class
        - `_set_accessible_label("offline")` → label: `"[pair_name] — offline"`
  - [x] 3.3 In `_draw_dot()`: add `elif self._state == "offline": cr.set_source_rgb(0.60, 0.60, 0.60)`
        (grey; consistent with UX-DR6 offline grey state spec)
  - [x] 3.4 On `set_state()` for non-offline states: remove `"sync-dot-offline"` CSS class
        (follow the same remove pattern as `"sync-dot-syncing"`)
  - [x] 3.5 `state` property docstring update: add `"offline"` to valid states list

- [x] **Task 4: UI widget offline state — `StatusFooterBar`** (AC: #4, #5, #6)
  - [x] 4.1 In `ui/src/protondrive/widgets/status_footer_bar.py` — add `set_offline()` method
  - [x] 4.2 In `_set_dot_state()`: add `elif state == "offline": self.footer_dot.add_css_class("sync-dot-offline")`
        and remove `"sync-dot-offline"` in the non-offline path (alongside existing syncing removal)
  - [x] 4.3 In `_on_dot_draw()`: add `elif self._dot_state == "offline": cr.set_source_rgb(0.60, 0.60, 0.60)`

- [x] **Task 5: Wire offline/online events in UI** (AC: #4, #5, #6)
  - [x] 5.1 In `ui/src/protondrive/main.py` `do_startup()`: register handlers
  - [x] 5.2 Add `_on_offline()` handler: calls `self._window.on_offline()` if window exists
  - [x] 5.3 Add `_on_online()` handler: calls `self._window.on_online()` if window exists
  - [x] 5.4 In `ui/src/protondrive/window.py` — add `on_offline()` method
  - [x] 5.5 In `window.py` — add `on_online()` method
  - [x] 5.6 In `main.py` `_on_get_status_result`: forward offline state via `on_offline()` if `online: false`
  - [x] 5.7 Guard `on_sync_complete()`: don't reset offline rows to "synced"
  - [x] 5.8 Guard `on_watcher_status()`: if any pair is offline, do not call `update_all_synced()`

- [x] **Task 6: Tests** (AC: #4, #5, #6)
  - [x] 6.1 `TestSyncPairRowOfflineState` in `test_sync_pair_row.py` — 9 tests covering all offline scenarios
  - [x] 6.2 `TestStatusFooterBarSetOffline` in `test_status_footer_bar.py` — 5 tests
  - [x] 6.3 `TestOfflineOnlineHandlers` in `test_main.py` — 4 tests for `_on_offline`/`_on_online`
  - [x] 6.4 Run `python -m pytest ui/tests/ -v` — 29 pre-existing failures (same as 3-0b), no new regressions
  - [x] 6.5 Run `bun test engine/src/` — 161 pass, 0 fail

---

## Dev Notes

### Network Probe Strategy

The Flatpak sandbox blocks UDP port 53 (standard DNS), so the network probe must use TCP only.
The existing DoH workaround in `main.ts` already establishes a pattern: connect to `1.1.1.1:443` (Cloudflare DNS-over-HTTPS IP, no DNS needed).

**Recommended probe**: TCP connect to `1.1.1.1:443` with a 3-second timeout using `node:net`.

```typescript
// engine/src/network-monitor.ts  
import net from "node:net";

async function defaultOnlineCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
```

This probe works identically in Flatpak (TCP allowed) and dev environments.

### Polling Design — `setTimeout` Chain, Not `setInterval`

Use a recursive `setTimeout` pattern (NOT `setInterval`). `setInterval` has a fixed delay that can't change at runtime — you'd need to `clearInterval` + start a new one every state change, which is fragile. `setTimeout` chains naturally support per-state delays:

```typescript
private schedule(): void {
  if (this.stopped) return;
  const delay = this.isOnline ? 30_000 : 5_000;  // 30s online, 5s offline
  this.timer = setTimeout(() => void this.runCheck(), delay);
}

private async runCheck(): Promise<void> {
  if (this.stopped) return;
  const online = await this.checkFn().catch(() => false);
  if (online !== this.isOnline) {
    this.isOnline = online;
    this.emitEvent({ type: online ? "online" : "offline", payload: {} });
  }
  this.schedule();  // reschedule with updated delay
}
```

`start()` calls `void this.runCheck()` immediately (no initial delay), then `runCheck()` self-schedules.

`stop()` sets `this.stopped = true` and calls `clearTimeout(this.timer)`.

**Initial state:** `isOnline = true` (optimistic). If the first check fails, `offline` fires within ≤3s (TCP timeout). The `get_status` call from the UI arrives after `ready` — if the first check hasn't resolved yet, `online: true` is returned, then the `offline` push event corrects the UI. This is acceptable: a brief wrong state corrected quickly is better than a false offline flash on every startup.

### `main.ts` Module Variable Pattern

Follow the established pattern for module-level test injection:

```typescript
let networkMonitor: NetworkMonitor | undefined;

// Test-only
export function _setNetworkMonitorForTests(m: NetworkMonitor | undefined): void {
  networkMonitor = m;
}
```

In `handleCommand` for `get_status`, the current hardcoded `online: true` (line 546 in main.ts) becomes:
```typescript
payload: { pairs, online: networkMonitor?.isCurrentlyOnline ?? true },
```

### `_on_get_status_result` Offline Forwarding

In `main.py`, `_on_get_status_result` (line 268) currently just calls `window.populate_pairs(pairs)`.
It must also check the `online` field. `populate_pairs()` must be called FIRST so that `_pairs_data` and `_sync_pair_rows` are populated before `on_offline()` reads them:

```python
def _on_get_status_result(self, payload: dict[str, Any]) -> None:
    if payload.get("error"):
        return
    pairs = payload.get("pairs", [])
    if self._window is not None:
        self._window.populate_pairs(pairs)            # ← must run first
        if not payload.get("online", True):
            self._window.on_offline()                  # ← reads _pairs_data populated above
```

### `SyncPairRow` CSS Class Management

Existing pattern (lines 57–60 in `sync_pair_row.py`):
```python
if state == "syncing":
    self.status_label.set_text("Syncing…")
    self.status_dot.add_css_class("sync-dot-syncing")
else:
    self.status_label.set_text("")
    self.status_dot.remove_css_class("sync-dot-syncing")
```

Extend with the same add/remove logic for `"sync-dot-offline"`. When entering "offline":
```python
self.status_dot.add_css_class("sync-dot-offline")
self.status_dot.remove_css_class("sync-dot-syncing")
```
When leaving "offline" for any other state:
```python
self.status_dot.remove_css_class("sync-dot-offline")
```

### Regression Guards in `window.py`

**`on_sync_complete` regression guard (Task 5.7):**
```python
def on_sync_complete(self, payload: dict[str, Any]) -> None:
    pair_id = payload.get("pair_id", "")
    row = self._sync_pair_rows.get(pair_id)
    if row is not None and row.state != "offline":   # ← guard: don't clobber offline
        row.set_state("synced")
    if self._sync_pair_rows and all(r.state == "synced" for r in self._sync_pair_rows.values()):
        self.status_footer_bar.update_all_synced()
    # rest of existing method unchanged...
```

**`on_watcher_status` regression guard (Task 5.8):**
```python
elif status == "ready":
    any_syncing = any(r.state == "syncing" for r in self._sync_pair_rows.values())
    any_offline = any(r.state == "offline" for r in self._sync_pair_rows.values())
    if not any_syncing and not any_offline:   # ← guard
        self.status_footer_bar.update_all_synced()
```

### Flat Engine File Structure

Engine files must remain flat under `engine/src/`. Creating `network-monitor.ts` is correct — this is a new file, not a subdirectory.

The `network-monitor.ts` file must NOT import from `sdk.ts` — it has no network client, it only uses `node:net` directly. Import chain: `network-monitor.ts` → `ipc.ts` (for `IpcPushEvent` type only via `import type`) + `errors.ts`.

### Import Conventions (engine)

```typescript
// network-monitor.ts
import net from "node:net";
import type { IpcPushEvent } from "./ipc.js";
// No other internal imports needed
```

`import type` is mandatory for type-only imports (`verbatimModuleSyntax` is on).
Local imports use `.js` extension.

### `bun:test` Mock Pattern

`NetworkMonitor` uses injectable `checkFn`. Tests must call `monitor.stop()` in `afterEach` to prevent timer leak.

```typescript
// Test: initial check fires immediately (not after 30s)
it("emits offline immediately when checkFn returns false", async () => {
  const events: IpcPushEvent[] = [];
  const monitor = new NetworkMonitor(
    (e) => events.push(e),
    async () => false,  // always offline
  );
  monitor.start();
  // Flush the initial checkFn promise + any microtasks
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events[0]?.type).toBe("offline");
  monitor.stop();
});

// Test: no duplicate events
it("does not re-emit offline on repeated failures", async () => {
  let callCount = 0;
  const monitor = new NetworkMonitor(
    (e) => events.push(e),
    async () => { callCount++; return false; },
  );
  // ...trigger multiple runCheck() calls...
  expect(events.filter(e => e.type === "offline")).toHaveLength(1);
});
```

`setTimeout(resolve, 0)` flushes the initial async `checkFn` call without needing fake timers.
Use `mock()` factory for spies (not `mock.fn()` — that is node:test syntax, not bun:test).

### What This Story Does NOT Do

- Does NOT persist changes to a queue while offline (that is Story 3-2)
- Does NOT pause or suppress sync operations while offline (sync failures go through existing error paths)
- Does NOT implement rate-limit handling (Story 3-4)
- Does NOT add `change_queue` SQLite writes (Story 3-2)

### Files to Create/Modify

**New:**
- `engine/src/network-monitor.ts`
- `engine/src/network-monitor.test.ts`

**Modified:**
- `engine/src/main.ts` — wire NetworkMonitor, fix `get_status` online field
- `ui/src/protondrive/widgets/sync_pair_row.py` — add "offline" state
- `ui/src/protondrive/widgets/status_footer_bar.py` — add `set_offline()`, grey dot
- `ui/src/protondrive/window.py` — add `on_offline()`, `on_online()`, regression guards
- `ui/src/protondrive/main.py` — register offline/online event handlers, forward from `_on_get_status_result`
- `ui/tests/` — new tests for offline UI state

**Do NOT touch:**
- `engine/src/watcher.ts` — no change queue yet (Story 3-2)
- `engine/src/state-db.ts` — no schema change in this story
- `engine/src/sync-engine.ts` — sync engine is unaware of offline in this story
- Blueprint `.blp` files — no new widgets needed; offline state is pure Python logic

### References

- FR20 (offline on startup), FR21 (offline mid-session): `_bmad-output/planning-artifacts/epics.md` lines 1111–1131
- UX-DR6 (SyncPairRow offline grey state): `epics.md` line 158
- UX-DR7 (StatusFooterBar offline state): `epics.md` line 159
- IPC push event table (`offline`/`online`): `_bmad-output/planning-artifacts/architecture.md` lines 156–157
- `get_status` online field: `architecture.md` line 138
- Engine flat source rule: `_bmad-output/project-context.md` lines 191–193
- `import type` / `.js` extension rules: `project-context.md` lines 68–70
- `bun:test` mock pattern: `project-context.md` lines 140–141
- Existing `SyncPairRow`: `ui/src/protondrive/widgets/sync_pair_row.py` lines 52–79
- Existing `StatusFooterBar`: `ui/src/protondrive/widgets/status_footer_bar.py`
- Existing `on_sync_complete` / `on_watcher_status`: `ui/src/protondrive/window.py` lines 296–319
- Existing `_on_get_status_result`: `ui/src/protondrive/main.py` line 268
- DoH TCP pattern (for probe design): `engine/src/main.ts` lines 25–66
- `_setXxxForTests` pattern: `engine/src/main.ts` lines 162–188
- 3-0b dev notes (test_main.py mock patterns, bun:test conventions): `3-0b-targeted-debt-fixes.md`

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

_none_

### Completion Notes List

- **Task 1:** Created `NetworkMonitor` with injectable `checkFn`, recursive `setTimeout` polling (30s online / 5s offline), optimistic initial state, transition-only event emission, immediate first check on `start()`. 8 tests, all pass.
- **Task 2:** Wired `NetworkMonitor` into `main.ts` — module-level var, instantiated + started in `main()`, `get_status` now reads `networkMonitor?.isCurrentlyOnline ?? true`, `_setNetworkMonitorForTests()` export added. 17 main.test.ts tests pass.
- **Task 3:** Extended `SyncPairRow.set_state()` with optional `last_synced_text` param; "offline" state shows grey dot + "Offline · [time]" or "Offline · never synced"; `sync-dot-offline` CSS class managed symmetrically with `sync-dot-syncing`.
- **Task 4:** Added `StatusFooterBar.set_offline()` showing "Offline — changes queued" with grey dot; `_set_dot_state()` extended for "offline" with full CSS class management.
- **Task 5:** Registered `offline`/`online` event handlers in `main.py`; added `on_offline()`/`on_online()` to `window.py`; `_on_get_status_result` forwards offline state after `populate_pairs()`; regression guards in `on_sync_complete()` and `on_watcher_status()`.
- **Task 6:** 18 new UI tests (9 SyncPairRow + 5 StatusFooterBar + 4 Application handlers). Pre-existing 29 UI test failures unchanged (same as 3-0b). 161 engine tests pass. Two pre-existing tests updated from `assert_called_with` → `assert_any_call` to accommodate new dual-class removal logic (correct behaviour).

### File List

- `engine/src/network-monitor.ts` (new)
- `engine/src/network-monitor.test.ts` (new)
- `engine/src/main.ts`
- `ui/src/protondrive/widgets/sync_pair_row.py`
- `ui/src/protondrive/widgets/status_footer_bar.py`
- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/tests/test_sync_pair_row.py`
- `ui/tests/test_status_footer_bar.py`
- `ui/tests/test_main.py`
- `_bmad-output/implementation-artifacts/3-1-offline-detection-and-ui-indicators.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

---

## Senior Developer Review (AI)

**Date:** 2026-04-14
**Outcome:** Changes Requested
**Layers:** Blind Hunter · Edge Case Hunter · Acceptance Auditor

### Action Items

- [x] [Review][Decision] D1 — AT-SPI2 announce vs `update_property(LABEL)` in `set_offline()` — Spec (AC5) says "announces via AT-SPI2 (polite)"; implementation uses `update_property([Gtk.AccessibleProperty.LABEL], [text])` which changes the accessible label but does NOT send a live-region announcement. Existing `set_syncing()` also uses this pattern. Options: (a) Add `self.announce(text, Gtk.AccessibleAnnouncementPriority.POLITE)` (GTK ≥4.14, available on GNOME 50 runtime); (b) accept `update_property(LABEL)` as the project's AT-SPI2 pattern — consistent with `set_syncing()`. [`ui/src/protondrive/widgets/status_footer_bar.py`]
- [x] [Review][Patch] P1 — In-flight `checkFn` emits event after `stop()` — `runCheck()` checks `this.stopped` at entry but not after `await this.checkFn()`. A 3-second TCP probe in-flight at `stop()` time will mutate `isOnline` and call `emitEvent` on a shutting-down server. Fix: add `if (this.stopped) return;` guard immediately after the `await` line. [`engine/src/network-monitor.ts:61`]
- [x] [Review][Patch] P2 — `networkMonitor` never stopped on SIGTERM/SIGINT — `main.ts` SIGTERM/SIGINT handlers call `server.close()` but not `networkMonitor?.stop()`. On clean exit this is benign, but in test scenarios or rapid restarts, the timer and any in-flight socket continue running. Fix: call `networkMonitor?.stop()` in both signal handlers before `server.close()`. [`engine/src/main.ts:578-584`]
- [x] [Review][Patch] P3 — Socket `error` handler missing `socket.destroy()` — `defaultOnlineCheck` error handler calls `clearTimeout(timer)` and `resolve(false)` but not `socket.destroy()`. A socket in error state may not auto-close on all platforms, leaving a dangling file descriptor. Fix: add `socket.destroy()` in the `error` handler. [`engine/src/network-monitor.ts:15-18`]
- [x] [Review][Patch] P4 — `on_online()` calls `update_all_synced()` without checking for in-progress syncs — If a sync is actively running when the network recovers, `on_online()` calls `status_footer_bar.update_all_synced()` unconditionally, causing a "All synced" flash before the next `sync_progress` event corrects it. `on_sync_complete` and `on_watcher_status` both have `any_syncing` guards; `on_online` should too. Fix: add `any_syncing` check before calling `update_all_synced()`. [`ui/src/protondrive/window.py:288-290`]
- [x] [Review][Defer] W1 — `on_online()` resets "syncing" rows to "synced" [`ui/src/protondrive/window.py:287`] — deferred; spec explicitly states "Returning to 'synced' is the correct safe default — engine will push `sync_progress`/`sync_complete` within seconds to correct state"
- [x] [Review][Defer] W2 — `get_status` snapshot races with push event (double `on_offline()` possible) [`engine/src/main.ts:555` + `main.py:283`] — deferred; `on_offline` is idempotent, low practical impact, Story 3-3 adds proper queue replay
- [x] [Review][Defer] W3 — `defaultOnlineCheck` internal 3-s timer/socket not cancellable by `stop()` [`engine/src/network-monitor.ts:4-21`] — deferred; ≤3s FD leak on shutdown only; acceptable for current scope
- [x] [Review][Defer] W4 — `_pairs_data` relative timestamps go stale during long offline periods [`ui/src/protondrive/window.py:282`] — deferred; cosmetic; corrected on next `sync_complete`
- [x] [Review][Defer] W5 — `_setNetworkMonitorForTests` doesn't stop previous monitor before replacing [`engine/src/main.ts:196`] — deferred; test hygiene; tests call `monitor.stop()` in `afterEach`
- [x] [Review][Defer] W6 — Test "emits online after offline" first-monitor block is effectively dead code [`engine/src/network-monitor.test.ts:40-50`] — deferred; Low severity; cleanup opportunity
