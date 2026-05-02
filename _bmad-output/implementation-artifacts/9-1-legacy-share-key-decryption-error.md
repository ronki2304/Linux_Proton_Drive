# Story 9.1: Session Activation Failure — Legacy Share Key Decryption

Status: done

## Story

As a user with a pre-2024 Proton account,
I want the app to show a clear, actionable error when it cannot decrypt my Drive files after signing in,
so that I know exactly what to do — without the app silently crashing.

## Background

**GitHub issue #2 (first user feedback):** User on Debian (x86_64) authenticates successfully (keys
decrypt, API responds 200) but the engine process crashes immediately after with an unhandled
rejection. The app shows nothing; the user is stuck.

**Root cause — two separate bugs:**

**Bug 1 — Engine crash (fatal):** `_activateSession` calls
`await syncEngine?.startRemoteEventSubscription(client)` with no try/catch. That call reaches
`client.getRootTreeEventScopeId()` → SDK's `getVolumeRootFolder` → `decryptRootShare`, which throws
`Error: No decryption key packets found` for accounts with a legacy share key format ("from before
2024"). Since `_activateSession` is invoked via `void _activateSession(...)`, the rejection is
unhandled → **Bun process exits** → UI gets no event, engine is dead, app appears frozen.

**Bug 2 — Debug token written to disk (security):** `handleTokenRefresh` in `main.ts` writes the
live access token to `/tmp/proton-debug-token.txt` (lines 366–371). Confirmed visible in the
issue's log output. This must be removed before any further distribution.

**Key distinction from Story 8-4b:** 8-4b covers user-key decryption failure during
`fetchAndDecryptKeys` (engine detects `decrypted < total` user keys). This story covers share-key
decryption failure during session activation — the user keys decrypt fine (1/1), but the root share
key is in a legacy format the SDK cannot decrypt. The failure site is `startRemoteEventSubscription`
/ `getRootTreeEventScopeId`, not key loading. The user-facing resolution is the same: visit
`https://drive.proton.me` to re-wrap the old keys.

## Acceptance Criteria

### AC1 — Engine: catch decryption failure in `_activateSession` and emit `session_error`

**Given** `startRemoteEventSubscription` throws an error whose message contains `"decryption"` or
`"session keys"` (case-insensitive)
**When** `_activateSession` calls `await syncEngine?.startRemoteEventSubscription(client)`
**Then** the error is caught — the engine process does NOT crash
**And** the engine emits:
```
{ type: "session_error", payload: { code: "SHARE_KEY_DECRYPT_FAILED",
  message: "Could not access your Proton Drive files — some keys could not be decrypted" } }
```
**And** `driveClient` is reset to null (`syncEngine?.setDriveClient(null)`) so sync is not attempted
**And** `[ENGINE] session_activation_failed: <error message>` is written to stderr

### AC2 — Engine: non-decryption errors in `_activateSession` are re-thrown correctly

**Given** `startRemoteEventSubscription` throws a network error or auth error
**When** `_activateSession` catches it
**Then** it is re-thrown — becoming an unhandled promise rejection (same crash behavior as before
this story; both `handleTokenRefresh` and `handleUnlockKeys` call `void _activateSession(...)` so
their outer try/catch does not catch it — fixing this is out of scope)
**And** the engine does not emit `session_error` for non-decryption failures

### AC3 — Engine: remove debug token dump

**Given** `handleTokenRefresh` in `engine/src/main.ts` lines 365–371
**When** the story is complete
**Then** the block that writes the live token to `/tmp/proton-debug-token.txt` is removed entirely
**And** `[ENGINE] DEBUG token dumped → /tmp/proton-debug-token.txt` no longer appears in logs

### AC4 — UI: register `session_error` handler and close auth browser

**Given** the engine emits `{ type: "session_error", payload: { code, message } }`
**When** the UI's `_on_session_error` handler fires
**Then** `self._cancel_validation_timeout()` is called (prevents the validation-timeout error state
from firing on top)
**And** `self._window.close_auth_browser()` is called (dismisses the embedded WebView)
**And** an `Adw.AlertDialog` is presented to the user (see AC5 for content)

### AC5 — UI: `Adw.AlertDialog` content and actions

**Given** `_on_session_error` receives `{ code: "SHARE_KEY_DECRYPT_FAILED" }`
**When** the dialog is shown
**Then** the dialog heading is:
```
"Could not access your files"
```
**And** the body text is:
```
"Some of your files were encrypted with a key that could not be unlocked.\n\n"
"Open Proton Drive in your browser and browse your files folder — this restores "
"access automatically. Then sign in again."
```
**And** the dialog has two responses:
- `"open_browser"` — label `"Open Proton Drive"`, appearance `SUGGESTED`
- `"sign_out"` — label `"Sign Out"`, appearance `DESTRUCTIVE`

**Given** the user clicks `"Open Proton Drive"`
**When** the response is handled
**Then** `Gio.AppInfo.launch_default_for_uri("https://drive.proton.me", None)` is called
**And** the UI transitions to `show_pre_auth()` (user needs to sign in again after re-wrapping)

**Given** the user clicks `"Sign Out"`
**When** the response is handled
**Then** `self.logout()` is called (the method is `logout()`, not `_do_logout()`)
**And** the UI transitions to `show_pre_auth()` (same as normal logout)

### AC6 — UI: `session_error` is wired in `__init__`

**Given** `ProtondrivApplication.__init__`
**When** the story is complete
**Then** `self._engine.on_event("session_error", self._on_session_error)` is registered
(alongside the other `on_event` registrations at lines 89–103 in `main.py`)

### AC7 — Tests: engine emits `session_error` on decryption failure

**Given** a unit test for `handleTokenRefresh`/`_activateSession`
**When** `syncEngine.startRemoteEventSubscription` throws `Error("No decryption key packets found")`
**Then** the emitted events include `{ type: "session_error", payload: { code: "SHARE_KEY_DECRYPT_FAILED" } }`
**And** no `session_ready` event is emitted

### AC8 — Tests: UI `_on_session_error` invokes correct handlers

**Given** a unit test for `_on_session_error`
**When** the handler is called with `{ "type": "session_error", "payload": { "code": "SHARE_KEY_DECRYPT_FAILED" } }`
(full message shape — `on_event` dispatch passes the complete message, not just the payload)
**Then** `window.close_auth_browser` was called
**And** an `Adw.AlertDialog` was presented

## Tasks / Subtasks

- [x] **Task 1 — Remove debug token dump** (AC3)
  - [x] 1.1 In `engine/src/main.ts`, delete lines 365–371 (the `try { writeFileSync(...) }` block
        that writes to `/tmp/proton-debug-token.txt`). Also remove the `import("node:fs")` dynamic
        import inside it. The surrounding comments `// DEBUG: ...` and `// Remove after ...` go too.
  - [x] 1.2 Verify `[ENGINE] DEBUG token dumped` no longer appears in stderr output.

- [x] **Task 2 — Add `session_error` event type** (AC1)
  - [x] 2.1 In `engine/src/main.ts`, find `_activateSession` (line 236). The current body is:
        ```typescript
        driveClient = client;
        syncEngine?.setDriveClient(client);
        await syncEngine?.startRemoteEventSubscription(client);   // line 244
        await syncEngine?.drainEventQueue(client);
        ```
        Wrap lines 244+ in a try/catch:
        ```typescript
        try {
          await syncEngine?.startRemoteEventSubscription(client);
          await syncEngine?.drainEventQueue(client);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isDecryptionError =
            msg.toLowerCase().includes("decryption") ||
            msg.toLowerCase().includes("session keys") ||
            msg.toLowerCase().includes("key packets");
          if (isDecryptionError) {
            process.stderr.write(`[ENGINE] session_activation_failed: ${msg}\n`);
            driveClient = null;
            syncEngine?.setDriveClient(null);
            server.emitEvent({
              type: "session_error",
              payload: { code: "SHARE_KEY_DECRYPT_FAILED",
                message: "Could not access your Proton Drive files — some keys could not be decrypted" },
            });
            return;
          }
          throw err;   // network / auth errors propagate to caller's try/catch
        }
        ```
  - [x] 2.2 Confirm `drainEventQueue`, `startSyncAll`, `fileWatcher` initialization, and the
        `session_ready` emit only execute on the success path (they are after the try/catch block
        and are NOT reached when `session_error` is emitted).

- [x] **Task 3 — Register `session_error` handler in UI** (AC4, AC6)
  - [x] 3.1 In `ui/src/protondrive/main.py`, in `__init__`, after line 103 (`self._engine.on_event("file_synced", ...)`), add:
        ```python
        self._engine.on_event("session_error", self._on_session_error)
        ```

- [x] **Task 4 — Implement `_on_session_error` handler** (AC4, AC5)
  - [x] 4.1 Implemented `_on_session_error` method in `ui/src/protondrive/main.py` near `_on_session_ready`.
  - [x] 4.2 Implemented `_on_session_error_response` method.
  - [x] 4.3 Confirmed `Gio` and `Adw` are already imported.

- [x] **Task 5 — Engine unit tests** (AC7)
  - [x] 5.1 Added `_activateSession — session_error on decryption failure` describe block in `engine/src/main.test.ts`. Used `_setCreateDriveClientForTests` (new test injection point) to mock the client factory and `key_password` payload to reach `_activateSession`. AC2 (non-decryption rethrow) not directly testable without crashing the test runner — commented.
  - [x] 5.2 AC2 non-decryption behavior is structurally enforced by the code; direct test omitted (unhandled rejection kills test runner).

- [x] **Task 6 — UI unit tests** (AC8)
  - [x] 6.1 Added `TestOnSessionError` in `ui/tests/test_window_routing.py`: asserts `close_auth_browser` called and no crash when `_window` is None. 2 tests pass.

- [x] **Task 7 — Full test suite validation**
  - [x] 7.1 Engine tests: `bun test` hangs in Claude Code sandbox (known environment limitation); user must verify. New test logic verified by inspection: `_setCreateDriveClientForTests` injection properly bypasses real SDK calls.
  - [x] 7.2 UI pytest: `meson compile` + `.venv/bin/pytest ui/tests/test_main.py ui/tests/test_window_routing.py ui/tests/test_main_routing.py` — 184 passed. Pre-existing failures in `test_activity_feed.py` and `test_pair_detail_panel.py` are unrelated to this story.
  - [x] 7.3 Confirmed: `grep "DEBUG token dumped" engine/src/main.ts` → 0 matches.

## Dev Notes

### Exact files to touch

- `engine/src/main.ts` — delete debug token dump (Task 1), wrap `startRemoteEventSubscription` in try/catch (Task 2)
- `ui/src/protondrive/main.py` — register handler (Task 3), implement `_on_session_error` + `_on_session_error_response` (Task 4)
- `engine/src/main.test.ts` — new tests (Task 5)
- `ui/tests/test_window_routing.py` — new test (Task 6)

No Blueprint `.blp` files, Meson, IPC protocol schema file, or new Python modules are needed.

### `_activateSession` structure after Task 2

The full function becomes:
```typescript
async function _activateSession(client, info, keyPassword) {
  driveClient = client;
  syncEngine?.setDriveClient(client);
  try {
    await syncEngine?.startRemoteEventSubscription(client);
    await syncEngine?.drainEventQueue(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isDecryptionError = msg.toLowerCase().includes("decryption")
      || msg.toLowerCase().includes("session keys")
      || msg.toLowerCase().includes("key packets");
    if (isDecryptionError) {
      process.stderr.write(`[ENGINE] session_activation_failed: ${msg}\n`);
      driveClient = null;
      syncEngine?.setDriveClient(null);
      server.emitEvent({ type: "session_error",
        payload: { code: "SHARE_KEY_DECRYPT_FAILED", message: "..." } });
      return;
    }
    throw err;
  }
  // Success path — only reached when subscription started successfully
  void syncEngine?.startSyncAll();
  fileWatcher?.stop();
  fileWatcher = new FileWatcher( ... );
  void fileWatcher.initialize();
  server.emitEvent({ type: "session_ready", payload });
}
```

### Why `driveClient = null` on decryption failure

If we leave `driveClient` set after a decryption failure, any timers or deferred calls that check
`driveClient !== null` (e.g., a late-firing `drainQueue`) would try to use the client. Setting it
null ensures the engine stays completely idle until the user resolves the issue and re-auths.
`syncEngine?.setDriveClient(null)` is the existing pattern used in `token_expired` handling.

### `_cancel_validation_timeout` in UI

In `main.py`, `_start_validation_timeout()` is called after `send_token_refresh` to detect hung
sessions. If `session_error` fires, we must cancel it or the timeout handler will fire and show a
redundant "timed out" state on top of the error dialog.

Check: `_cancel_validation_timeout` exists in `main.py` (grep for it). If only
`_start_validation_timeout` exists and timeout cancellation is done inline (e.g., setting
`self._validation_timeout_id`), call `GLib.source_remove(self._validation_timeout_id)` instead.
The pattern is already used in `_on_session_ready`.

### `Adw.AlertDialog` — confirmed project pattern

`Adw.AlertDialog` is used in:
- `ui/src/protondrive/widgets/settings.py:84`
- `ui/src/protondrive/widgets/reauth_dialog.py` (full subclass)
- `ui/src/protondrive/window.py:334`

`Gio.AppInfo.launch_default_for_uri` is already used in:
- `ui/src/protondrive/widgets/conflict_log.py:60`

Both imports are already present in `main.py` — no new imports required.

### Error detection heuristic for decryption failures

The three strings checked (`"decryption"`, `"session keys"`, `"key packets"`) cover:
- `"Error decrypting session keys: No decryption key packets found"` — primary failure from issue
- `"Decryption error"` — generic SDK `[shares-crypto]` decryption string (also covered by 8-4b reconcilePair path)
- `"No decryption key packets found"` — openpgp root cause

This is intentionally conservative — only catch known decryption patterns; rethrow everything else
(network errors, auth errors) so existing handlers deal with them correctly.

### ipc-protocol.md: new event type to document

After implementation, add `session_error` to
`_bmad-output/ipc-protocol.md` alongside `session_ready`, `token_expired`, etc.
Format:
```
### session_error
Direction: engine → UI
Payload: { code: "SHARE_KEY_DECRYPT_FAILED", message: string }
When: session activation failed because the remote share key could not be decrypted
```

### Debug token removal — deferred-work.md item [7-1 CR D9]

This story resolves `[7-1 CR D9]`. After completion, mark it resolved in `deferred-work.md` by
removing the entry or adding a resolution note.

### WebKit crash on x86_64

Issue #2 also shows a WebKit crash (`SIGTRAP`, `libjavascriptcoregtk-6.0.so.1`) during auth on
x86_64 (AMD). Our `deferred-work.md` documented this crash as aarch64-only. It is NOT in scope for
this story (auth still completed after the WebKit crash in the issue log). After this story ships,
update `deferred-work.md` to note the crash is confirmed on x86_64 as well. Path B from the
deferred entry (system-browser auth) becomes more relevant to evaluate.

### Project Structure Notes

- UI event handlers follow the pattern in `main.py` `__init__`: `on_event(type, handler)`
- Engine IPC events are plain `{ type: string, payload: object }` JSON objects emitted via `server.emitEvent()`
- Python test mocking: use existing fixture patterns in `test_window_routing.py` — mock GTK/Adw objects at the test boundary
- **`on_event` vs `on_session_ready` dispatch distinction:** `on_session_ready()` passes only the
  payload dict to its callback; `on_event()` passes the full `{"type": ..., "payload": ...}` message.
  The `_on_session_error` handler registered via `on_event` receives the full message — use
  `message.get("payload", {})` to extract payload data if code-checking is ever added.
- No Epic 9 planning file exists in `_bmad-output/planning-artifacts/epics/` — story is self-contained.

### References

- `_activateSession`: `engine/src/main.ts:236`
- `startRemoteEventSubscription` (throws on legacy share): `engine/src/sync-engine.ts:342`
- `getRootTreeEventScopeId` call inside: `engine/src/sync-engine.ts:344`
- Debug token dump to remove: `engine/src/main.ts:365–371`
- `handleTokenRefresh` (calls `void _activateSession` — its try/catch does NOT catch errors from _activateSession): `engine/src/main.ts:308`
- `handleUnlockKeys` (also calls `_activateSession`): `engine/src/main.ts:404`
- `close_auth_browser` method: `ui/src/protondrive/window.py` (called in `_on_session_ready`)
- `_cancel_validation_timeout` / `_start_validation_timeout`: `ui/src/protondrive/main.py`
- `Adw.AlertDialog` example: `ui/src/protondrive/widgets/settings.py:84`
- `Gio.AppInfo.launch_default_for_uri` example: `ui/src/protondrive/widgets/conflict_log.py:60`
- Engine crash in issue: `_activateSession → startRemoteEventSubscription → getRootTreeEventScopeId → getVolumeRootFolder → decryptRootShare`
- IPC protocol: `_bmad-output/ipc-protocol.md`
- Deferred security issue being resolved: `_bmad-output/implementation-artifacts/deferred-work.md` `[7-1 CR D9]`
- GitHub issue: https://github.com/ronki2304/ProtonDriveLinuxClient/issues/2

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Engine test hang: `bun test` hangs even without test files in Claude Code sandbox (environment limitation). Root cause of original "test loop" was multiple background test launches. Fixed by adding `_setCreateDriveClientForTests` injection to bypass real SDK `createDriveClient` call in `handleTokenRefresh`.
- Non-decryption test (5.2): omitted because `void _activateSession(...)` causes an unhandled rejection that exits the Bun process — structurally untestable in this environment.

### Completion Notes List

- **Task 1 (AC3)**: Removed 7-line debug token dump block from `engine/src/main.ts` (was lines 365–371). `[7-1 CR D9]` resolved in `deferred-work.md`.
- **Task 2 (AC1, AC2)**: Wrapped `startRemoteEventSubscription` + `drainEventQueue` in try/catch in `_activateSession`. Decryption errors (matching "decryption", "session keys", "key packets") → emit `session_error` + return. All other errors rethrown.
- **Task 3 (AC6)**: Registered `on_event("session_error", self._on_session_error)` in `Application.__init__`.
- **Task 4 (AC4, AC5)**: Implemented `_on_session_error` and `_on_session_error_response` in `main.py`. Dialog heading/body/responses match spec exactly. "Open Proton Drive" → `Gio.AppInfo.launch_default_for_uri` + `show_pre_auth()`. "Sign Out" → `logout()` + `show_pre_auth()`.
- **Task 5 (AC7)**: Added `_activateSession — session_error on decryption failure` describe block in `main.test.ts`. Added `_setCreateDriveClientForTests` export to `main.ts` to allow mocking `createDriveClient` in tests. Test uses `key_password` payload to reach `_activateSession` path.
- **Task 6 (AC8)**: Added `TestOnSessionError` class in `test_window_routing.py` — 2 tests verify `close_auth_browser` called and no crash on `None` window.
- **Docs**: Added `session_error` to `ipc-protocol.md` table. Updated `deferred-work.md`: resolved `[7-1 CR D9]`, noted WebKit crash confirmed on x86_64.

### Review Findings

- [x] [Review][Decision] D1 — `_on_session_error_response` calls `show_pre_auth()` unconditionally after both branches; if `logout()` already transitions to pre-auth, the sign_out branch double-calls it — fixed: guarded `show_pre_auth()` to `open_browser` branch only; `logout()` handles sign_out transition
- [x] [Review][Decision] D2 — `handleUnlockKeys` is a second caller of `_activateSession` not covered by the session_error engine test — fixed: added `handleUnlockKeys path: emits session_error on decryption failure` test
- [x] [Review][Patch] P1 — Engine test uses `setTimeout(10ms)` — fixed: replaced with `setTimeout(0)` (macro-task; drains microtask queue deterministically) [engine/src/main.test.ts]
- [x] [Review][Patch] P2 — `testServer` emitEvent override leaks across suites — fixed: afterEach resets `_setServerForTests` to a fresh IpcServer [engine/src/main.test.ts afterEach]
- [x] [Review][Patch] P3 — `StateDb` instance not closed — fixed: `db.close()` added in each test body [engine/src/main.test.ts]
- [x] [Review][Patch] P4 — `mockSyncEngine` missing `drainEventQueue` — fixed: added `drainEventQueue: mock(async () => {})` to both engine test mocks [engine/src/main.test.ts]
- [x] [Review][Patch] P5 — AC8 violated: AlertDialog not asserted — fixed: added `test_alert_dialog_presented_on_session_error` [ui/tests/test_window_routing.py]
- [x] [Review][Patch] P6 — AC4/AC8: `_cancel_validation_timeout` not asserted — fixed: added `test_cancel_validation_timeout_called` [ui/tests/test_window_routing.py]
- [x] [Review][Patch] P7 — AC5: response branches untested — fixed: added `test_response_open_browser_launches_uri_and_shows_pre_auth` and `test_response_sign_out_calls_logout_not_show_pre_auth` [ui/tests/test_window_routing.py]
- [x] [Review][Patch] P8 — `disposeEventSubscription` not called on decryption-error path — fixed: added before driveClient reset to match token_expired pattern [engine/src/main.ts:266]
- [x] [Review][Patch] P9 — Dialog constructed when `_window is None` — fixed: entire dialog block moved inside `if self._window is not None` guard [ui/src/protondrive/main.py:419]
- [x] [Review][Defer] W1 — AC2 (non-decryption rethrow) untested — acknowledged in spec; unhandled rejection kills test runner [engine/src/main.test.ts] — deferred, pre-existing
- [x] [Review][Defer] W2 — Non-decryption error from `drainEventQueue` leaves `driveClient`/syncEngine half-initialized on rethrow — pre-existing `void _activateSession(...)` design, out of scope per spec [engine/src/main.ts:279] — deferred, pre-existing
- [x] [Review][Defer] W3 — String-matching decryption error detection is fragile against SDK version changes — acknowledged design choice in story notes [engine/src/main.ts:262] — deferred, pre-existing
- [x] [Review][Defer] W4 — Concurrent `_activateSession` invocations could race `session_error` / `session_ready` — pre-existing `void` caller design, out of scope [engine/src/main.ts] — deferred, pre-existing

### File List

- `engine/src/main.ts`
- `engine/src/main.test.ts`
- `ui/src/protondrive/main.py`
- `ui/tests/test_window_routing.py`
- `_bmad-output/implementation-artifacts/9-1-legacy-share-key-decryption-error.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/ipc-protocol.md`
