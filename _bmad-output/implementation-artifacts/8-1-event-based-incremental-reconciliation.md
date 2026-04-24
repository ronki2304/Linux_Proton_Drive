# Story 8.1: Event-Based Incremental Reconciliation

Status: ready-for-dev

## Story

As a user,
I want the sync client to start up quickly and not hammer the ProtonDrive API on every launch,
so that reconciliation is near-instant after the first run and the client complies with Proton's SDK usage requirements.

## Acceptance Criteria

1. **State DB migration v6** — two new tables added atomically:
   - `event_checkpoint (tree_event_scope_id TEXT PRIMARY KEY, last_event_id TEXT NOT NULL)` — one row per scope, stores the last durably received event ID
   - `event_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, tree_event_scope_id TEXT NOT NULL, event_type TEXT NOT NULL, event_payload TEXT NOT NULL)` — ordered persistent inbox for received events
   Migration is additive — no data loss on upgrade from existing installs (v5 → v6).

2. **`LatestEventIdProvider` wired** — `DriveClient` / `createDriveClient` accepts a `LatestEventIdProvider` implementation backed by `StateDb`. When the SDK creates an event subscription it calls `getLatestEventId(scopeId)` to retrieve the saved checkpoint (or `null` on first run).

3. **First run (no checkpoint)** — `LatestEventIdProvider` returns `null`. The SDK starts the subscription from "now". A full remote tree walk runs as today. The first `FastForward` event from the subscription establishes the checkpoint.

4. **Subsequent startups (checkpoint exists)** — `LatestEventIdProvider` returns the saved event ID. The SDK replays missed events via the `DriveListener` callback. A full tree walk is **skipped**.

5. **Two-phase event processing** — the `DriveListener` callback is thin: it only persists the event to `event_queue` and atomically advances the checkpoint, then returns. All reconcile work happens in a separate drain loop. A crash at any point is safe:
   - Crash before callback writes: checkpoint unchanged → SDK replays on next startup
   - Crash after callback writes but before drain: event survives in `event_queue` → drained on next startup
   - Crash mid-drain: event still in `event_queue` → retried on next startup

6. **`FastForward` event** — persisted to queue; drain loop deletes it without doing any work (checkpoint already advanced by callback).

7. **`TreeRefresh` event** — persisted to queue; checkpoint cleared atomically in callback. Drain loop: clears all remaining queue entries for the scope, then triggers a full tree walk. After the walk, the next `FastForward` re-establishes the checkpoint.

8. **`NodeCreated` / `NodeUpdated` event** — drain loop resolves the node, determines which sync pair(s) it belongs to, and enqueues a targeted reconcile (download or conflict check) for that file only.

9. **`NodeDeleted` event** — drain loop schedules a lightweight pair reconcile for the next cycle (targeted deletion deferred — see Dev Notes).

10. **`DriveListener` must not throw** — the callback wraps all logic in `try-catch`. Errors are logged via `debugLog` but never propagate out of the callback.

11. **Drain loop on startup** — before checking whether to run a full walk, the engine drains any leftover `event_queue` entries from a previous session. This ensures events received just before a crash are not silently skipped.

12. **Subscription lifecycle** — the `EventSubscription` returned by `subscribeToTreeEvents` is stored on the engine and `dispose()` is called in the engine shutdown sequence alongside `fileWatcher.stop()` and `server.close()`.

13. **SDK compliance** — all Proton Drive API access goes through the SDK. No direct HTTP calls to the Drive API are made anywhere in this story. Requirement from `github.com/ProtonDriveApps/sdk` README: *"Always interact with Proton Drive through the SDK. Direct API calls are not permitted."*

14. **No regression** — all existing engine unit tests pass; the full-walk path (first run or after `TreeRefresh`) produces identical queue entries to the current implementation.

## Critical SDK Clarification — Read Before Starting

### `VolumeEventManager` Exists But Is Off-Limits

`volumeEventManager.js` and `volumeEventManager.d.ts` both exist in `dist/internal/events/`. It implements a pull-model async generator `getEvents(eventId)` that could theoretically replay events from a saved ID.

