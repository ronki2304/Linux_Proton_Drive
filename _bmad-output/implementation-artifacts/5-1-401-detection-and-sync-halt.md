# Story 5.1: 401 Detection & Sync Halt

Status: done

## Story

As a user,
I want the sync engine to immediately stop retrying when my session expires,
so that it doesn't loop on failed requests and instead prompts me to re-authenticate.

## Acceptance Criteria

### AC1 — SDK 401 halts sync and emits `token_expired`

**Given** the SDK returns a 401 (Unauthorized) response during an active sync operation (drainQueue or reconcileAndEnqueue)
**When** the engine processes the error
**Then** sync halts immediately — no retry on 401
**And** the engine emits a `token_expired` push event with `{queued_changes: N}` where N is the total count of locally-changed files pending sync across all pairs
**And** the sync `driveClient` reference is cleared (set to null) so subsequent drain/reconcile calls short-circuit immediately

### AC2 — UI shifts to warning state on `token_expired`

**Given** a `token_expired` event is received by the UI
**When** the UI processes it
**Then** an `Adw.Banner` (id: `session_expired_banner`) appears at the top of the sidebar with text "Session expired — sign in to resume sync"
**And** the user is NOT routed to the pre-auth screen
**And** credentials are NOT deleted from the keyring (token is preserved for re-auth in Story 5-2)

### AC3 — Local file changes continue queuing during expired session

**Given** the 401 detection has fired and `driveClient` is null
**When** the user modifies files in a watched sync folder
**Then** the `FileWatcher` is still running and continues enqueuing changes to `change_queue` in SQLite
**And** NO `token_expired` event is emitted again from watcher-triggered drain attempts (short-circuits cleanly on null client)

### AC4 — Detection is immediate, not retried

**Given** the 401 detection
**When** it occurs within one failed SDK call during a sync operation
**Then** the engine does NOT retry that operation — the `withBackoff` loop only retries on `RateLimitError`; 401 propagates immediately as `AuthExpiredError`

---

## Tasks / Subtasks

