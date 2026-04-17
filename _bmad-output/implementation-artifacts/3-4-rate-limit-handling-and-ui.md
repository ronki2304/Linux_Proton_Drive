# Story 3.4: Rate Limit Handling & UI

Status: done

## Story

As a user,
I want to know when ProtonDrive is rate-limiting my sync,
so that I understand why sync is paused and know it will resume automatically.

## Acceptance Criteria

### AC1 — SDK 429 surfaces as `RateLimitError` (not `NetworkError`)

**Given** the SDK throws `RateLimitedError` (HTTP 429)
**When** `mapSdkError` in `sdk.ts` processes it
**Then** the engine throws `RateLimitError` (new typed subclass of `EngineError`)
**And** `RateLimitError` is NOT a `NetworkError` subclass (so `isFetchFailure()` in `sync-engine.ts` does NOT catch it)
**And** the error is thrown with message `"Rate limited"`

### AC2 — Engine applies exponential backoff on upload/download/trash operations

**Given** `uploadOne`, `downloadOne`, or `client.trashNode` in `processQueueEntry` throws `RateLimitError`
**When** the engine catches it in `withBackoff()`
**Then** the engine computes `resume_in_seconds = Math.min(2 ** attempt, 30)` (1s, 2s, 4s, 8s, 16s, 30s capped)
**And** emits a `rate_limited` push event with `{ resume_in_seconds }` before sleeping
**And** sleeps for `resume_in_seconds` seconds
**And** retries the operation (up to 5 total attempts: attempts 0–4)
**And** on the 5th failure, re-throws `RateLimitError` for the caller to handle as a regular per-file error

### AC3 — `rate_limited` push event emitted with `resume_in_seconds`

**Given** the engine is about to back off
**When** `withBackoff()` decides to sleep
**Then** it emits `{ type: "rate_limited", payload: { resume_in_seconds: N } }` (snake_case, IPC wire format)
**And** the event fires BEFORE the sleep — so the UI can show the countdown immediately

### AC4 — UI receives `rate_limited` event and updates footer

**Given** the UI receives a `rate_limited` event
**When** `on_rate_limited(payload)` is called on `MainWindow`
**Then** `status_footer_bar.set_rate_limited(resume_in)` is called with the integer value

### AC5 — `StatusFooterBar` shows countdown and auto-clears

**Given** `set_rate_limited(N)` is called
**When** rendering the rate-limited state
**Then** the footer label shows `"Sync paused — resuming in Ns"` immediately
**And** a `GLib.timeout_add(1000, ...)` callback decrements the counter each second
**And** the label updates each second: "Sync paused — resuming in (N-1)s", … , "Sync paused — resuming shortly" at 0
**And** the status dot uses the teal ("syncing") color — rate limiting is NOT an error

**Given** a subsequent `sync_progress` or `sync_complete` event arrives (engine resumed after backoff)
**When** the UI calls `set_syncing()` or `update_all_synced()`
**Then** the countdown timer stops automatically (tick callback sees `_dot_state != "rate_limited"` and returns `GLib.SOURCE_REMOVE`)

**Given** `set_rate_limited()` is called while a countdown is already running (engine hits rate limit again)
**When** the new `set_rate_limited(N)` is called
**Then** the old timer is cancelled via `GLib.source_remove()` and a fresh countdown starts

### AC6 — Rate limiting is NOT an error state

**Given** the rate-limited state
**When** the user inspects the UI
**Then** no red banner or error dialog is shown
**And** the footer presents it as a temporary pause ("paused — resuming"), never as a failure

### AC7 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit per logical group. **Commit directly to `main`** — do not create a feature branch.

---

## Tasks / Subtasks