Do **not** use it. It is an internal SDK class (`dist/internal/`), not part of the public API. The SDK README explicitly prohibits instantiating internal classes or making direct Drive API calls. The public subscription API (`subscribeToTreeEvents`) delivers the same capability without violating the contract.

### Direct API Calls Are Prohibited

The Proton Drive SDK README (`github.com/ProtonDriveApps/sdk`) explicitly states:

> **"Always interact with Proton Drive through the SDK. Direct API calls are not permitted."**

This rules out:
- Calling `drive/v2/volumes/{id}/events/{eventId}` directly via `ProtonHTTPClient`
- Instantiating `VolumeEventManager`, `EventsAPIService`, or `DriveAPIService` (internal SDK classes) — even via `@ts-ignore`

### Correct Public SDK Event API

The only compliant approach is the public SDK subscription API:

```typescript
// ProtonDriveClient public methods (from dist/protonDriveClient.d.ts):
subscribeToTreeEvents(treeEventScopeId: string, callback: DriveListener): Promise<EventSubscription>

// Public interface passed to ProtonDriveClient constructor:
interface LatestEventIdProvider {
  getLatestEventId(treeEventScopeId: string): Promise<string | null>;
}

// Public event types (from dist/interface/events.d.ts — all re-exported from index):
import type { DriveListener, DriveEvent, EventSubscription, LatestEventIdProvider } from "@protontech/drive-sdk";
import { DriveEventType } from "@protontech/drive-sdk";
```

### `treeEventScopeId === volumeId` (confirmed from SDK source)

From `dist/internal/events/index.js` line 67:
```javascript
async subscribeToTreeEvents(treeEventScopeId, callback) {
  const volumeId = treeEventScopeId;  // they are identical
```

Obtained from `NodeEntity.treeEventScopeId` — e.g., `getMyFilesRootFolder().value.treeEventScopeId`. All nodes in My Files share one scope. One subscription covers all sync pairs.

### How `LatestEventIdProvider` Drives Checkpoint Replay

The SDK calls `getLatestEventId(scopeId)` when it sets up a subscription internally. If it returns:
- `null` → SDK starts from "now"; no historical events replayed
- `string` → SDK replays all events since that ID via the callback before delivering new ones

This is the mechanism for both startup delta replay and live change detection — in one subscription.

### `DriveListener` Contract

```typescript
type DriveListener = (event: DriveEvent) => Promise<void>;
// SDK docs: "Drive listeners should never throw and be wrapped in a try-catch loop."
```

The SDK does **not** catch exceptions from the callback. An unhandled throw crashes the event loop.

## Tasks / Subtasks

- [x] **Task 0 — SDK verification: RESOLVED**
  - [x] 0.1 `VolumeEventManager` exists as internal JS only (no `.d.ts`) — cannot use without violating SDK rules
  - [x] 0.2 Direct HTTP calls to Drive API are prohibited per SDK README
  - [x] 0.3 Correct approach: `subscribeToTreeEvents` + `LatestEventIdProvider` — fully public SDK API

