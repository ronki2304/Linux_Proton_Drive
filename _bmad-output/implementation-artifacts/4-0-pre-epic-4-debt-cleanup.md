# Story 4.0: Pre-Epic-4 Debt Cleanup

Status: done

## Story

As a developer,
I want all critical action items from the Epic 3 retrospective resolved before starting Epic 4 feature work,
so that conflict detection starts on a clean, reliable foundation.

## Acceptance Criteria

### AC1 — 29 pre-existing auth test failures cleared

**Given** 29 pre-existing auth test failures in `ui/tests/` (present since Story 3-0b)
**When** Story 4-0 ships
**Then** `meson test -C builddir` passes with zero pre-existing failures in:
- `test_auth_completion.py`
- `test_auth_window.py`
- `test_credential_store.py`
- `test_main_routing.py`
**And** all 29 failures are fixed (not skipped or marked xfail unless genuinely untestable)

### AC2 — Resource lifecycle rule added to `project-context.md`

**Given** the resource lifecycle gap identified in the Epic 3 retrospective
**When** `project-context.md` is updated
**Then** the following rule is added under the Code Quality section:
> "Every opened resource (socket, timer, file handle) must have a corresponding close/stop/destroy on all exit paths including error paths"

### AC3 — DB atomicity rule added to `project-context.md`

**Given** the DB atomicity gap identified in the Epic 3 retrospective
**When** `project-context.md` is updated
**Then** the following rule is added under the Code Quality section:
> "Compound DB operations (upsert+dequeue, delete+dequeue) must use `db.transaction()`"

### AC4 — `upsertSyncState` uses `INSERT ... ON CONFLICT DO UPDATE SET`

**Given** `upsertSyncState` currently uses `INSERT OR REPLACE` which resets `rowid` on every update
**When** Story 4-0 ships
**Then** `upsertSyncState` in `engine/src/state-db.ts` is rewritten to use
`INSERT INTO sync_state ... ON CONFLICT(pair_id, relative_path) DO UPDATE SET ...`
**And** all 5 fields (`pair_id`, `relative_path`, `local_mtime`, `remote_mtime`, `content_hash`) are preserved
**And** `rowid` is preserved across updates (no reset) — required for any Epic 4 foreign-key use

### AC5 — No new user-facing functionality

**Given** this is a Story 0 debt cleanup
**When** the story ships
**Then** no new IPC events, UI widgets, or sync engine features are added

### AC6 — Story stops at `review`

Dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit. **Commit directly to `main`** — do not create a feature branch.

---

## Tasks / Subtasks