- [x] **Task 1: Add `AuthExpiredError` to `errors.ts`** (AC: #1, #4)
  - [x] 1.1 Open `engine/src/errors.ts`
  - [x] 1.2 Add after `RateLimitError`:
    ```ts
    export class AuthExpiredError extends EngineError {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "AuthExpiredError";
      }
    }
    ```
  - [x] 1.3 Verify `errors.ts` has zero imports from other engine files (invariant from project-context.md)

- [x] **Task 2: Map 401 `ServerError` → `AuthExpiredError` in `sdk.ts`** (AC: #1, #4)
  - [x] 2.1 Open `engine/src/sdk.ts`, locate `mapSdkError` (around line 164)
  - [x] 2.2 Add BEFORE the existing `if (err instanceof ServerError)` check:
    ```ts
    if (err instanceof ServerError && err.statusCode === 401) {
      throw new AuthExpiredError("Session token expired", { cause: err });
    }
    ```
  - [x] 2.3 Import `AuthExpiredError` from `./errors.js` at the top of the existing engine imports section (already in the file for `NetworkError`, etc.) — note: `sdk.ts` only imports from `./errors.js` and `@protontech/drive-sdk`
  - [x] 2.4 Add `server401` to `sdkErrorFactoriesForTests` (around line 229):
    ```ts
    server401: (msg = "session expired") =>
      Object.assign(new ServerError(msg), { statusCode: 401 }),
    ```
  - [x] 2.5 `bunx tsc --noEmit` — zero type errors

- [x] **Task 3: Add `sdk.test.ts` coverage for 401 mapping** (AC: #1, #4)
  - [x] 3.1 Open `engine/src/sdk.test.ts`
  - [x] 3.2 Import `AuthExpiredError` from `./errors.js` alongside existing engine error imports
  - [x] 3.3 Add after the existing `"ServerError → NetworkError"` test. **Do NOT use `expectMapping` here** — its signature is typed to `NetworkError | SyncError | RateLimitError` and won't accept `AuthExpiredError`. Write an inline test following the same shape as the `RateLimitedError` test (line ~612 in sdk.test.ts):
    ```ts
    it("ServerError with statusCode 401 → AuthExpiredError('Session token expired'), NOT NetworkError", async () => {
      const sdkErr = sdkErrorFactoriesForTests.server401();
      const sdk = makeFakeSdk({
        getMyFilesRootFolder: mock(async () => { throw sdkErr; }),
      });
      const client = new DriveClient(sdk);
      let captured: unknown;
      try {
        await client.listRemoteFolders(null);
        expect(true).toBe(false);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(AuthExpiredError);
      expect((captured as Error).message).toMatch(/Session token expired/);
      expect(captured instanceof NetworkError).toBe(false);  // 401 must NOT be treated as NetworkError
      expect((captured as Error & { cause?: unknown }).cause).toBe(sdkErr);
    });
    ```

- [x] **Task 4: Update `SyncEngine` constructor and add halt logic** (AC: #1, #3, #4)
  - [x] 4.1 Open `engine/src/sync-engine.ts`
  - [x] 4.2 Import `AuthExpiredError` from `./errors.js` alongside existing error imports (line 10)
  - [x] 4.3 Add `isAuthExpired` helper alongside existing `isFetchFailure` helper (after line 23):
    ```ts
    function isAuthExpired(err: unknown): boolean {
      return err instanceof AuthExpiredError;
    }
    ```
  - [x] 4.4 Add `onTokenExpired` parameter to constructor between `onNetworkFailure` and `sleepMs`:
    ```ts
    constructor(
      private readonly stateDb: StateDb,
      private readonly emitEvent: (event: IpcPushEvent) => void,
      private readonly getConfigPairs: () => ConfigPair[] = listConfigPairs,
      private readonly onNetworkFailure: () => void = () => {},
      private readonly onTokenExpired: () => void = () => {},   // NEW — 5th param
      private readonly sleepMs: (ms: number) => Promise<void> = ...,
    ) {}
    ```
    **No existing callers pass sleepMs positionally, so this is non-breaking.**
  - [x] 4.5 In `reconcileAndEnqueue`, in the per-pair catch block (around line 173), add BEFORE the `isFetchFailure` check:
    ```ts
    if (isAuthExpired(err)) {
      process.stderr.write("[ENGINE] reconcile aborted — 401 session expired\n");
      this.onTokenExpired();
      return true; // halt reconcile; same return semantics as network failure
    }
    ```
  - [x] 4.5b **Guard all SDK-calling catches inside `reconcilePair`** — `reconcilePair` has 5 inner try/catch blocks that wrap SDK calls and swallow ALL errors. Each must re-throw `AuthExpiredError` so it can propagate out to `reconcileAndEnqueue`'s per-pair catch (line 173). Add `if (isAuthExpired(err)) throw err;` as the **first line** of each of these catches:
    | Line | Wraps | Currently swallows with |
    |------|-------|------------------------|
    | ~200 | `resolveRemoteId` → `listRemoteFolders`/`createRemoteFolder` | `remote_path_not_found` |
    | ~326 | `client.downloadFile` (conflict download) | `sync_file_error` |
    | ~380 | `client.downloadFile` (collision download) | `sync_file_error` |
    | ~411 | `client.trashNode` | `sync_cycle_error` |
    | ~459 | `client.downloadFile` (download items) | `sync_file_error` |

    Pattern for each catch:
    ```ts
    } catch (err) {
      if (isAuthExpired(err)) throw err; // ← add as first line
      // existing handling unchanged below
      const msg = err instanceof Error ? err.message : "unknown";
      ...
    }
    ```
    **Without this fix**, a 401 during `trashNode`, `downloadFile`, or remote-id resolution would be silently swallowed and sync would continue calling the SDK with an expired token — violating AC1.

  - [x] 4.6 In `drainQueue`, in the inner try/catch for `walkRemoteTree` (around line 553), add BEFORE the existing error handling:
    ```ts
    if (isAuthExpired(err)) throw err; // propagate to outer catch to halt drain
    ```
  - [x] 4.7 In `processQueueEntry`, in the outer catch block (around line 809), add BEFORE the existing `isFetchFailure` check:
    ```ts
    if (isAuthExpired(err)) throw err; // propagate to halt drain — do NOT emit "failed" or "queue_replay_failed"
    ```
  - [x] 4.8 Change `drainQueue`'s main `try { ... } finally { ... }` structure to add a catch for `AuthExpiredError`. The `finally` block must still run (emits `queue_replay_complete`, resets `isDraining`):
    ```ts
    try {
      // ... existing pairs loop
    } catch (err) {
      if (isAuthExpired(err)) {
        this.onTokenExpired();
        // fall through to finally — isDraining reset, queue_replay_complete emitted
      } else {
        throw err; // unexpected; propagate
      }
    } finally {
      // existing: emit queue_replay_complete + sync_complete + isDraining = false
    }
    ```
  - [x] 4.9 `bunx tsc --noEmit` — zero type errors

- [x] **Task 5: Add `sync-engine.test.ts` coverage for 401 halt** (AC: #1, #3, #4)
  - [x] 5.1 Open `engine/src/sync-engine.test.ts`
  - [x] 5.2 Import `AuthExpiredError` from `./errors.js`
  - [x] 5.3 Add a new `describe` block for 401 detection. This block goes inside the same outer describe context as the fetch-failure test at line 456 (it uses `PAIR_ID`, `db`, `tmpDir`, `emittedEvents`, `engine`, `mockClient` from the shared `beforeEach`/`afterEach`). Use `join` from `node:path` for paths if needed:
    ```ts
    describe("SyncEngine — 401 auth expiry detection", () => {
      // AC1: 401 during reconcileAndEnqueue (walkRemoteTree/reconcilePair) → onTokenExpired called
      it("401 during reconcile → onTokenExpired called, not onNetworkFailure", async () => {
        db.insertPair({
          pair_id: PAIR_ID,
          local_path: tmpDir,
          remote_path: "/Documents",
          remote_id: "some-remote-id",
          created_at: "2026-04-10T00:00:00.000Z",
          last_synced_at: null,
        });

        mockClient = makeMockClient({
          listRemoteFiles: mock(async () => {
            throw new AuthExpiredError("401");
          }),
        });

        let tokenExpiredCalled = false;
        let networkFailureCalled = false;
        engine = new SyncEngine(db, (e) => emittedEvents.push(e), undefined, () => {
          networkFailureCalled = true;
        }, () => {
          tokenExpiredCalled = true;
        });
        engine.setDriveClient(mockClient);

        await engine.startSyncAll();

        expect(tokenExpiredCalled).toBe(true);
        expect(networkFailureCalled).toBe(false);
      });

      // AC1: 401 during drainQueue → onTokenExpired called, drain halts cleanly
      it("401 during drain → onTokenExpired called, drain halts", async () => {
        db.insertPair({
          pair_id: PAIR_ID,
          local_path: tmpDir,
          remote_path: "/Documents",
          remote_id: "some-remote-id",
          created_at: "2026-04-10T00:00:00.000Z",
          last_synced_at: null,
        });

        mockClient = makeMockClient({
          listRemoteFiles: mock(async () => {
            throw new AuthExpiredError("401");
          }),
        });

        let tokenExpiredCalled = false;
        engine = new SyncEngine(db, (e) => emittedEvents.push(e), undefined, () => {}, () => {
          tokenExpiredCalled = true;
        });
        engine.setDriveClient(mockClient);

        await engine.drainQueue();

        expect(tokenExpiredCalled).toBe(true);
        // queue_replay_complete must still emit (finally block still runs)
        const completeEvent = emittedEvents.find((e) => e.type === "queue_replay_complete");
        expect(completeEvent).toBeTruthy();
      });

      // AC3: with null driveClient (after token expiry), drainQueue returns immediately without throwing
      it("drainQueue with null client after token expiry returns immediately", async () => {
        db.insertPair({
          pair_id: PAIR_ID,
          local_path: tmpDir,
          remote_path: "/Documents",
          remote_id: "some-remote-id",
          created_at: "2026-04-10T00:00:00.000Z",
          last_synced_at: null,
        });

        engine = new SyncEngine(db, (e) => emittedEvents.push(e));
        // No setDriveClient call — client stays null

        await engine.drainQueue(); // must not throw

        const errorEvents = emittedEvents.filter((e) => e.type === "error");
        expect(errorEvents.length).toBe(0);
      });
    });
    ```

- [x] **Task 6: Wire `onTokenExpired` callback in `main.ts`** (AC: #1, #3)
  - [x] 6.1 Open `engine/src/main.ts`, locate the `SyncEngine` construction (around line 607)
  - [x] 6.2 Add `onTokenExpired` callback as 5th argument:
    ```ts
    syncEngine = new SyncEngine(
      stateDb,
      (e) => server.emitEvent(e),
      undefined,                                          // getConfigPairs: use default
      () => networkMonitor?.forceCheck(),                 // onNetworkFailure (existing)
      () => {                                             // onTokenExpired (NEW)
        if (!driveClient) return;                         // idempotent — already expired
        driveClient = null;
        syncEngine?.setDriveClient(null);
        // DO NOT stop fileWatcher — keep queuing local changes (AC3)
        const queuedTotal = stateDb
          ? stateDb.listPairs().reduce((sum, p) => sum + stateDb!.queueSize(p.pair_id), 0)
          : 0;
        server.emitEvent({ type: "token_expired", payload: { queued_changes: queuedTotal } });
      },
    );
    ```
  - [x] 6.3 `bunx tsc --noEmit` — zero type errors

- [x] **Task 7: Add `Adw.Banner` to `window.blp`** (AC: #2)
  - [x] 7.1 Open `ui/data/ui/window.blp`
  - [x] 7.2 In the sidebar `Adw.ToolbarView`, add `session_expired_banner` as a second `[top]` child immediately AFTER the existing `Adw.HeaderBar {}`:
    ```
    [top]
    Adw.HeaderBar {}

    [top]
    Adw.Banner session_expired_banner {
      title: _("Session expired — sign in to resume sync");
      revealed: false;
      styles ["error"]
    }
    ```
    **Note:** Blueprint `[top]` items appear in order; second `[top]` appears below the HeaderBar.
  - [x] 7.3 `meson compile -C builddir` — zero Blueprint compilation errors

- [x] **Task 8: Wire banner in `window.py`** (AC: #2)
  - [x] 8.1 Open `ui/src/protondrive/window.py`
  - [x] 8.2 Add `session_expired_banner` child (alongside existing `Template.Child()` declarations):
    ```python
    session_expired_banner: Adw.Banner = Gtk.Template.Child()
    ```
  - [x] 8.3 Add `Adw` to gi.repository import if not already present (it is, used for `Adw.Toast`)
  - [x] 8.4 Add `show_token_expired_warning` method:
    ```python
    def show_token_expired_warning(self, queued_changes: int) -> None:
        """Show the session-expired banner. Called by Application on token_expired."""
        self.session_expired_banner.set_revealed(True)
    ```
  - [x] 8.5 Add `clear_token_expired_warning` method:
    ```python
    def clear_token_expired_warning(self) -> None:
        """Hide the session-expired banner. Called on session_ready."""
        self.session_expired_banner.set_revealed(False)
    ```
  - [x] 8.6 In `on_session_ready`, add a call to `self.clear_token_expired_warning()` at the start of the method so re-auth clears the banner (Story 5-2 will also dismiss it, but defense-in-depth):
    ```python
    def on_session_ready(self, payload: dict[str, Any]) -> None:
        """Handle session_ready from engine — same for initial auth and re-auth."""
        self.clear_token_expired_warning()      # ← add this line
        self._session_data = payload
        ...
    ```

- [x] **Task 9: Update `_on_token_expired` in `main.py`** (AC: #2, #3)
  - [x] 9.1 Open `ui/src/protondrive/main.py`
  - [x] 9.2 Replace the body of `_on_token_expired` with the new behavior:
    - Keep: cancel validation timeout, reset `_watcher_status = "unknown"`
    - Keep: ignore if auth browser is active (mid-login guard)
    - **Remove**: `self._credential_manager.delete_token()` — token preserved for re-auth in Story 5-2
    - **Remove**: `self._credential_manager.delete_key_password()` — same
    - **Remove**: `self.settings.set_boolean("wizard-auth-complete", False)`
    - **Remove**: `self._window.show_pre_auth()`
    - **Add**: extract `queued_changes` from payload and call `self._window.show_token_expired_warning(queued_changes)`
    ```python
    def _on_token_expired(self, payload: dict[str, Any]) -> None:
        """Token expired mid-sync — show warning banner; keep credentials for re-auth.

        Story 5-1: UI shifts to warning state; credentials are preserved so
        Story 5-2 can pre-fill re-auth without requiring a fresh login.
        Do NOT route to pre-auth — user stays on main view and can queue changes.
        """
        import sys
        print(f"[APP] token_expired received: {payload}", file=sys.stderr)
        self._cancel_validation_timeout()
        self._watcher_status = "unknown"

        if self._window is not None and self._window.is_auth_browser_active():
            print("[APP] token_expired ignored — auth browser active", file=sys.stderr)
            return

        queued_changes: int = payload.get("queued_changes", 0) if isinstance(payload, dict) else 0

        if self._window is not None:
            self._window.show_token_expired_warning(queued_changes)
    ```

- [x] **Task 10: Update UI tests** (AC: #2)
  - [x] 10.1 Open `ui/tests/test_main.py`
  - [x] 10.2 Add new test class `TestTokenExpiredCallsWarning`:
    ```python
    class TestTokenExpiredCallsWarning:
        """_on_token_expired calls show_token_expired_warning, not show_pre_auth."""

        def test_calls_show_token_expired_warning(self) -> None:
            app = _make_app()
            app._on_token_expired({"queued_changes": 3})
            app._window.show_token_expired_warning.assert_called_once_with(3)

        def test_does_not_call_show_pre_auth(self) -> None:
            app = _make_app()
            app._on_token_expired({"queued_changes": 0})
            app._window.show_pre_auth.assert_not_called()

        def test_does_not_delete_credentials(self) -> None:
            app = _make_app()
            app._on_token_expired({"queued_changes": 0})
            app._credential_manager.delete_token.assert_not_called()
            app._credential_manager.delete_key_password.assert_not_called()

        def test_zero_queued_changes_fallback(self) -> None:
            app = _make_app()
            app._on_token_expired({})   # no queued_changes key
            app._window.show_token_expired_warning.assert_called_once_with(0)

        def test_no_window_is_noop(self) -> None:
            app = _make_app()
            app._window = None
            app._on_token_expired({"queued_changes": 2})  # must not raise
    ```
  - [x] 10.3 Existing `TestTokenExpiredResetsWatcherStatus` tests pass unchanged — `_watcher_status` reset is kept
  - [x] 10.4 Run `meson compile -C builddir && .venv/bin/pytest ui/tests/` — all pass

- [x] **Task 11: Final validation** (AC: #1–#4)
  - [x] 11.1 `bunx tsc --noEmit` from `engine/` — zero type errors
  - [x] 11.2 `bun test` from `engine/` — all existing tests pass; new 401 tests pass
  - [x] 11.3 `meson compile -C builddir && .venv/bin/pytest ui/tests/` — all pass
  - [x] 11.4 Set story status to `review`

---

## Dev Notes

### §1 — `AuthExpiredError` must have zero internal imports

`errors.ts` is the zero-internal-import file (project-context.md §"Code Organization"). `AuthExpiredError extends EngineError` — it needs no new imports. The existing error hierarchy provides the base class.

### §2 — 401 detection via `ServerError.statusCode` (not `APIHTTPError`)

`APIHTTPError` is in `@protontech/drive-sdk/dist/internal/apiService/errors` — not exported from the main SDK index and not importable without violating the SDK boundary constraint. `ServerError` (main index export) has `statusCode?: number`, and `APIHTTPError extends ServerError` sets it to the HTTP status code. So `err instanceof ServerError && err.statusCode === 401` is the correct detection — no internal import needed.

**`mapSdkError` ordering is critical:** The new 401 check MUST come BEFORE the generic `ServerError` check, or 401 errors are silently swallowed into `NetworkError`.

### §3 — `withBackoff` does NOT retry on `AuthExpiredError`

`withBackoff` catches only `RateLimitError`. Any other exception (including `AuthExpiredError`) immediately propagates up to the caller. This guarantees AC4: detection is immediate, not after N retries.

### §4 — `onTokenExpired` callback ordering in `SyncEngine` constructor

The constructor signature change inserts `onTokenExpired` as 5th param between `onNetworkFailure` (4th) and `sleepMs` (now 6th). The only production call is in `main.ts` which passes 4 positional args today (`stateDb`, `emitEvent`, `undefined`, `onNetworkFailure`). After adding `onTokenExpired` as 5th, `sleepMs` shifts to 6th — safe because no caller ever passes `sleepMs` positionally (test inspection confirmed).

### §5 — FileWatcher stays running on `token_expired` (AC3)

The `onTokenExpired` callback in `main.ts` MUST NOT call `fileWatcher?.stop()`. This is the critical difference from the `handleTokenRefresh` empty-token path (line 263) which does stop the watcher. For mid-sync 401, the watcher must keep running so `change_queue` accumulates local changes during the expired-session period. Story 5-3 will drain the queue post re-auth.

### §6 — `drainQueue` try/catch/finally ordering

The current `drainQueue` has `try { ... } finally { ... }`. Adding a `catch` for `AuthExpiredError` before the `finally` changes it to `try { ... } catch (err) { ... } finally { ... }`. The `finally` still runs in all paths — this is the semantics we want: `isDraining = false`, `queue_replay_complete` event emitted even after 401 abort. This prevents the UI from getting stuck in a "replaying" state.

### §7 — UI: `Adw.Banner` with `styles ["error"]`

Libadwaita 1.8 (GNOME 50 runtime): `AdwBanner` supports `styles ["error"]` for the red/destructive appearance. Do not use `styles ["warning"]` — we want red, not amber, since the user cannot sync. The banner is added to the sidebar `ToolbarView` as a second `[top]` item, appearing below the header bar. Pattern confirmed by `pair-detail-panel.blp` which already uses `Adw.Banner`.

### §8 — `_on_token_expired` behavior change is intentional; `handleTokenRefresh` empty-token path is UNCHANGED

**UI behavior change (intentional):**
Previously: route to pre-auth + delete credentials (treatment: logout).
After Story 5-1: show warning banner + preserve credentials (treatment: session expired, re-auth needed).
This is required for Story 5-2's re-auth modal to work — it needs the token and queued-change count.

Story 5-2 will add the modal that appears from the banner. Story 5-1 only adds the banner infrastructure and the engine-side halt.

**`handleTokenRefresh` in `main.ts` is UNCHANGED — do NOT touch it:**
`handleTokenRefresh` (engine/src/main.ts ~line 257) has two existing `token_expired` emission paths:
1. Empty token path (~line 268): emits `token_expired` AND calls `fileWatcher?.stop()` — intentional, this is a config-level "no token" state.
2. `validateSession` failure path (~line 383): same, also stops the watcher.

The mid-sync 401 path (`onTokenExpired` callback, Task 6) does NOT stop the watcher — this is the intentional asymmetry with §5. Do not "fix" this asymmetry — it is correct by design.

### §9 — Tests to leave unchanged

- `ui/tests/test_launch_routing.py:74`: checks `"show_pre_auth" in source` — this STILL PASSES because `show_pre_auth` is called from other handlers (`_on_wizard_back`, `show_pre_auth` method itself). Do NOT remove this assertion.
- `ui/tests/test_main.py:TestTokenExpiredResetsWatcherStatus`: still valid — `_watcher_status = "unknown"` is preserved.

### §10 — `processQueueEntry` re-throws `AuthExpiredError`

The current catch at line 809 converts all errors to `"failed"` (after calling `onNetworkFailure` for fetch failures). For `AuthExpiredError`, we re-throw BEFORE the existing handling. The `drainQueue`'s outer catch then catches it and calls `onTokenExpired()`. This prevents the error from being emitted as a `queue_replay_failed` event (which would confuse the UI into thinking individual files failed when the whole session expired).

### Project Structure Notes

**Files to create:** none

**Files to modify:**
- `engine/src/errors.ts` — add `AuthExpiredError`
- `engine/src/sdk.ts` — add 401 detection in `mapSdkError`; add `server401` to test factories; import `AuthExpiredError`
- `engine/src/sync-engine.ts` — add `isAuthExpired`, add `onTokenExpired` param, add halt logic in `drainQueue` and `reconcileAndEnqueue`; import `AuthExpiredError`
- `engine/src/main.ts` — wire `onTokenExpired` callback in `SyncEngine` construction
- `engine/src/sdk.test.ts` — add 401 → `AuthExpiredError` test; import `AuthExpiredError`
- `engine/src/sync-engine.test.ts` — add 401 halt tests
- `ui/data/ui/window.blp` — add `session_expired_banner`
- `ui/src/protondrive/window.py` — add `session_expired_banner` child + `show_token_expired_warning` + `clear_token_expired_warning`
- `ui/src/protondrive/main.py` — rewrite `_on_token_expired` body

**Do NOT modify:**
- Any other Blueprint files
- `engine/src/ipc.ts`, `state-db.ts`, `config.ts`, `watcher.ts`, `conflict.ts`, `network-monitor.ts`
- `ui/tests/test_launch_routing.py` — test still passes (see §9)
- `sprint-status.yaml` — dev agent sets story to `review`, not `done`

### References

- Epic 5 story definition: `_bmad-output/planning-artifacts/epics/epic-5-token-expiry-error-recovery.md#Story-5.1`
- `errors.ts` zero-import rule: `_bmad-output/project-context.md` §Code Organization
- SDK error hierarchy: `engine/node_modules/@protontech/drive-sdk/dist/errors.d.ts`
- `APIHTTPError` (internal): `engine/node_modules/@protontech/drive-sdk/dist/internal/apiService/errors.d.ts`
- `ServerError.statusCode` confirmed at runtime: `dist/errors.js:98` (class field, not getter)
- `mapSdkError` location: `engine/src/sdk.ts:164`
- `sdkErrorFactoriesForTests` location: `engine/src/sdk.ts:229`
- `SyncEngine` constructor: `engine/src/sync-engine.ts:76`
- `isFetchFailure` helper (model for `isAuthExpired`): `engine/src/sync-engine.ts:17`
- `reconcileAndEnqueue` per-pair catch: `engine/src/sync-engine.ts:173`
- `drainQueue` walkRemoteTree catch: `engine/src/sync-engine.ts:553`
- `processQueueEntry` outer catch: `engine/src/sync-engine.ts:809`
- `SyncEngine` construction in `main.ts`: `engine/src/main.ts:607`
- `_on_token_expired` (current): `ui/src/protondrive/main.py:407`
- `window.blp` (add banner): `ui/data/ui/window.blp`
- `Adw.Banner` pattern: `ui/data/ui/pair-detail-panel.blp:35`
- Network failure test (model): `engine/src/sync-engine.test.ts:456`
- `_make_app` test helper: `ui/tests/test_main.py:17`
- Deferred work (pre-existing engine gaps, not in scope): `_bmad-output/implementation-artifacts/deferred-work.md`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None.

### Completion Notes List

- Added `AuthExpiredError` to `engine/src/errors.ts` (zero internal imports, extends `EngineError`)
- Mapped `ServerError { statusCode: 401 }` → `AuthExpiredError` in `mapSdkError` (before generic `ServerError` branch)
- Added `server401` factory to `sdkErrorFactoriesForTests`
- Added `isAuthExpired` helper and `onTokenExpired` constructor param (5th, between `onNetworkFailure` and `sleepMs`) to `SyncEngine`
- Guarded 5 inner catches in `reconcilePair` with `if (isAuthExpired(err)) throw err;` so 401s propagate out
- Added `isAuthExpired` re-throw in `drainQueue` walkRemoteTree catch and `processQueueEntry` outer catch
- Changed `drainQueue` `try/finally` to `try/catch(AuthExpiredError)/finally` — calls `onTokenExpired`, finally still runs
- Added `isAuthExpired` check before `isFetchFailure` in `reconcileAndEnqueue` per-pair catch
- Wired `onTokenExpired` in `engine/src/main.ts`: clears `driveClient`, calls `setDriveClient(null)`, does NOT stop watcher, emits `token_expired` with queued count
- Added `Adw.Banner session_expired_banner` to sidebar `ToolbarView` in `window.blp` (second `[top]`, `styles ["error"]`)
- Added `session_expired_banner` Template.Child, `show_token_expired_warning`, `clear_token_expired_warning` to `window.py`; `on_session_ready` now calls `clear_token_expired_warning()` first
- Rewrote `_on_token_expired` in `main.py`: removed credential deletion, removed `show_pre_auth`, added `show_token_expired_warning(queued_changes)`
- Added `TestTokenExpiredCallsWarning` test class (5 tests) in `ui/tests/test_main.py`
- Fixed withBackoff and rate-limit drain tests in `sync-engine.test.ts` to pass `sleepMs` as 6th arg
- Engine: 231 tests pass; UI: 535 tests pass; tsc: zero errors; Blueprint: zero errors

### File List

- `engine/src/errors.ts`
- `engine/src/sdk.ts`
- `engine/src/sdk.test.ts`
- `engine/src/sync-engine.ts`
- `engine/src/sync-engine.test.ts`
- `engine/src/main.ts`
- `ui/data/ui/window.blp`
- `ui/src/protondrive/window.py`
- `ui/src/protondrive/main.py`
- `ui/tests/test_main.py`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/5-1-401-detection-and-sync-halt.md`

## Change Log

- 2026-04-18: Story 5-1 implemented — 401 detection, sync halt, `AuthExpiredError`, `onTokenExpired` callback, `Adw.Banner` session-expired UI; all 4 ACs satisfied; 231 engine tests + 535 UI tests pass.

---

## Review Findings

### Decision Needed

- [x] [Review][Decision] `queued_changes` accepted but silently ignored in `show_token_expired_warning` — `window.py:290` accepts `queued_changes: int` but only calls `set_revealed(True)`. The engine computes `queuedTotal` and emits it; `main.py` extracts it and passes it to `show_token_expired_warning`; the method discards it. Options: (A) display count in banner text (e.g. "Session expired — N files pending"), (B) rename param to `_queued_changes` to signal intentionally unused, (C) drop the param from the method signature and update tests. The param is dead interface surface regardless of choice.
- [x] [Review][Decision] UI silently drops `token_expired` when auth browser is active, but engine has already set `driveClient = null` — `main.py:419-421` returns early (no banner) when `is_auth_browser_active()`. If concurrent re-auth succeeds, `on_session_ready` recovers correctly. If re-auth fails, the user has no visual feedback that sync is halted — engine state and UI state are diverged. Options: (A) show banner even when auth browser is active (may confuse mid-re-auth user), (B) accept current behavior as intentional (Story 5-2 re-auth modal is the recovery path), (C) add a deferred-show that fires the banner if session_ready does not arrive within a timeout.

### Patches

- [x] [Review][Patch] `stateDb!` non-null assertion inside ternary guard is redundant and error-prone [`engine/src/main.ts:617-619`] — `stateDb ? stateDb.listPairs().reduce((sum, p) => sum + stateDb!.queueSize(...), 0) : 0` mixes guard and assertion in same expression. Fix: capture `const db = stateDb; if (!db) ...` before the reduce, or use `stateDb.queueSize(...)` without `!` inside the already-guarded branch.

### Deferred

- [x] [Review][Defer] Banner has no re-auth action button [`ui/data/ui/window.blp`] — deferred, Story 5-2 scope; `Adw.Banner` supports `button-label`/`action-name` but 5-1 intentionally omits it; Story 5-2 will add the re-auth modal trigger.
- [x] [Review][Defer] `startSyncAll` comment misleads about 401 path [`engine/src/sync-engine.ts:~132`] — deferred, documentation smell; comment "NetworkMonitor will trigger a fresh drain on reconnect" is accurate for network-failure path but does not note that 401 path (`onTokenExpired`) does not reconnect-drain; no behavioral bug.
- [x] [Review][Defer] Banner `revealed` state not reset on `logout()` [`ui/src/protondrive/main.py`] — deferred, low risk; `logout()` calls `show_pre_auth()` which hides the main view so banner is not visible; `on_session_ready` calls `clear_token_expired_warning()` on re-auth, clearing the state; only a gap if user navigates back to main view without going through `on_session_ready`.
- [x] [Review][Defer] `TestTokenExpiredResetsWatcherStatus` tests call `_on_token_expired` with full-message-shaped payload dict [`ui/tests/test_main.py`] — deferred, pre-existing; old tests pass `{"payload": {...}}` while new tests correctly pass `{"queued_changes": N}` directly; old tests don't check extracted values so they pass regardless; harmless but inconsistent.
- [x] [Review][Defer] 401 during conflict download leaves orphaned `.conflict-YYYY-MM-DD` file on disk [`engine/src/sync-engine.ts:~335`] — deferred, edge case within edge case; conflict copy is written and `conflict_detected` event emitted before download attempt; if download throws `AuthExpiredError`, copy is re-thrown and halt fires, leaving the copy orphaned; next reconcile after re-auth may create a second conflict copy for the same file.