- [ ] **Task 1 — State DB migration v6** (AC: 1)
  - [ ] 1.1 In `engine/src/state-db.ts`, add to `MIGRATIONS` array and bump `CURRENT_VERSION` from `5` to `6`:
    ```typescript
    {
      version: 6,
      up: `
        CREATE TABLE IF NOT EXISTS event_checkpoint (
          tree_event_scope_id TEXT PRIMARY KEY,
          last_event_id       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_queue (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          tree_event_scope_id TEXT NOT NULL,
          event_type          TEXT NOT NULL,
          event_payload       TEXT NOT NULL
        );
      `,
    }
    ```
    Follow the existing migration pattern — each migration is wrapped in `db.transaction` inside `migrate()`.
  - [ ] 1.2 Add checkpoint methods to `StateDb` (follow existing `prepare().get()` / `.run()` style):
    ```typescript
    getEventCheckpoint(scopeId: string): string | null
    setEventCheckpoint(scopeId: string, eventId: string): void
    clearEventCheckpoint(scopeId: string): void
    ```
  - [ ] 1.3 Add `EventQueueEntry` interface to `state-db.ts` (follow the `SyncPair` / `ChangeQueueEntry` convention — every DB row type gets a named interface):
    ```typescript
    export interface EventQueueEntry {
      id: number;
      tree_event_scope_id: string;
      event_type: string;
      event_payload: string;
    }
    ```
  - [ ] 1.4 Add event queue methods to `StateDb`:
    ```typescript
    // Atomically persist event and update checkpoint in one transaction
    // (uses db.transaction — never split into two separate calls).
    // newCheckpoint: string → setCheckpoint; null → clearCheckpoint
    persistEvent(scopeId: string, eventType: string, payload: string, newCheckpoint: string | null): void

    // Returns all queued events ordered by id ASC (insertion order)
    getQueuedEvents(): EventQueueEntry[]

    deleteQueuedEvent(id: number): void

    // Removes all queue entries for a scope (used by TreeRefresh drain)
    clearQueuedEvents(scopeId: string): void
    ```
  - [ ] 1.5 Unit tests in `engine/src/state-db.test.ts`:
    - Fresh DB: `getEventCheckpoint` returns `null`; `getQueuedEvents` returns `[]`
    - `persistEvent` with checkpoint: event in queue; `getEventCheckpoint` returns new value
    - `persistEvent` with null checkpoint: event in queue; `getEventCheckpoint` returns null (cleared)
    - `persistEvent` atomicity: simulate DB failure mid-transaction → neither row written
    - `deleteQueuedEvent`: event removed; others unaffected
    - `clearQueuedEvents`: only target scope cleared
    - Upgrade: v5-schema DB → `event_checkpoint` and `event_queue` tables exist; old data intact

- [ ] **Task 2 — `LatestEventIdProvider` + subscription wiring in `engine/src/sdk.ts`** (AC: 2, 10)
  - [ ] 2.1 Add to type-only imports from `@protontech/drive-sdk`:
    ```typescript
    import type {
      DriveListener,
      DriveEvent,
      EventSubscription,
      LatestEventIdProvider,
    } from "@protontech/drive-sdk";
    ```
    Add `DriveEventType` to value imports (it is an enum, not type-only):
    ```typescript
    import { ..., DriveEventType } from "@protontech/drive-sdk";
    ```
  - [ ] 2.2 Add both new methods to `ProtonDriveClientLike` Pick (source: `engine/src/sdk.ts:137–146`):
    ```typescript
    | "subscribeToTreeEvents"
    | "getNode"
    ```
    `getMyFilesRootFolder` is already present. `"getNode"` is required by `getRemoteNode()` in Task 2.3 — missing it is a TypeScript compile error.
  - [ ] 2.3 Add three methods to `DriveClient`:
    ```typescript
    /** Returns the treeEventScopeId for My Files root — shared across all pairs. */
    async getRootTreeEventScopeId(): Promise<string>

    /** Subscribes to remote drive events. Wraps subscribeToTreeEvents with mapSdkError
     *  on the subscribe call only — callback errors are the caller's responsibility. */
    async subscribeToRemoteEvents(
      treeEventScopeId: string,
      callback: DriveListener,
    ): Promise<EventSubscription>

    /** Resolves a single node by UID — used to inspect NodeCreated/Updated events. */
    async getRemoteNode(nodeUid: string): Promise<MaybeNode>
    ```
    All three wrap SDK calls with `mapSdkError` in their catch block.
  - [ ] 2.4 Update `createDriveClient` to accept and wire `LatestEventIdProvider`:
    ```typescript
    export function createDriveClient(
      token: string,
      uid?: string,
      latestEventIdProvider?: LatestEventIdProvider,
    ): DriveClient
    ```
    In the `params` object (line 1799), replace `latestEventIdProvider: undefined` with `latestEventIdProvider`.
    Existing call sites in `main.ts` (line 301) pass two args — no breaking change (third defaults to `undefined`).
  - [ ] 2.5 Re-export SDK event types from `sdk.ts` so callers never import from `@protontech/drive-sdk` directly (SDK boundary rule):
    ```typescript
    export type { DriveListener, DriveEvent, EventSubscription, LatestEventIdProvider } from "@protontech/drive-sdk";
    export { DriveEventType } from "@protontech/drive-sdk";
    ```
  - [ ] 2.6 Unit tests in `engine/src/sdk.test.ts`:
    - `getRootTreeEventScopeId()` returns `root.value.treeEventScopeId`
    - `subscribeToRemoteEvents()` delegates to `sdk.subscribeToTreeEvents` with correct args
    - `getRemoteNode()` delegates and returns `MaybeNode`
    - `createDriveClient` with a `latestEventIdProvider` — verify it is wired into `ProtonDriveClient` params (use a mock SDK constructor)

- [ ] **Task 3 — Subscription lifecycle in `engine/src/sync-engine.ts`** (AC: 3–14)
  - [ ] 3.1 Import from `./sdk.js` only (never from `@protontech/drive-sdk` directly):
    ```typescript
    import type { DriveEvent, EventSubscription, LatestEventIdProvider } from "./sdk.js";
    import { DriveEventType } from "./sdk.js";
    ```
  - [ ] 3.2 Add private field to `SyncEngine`:
    ```typescript
    private eventSubscription?: EventSubscription;
    ```
  - [ ] 3.3 Add `makeLatestEventIdProvider(): LatestEventIdProvider`:
    ```typescript
    makeLatestEventIdProvider(): LatestEventIdProvider {
      return {
        getLatestEventId: async (scopeId: string) =>
          this.stateDb.getEventCheckpoint(scopeId),
      };
    }
    ```
  - [ ] 3.4 Add **thin** `DriveListener` callback — persists only, no reconcile work:
    ```typescript
    private makeEventCallback(): DriveListener {
      return async (event: DriveEvent) => {
        try {
          // Determine new checkpoint state for this event type
          const newCheckpoint =
            event.type === DriveEventType.TreeRefresh ||
            event.type === DriveEventType.TreeRemove
              ? null                    // clear checkpoint
              : event.eventId ?? null;  // advance checkpoint

          // Atomically persist event + update checkpoint
          this.stateDb.persistEvent(
            event.treeEventScopeId,
            event.type,
            JSON.stringify(event),
            newCheckpoint,
          );

          // Signal drain loop (fire-and-forget — drain runs asynchronously)
          this.scheduleDrain();
        } catch (err) {
          debugLog("Failed to persist event (non-fatal): " + String(err));
          // Never rethrow — DriveListener must not throw (SDK contract)
        }
      };
    }
    ```
  - [ ] 3.5 Add `private async drainEventQueue(client: DriveClient): Promise<void>`:
    ```
    Loop: events = stateDb.getQueuedEvents()
    For each event (in insertion order):
      parse event.payload as DriveEvent

      switch event.type:
        FastForward:
          debugLog("Caught up to: " + parsedEvent.eventId)
          // no work — checkpoint already advanced by callback
          stateDb.deleteQueuedEvent(event.id)

        TreeRefresh:
          stateDb.clearQueuedEvents(event.treeEventScopeId)  // discard pending events for scope
          await reconcileAndEnqueue() for all pairs in scope (full walk)
          stateDb.deleteQueuedEvent(event.id)
          // checkpoint will advance on next FastForward
          break  // restart drain loop from top after full walk

        NodeCreated / NodeUpdated:
          result = await client.getRemoteNode(parsedEvent.nodeUid)
          if !result.ok: debugLog and skip (delete entry, continue)
          determine which pair the node belongs to
          if in a pair: enqueue targeted reconcile (download or conflict check)
          stateDb.deleteQueuedEvent(event.id)

        NodeDeleted:
          mark pair for reconcile on next cycle (deferred — see Dev Notes)
          stateDb.deleteQueuedEvent(event.id)

        TreeRemove:
          log scope removed; do not crash
          stateDb.deleteQueuedEvent(event.id)

        SharedWithMeUpdated:
          stateDb.deleteQueuedEvent(event.id)  // skip

      On any unhandled error: log; stop drain (preserve ordering); retry on next drain call
    ```
  - [ ] 3.6 Add `private drainTimer` field and `scheduleDrain()` — debounces rapid event bursts into a single drain pass:
    ```typescript
    private drainTimer?: ReturnType<typeof setTimeout>;

    private scheduleDrain(): void {
      if (this.drainTimer) clearTimeout(this.drainTimer);
      this.drainTimer = setTimeout(() => {
        this.drainTimer = undefined;
        if (this.driveClient) void this.drainEventQueue(this.driveClient);
      }, 500);
    }
    ```
    The 500 ms window coalesces bursts (e.g. 50 `NodeCreated` events from a folder upload). `this.driveClient` guard prevents firing before session activation.
  - [ ] 3.7 Add `private async startRemoteEventSubscription(client: DriveClient): Promise<void>`:
    ```typescript
    const scopeId = await client.getRootTreeEventScopeId();
    this.eventSubscription = await client.subscribeToRemoteEvents(
      scopeId,
      this.makeEventCallback(),
    );
    ```
    Guard: if `this.eventSubscription` is already set, return immediately.
  - [ ] 3.8 Wire into `main.ts` — three precise changes:

    **3.8a — `createDriveClient` call site (`main.ts:301`)**
    ```typescript
    // Before:
    const client = createDriveClient(token, uid);
    // After:
    const client = createDriveClient(token, uid, engine.makeLatestEventIdProvider());
    ```
    `engine` (the module-level `SyncEngine`) is constructed before `_activateSession` is called, so `makeLatestEventIdProvider()` is available here.

    **3.8b — Inside `_activateSession` (`main.ts:231`)**
    `_activateSession` is the single hook point called at lines 312, 332, and 431. It already calls `syncEngine?.setDriveClient(client)` then `syncEngine?.startSyncAll()`. Insert the subscription start and pre-drain between those two:
    ```typescript
    syncEngine?.setDriveClient(client);
    // NEW — start subscription before deciding whether to full-walk
    await syncEngine?.startRemoteEventSubscription(client);
    await syncEngine?.drainEventQueue(client);   // drain any leftover queue from previous session
    void syncEngine?.startSyncAll();             // existing call — see 3.8c
    ```

    **3.8c — Modify `reconcileAndEnqueue()` to skip full walk when checkpoint exists**
    `startSyncAll()` calls `reconcileAndEnqueue()` unconditionally. Add a checkpoint guard at the top of `reconcileAndEnqueue()`:
    ```typescript
    async reconcileAndEnqueue(force = false): Promise<boolean> {
      if (!force) {
        const scopeId = await this.driveClient?.getRootTreeEventScopeId();
        if (scopeId && this.stateDb.getEventCheckpoint(scopeId) !== null) {
          debugLog("Checkpoint present — skipping full walk");
          return false;
        }
      }
      // ... existing remote walk logic unchanged
    }
    ```
    Pass `force: true` from the `TreeRefresh` drain path in `drainEventQueue` so it always walks after a forced reset.
  - [ ] 3.9 Expose `disposeEventSubscription()` on `SyncEngine` for shutdown:
    ```typescript
    disposeEventSubscription(): void {
      this.eventSubscription?.dispose();
      this.eventSubscription = undefined;
    }
    ```
    Call from the SIGTERM and SIGINT handlers in `main.ts` (lines 905–912). The actual handlers only call `networkMonitor?.stop()` and `server.close()` — `fileWatcher?.stop()` is NOT in those handlers. Add `disposeEventSubscription` alongside `networkMonitor?.stop()`:
    ```typescript
    process.on("SIGTERM", () => {
      syncEngine?.disposeEventSubscription();  // NEW
      networkMonitor?.stop();
      server.close();
    });
    process.on("SIGINT", () => {
      syncEngine?.disposeEventSubscription();  // NEW
      networkMonitor?.stop();
      server.close();
    });
    ```
  - [ ] 3.10 Unit tests in `engine/src/sync-engine.test.ts`:
    - **Callback is thin**: `DriveListener` calls `persistEvent` and `scheduleDrain`; does NOT call `getRemoteNode` or reconcile
    - **Callback never throws**: simulate `persistEvent` throwing → error logged; callback returns normally
    - **First run (no checkpoint)**: drain runs; full walk runs; first `FastForward` in callback advances checkpoint
    - **Subsequent run (checkpoint exists)**: full walk NOT called; drain processes replayed events
    - **Leftover queue on startup**: events from previous session drained before deciding whether to full-walk
    - **`FastForward` drain**: deleted from queue; no download enqueued
    - **`TreeRefresh` drain**: queue cleared for scope; `reconcileAndEnqueue` triggered; drain restarts
    - **`NodeCreated` drain for node in pair's folder**: download enqueued; queue entry deleted
    - **Drain stops on error**: first failing event stays in queue; subsequent events not processed
    - **Shutdown**: `disposeEventSubscription()` calls `subscription.dispose()`
    - **Guard**: `startRemoteEventSubscription` called only once even if invoked twice

- [ ] **Task 4 — Validate** (AC: 1–12)
  - [ ] 4.1 `bun test --path-ignore-patterns '__integration__'` from `engine/` — zero failures; count strictly higher than 350 (8-0 baseline); this story adds new tests so the total must increase
  - [ ] 4.2 `.venv/bin/pytest ui/tests/` — zero failures; count ≥ 672 (8-0 baseline)
  - [ ] 4.3 Manual smoke (requires real Proton account + `PROTONDRIVE_DEBUG=1`):
    - Fresh install: full walk runs; after first `FastForward` callback fires, checkpoint is saved in DB
    - Restart: no full walk; subscription starts with saved ID; events replay via callback; `FastForward` = caught up
    - Change a remote file on ProtonDrive Web → event arrives via callback → file downloaded
  - [ ] 4.4 Set story status to `review`

## Dev Notes

### Why Subscription (Push) Over Pull

The Proton Drive SDK README prohibits direct API calls. The only compliant way to consume Drive events is through the SDK's public subscription API (`subscribeToTreeEvents`). This is a service-bus / pub-sub pattern:

- **Persistent**: subscription runs for the app lifetime, not just at startup
- **No "done" signal**: events arrive indefinitely; `FastForward` means "caught up right now", not "subscription ended"
- **Handles both use cases**: startup delta replay (from saved checkpoint) AND live change detection (ongoing)

This story therefore implicitly delivers what was originally scoped as two stories (8-1 startup delta + 8-2 live polling). Story 8-2 may become trivial or obsolete.

### Two-Phase Event Processing (Persist → Drain)

The `DriveListener` callback is intentionally thin — it only writes to the DB and returns. All reconcile work happens in the drain loop. This separation guarantees no events are lost across crashes:

```
SDK callback:
  persistEvent(scopeId, type, payload, newCheckpoint)  ← atomic DB write
  scheduleDrain()                                        ← non-blocking signal

Drain loop (async, debounced):
  for each row in event_queue (ordered by id):
    process event
    deleteQueuedEvent(id)
```

The checkpoint (`event_checkpoint`) tracks the last event durably received, not the last processed. On restart:
- `LatestEventIdProvider` returns the checkpoint → SDK replays everything since then
- Drain loop processes any leftover `event_queue` entries from the previous session first
- Then the SDK's replayed events arrive and are also drained

If an event is in the queue but not yet processed when a crash occurs, it will be processed on the next startup via the leftover drain. If it's also replayed by the SDK (because the checkpoint hadn't advanced), the duplicate is safe — all queue operations are idempotent.