- [x] **Task 1: Fix 29 auth test failures** (AC: #1)
  - [x] 1.1 Fix `test_auth_completion.py` — update `send_token_refresh` assertions (see Dev Notes §1.1)
  - [x] 1.2 Fix `test_auth_window.py` — `TestWindowOnAuthCompleted` (see Dev Notes §1.2)
  - [x] 1.3 Fix `test_auth_window.py` — `TestWebViewCleanup` (see Dev Notes §1.3)
  - [x] 1.4 Fix `test_auth_window.py` — `TestStory20WebviewSessionClearing` (see Dev Notes §1.4)
  - [x] 1.5 Fix `test_main_routing.py` — add `_pending_key_unlock_dialog = None` to helper (see Dev Notes §1.5)
  - [x] 1.6 Verify `test_credential_store.py` — confirm all pass without changes (or diagnose and fix any that don't)
  - [x] 1.7 Run `meson test -C builddir` (or `python -m pytest ui/tests/test_auth*.py ui/tests/test_credential_store.py ui/tests/test_main_routing.py` for a quick check) — confirm zero failures in the 4 files

- [x] **Task 2: Update `project-context.md` — resource lifecycle rule** (AC: #2)
  - [x] 2.1 In `_bmad-output/project-context.md`, find the "Code Quality & Style Rules" section
  - [x] 2.2 Under `#### Code Organization` (or at end of that section), add:
    > "Every opened resource (socket, timer, file handle) must have a corresponding close/stop/destroy on all exit paths including error paths"
  - [x] 2.3 Also add rule under TypeScript engine Error Handling section or as a standalone rule so it's visible to engine devs

- [x] **Task 3: Update `project-context.md` — DB atomicity rule** (AC: #3)
  - [x] 3.1 In the same file, under "Sync Engine Architecture" or SQLite sections, add:
    > "Compound DB operations (upsert+dequeue, delete+dequeue) must use `db.transaction()`"

- [x] **Task 4: Rewrite `upsertSyncState` in `engine/src/state-db.ts`** (AC: #4)
  - [x] 4.1 Replace the current `INSERT OR REPLACE` body with `INSERT ... ON CONFLICT DO UPDATE SET` (exact SQL in Dev Notes §4)
  - [x] 4.2 `bunx tsc --noEmit` — zero errors
  - [x] 4.3 `bun test engine/src/state-db.test.ts` — all existing tests pass (rowid preservation tested)
  - [x] 4.4 `bun test` from project root — no regressions

- [x] **Task 5: Final validation** (AC: #1, #4)
  - [x] 5.1 `bun test` — all engine tests pass
  - [x] 5.2 `meson test -C builddir` (or pytest quick check) — zero failures in all 4 auth test files
  - [x] 5.3 Set story status to `review`

---

## Dev Notes

### §1 — Root Cause Analysis: 29 Auth Test Failures

These tests were written for the auth flow design as of Story 2.9/3-0b. The auth flow changed significantly in Story 2-11 (key derivation) and subsequent work: `_on_token_received` no longer tears down the WebView (cookies are preserved for session persistence so users don't re-authenticate on every launch), and `send_token_refresh` gained new optional params.

**Do NOT revert the production code changes.** The current behavior in `auth_window.py`, `window.py`, and `main.py` is intentional and correct. **The tests need to be updated to match the new design.**

---

#### §1.1 — `test_auth_completion.py` (≈2 failures)

**Root cause:** `Application.on_auth_completed` signature changed from `(self, token)` to `(self, token, login_password=None, captured_salts=None)`. Tests assert `send_token_refresh.assert_called_once_with("good-token")` but the actual call is:
```python
self._engine.send_token_refresh(token, login_password=None, captured_salts=None)
```

**Fix:** Update the two assertions:
```python
# test_success_returns_true_and_sets_wizard_flag
app._engine.send_token_refresh.assert_called_once_with(
    "good-token", login_password=None, captured_salts=None
)

# test_no_credential_manager_still_succeeds
app._engine.send_token_refresh.assert_called_once_with(
    "token-x", login_password=None, captured_salts=None
)
```

Also verify: `app._settings.set_boolean.assert_called_with("wizard-auth-complete", True)` — this should still work since `settings` property returns `_settings` when `_settings` is already set (non-None MagicMock). Check that `_make_app()` in test sets `app._settings = MagicMock()` (not None) so the property doesn't try to create a new `Gio.Settings`.

---

#### §1.2 — `test_auth_window.py` — `TestWindowOnAuthCompleted` (≈1 failure)

**Root cause:** `test_success_calls_show_main` expects `win.show_main.assert_called_once()` after `win._on_auth_completed(MagicMock(), "token")`. But `_on_auth_completed` in `window.py` no longer calls `show_main` — it only forwards the token to the app for engine validation. The UI transition to main happens later when `_on_session_ready` calls `close_auth_browser()`.

Current `_on_auth_completed` behavior (window.py:420–442):
1. Gets `login_password` and `captured_salts` from the auth_window widget arg
2. Calls `app.on_auth_completed(token, login_password=..., captured_salts=...)`
3. On failure: calls `self._auth_window.show_credential_error()`

**Fix for `test_success_calls_show_main`:** Replace the test to assert the token was forwarded, not that `show_main` was called:
```python
def test_success_forwards_token_to_app(self) -> None:
    win = _make_window()
    mock_app = MagicMock()
    mock_app.on_auth_completed.return_value = True
    win.get_application = MagicMock(return_value=mock_app)

    mock_auth_win = MagicMock()
    mock_auth_win.captured_login_password = None
    mock_auth_win.captured_salts = None

    win._on_auth_completed(mock_auth_win, "token")

    mock_app.on_auth_completed.assert_called_once_with(
        "token", login_password=None, captured_salts=None
    )
```

`test_failure_does_not_call_show_main`, `test_failure_shows_credential_error_on_auth_window`, `test_no_application_is_safe_noop` — review each and update as needed. The auth_window parameter now has `captured_login_password` and `captured_salts` accessed in the handler; if these are `MagicMock()` attributes, the call should still work.

---

#### §1.3 — `test_auth_window.py` — `TestWebViewCleanup` (≈4–5 failures)

**Root cause:** `_on_token_received` was refactored to NOT tear down the WebView. Old design: emit token, tear down WebView. New design: emit token (multiple times possible, deduped by 8s window), keep WebView alive for cookie polling; teardown only on `mark_auth_complete()`.

Current `_on_token_received` (auth_window.py:378–398):
```python
def _on_token_received(self, token: str) -> None:
    if self._completed:
        return
    # dedup check: same token within _RESEND_INTERVAL_S
    now = time.monotonic()
    if (token == self._last_token_sent and
            now - self._last_send_time < self._RESEND_INTERVAL_S):
        return
    self._last_token_sent = token
    self._last_send_time = now
    self.emit("auth-completed", token)
    # NO TEARDOWN HERE — WebView stays alive for cookie polling
```

**Fix:** Update `TestWebViewCleanup` to test `mark_auth_complete()` instead of `_on_token_received()`:
- `test_try_close_called` → call `w.mark_auth_complete()`, assert `wv.try_close.assert_called_once()`
- `test_webview_set_to_none` → call `w.mark_auth_complete()`, assert `w._webview is None`
- `test_auth_server_stopped` → call `w.mark_auth_complete()`, assert stop called
- `test_webview_removed_from_container` → call `w.mark_auth_complete()`, assert remove called

For `test_auth_completed_emitted` — this tests `_on_token_received` emitting the signal, which still happens. Update the mock setup to set `w._last_token_sent = None` so the dedup check doesn't suppress. The `_make_window()` helper doesn't set these new attrs; add:
```python
window._last_token_sent = None
window._last_send_time = 0.0
window._RESEND_INTERVAL_S = 8.0
window._cookie_poll_id = None
```

Also add `_completed = False` if not already there.

---

#### §1.4 — `test_auth_window.py` — `TestStory20WebviewSessionClearing` (≈3 failures)

**Root cause:** The design intent changed: cookies are intentionally preserved so users don't re-authenticate. `_teardown_webview` no longer calls `_clear_webview_session`. The `_clear_webview_session` static method still exists for potential future use.

- `test_token_received_clears_website_data_before_try_close` — `_on_token_received` doesn't clear data anymore. Either **delete this test** (the behavior it tested is intentionally removed) or rewrite to verify data is NOT cleared (confirming the new design).
- `test_cleanup_clears_website_data` — same reasoning. Either delete or invert: `cleanup()` must NOT call `data_manager.clear()`.
- `test_cleanup_and_token_received_use_same_helper` — `_on_token_received` no longer calls `_teardown_webview`. Rewrite to test that `mark_auth_complete()` and `cleanup()` both call `_teardown_webview`.

The static tests (`test_clear_session_falls_back_to_webview_data_manager`, `test_clear_session_swallows_glib_error_silently`) test `_clear_webview_session` directly and should still pass — don't touch them.

**Decision guidance:** Prefer rewriting tests to confirm the new design rather than deleting them — tests serve as design documentation.

---

#### §1.5 — `test_main_routing.py` (≈4 failures)

**Root cause:** `_make_application()` helper missing `_pending_key_unlock_dialog = None`. The `_on_session_ready` method now accesses `self._pending_key_unlock_dialog` early in its body:
```python
if self._pending_key_unlock_dialog is not None:
    ...
```
This raises `AttributeError` since the attribute isn't set by the test helper.

Also: `_on_session_ready` now calls `self._window.close_auth_browser()` before routing. This is fine since `app._window = MagicMock()`, but the routing assertions may need adjustment.

**Fix in `_make_application()`:**
```python
def _make_application() -> _main_mod.Application:
    app = object.__new__(_main_mod.Application)
    app._settings = None
    app._engine = MagicMock()
    app._credential_manager = None
    app._window = MagicMock()
    app._token_validation_timer_id = None
    app._cached_session_data = None
    app._pending_key_unlock_dialog = None  # ADD THIS
    return app
```

After this fix, check if `_had_browser_session` is needed anywhere in `_on_session_ready`. If yes, add `app._had_browser_session = False` too. Scan `main.py:_on_session_ready` for all `self.` attribute accesses.

The routing tests (`test_routes_to_wizard_when_config_absent`, etc.) — the assertions test `show_setup_wizard` and `show_main`, which are still called. But the signature changed: `show_setup_wizard(self._engine)` not `show_setup_wizard()`. Update assertions to use `assert_called_once()` without args check, or update to `assert_called_once_with(app._engine)`.

---

### §2 — `project-context.md` Updates (AC2, AC3)

File: `_bmad-output/project-context.md`

**Rule 1 (AC2)** — Add under "Code Quality & Style Rules → Code Organization":
```
- **Resource lifecycle** — Every opened resource (socket, timer, file handle) must
  have a corresponding close/stop/destroy on all exit paths including error paths
```

**Rule 2 (AC3)** — Add under "Sync Engine Architecture → SQLite" or as a bullet under the existing SQLite rules:
```
- **DB atomicity** — Compound DB operations (upsert+dequeue, delete+dequeue) must
  use `db.transaction()`; two separate writes with a crash between them = corrupt state
```

Both rules should also appear in the TypeScript section if the architecture doc has one, since the engine is the primary consumer.

---

### §4 — `upsertSyncState` Fix (AC4)

**File:** `engine/src/state-db.ts`

**Current (lines 186–193):**
```ts
upsertSyncState(state: SyncState): void {
  this.db
    .prepare(
      `INSERT OR REPLACE INTO sync_state (pair_id, relative_path, local_mtime, remote_mtime, content_hash)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(state.pair_id, state.relative_path, state.local_mtime, state.remote_mtime, state.content_hash);
}
```

**Replace with:**
```ts
upsertSyncState(state: SyncState): void {
  this.db
    .prepare(
      `INSERT INTO sync_state (pair_id, relative_path, local_mtime, remote_mtime, content_hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pair_id, relative_path) DO UPDATE SET
         local_mtime   = excluded.local_mtime,
         remote_mtime  = excluded.remote_mtime,
         content_hash  = excluded.content_hash`
    )
    .run(state.pair_id, state.relative_path, state.local_mtime, state.remote_mtime, state.content_hash);
}
```

`INSERT OR REPLACE` deletes-then-inserts (resets `rowid`). `ON CONFLICT DO UPDATE` updates in-place (preserves `rowid`). The `sync_state` PRIMARY KEY is `(pair_id, relative_path)` — no ambiguity about which conflict to handle.

**Existing tests** in `state-db.test.ts` cover round-trip upsert behavior and should still pass. Add a rowid-preservation test if not already present:
```ts
it("upsertSyncState preserves rowid across updates", () => {
  const db = makeTestDb();
  db.upsertSyncState({ pair_id: "p1", relative_path: "a.txt", local_mtime: "2026-01-01T00:00:00.000Z", remote_mtime: "2026-01-01T00:00:00.000Z", content_hash: null });
  const before = db["db"].prepare("SELECT rowid FROM sync_state WHERE pair_id = 'p1' AND relative_path = 'a.txt'").get() as { rowid: number };
  db.upsertSyncState({ pair_id: "p1", relative_path: "a.txt", local_mtime: "2026-01-02T00:00:00.000Z", remote_mtime: "2026-01-02T00:00:00.000Z", content_hash: "abc" });
  const after = db["db"].prepare("SELECT rowid FROM sync_state WHERE pair_id = 'p1' AND relative_path = 'a.txt'").get() as { rowid: number };
  expect(before.rowid).toBe(after.rowid);
});
```

---

### Project Structure Notes

Files touched by this story:
- `ui/tests/test_auth_completion.py` — test assertion updates only
- `ui/tests/test_auth_window.py` — test updates to match new auth flow design
- `ui/tests/test_main_routing.py` — add `_pending_key_unlock_dialog = None` to helper
- `ui/tests/test_credential_store.py` — diagnose; likely no changes needed
- `engine/src/state-db.ts` — `upsertSyncState` SQL change only
- `engine/src/state-db.test.ts` — add rowid-preservation test
- `_bmad-output/project-context.md` — two rule additions

**Do NOT modify:**
- `ui/src/protondrive/auth_window.py` — production code is correct; tests must adapt
- `ui/src/protondrive/window.py` — same
- `ui/src/protondrive/main.py` — same
- Any sync engine production files other than `state-db.ts`

### References

- Epic 4 story definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-40`
- Epic 3 retrospective (source of all 4 action items): `_bmad-output/implementation-artifacts/epic-3-retro-2026-04-17.md`
- Production auth flow: `ui/src/protondrive/auth_window.py:378` (`_on_token_received`), `:400` (`mark_auth_complete`)
- Production window routing: `ui/src/protondrive/window.py:420` (`_on_auth_completed`)
- Production app routing: `ui/src/protondrive/main.py:106` (`on_auth_completed`), `:226` (`_on_session_ready`)
- StateDB upsert: `engine/src/state-db.ts:186` (`upsertSyncState`)
- Schema: `engine/src/state-db.ts:52` (`sync_state` PRIMARY KEY is `(pair_id, relative_path)`)
- Project context: `_bmad-output/project-context.md`

### Review Findings

- [x] [Review][Decision] AC2/AC3 rule wording vs spec — accepted: bold label follows house style in project-context.md; extra AC3 explanatory clause adds useful context for future agents
- [x] [Review][Decision] AC1 — `test_failure_does_not_call_show_main` deleted rather than rewritten — accepted: assertion was vacuously true under new design; `_on_auth_completed` never calls `show_main` in either success or failure path
- [x] [Review][Decision] AC1/Design — `TestStory20WebviewSessionClearing` inverts prior AC8 without new story trace — resolved: design is intentional (Story 2-11 session-persistence goal); docstring added to test class citing Story 2-11 as the design-decision source
- [x] [Review][Patch] `test_failure_shows_credential_error_on_auth_window` passes bare `MagicMock()` as auth_window — fixed: replaced with configured mock (captured_login_password=None, captured_salts=None) matching the success test pattern [ui/tests/test_auth_completion.py:115]
- [x] [Review][Defer] No test covering non-None captured credentials — coverage gap; both assertions verify only the `None` case, so a bug that ignores actual credential values would go undetected — deferred, pre-existing gap
- [x] [Review][Defer] `_LoadEventVal.value_nick` uses lowercase vs production enum behavior — verify production code never compares `.value_nick` by case-sensitive string; if it does, "committed" vs "COMMITTED" would silently fail [ui/tests/conftest.py:90] — deferred, pre-existing
- [x] [Review][Defer] `_make_window()` missing `_completed = False` initialization — if any test exercises code paths that read `self._completed` (e.g., `_poll_for_auth_cookie`), AttributeError or silent wrong-path behavior results [ui/tests/test_auth_window.py:~75] — deferred, pre-existing

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- 29 pre-existing failures confirmed via `.venv/bin/pytest` before any changes
- `cryptography` module absent from venv; resolved via symlink to system package + `_cffi_backend.so`
- `TestSecretPortalStoreKeyPassword.setup_method` had mock isolation bug: `_secret_mock.reset_mock()` without `side_effect=True` let `password_lookup_sync.side_effect` leak from `test_is_available_failure`; fixed to `reset_mock(side_effect=True)`
- `conftest.py` `LoadEvent.COMMITTED` was a plain string "COMMITTED"; production code uses `event.value_nick` in debug print — fixed by replacing with `_LoadEventVal` objects that carry `value_nick`
- `TestAuthFlowOrdering`: `_mod.WebKit.WebView = lambda: mock_webview` rejected `user_content_manager=` kwarg from `_create_webview()`; updated to `lambda *args, **kwargs: mock_webview`

### Completion Notes List

- **Task 1**: Fixed all 29 auth test failures across 4 files. No production code changed.
  - `test_auth_completion.py`: Updated 2 `send_token_refresh` assertions to include `login_password=None, captured_salts=None`; rewrote `test_success_calls_show_main` → `test_success_forwards_token_to_app`; removed `test_failure_does_not_call_show_main` (behavior no longer relevant)
  - `test_auth_window.py`: Added 4 missing attrs (`_cookie_poll_id`, `_last_token_sent`, `_last_send_time`, `_RESEND_INTERVAL_S`) to `_make_window()` and `TestAuthFlowOrdering` inline window; rewrote `TestWebViewCleanup` to target `mark_auth_complete()` instead of `_on_token_received()`; rewrote `TestStory20WebviewSessionClearing` to assert cookies are NOT cleared (new design)
  - `test_main_routing.py`: Added `_pending_key_unlock_dialog = None` to `_make_application()`
  - `test_credential_store.py`: Fixed mock isolation in `TestSecretPortalStoreKeyPassword.setup_method`; installed `cryptography` via venv symlink
  - `conftest.py`: Replaced `LoadEvent` string constants with `_LoadEventVal` objects carrying `value_nick`
- **Task 2**: Added resource lifecycle rule under `#### Code Organization` in `project-context.md`
- **Task 3**: Added DB atomicity rule under SQLite rules in `#### Sync Engine Architecture` in `project-context.md`
- **Task 4**: Replaced `INSERT OR REPLACE` with `INSERT ... ON CONFLICT DO UPDATE SET` in `upsertSyncState`; added rowid-preservation test — 28 state-db tests pass, 207 engine tests pass
- **AC5**: No new IPC events, UI widgets, or sync engine features added — only test updates and SQL fix

### File List

- `ui/tests/test_auth_completion.py`
- `ui/tests/test_auth_window.py`
- `ui/tests/test_main_routing.py`
- `ui/tests/test_credential_store.py`
- `ui/tests/conftest.py`
- `engine/src/state-db.ts`
- `engine/src/state-db.test.ts`
- `_bmad-output/project-context.md`