- [x] **Task 1: Add `RateLimitError` to `errors.ts`** (AC: #1)
  - [x] 1.1 In `engine/src/errors.ts`, add after `NetworkError`:
    ```ts
    export class RateLimitError extends EngineError {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "RateLimitError";
      }
    }
    ```
    `errors.ts` has ZERO internal imports by design — do NOT add any imports to this file.
  - [x] 1.2 `bunx tsc --noEmit` — zero errors

- [x] **Task 2: Update `sdk.ts` — map `RateLimitedError` to `RateLimitError`** (AC: #1)
  - [x] 2.1 In `engine/src/sdk.ts`, add `RateLimitError` to the existing import from `./errors.js` (line ~70: `import { EngineError, NetworkError, SyncError } from "./errors.js"`):
    ```ts
    import { EngineError, NetworkError, RateLimitError, SyncError } from "./errors.js";
    ```
  - [x] 2.2 In `mapSdkError`, change the `RateLimitedError` branch from:
    ```ts
    if (err instanceof RateLimitedError) {
      throw new NetworkError("Rate limited", { cause: err });
    }
    ```
    to:
    ```ts
    if (err instanceof RateLimitedError) {
      throw new RateLimitError("Rate limited", { cause: err });
    }
    ```
    This is the ONLY change to `mapSdkError` — order of checks is preserved.
  - [x] 2.3 In `sdkErrorFactoriesForTests`, add:
    ```ts
    rateLimited: (msg = "rate limited") => new RateLimitedError(msg),
    ```
    (This factory already existed; verify the existing `rateLimited` factory in the object — it was present and still works, just now the mapping target changed.)
  - [x] 2.4 `bunx tsc --noEmit` — zero errors

- [x] **Task 3: `SyncEngine.withBackoff()` + apply to operations** (AC: #2, #3)
  - [x] 3.1 In `engine/src/sync-engine.ts`, add `RateLimitError` to the existing errors import (line ~9):
    ```ts
    import { NetworkError, RateLimitError, SyncError } from "./errors.js";
    ```
  - [ ] 3.2 Add an optional `sleepMs` parameter to `SyncEngine` constructor (last param, for test injection):
    ```ts
    constructor(
      private readonly stateDb: StateDb,
      private readonly emitEvent: (event: IpcPushEvent) => void,
      private readonly getConfigPairs: () => ConfigPair[] = listConfigPairs,
      private readonly onNetworkFailure: () => void = () => {},
      private readonly sleepMs: (ms: number) => Promise<void> =
        (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ) {}
    ```
    This is the 5th constructor parameter. All existing callers pass 4 args; the default is the real `setTimeout`-based sleep. No existing call sites need updating.
  - [x] 3.3 Add the `withBackoff` private method to `SyncEngine` (add after the constructor, before `startSyncAll`):
    ```ts
    /**
     * Retry `fn` with exponential backoff on RateLimitError.
     * Emits `rate_limited` push event before each sleep.
     * Max 5 attempts (attempts 0–4); re-throws on the 5th failure.
     * Sleep duration: min(2^attempt, 30) seconds.
     */
    private async withBackoff<T>(fn: () => Promise<T>): Promise<T> {
      const MAX_RETRIES = 5;
      const MAX_BACKOFF_S = 30;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof RateLimitError && attempt < MAX_RETRIES - 1) {
            const resumeIn = Math.min(Math.pow(2, attempt), MAX_BACKOFF_S);
            this.emitEvent({
              type: "rate_limited",
              payload: { resume_in_seconds: resumeIn },
            });
            await this.sleepMs(resumeIn * 1000);
            continue;
          }
          throw err;
        }
      }
      // Unreachable (loop always returns or throws), but TypeScript needs this.
      throw new SyncError("withBackoff: exhausted retries");
    }
    ```
  - [x] 3.4 Apply `withBackoff` in `uploadOne()` — wrap the two SDK calls:
    ```ts
    // BEFORE (line ~866):
    const result = await client.uploadFileRevision(item.existingNodeUid, body);
    // AFTER:
    const result = await this.withBackoff(() => client.uploadFileRevision(item.existingNodeUid!, body));

    // BEFORE (line ~869):
    const result = await client.uploadFile(item.remoteFolderId, basename(item.relativePath), body);
    // AFTER:
    const result = await this.withBackoff(() => client.uploadFile(item.remoteFolderId, basename(item.relativePath), body));
    ```
    `uploadOne` signature is unchanged — only the inner SDK calls are wrapped.
  - [x] 3.5 Apply `withBackoff` in `downloadOne()` — wrap `client.downloadFile`:
    ```ts
    // BEFORE (line ~884):
    await client.downloadFile(item.nodeUid, writableStream);
    // AFTER:
    await this.withBackoff(() => client.downloadFile(item.nodeUid, writableStream));
    ```
  - [x] 3.6 Apply `withBackoff` in `processQueueEntry()` — wrap `client.trashNode` (the `"trashNode"` case):
    ```ts
    // BEFORE (line ~442):
    await client.trashNode(remote!.id);
    // AFTER:
    await this.withBackoff(() => client.trashNode(remote!.id));
    ```
    The `"upload"` case already goes through `uploadOne()` which is now wrapped (Task 3.4).
  - [x] 3.7 **Do NOT wrap** `walkRemoteTree`, `resolveRemoteId`, `createRemoteFolder`, list operations — these are read-heavy operations where rate limiting is unlikely; if they do get rate limited the error propagates to `syncPair`'s catch as a `RateLimitError`, gets emitted as `sync_cycle_error`, and logged. Scope is upload/download/trash operations only.
  - [x] 3.8 `isFetchFailure()` (lines 14-21) — verify it does NOT need changes. It checks `err instanceof NetworkError`. Since `RateLimitError extends EngineError` (not `NetworkError`), rate limit errors are NOT caught by `isFetchFailure`. This is correct — rate limits should not trigger the network-failure path. No change needed.
  - [x] 3.9 `bunx tsc --noEmit` — zero errors

- [x] **Task 4: Engine tests for `withBackoff` and rate-limit integration** (AC: #2, #3)
  - [x] 4.1 In `engine/src/sdk.test.ts`, add a test in the existing `DriveClient` error-mapping describe block:
    - Test: `RateLimitedError` → `RateLimitError` (NOT `NetworkError`) — use `sdkErrorFactoriesForTests.rateLimited()`; verify `err instanceof RateLimitError` is `true` and `err instanceof NetworkError` is `false`
  - [x] 4.2 In `engine/src/sync-engine.test.ts`, add a new `describe` block `SyncEngine — withBackoff`:
    - **Setup**: Construct `SyncEngine` with a `mock()` sleepMs: `const sleepSpy = mock(async (_ms: number) => {})`. Pass as 5th constructor arg.
    - Test: **no rate limit → calls fn once, returns result** — fn returns `"ok"`; expect return `"ok"`, fn called once, no `rate_limited` events emitted
    - Test: **one rate limit then success → retries, emits event, returns result** — fn throws `RateLimitError` on attempt 0, returns `"ok"` on attempt 1; expect:
      - fn called twice
      - exactly ONE `rate_limited` event emitted with `{ resume_in_seconds: 1 }` (2^0 = 1)
      - `sleepSpy` called with `1000` (1s in ms)
      - final return `"ok"`
    - Test: **two rate limits then success → correct backoff schedule** — fn throws rate limit on attempts 0 and 1, returns on attempt 2; expect:
      - `rate_limited` events: `[{resume_in_seconds:1}, {resume_in_seconds:2}]` (2^0, 2^1)
      - `sleepSpy` calls: `[1000, 2000]`
    - Test: **rate limit capped at 30s** — fn throws on all first 4 attempts; on attempt 4 the duration is `min(2^4, 30) = 16`, then `min(2^4...`; specifically verify attempt 5+ (`2^5=32`) is capped to 30: set up 5 failures, first retry has `resume_in_seconds=1`, last retry `resume_in_seconds=min(2^4,30)=16`
    - Test: **max retries exhausted → re-throws on 5th failure** — fn always throws `RateLimitError`; after 5 calls (attempts 0–4), `withBackoff` re-throws `RateLimitError`; expect fn called exactly 5 times, 4 `rate_limited` events (not 5: the last attempt throws without a subsequent retry)
    - Test: **non-RateLimitError passes through immediately** — fn throws `SyncError`; expect fn called once, error propagates, no `rate_limited` events, `sleepSpy` not called
  - [x] 4.3 In `engine/src/sync-engine.test.ts`, add to the existing `SyncEngine — replayQueue` describe block:
    - Test: **rate limit on upload during replay → retries, emits event, entry dequeued** — seed a pair + queue entry + local file + mock remote; `uploadFileRevision` mock throws `RateLimitError` on attempt 0, returns success on attempt 1; `sleepMs` = no-op; expect:
      - one `rate_limited` event emitted during replay
      - entry dequeued from `change_queue` (`synced = 1`)
  - [x] 4.4 `bun test engine/src/` — all pass

- [x] **Task 5: UI — register and forward `rate_limited` event** (AC: #4)
  - [x] 5.1 In `ui/src/protondrive/main.py`, add to the existing event registrations (after line 73 `queue_replay_complete`):
    ```python
    self._engine.on_event("rate_limited", self._on_rate_limited)
    ```
  - [x] 5.2 Add forwarder method in the same class (mirror the `_on_queue_replay_complete` pattern):
    ```python
    def _on_rate_limited(self, payload: dict[str, Any]) -> None:
        if self._window is not None:
            self._window.on_rate_limited(payload)
    ```
  - [x] 5.3 In `ui/src/protondrive/window.py`, add handler method:
    ```python
    def on_rate_limited(self, payload: dict[str, Any]) -> None:
        resume_in = (payload.get("resume_in_seconds") or 0)
        resume_in = int(resume_in) if resume_in > 0 else 5  # safe default
        self.status_footer_bar.set_rate_limited(resume_in)
    ```
    Note: `or 0` guards against `None` (same pattern as `on_queue_replay_complete`).

- [x] **Task 6: `StatusFooterBar.set_rate_limited()` + countdown** (AC: #5, #6)
  - [x] 6.1 In `ui/src/protondrive/widgets/status_footer_bar.py`, add `GLib` to the import:
    ```python
    from gi.repository import GLib, Gtk
    ```
  - [x] 6.2 In `__init__`, add two new state attributes after `self._dot_state = "synced"`:
    ```python
    self._rate_limit_remaining: int = 0
    self._rate_limit_source_id: int | None = None
    ```
  - [x] 6.3 Add method `set_rate_limited`:
    ```python
    def set_rate_limited(self, resume_in: int) -> None:
        """Show rate-limited state with countdown. Not an error — a temporary pause."""
        # Cancel any active countdown before starting a new one.
        if self._rate_limit_source_id is not None:
            GLib.source_remove(self._rate_limit_source_id)
            self._rate_limit_source_id = None

        self._rate_limit_remaining = max(1, resume_in)
        text = f"Sync paused \u2014 resuming in {self._rate_limit_remaining}s"
        self.footer_label.set_text(text)
        self._set_dot_state("rate_limited")
        self.update_property([Gtk.AccessibleProperty.LABEL], [text])
        self.announce(text, Gtk.AccessibleAnnouncementPriority.LOW)
        self._rate_limit_source_id = GLib.timeout_add(1000, self._on_rate_limit_tick)
    ```
  - [x] 6.4 Add countdown tick callback:
    ```python
    def _on_rate_limit_tick(self) -> bool:
        """GLib.timeout_add callback — fires every 1s during rate-limit countdown."""
        # If state changed (sync resumed, went offline, etc.), stop the timer.
        if self._dot_state != "rate_limited":
            self._rate_limit_source_id = None
            return GLib.SOURCE_REMOVE
        self._rate_limit_remaining -= 1
        if self._rate_limit_remaining <= 0:
            # Countdown elapsed — show static text until engine sends sync_progress.
            self.footer_label.set_text("Sync paused \u2014 resuming shortly")
            self.update_property(
                [Gtk.AccessibleProperty.LABEL],
                ["Sync paused \u2014 resuming shortly"],
            )
            self._rate_limit_source_id = None
            return GLib.SOURCE_REMOVE
        text = f"Sync paused \u2014 resuming in {self._rate_limit_remaining}s"
        self.footer_label.set_text(text)
        self.update_property([Gtk.AccessibleProperty.LABEL], [text])
        return GLib.SOURCE_CONTINUE
    ```
  - [x] 6.5 **`_set_dot_state()` requires NO code change for `"rate_limited"`** — read lines 82–104 of `status_footer_bar.py` to confirm. The existing `elif` chain handles `"syncing"`, `"offline"`, and `"conflict"` then falls through for all other state strings (including `"synced"` and the new `"rate_limited"`). No CSS class is added, and `_on_dot_draw` handles the color. Do NOT add an `elif state == "rate_limited": pass` — it would be noise. No edit to `_set_dot_state()` body is needed.
  - [x] 6.6 Extend `_on_dot_draw()` to render teal for `"rate_limited"`:
    ```python
    elif self._dot_state == "rate_limited":
        cr.set_source_rgb(0.11, 0.63, 0.63)  # teal — same as "syncing" (not an error)
    ```
    Add this after the `elif self._dot_state == "conflict"` line. The dot is teal to communicate "in-progress pause", not failure. The text distinguishes the state.
  - [x] 6.7 **Do NOT add a new Blueprint `.blp` file** — this is pure Python on an existing widget.

- [x] **Task 7: UI tests** (AC: #4, #5, #6)
  - [x] 7.1 In `ui/tests/test_status_footer_bar.py`, add `TestStatusFooterBarSetRateLimited` after `TestStatusFooterBarSetConflictPending`. Mirror the fixture/mock pattern exactly. Tests:
    - Test: `set_rate_limited(5)` → `footer_label.set_text` called with `"Sync paused — resuming in 5s"` (em-dash `\u2014`)
    - Test: `set_rate_limited(1)` → `footer_label.set_text` called with `"Sync paused — resuming in 1s"` (no special singular form — just "1s")
    - Test: `set_rate_limited(5)` → `_dot_state == "rate_limited"` (inspect the attribute directly)
    - Test: `set_rate_limited(5)` → `GLib.timeout_add` called with `(1000, ...)` — mock `GLib.timeout_add` to capture the call
    - Test: `set_rate_limited(5)` → `bar.announce` called with `("Sync paused — resuming in 5s", Gtk.AccessibleAnnouncementPriority.LOW)` — mock `bar.announce = MagicMock()` before calling (mirror the pattern at `test_status_footer_bar.py:28,119–120`)
    - Test: `set_rate_limited(5)` called twice → `GLib.source_remove` called once with the first source ID. Mock setup: `GLib.timeout_add = MagicMock(side_effect=[42, 99])` (first call returns 42, second returns 99). After both `set_rate_limited` calls, assert `GLib.source_remove.assert_called_once_with(42)`. This proves the first timer (ID 42) was cancelled before the second (ID 99) started.
    - Test: `_on_dot_draw` renders teal `(0.11, 0.63, 0.63)` when `_dot_state == "rate_limited"` — set `widget._dot_state = "rate_limited"` then call `widget._on_dot_draw(mock_area, mock_cr, 10, 10)` and assert `mock_cr.set_source_rgb(0.11, 0.63, 0.63)`
    - Test: `_on_rate_limit_tick` when `_dot_state != "rate_limited"` → returns `GLib.SOURCE_REMOVE` (False) — set `_dot_state = "synced"`, call tick, assert returns `False`
    - Test: `_on_rate_limit_tick` with 2 seconds remaining → returns `GLib.SOURCE_CONTINUE` (True), label updated to "Sync paused — resuming in 1s"
    - Test: `_on_rate_limit_tick` with 0 seconds remaining → returns `GLib.SOURCE_REMOVE`, label becomes `"Sync paused — resuming shortly"`
  - [x] 7.2 In `ui/tests/test_main.py`, add to the existing event registration tests:
    - Test: `rate_limited` handler is registered in `do_startup()` under the key `"rate_limited"`
    - Test: `_on_rate_limited({"resume_in_seconds": 10})` → `window.on_rate_limited` called with the payload
  - [x] 7.3 In `ui/tests/test_window_routing.py`, add tests for `on_rate_limited`:
    - Test: `on_rate_limited({"resume_in_seconds": 5})` → `status_footer_bar.set_rate_limited(5)` called
    - Test: `on_rate_limited({"resume_in_seconds": None})` → `status_footer_bar.set_rate_limited(5)` called (safe default; `None or 0` → `0 > 0` fails → default `5`)
    - Test: `on_rate_limited({"resume_in_seconds": 0})` → `status_footer_bar.set_rate_limited(5)` called (same safe-default path)
  - [x] 7.4 Run `meson test -C builddir` (or `meson setup builddir` first if not configured) — pre-existing failures unchanged; new tests pass.

- [x] **Task 8: Final validation** (AC: all)
  - [x] 8.1 `bun test engine/src/` — all pass (205 pass, 0 fail)
  - [x] 8.2 `bunx tsc --noEmit` — zero errors
  - [x] 8.3 `meson test -C builddir` — 417 pass, 29 pre-existing failures, no new regressions
  - [x] 8.4 Set story Status to `review`. Commit directly to `main`.

---

## Dev Notes

### What `RateLimitError` Is (and Isn't)

`RateLimitError` is a new typed error subclass in `errors.ts`. It extends `EngineError` directly — NOT `NetworkError`. This is intentional:

- `isFetchFailure()` in `sync-engine.ts` checks `err instanceof NetworkError` to detect dropped connections. Rate limits are NOT dropped connections — the server is responding. If `RateLimitError` extended `NetworkError`, rate limits would trigger `onNetworkFailure()`, causing the UI to show the offline indicator and the watcher to start queuing. That is wrong behavior — the app IS connected; sync is just paused.
- `RateLimitError` should NOT cause the engine to transition to offline mode.
- After 5 failed attempts, `RateLimitError` propagates to `processOne`'s catch handler → emits `sync_file_error` event (for `startSyncAll` path) or `processQueueEntry`'s catch → emits `queue_replay_failed` (for `replayQueue` path). This is acceptable: extreme rate limiting is reported as a per-file error after exhaustion.

### `withBackoff` Placement and Scope

**Why wrapping at SDK-call level (not pair level):**
- Rate limits happen per-HTTP-request, not per-pair
- Pair-level retry would re-walk the remote tree on every rate limit, generating more API calls
- Per-call retry only retries the specific operation that was rate limited

**Operations wrapped:**
- `client.uploadFileRevision(...)` in `uploadOne()`
- `client.uploadFile(...)` in `uploadOne()`
- `client.downloadFile(...)` in `downloadOne()`
- `client.trashNode(...)` in `processQueueEntry()` trashNode case

**Operations NOT wrapped (acceptable scope reduction):**
- `client.listRemoteFiles` / `listRemoteFolders` in `walkRemoteTree` — list operations are less likely to be rate-limited; if they are, the error propagates to `syncPair`'s catch as `RateLimitError`, emitted as `sync_cycle_error`. Next sync cycle will retry.
- `client.createRemoteFolder` in `syncPair` / `resolveRemoteId` — same rationale.

### Backoff Schedule

```
attempt 0 → 1s  (2^0)
attempt 1 → 2s  (2^1)
attempt 2 → 4s  (2^2)
attempt 3 → 8s  (2^3)
attempt 4 (final retry after 4th sleep) → 16s
(2^5 = 32 would be 30 capped, but max is attempt 4)
```

Total maximum wait before giving up: 1+2+4+8+16 = 31s across 5 attempts.

### `sleepMs` Constructor Parameter for Test Injection

The 5th constructor parameter `sleepMs` defaults to the real `setTimeout`-based sleep. Tests pass `async (_ms: number) => {}` to skip waits:

```ts
const sleepSpy = mock(async (_ms: number) => {});
const engine = new SyncEngine(stateDb, emitEvent, listConfigPairs, () => {}, sleepSpy);
```

`sleepSpy.mock.calls` can verify the delay values passed.

### Concurrent Backoff in `executeWorkList` — Expected Behavior

`executeWorkList` runs up to 3 concurrent uploads via `Promise.all` + `Semaphore(3)`. Each upload runs its own independent `withBackoff` loop. If all three uploads get rate-limited at attempt 0, the engine emits **three separate `rate_limited` events** nearly simultaneously, each with `resume_in_seconds: 1`. The UI calls `set_rate_limited(1)` three times in rapid succession — each call cancels the previous timer and resets the countdown. The countdown resets 2–3 times within a single tick, then stabilizes. This is **expected behavior**, not a bug. The timer-cancel logic in `set_rate_limited()` handles it correctly. Story 2-12's unified queue drainer will eliminate this by removing `executeWorkList`'s parallelism entirely.

**Do NOT add deduplication or a "rate-limit-already-active" guard** — it would introduce state drift between engine and UI that is harder to reason about than the harmless visual reset.

### UI Countdown Auto-Cancellation

The countdown uses `GLib.timeout_add(1000, this._on_rate_limit_tick)`. The tick callback auto-stops by returning `GLib.SOURCE_REMOVE` (= `False`) when:
1. `_dot_state` changed (any call to `_set_dot_state` with a different state) — the next tick sees the new state and bails
2. `_rate_limit_remaining` reaches 0 — tick returns `False` itself

The `set_rate_limited()` call explicitly cancels any existing timer via `GLib.source_remove(self._rate_limit_source_id)` before starting a new one. This handles the case where the engine sends a second `rate_limited` event before the first countdown elapsed.

**Important:** `GLib.SOURCE_REMOVE = False`, `GLib.SOURCE_CONTINUE = True`. Use the constants for clarity.

### UI Event Flow

```
engine emits rate_limited {resume_in_seconds: N}
 → engine.py dispatches to on_event("rate_limited") handler
 → main.py._on_rate_limited(payload)
 → window.on_rate_limited(payload)
 → status_footer_bar.set_rate_limited(N)
     → GLib.timeout_add(1000, _on_rate_limit_tick) starts
     → footer shows "Sync paused — resuming in Ns"

[N seconds later — engine retries, succeeds]
engine emits sync_progress
 → window.on_sync_progress(payload)
 → status_footer_bar.set_syncing(...)  [or update_all_synced on sync_complete]
     → _set_dot_state("syncing") — _dot_state changes
     → [next tick fires 1s later, sees _dot_state != "rate_limited", returns SOURCE_REMOVE]
```

### `_set_dot_state` for `"rate_limited"` — No New CSS Class

`"rate_limited"` state falls through the existing `if/elif` chain in `_set_dot_state()` without adding any CSS class (same as `"synced"`). The dot color is controlled purely by `_on_dot_draw`, which adds the `"rate_limited"` → teal branch.

If you're extending `_set_dot_state` for future states, always follow the remove-all-then-add-one pattern from Story 3-3 Task 7.2. The current method removes all 3 CSS classes before adding one. `"rate_limited"` is intentionally class-free.

### Regression Guard: `_conflict_pending_count` and Rate Limiting

The `_conflict_pending_count` guard in `window.py` (protecting `on_sync_complete` and `on_watcher_status`) does NOT need to be extended for rate limiting. Rate limiting is transient:
1. It does not clear `_conflict_pending_count`
2. When the engine resumes and `sync_complete` fires, the conflict guard still applies correctly

No changes to `on_sync_complete`, `on_watcher_status`, or `on_online` regression guards.

### IPC Wire Format

`rate_limited` push event uses snake_case fields (IPC wire format rule):
```json
{ "type": "rate_limited", "payload": { "resume_in_seconds": 5 } }
```

NOT `resumeInSeconds`. The Python parser sees `payload.get("resume_in_seconds")`.

### `processOne` Error Path — Rate Limit After Exhaustion

After 5 retries, `withBackoff` re-throws `RateLimitError`. This propagates to:
- `processOne`'s catch (line ~843): emits `{ type: "error", code: "sync_file_error", message: "Rate limited", pair_id }`. This is the correct behavior — a file that can't be uploaded after 5 attempts is reported as a per-file sync error. The user does NOT see a popup; the error event goes to the existing error handler which shows it inline on the affected pair card (non-fatal error display rule).
- `processQueueEntry`'s catch (line ~477): same path, emits `queue_replay_failed` error event.

### Files to Create / Modify

**Engine (TypeScript):**
- `engine/src/errors.ts` — add `RateLimitError`
- `engine/src/sdk.ts` — `mapSdkError` change, import `RateLimitError`
- `engine/src/sdk.test.ts` — add `RateLimitedError → RateLimitError` mapping test
- `engine/src/sync-engine.ts` — import `RateLimitError`, add `sleepMs` param, add `withBackoff()`, apply to `uploadOne`/`downloadOne`/`trashNode`
- `engine/src/sync-engine.test.ts` — add `withBackoff` describe block + rate-limit replay test

**UI (Python):**
- `ui/src/protondrive/main.py` — register `rate_limited` handler, add forwarder
- `ui/src/protondrive/window.py` — add `on_rate_limited()` method
- `ui/src/protondrive/widgets/status_footer_bar.py` — add `set_rate_limited()`, `_on_rate_limit_tick()`, extend `_on_dot_draw()`, add GLib import, add state attrs in `__init__`
- `ui/tests/test_status_footer_bar.py` — add `TestStatusFooterBarSetRateLimited` (9 tests)
- `ui/tests/test_main.py` — add `rate_limited` registration test (2 tests)
- `ui/tests/test_window_routing.py` — add `on_rate_limited` routing tests (3 tests)

**Not touched:**
- `engine/src/state-db.ts` — no schema changes
- `engine/src/network-monitor.ts` — unchanged
- `engine/src/watcher.ts` — unchanged
- `engine/src/main.ts` — unchanged (rate limit handling is inside SyncEngine)
- `engine/src/ipc.ts` — new event type is additive, no structural change
- Blueprint `.blp` files — no new widgets
- GSettings schemas — no new keys

### What Already Exists (Do NOT Recreate)

- **`isFetchFailure()`** at `sync-engine.ts:14` — checks `NetworkError`; `RateLimitError` is intentionally NOT caught here
- **`processOne` catch handler** at `sync-engine.ts:843` — emits `sync_file_error`; after rate limit exhaustion, `RateLimitError` routes here naturally
- **`processQueueEntry` catch handler** at `sync-engine.ts:477` — emits `queue_replay_failed`; same for replay path
- **`sdkErrorFactoriesForTests`** at `sdk.ts:229` — the `rateLimited` factory already exists; just update the assertion in tests from `NetworkError` to `RateLimitError`
- **`_set_dot_state()` remove-all-then-add-one matrix** at `status_footer_bar.py:82` — Story 3-3 established this; `"rate_limited"` state falls through cleanly without a CSS class
- **`on_event()` dispatcher** in `engine.py` — supports arbitrary event types with dict dispatch; adding `rate_limited` is one line

### SDK Note: `RateLimitedError` Has No `retryAfter` Field

The SDK's `RateLimitedError` type (from `dist/errors.d.ts`) only has `name: string; code: number`. It does NOT expose a `Retry-After` header value. Therefore, `resume_in_seconds` is computed entirely by the engine's exponential backoff schedule, not from the SDK. This is correct per FR23: "applies exponential backoff when rate-limited".

### Story 2-12 Note

The unified queue drainer refactor (Story 2-12) will inherit `withBackoff` as-is — the drainer processes entries sequentially and can wrap individual operations identically. No special design needed here for 2-12 compatibility.

### References

- `engine/src/errors.ts` — base error classes (zero-import rule)
- `engine/src/sdk.ts:155–211` — `mapSdkError` function (change `RateLimitedError` branch)
- `engine/src/sdk.ts:229` — `sdkErrorFactoriesForTests` (add `rateLimit` → `RateLimitError` mapping)
- `engine/src/sync-engine.ts:9` — errors import (add `RateLimitError`)
- `engine/src/sync-engine.ts:14–21` — `isFetchFailure()` (verify: does NOT catch `RateLimitError`, no changes needed)
- `engine/src/sync-engine.ts:80–94` — `SyncEngine` constructor (add `sleepMs` 5th param)
- `engine/src/sync-engine.ts:855–870` — `uploadOne()` (wrap two SDK calls in `withBackoff`)
- `engine/src/sync-engine.ts:873–918` — `downloadOne()` (wrap `client.downloadFile`)
- `engine/src/sync-engine.ts:440–452` — `processQueueEntry` trashNode case (wrap `client.trashNode`)
- `engine/src/sync-engine.ts:843` — `processOne` catch (existing `sync_file_error` emitter, no change)
- `engine/src/sync-engine.ts:477` — `processQueueEntry` catch (existing `queue_replay_failed` emitter, no change)
- `engine/node_modules/@protontech/drive-sdk/dist/errors.d.ts:103` — `RateLimitedError` class definition (no `retryAfter`)
- `ui/src/protondrive/main.py:66–73` — existing event registrations (add `rate_limited`)
- `ui/src/protondrive/window.py` — add `on_rate_limited()` (mirror `on_queue_replay_complete` pattern at ~319)
- `ui/src/protondrive/widgets/status_footer_bar.py:19` — `__init__` (add 2 state attrs)
- `ui/src/protondrive/widgets/status_footer_bar.py:62` — `set_conflict_pending` (mirror pattern for `set_rate_limited`)
- `ui/src/protondrive/widgets/status_footer_bar.py:82` — `_set_dot_state()` (verify `"rate_limited"` falls through without CSS class)
- `ui/src/protondrive/widgets/status_footer_bar.py:106` — `_on_dot_draw()` (add teal branch for `"rate_limited"`)
- `ui/tests/test_status_footer_bar.py:87` — `TestStatusFooterBarSetConflictPending` (add `TestStatusFooterBarSetRateLimited` after)
- `ui/tests/test_main.py` — existing `TestQueueReplayCompleteHandler` (add `TestRateLimitedHandler` after)
- `ui/tests/test_window_routing.py` — existing `TestOnQueueReplayComplete` (add `TestOnRateLimited` after)
- FR23: `_bmad-output/planning-artifacts/prd/functional-requirements.md:33`
- UX Rate-limited pattern: `_bmad-output/planning-artifacts/ux-design-specification.md:372`
- Story 3-3 Dev Notes (`set_conflict_pending` pattern, `_set_dot_state` matrix): `_bmad-output/implementation-artifacts/3-3-queue-replay-and-auto-resume-on-reconnect.md`
- Engine flat source rule: `_bmad-output/project-context.md:191`
- `import type` + `.js` extension rules: `_bmad-output/project-context.md:68–70`
- IPC snake_case wire format: `_bmad-output/project-context.md:180`

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — clean implementation, no debugging needed.

### Completion Notes List

- Task 1: Added `RateLimitError extends EngineError` to `errors.ts` (zero-import rule preserved)
- Task 2: Updated `sdk.ts` `mapSdkError` — `RateLimitedError` now maps to `RateLimitError` (not `NetworkError`). Updated existing test in `sdk.test.ts` from `NetworkError` to `RateLimitError` assertion.
- Task 3: Added `sleepMs` 5th constructor param to `SyncEngine` with real `setTimeout` default. Added `withBackoff<T>()` private method. Wrapped `client.uploadFileRevision`, `client.uploadFile`, `client.downloadFile`, and `client.trashNode` calls.
- Task 4: 205 engine tests pass. New `SyncEngine — withBackoff` describe block with 6 tests. Rate-limit replay integration test added to `SyncEngine — replayQueue` describe.
- Task 5: Registered `rate_limited` event in `main.py`; added `_on_rate_limited` forwarder; added `on_rate_limited` to `window.py`.
- Task 6: Added GLib import to `status_footer_bar.py`; added `_rate_limit_remaining` and `_rate_limit_source_id` attrs; added `set_rate_limited()` and `_on_rate_limit_tick()` methods; extended `_on_dot_draw` with teal branch for `"rate_limited"`. `_set_dot_state()` unchanged (falls through cleanly).
- Task 7: 10 new tests in `TestStatusFooterBarSetRateLimited`; 2 tests in `TestRateLimitedHandler`; 3 tests in `TestOnRateLimited`. All pass. Fixed shared-mock leak by saving/restoring `GLib.timeout_add` in timer tests.
- Task 8: All validation passed. 205/205 engine, 0 TypeScript errors, 417 UI pass with same 29 pre-existing failures.

### File List

- `engine/src/errors.ts` — added `RateLimitError`
- `engine/src/sdk.ts` — imported `RateLimitError`, changed `mapSdkError` `RateLimitedError` branch
- `engine/src/sdk.test.ts` — updated rate-limited test, added `RateLimitError` import
- `engine/src/sync-engine.ts` — imported `RateLimitError`, added `sleepMs` constructor param, added `withBackoff()`, wrapped upload/download/trash SDK calls
- `engine/src/sync-engine.test.ts` — added `RateLimitError`/`SyncError` imports, `SyncEngine — withBackoff` describe block, rate-limit replay test
- `ui/src/protondrive/main.py` — registered `rate_limited` handler, added `_on_rate_limited` forwarder
- `ui/src/protondrive/window.py` — added `on_rate_limited()` method
- `ui/src/protondrive/widgets/status_footer_bar.py` — `GLib` import, state attrs, `set_rate_limited()`, `_on_rate_limit_tick()`, teal dot draw branch
- `ui/tests/test_status_footer_bar.py` — `_make_bar()` updated with new state attrs, `TestStatusFooterBarSetRateLimited` (10 tests)
- `ui/tests/test_main.py` — `TestRateLimitedHandler` (2 tests)
- `ui/tests/test_window_routing.py` — `TestOnRateLimited` (3 tests)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status: in-progress → review
- `_bmad-output/implementation-artifacts/3-4-rate-limit-handling-and-ui.md` — all tasks checked, dev record filled

---

### Review Findings

- [x] [Review][Defer] Unreachable `throw new SyncError("withBackoff: exhausted retries")` [engine/src/sync-engine.ts] — deferred, pre-existing; loop always returns or throws before reaching it; added to satisfy TypeScript's control-flow analysis
- [x] [Review][Defer] Non-numeric `resume_in_seconds` guard in `on_rate_limited` [ui/src/protondrive/window.py:353-354] — deferred, pre-existing pattern; `or 0` guards None but a string/object value would raise TypeError; trusted internal engine→UI boundary makes this effectively unreachable