### Checkpoint Establishment on First Run

On first run, `LatestEventIdProvider` returns `null`. The SDK starts the subscription from "now". A full remote tree walk runs. The first `FastForward` event arrives via callback → `persistEvent` atomically writes it to the queue and advances the checkpoint → drain loop deletes it. On next startup, the checkpoint is set and the full walk is skipped.

### No `getVolumeLatestEventId()` Call Needed

The original story planned to call `getLatestEventId()` explicitly after the full walk. This is not needed with the subscription model — the SDK manages the event position internally; the first `FastForward` callback establishes the saved checkpoint. No direct API call required.

### History Depth — `TreeRefresh` Is the SDK Signal

The Proton Drive event log has a finite server-side retention window. When a saved checkpoint is too old to replay from, the SDK fires a `TreeRefresh` event — this is the authoritative signal that the history gap cannot be bridged incrementally.

The engine treats `TreeRefresh` as the complete lifecycle reset: clear the checkpoint, run a full tree walk, re-establish the checkpoint from the first subsequent `FastForward`. No client-side timestamp expiry is needed — the SDK owns this decision.

This means the lifecycle is fully event-driven end-to-end:
- Normal gap (app closed overnight): SDK replays events → `FastForward`
- Large gap (app closed 3 months): SDK fires `TreeRefresh` → full walk → `FastForward`
- Both paths are handled by the same two event handlers.

### `NodeDeleted` Limitation (Deferred)

`NodeDeleted` events carry only `nodeUid`. Our `sync_state` table keys by `relative_path`. Without a `nodeUid → path` index, targeted deletion is not possible in this story. Acceptable approach: set a per-pair flag triggering a lightweight reconcile on the next cycle. Future story: add `nodeUid` column to `sync_state` for O(1) mapping.

### `makeLatestEventIdProvider` Exposure

`makeLatestEventIdProvider()` must be called before `createDriveClient` in `main.ts`. If `SyncEngine` is constructed before the client, this is straightforward:
```typescript
const engine = new SyncEngine(stateDb, ...);
const client = createDriveClient(token, uid, engine.makeLatestEventIdProvider());
```
If the architecture requires constructing the client first, pass a closure over `stateDb` directly instead.

### State DB Migration Pattern

`CURRENT_VERSION = 5` at `state-db.ts:104`. Add the v6 migration to the `MIGRATIONS` array (lines 41–102) and bump the constant. `migrate()` at line 155 applies all pending migrations in order automatically.

### `DriveClient` Constructor Impact

`getRemoteNode()` requires adding `"getNode"` to `ProtonDriveClientLike` (Task 2.2). Check `ProtonDriveClient.d.ts` — `getNode(nodeUid)` exists and returns `Promise<MaybeNode>`. Missing this entry is a TypeScript compile error; it must be in the Pick alongside `"subscribeToTreeEvents"`.

### JSON Serialization of `DriveEvent`

`DriveEventType` is a string enum — its values survive `JSON.stringify`/`JSON.parse` unchanged. The drain loop's `switch (parsedEvent.type)` must compare against `DriveEventType.NodeCreated`, `DriveEventType.FastForward`, etc. — not raw string literals. This matters because if you write `case "NodeCreated":` and the enum value ever changes, the switch silently falls through. Always use the enum constants.

### Subscription Start Ordering

Start the subscription **before** checking whether to run the full walk:
1. `startRemoteEventSubscription(client)` — SDK hooks `LatestEventIdProvider`, records start position
2. Check checkpoint: if null → full walk; if present → skip
3. Events from step 1 onward arrive via callback regardless of step 2

This ordering ensures no events are missed between subscription start and full walk completion.

### Run Commands

```bash
# Engine unit tests (integration exclusion from 8-0)
cd engine && bun test --path-ignore-patterns '__integration__'

# UI tests
.venv/bin/pytest ui/tests/

# Debug log for smoke test
PROTONDRIVE_DEBUG=1 bun run engine/src/main.ts
```

### Files to Touch

| File | Change |
|---|---|
| `engine/src/state-db.ts` | Migration v6 (2 tables), 7 new methods, bump `CURRENT_VERSION` to 6 |
| `engine/src/state-db.test.ts` | Checkpoint round-trip, queue round-trip, atomicity, upgrade tests |
| `engine/src/sdk.ts` | Type imports, extend `ProtonDriveClientLike`, 3 new `DriveClient` methods, update `createDriveClient` signature, re-export event types |
| `engine/src/sdk.test.ts` | Tests for 3 new methods + `createDriveClient` provider wiring |
| `engine/src/sync-engine.ts` | `eventSubscription` field, `makeLatestEventIdProvider`, `makeEventCallback` (thin), `drainEventQueue`, `scheduleDrain`, `startRemoteEventSubscription`, startup flow, `disposeEventSubscription` |
| `engine/src/sync-engine.test.ts` | 11 new test cases |
| `engine/src/main.ts` | Pass `engine.makeLatestEventIdProvider()` to `createDriveClient`; startup ordering; `engine.disposeEventSubscription()` in shutdown |

### Anti-Patterns to Avoid

- **Never call Drive API endpoints directly** — no `fetchJson` calls to `drive/volumes/...`, `drive/v2/...`, or any Proton API path. Everything goes through the SDK.
- **Never instantiate `VolumeEventManager`, `EventsAPIService`, or `DriveAPIService`** — internal SDK classes, prohibited even via `@ts-ignore`.
- **Never import `@protontech/drive-sdk` in `sync-engine.ts` or `main.ts`** — use `./sdk.js` re-exports (boundary rule).
- **Never throw from `DriveListener`** — SDK does not catch callback exceptions.
- **Never do reconcile work inside the `DriveListener` callback** — callback is persist-only; all work happens in the drain loop. Use `persistEvent` (atomic DB write) then `scheduleDrain()`. That's it.
- **⚠️ Never confuse `drainEventQueue()` with `drainQueue()`** — these are two completely different methods on `SyncEngine` draining two different tables. `drainQueue()` (existing) processes `change_queue` sync work. `drainEventQueue()` (new) processes `event_queue` remote events inbox. Calling the wrong one silently does nothing useful and is very hard to debug.
- **Never call `startRemoteEventSubscription` twice** — guard with `if (this.eventSubscription) return`.

### References

- [Source: github.com/ProtonDriveApps/sdk README] — "Direct API calls are not permitted"; `LatestEventIdProvider` contract
- [Source: engine/node_modules/@protontech/drive-sdk/dist/protonDriveClient.d.ts] — `subscribeToTreeEvents`, `getNode` signatures; `latestEventIdProvider` in constructor params
- [Source: engine/node_modules/@protontech/drive-sdk/dist/interface/events.d.ts] — `DriveEventType` enum, all `DriveEvent` shapes, `LatestEventIdProvider`, `DriveListener`
- [Source: engine/node_modules/@protontech/drive-sdk/dist/interface/nodes.d.ts#L119] — `NodeEntity.treeEventScopeId: string`
- [Source: engine/node_modules/@protontech/drive-sdk/dist/internal/events/index.js#L67] — `treeEventScopeId === volumeId` confirmed
- [Source: engine/src/state-db.ts#L104] — `CURRENT_VERSION = 5`; migration pattern at lines 155–167
- [Source: engine/src/sdk.ts#L137–146] — `ProtonDriveClientLike` Pick type (add `"subscribeToTreeEvents"`, `"getNode"`)
- [Source: engine/src/sdk.ts#L1799–1813] — `createDriveClient` params; `latestEventIdProvider: undefined` at line 1809
- [Source: engine/src/sync-engine.ts#L178] — `reconcileAndEnqueue()` entry point (add `force` param + checkpoint guard)
- [Source: engine/src/sync-engine.ts#L276] — `reconcilePair` entry point (unchanged)
- [Source: engine/src/main.ts#L231] — `_activateSession()` — the ONLY hook point; called at lines 312, 332, 431; insert `startRemoteEventSubscription` + `drainEventQueue` here
- [Source: engine/src/main.ts#L301] — `createDriveClient` call site (add provider arg)
- [Source: engine/src/main.ts#L905–912] — SIGTERM/SIGINT handlers (add `syncEngine?.disposeEventSubscription()`)
- [Source: _bmad-output/implementation-artifacts/8-0-pre-epic-debt-cleanup.md] — 8-0 baseline: 350 engine tests, 672 UI tests; CI command: `bun test --path-ignore-patterns '__integration__'`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List
