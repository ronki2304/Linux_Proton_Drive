# Deferred Work

## Resolution Plan (from Epic 1 Retrospective, 2026-04-08)

### Epic 2 Story 0 — Technical Debt Cleanup (9 items)

Items that directly affect Epic 2 stability. Must be resolved before starting Epic 2 feature stories.

| # | Item | Source | Why it matters for Epic 2 |
|---|------|--------|--------------------------|
| 1 | `writeMessage` ignores `socket.write()` backpressure | 1-3 W3 | Continuous sync progress events will flood the socket |
| 2 | `restart()` reentrancy risk if error callback triggers restart | 1-5 W6 | Sync failures in Epic 2 will hit this path |
| 3 | `_write_message` failure doesn't tear down stale connection | 1-5 W4 | Sync disconnects need clean teardown |
| 4 | `cleanup()` doesn't close connection explicitly | 1-5 W1 | Engine lifecycle must be solid for long-running sync |
| 5 | `send_command` queues dict by reference — mutation risk | 1-5 W5 | Sync queue replay could mutate queued commands |
| 6 | Malformed JSON messages silently dropped with no logging | 1-4 W2 | Sync debugging impossible without visibility |
| 7 | `_on_auth_completed` transitions to main UI even if token storage fails | 1-8, 1-6 | Setup wizard (Story 2.4) reuses this flow |
| 8 | WebView network session not explicitly cleared after auth | 1-9 W4 | Auth reuse in setup wizard could leak sessions |
| 9 | `sys.modules` pollution in test fixtures | 1-4 W6, 1-8 | 110+ tests and growing — fix now or never |

### Stays with planned epic (not in Story 0)

| Item | Planned Epic | Reason |
|------|-------------|--------|
| `_on_engine_error` is `pass` — no error display | Epic 5 | Error UI designed in Epic 5 |
| Fatal vs non-fatal error distinction in UI rendering | Epic 5 | Needs error display first |
| `rate_limited` UI paused state | Epic 3 | Offline/network epic |
| Responsive CSS for storage label hiding | Cosmetic | Not blocking |
| Auth server timeout | Low risk | Daemon thread dies with process |
| Thread safety on `_token_received` flag | Low risk | Single-request server |
| `_on_load_changed` hides error banner on sub-resources | Low risk | WebKitGTK main-frame only in practice |
| `logout()` swallows `delete_token()` exceptions | Epic 5 | Error handling scope |
| `start_auth_flow()` dead code | Cleanup | Harmless until called |
| `EngineConnectionError` defined but never raised | Cleanup | Dead code, may be used later |
| Unbounded buffer growth in `MessageReader` | Low risk | Local Unix socket only |
| `shutdown` bypasses `commandHandler` | Future | No cleanup hooks needed yet |
| `encodeMessage` can exceed `MAX_PAYLOAD_SIZE` | Future | No large messages in current scope |
| `setTimeout`-based test synchronization | Low risk | Works for now |
| No test for client disconnect during async command | Low priority | Complex to test |
| `read_bytes_async` short reads | Low risk | Gio buffers for Unix sockets |
| Synchronous `client.connect()` | Acceptable | Near-instant on localhost |
| No tests for backoff timing / Gio read loop | Nice-to-have | Requires GLib integration testing |
| No timeout on auth server (×2) | Low risk | Daemon thread dies with process |
| `time.sleep` synchronization in auth tests | Low flake | Would need threading events |
| `_on_token_expired` during active auth leaks resources | Edge case | Cross-story lifecycle |
| `do_activate` shows empty main UI before engine ready | Resolved | Fixed in Story 1.11 |
| `_on_auth_completed` calls `show_main()` before engine confirms session | Resolved | Fixed in Story 1.10/1.11 |
| `on_event("ready")` handler never dispatches to Application callback | Resolved | Fixed in Story 1.5 |
| Version mismatch and crash both `fatal=True` — indistinguishable | Epic 5 | Needs design decision with error UI |

---

## Original Deferred Items by Story

## Deferred from: code review of 1-1-ui-project-scaffolding (2026-04-08)

- `_on_engine_error` is `pass` — needs error display implementation (Story 5.x)
- `on_event("ready")` handler in `engine.py` `_dispatch_event` handles `ready` internally and returns before checking `_event_handlers` — Application's `_on_engine_ready` never fires (story 1-3/1-5)
- `start_auth_flow()` in Application is dead code — no call site reaches it
- `logout()` swallows `CredentialManager.delete_token()` exceptions with bare `except Exception: pass` — token may persist after UI shows logged-out state
- `_on_auth_completed` calls `show_main()` before engine confirms session via `session_ready` — user sees uninitialized main view

## Deferred from: code review of 1-3-ipc-protocol-and-socket-server (2026-04-08)

- W1: Unbounded buffer growth in `MessageReader.feed()` via slow-drip on local Unix socket — theoretical DoS, local socket only
- W2: `shutdown` command bypasses `commandHandler` — no app-level cleanup hook for future stories
- W3: `writeMessage` ignores `socket.write()` backpressure return value — acceptable for MVP volumes on local socket
- W4: `encodeMessage` can produce frames exceeding `MAX_PAYLOAD_SIZE` — no large messages in current scope
- W5: `setTimeout`-based test synchronization is fragile for CI — works for now
- W6: No test for client disconnect during async command processing — complex to test, low priority

## Deferred from: code review of 1-4-engine-spawn-and-socket-connection (2026-04-08)

- W1: `read_bytes_async` short reads may cause framing desync — Gio DataInputStream buffers for Unix sockets, low risk
- W2: Malformed JSON messages silently dropped with no logging — acceptable for MVP, add structured logging later
- W3: Synchronous `client.connect()` instead of `connect_async()` — Unix socket connect is near-instant on localhost
- W4: `EngineConnectionError` defined but never raised — dead code, may be used by future stories
- W5: No tests for backoff timing, Gio read loop, or write framing verification — requires GLib integration testing
- W6: Module-level GI mocks in test_engine.py leak across test session — works for now, revisit when test suite grows

## Deferred from: code review of stories 1-6 and 1-7 (2026-04-08)

- No timeout on auth server — daemon thread dies with process, not spec'd; consider adding for robustness later
- time.sleep synchronization in auth tests — low flake risk, would need threading events to fix properly
- on_auth_completed in main.py doesn't handle store_token failure — pre-existing code, needs try/except around credential ops

## Deferred from: code review of 1-8-pre-auth-screen-and-credential-comfort (2026-04-08)

- `_on_auth_completed` transitions to main UI even if token storage fails [window.py:121] — story 1.9/1.10 scope
- `_on_token_expired` during active auth browser leaks auth resources (no cleanup call) [main.py:96] — cross-story lifecycle issue
- `do_activate` shows empty main UI before engine ready fires [main.py:54] — story 1.11 launch routing scope
- Test `sys.modules` pollution not scoped to fixtures [test_pre_auth.py] — pre-existing pattern across all UI tests

## Deferred from: code review of 1-5-protocol-handshake-and-engine-lifecycle (2026-04-08)

- W1: `cleanup()` doesn't close connection explicitly — OS cleans up on exit; engine closes its end
- W2: `_on_engine_error` in main.py is a no-op — no error display UI yet, scoped to future story
- W3: Version mismatch and crash both `fatal=True` — indistinguishable for UI rendering, needs design decision
- W4: `_write_message` failure doesn't tear down stale connection — needs broader connection teardown strategy
- W5: `send_command` queues dict by reference — mutation risk, but internal callers create fresh dicts
- W6: `restart()` reentrancy risk if error callback triggers restart — theoretical until error display implemented

## Deferred from: code review of 1-9-embedded-webkitgtk-auth-browser (2026-04-08)

- W1: `_token_received` flag not thread-safe (concurrent `/callback` race) — single-request server makes concurrent hits near-impossible
- W2: No timeout on auth server — runs indefinitely if user abandons — daemon thread dies with process
- W3: `_on_load_changed` hides error banner on any load event including sub-resources — WebKitGTK main-frame only in practice
- W4: WebView network session not explicitly cleared after auth — `try_close()` + None triggers GC
- W5: `_on_auth_completed` calls `show_main()` before confirming token processed — sync call currently

## Deferred from: code review of 2-0-tech-debt-cleanup (2026-04-09)

- W1: AC10 — `meson test -C builddir` returns "No tests defined"; `ui/meson.build` has no `test()` declaration — pytest is the canonical UI runner. Defer to Story 2.10 (Flatpak build validation) which will wire the meson `test()` wrapper.
- W2: `debugLog` parse-error path may theoretically leak frame contents via Node `SyntaxError` message [engine/src/ipc.ts:276] — Node JSON.parse errors do not currently include payload bytes but the format is not a contract. Ratchet later if Node changes message format.
- W3: `EngineClient.restart()` reentrancy guard silently drops legitimate second restart request [engine.py:440-470] — matches AC3 explicit spec ("second call is a no-op"). Revisit after Story 2.5 stresses the restart path under real sync failures.
- W4: Unbounded `writeQueue` under sync_progress storms [engine/src/ipc.ts:236-251] — AC1 met literally ("buffer rather than drop"), but unbounded queueing trades dropped messages for OOM. Defer to Story 2.5: pick cap (length / bytes / coalesce sync_progress) with real load data instead of guessing.
- W5: `AuthWindow.show_credential_error` hardcodes "keyring" message [auth_window.py:115-117] — misleading for non-libsecret AuthErrors (encrypted-file backend, etc.). Plumbing the actual `str(exc)` would require changing `Application.on_auth_completed` return type from `bool` to `str | None` and rewriting 9 tests. Defer until encrypted-file backend tests are added in a future story, or accept the generic message as adequate.

## Deferred from: code review of 2-1-sqlite-state-database-and-schema (2026-04-09)

- sync_state table has no CRUD methods [state-db.ts] — not in story scope; will be added when sync engine story (2-5) requires it
- Prepared statements not cached as class fields [state-db.ts] — performance optimization; not a correctness issue at this stage
- change_type stored as unconstrained TEXT [state-db.ts:65] — valid change type set not yet defined (depends on sync engine story 2-5); add CHECK constraint or TS union then
- listPairs ordering by TEXT timestamp not UTC-enforced [state-db.ts:107] — caller convention; project uses ISO 8601 UTC throughout
- dequeue() silently succeeds when id not found [state-db.ts:133] — design choice; run() returns changes count if callers need verification later
- XDG_DATA_HOME not validated as absolute path [state-db.ts:86] — XDG spec requires absolute; low risk for desktop app with controlled environment
- No filesystem test for mkdir-p / XDG fallback path [state-db.test.ts] — AC5 scopes tests to :memory:; integration tests can cover later

## Deferred from: code review of 2-2-sdk-driveclient-wrapper (2026-04-10)

- `NodeWithSameNameExistsValidationError` subclass metadata (`existingNodeUid`, `availableName`, `isUnfinishedUpload`) discarded by the generic `ValidationError` branch in `mapSdkError` [engine/src/sdk.ts:128-130] — Story 2.5 sync engine needs this for rename-on-conflict and resume-unfinished-upload flows. Either extend `mapSdkError` with a dedicated subclass branch + new typed engine error subclass, or expose a richer `cause` extraction helper.
- `RateLimitedError` retry-after / backoff hint dropped on translation to `NetworkError("Rate limited")` [engine/src/sdk.ts:114-116] — spec explicitly assigns retry handling to Story 3.4. Pick up there with backoff scheduling that consults the original `cause` for the delay.
- Empty / whitespace `node.name` accepted verbatim and emitted as `RemoteFolder` [engine/src/sdk.ts:217-221] — folder picker UI in Story 2.3 should handle visual fallback (placeholder name, dimmed row); not wrapper validation responsibility.
- `iterateFolderChildren` throwing mid-stream discards partial results — current `for await ... folders.push` accumulates locally and the catch wipes them [engine/src/sdk.ts:206-224]. Intentional all-or-nothing semantics; degraded-mode partial-list browsing is out of MVP scope.
- `FileDownloader.getClaimedSizeInBytes()` is exposed by the SDK but unused by `downloadFile` [engine/src/sdk.ts:276-294] — Story 2.5 may want it for progress UI and size sanity checks before writing.
- Pre-existing `tsc --noEmit` failures: `state-db.ts:1` cannot find module `better-sqlite3`, `main.test.ts:97,144` TS2352 cast errors, `debug-log.ts:76` TS7022 implicit-any. Acknowledged in Dev Agent Record; zero new tsc errors introduced by Story 2.2. Recommend resolving before Story 2.5 starts (Story 2.5 will need state-db).
- `state-db.test.ts` cannot run because `better-sqlite3` native module is not installed in this dev env (no C toolchain — `gcc`/`make` missing). Either install build tools or migrate to `bun:sqlite` per project CLAUDE.md guidance. Should be unblocked before Story 2.5.

## Deferred from: code review of 2-4-setup-wizard-and-first-pair-creation (2026-04-10)

- Concurrent write race in `writeConfigYaml`: read-modify-write across `readConfigYaml → writeFileSync → renameSync` is not atomic under concurrent `add_pair` calls. Single-process desktop app makes this theoretical for Story 2.4 (first-pair only); revisit when multi-pair support is added in Stories 2.x (two concurrent pairs could race on the file).

## Deferred from: code review of 2-3-remote-folder-picker-component (2026-04-10)

- `handleCommand` fallback returns `${type}_result` for unknown commands [engine/src/main.ts:57-61] — pre-existing behavior from Story 1.3/1.5. With the new `_result` correlation semantics from Story 2.3, an unknown command type now returns a synthetic `_result` that fires the caller's `send_command_with_response` callback with `{error: "unknown_command"}` instead of an explicit error event. Not introduced by this story; reconsider when generic dispatch table is added (Story 2.5 may introduce one).

## Deferred from: code review of 2-2-5-sdk-live-wiring (2026-04-10)

- Proton AccessToken expires between launches — no RefreshToken flow [main.py, credential_store.py]: on relaunch `validateSession()` returns 401, `_on_token_expired` deletes the stored token, login screen is shown. Re-auth is instant (WebKitGTK server-side session persists) but requires user interaction. Fix: store the RefreshToken alongside the AccessToken, call `POST /auth/v4/refresh` silently on launch before falling back to the login screen. Pick up in a future story (candidate: new story between 2.2.5 and 2.4, or bundle with 5.x token-expiry epic).
- `encryptMessage` `compress` parameter not forwarded [sdk.ts:619,642,661,675] — `OpenPGPCryptoProxy["encryptMessage"]` interface includes `compress?: boolean` but openpgp v6 removed compression as a direct `encrypt()` parameter. No mappable openpgp v6 field confirmed. Requires drive-sdk team clarification before implementing. Pick up when adding public link support or when SDK bumps to a version that documents the compression mapping.
- `decryptMessage` redundant double-settle of signatures [sdk.ts:709] — `resolveVerificationStatus` internally calls `Promise.allSettled`; the method then calls it again for `verificationErrors`. Correct but wasteful. Pre-existing design choice; refactor when touching `decryptMessage` in a future story.

## Deferred from: code review of 2-5-sync-engine-core-two-way-sync (2026-04-10)

- Deletion propagation never implemented — remote→local and local→remote file deletions are silently skipped; tracked for Epic 4 or later [sync-engine.ts:316-319]
- Upload remoteMtime assumes SDK stores body.modificationTime exactly as provided — if SDK normalizes timestamps (truncation, timezone), every uploaded file re-uploads on next cycle; documented design tradeoff in Dev Notes; validate against live API before shipping
- walkRemoteTree unbounded recursion — no max-depth or cycle guard for circular folder references (e.g. Proton shared folders); add depth cap before enabling multi-user scenarios
- upsertSyncState uses INSERT OR REPLACE which resets rowid — add CHECK or ON CONFLICT DO UPDATE SET if sync_state gains foreign-key dependents in Epic 4
- walkLocalTree follows symlinks without restriction — symlink cycle causes infinite recursion; add `followSymlinks: false` or visited-set before supporting symlinked folder trees
- resolveRemoteId uses case-sensitive name match — Proton Drive API folder name casing may differ from user config; evaluate case-insensitive fallback before shipping
- processOne stat-after-rename susceptible to ENOENT race — external process removing destPath between rename and stat leaves file untracked, causing re-download on next cycle; acceptable for single-user desktop MVP
- Cold-start insertPair UNIQUE exception not caught if concurrent startSyncAll races — mitigated by F1 re-entrancy patch; add explicit catch if re-entrancy guard is not implemented

## Deferred from: code review of 2-6-inotify-file-watcher-and-change-detection (2026-04-11)

- Stale pairs snapshot at FileWatcher construction time — pairs added via `add_pair` after `fileWatcher` is created are not watched until next re-auth cycle; pick up when implementing watcher lifecycle refresh (Story 6-2 / future) [engine/src/main.ts:77]
- Silent non-ENOSPC failure paths — ENOENT/EACCES on `readdir` or non-ENOSPC `watchFn` errors only debugLog with no user-visible error event; pick up in Story 6-4 (local-folder-missing-detection-and-recovery) [engine/src/watcher.ts:37, 64-67]
- Overlapping `local_path` between pairs — second pair's `watchFn` calls overwrite first pair's Map entries without `close()`, leaking FSWatcher handles; mitigated by Story 6-2 (nesting-and-overlap-validation) which prevents overlapping pairs from being created [engine/src/watcher.ts:43-51]
- `_watcher_status` not reset on `token_expired` / logout — stale `"ready"` state persists across re-auth; Story 2.7 (StatusFooterBar) should reset this as part of its watcher lifecycle display logic [ui/src/protondrive/main.py:39, 137-139]
- `stateDb!` / `syncEngine!` non-null assertion risk before `main()` completes — pre-existing gap in `handleTokenRefresh`; caught silently by outer `catch` block in practice [engine/src/main.ts:77]

## Deferred from: code review of 2-7-syncpairrow-and-statusfooterbar-components (2026-04-11)

- `StatusFooterBar` LIVE region (AC5): spec requires `GTK_ACCESSIBLE_STATE_LIVE` (polite) for dynamic footer announcements; current `update_property(LABEL)` is a static update, not a live-region; GTK4 Python bindings don't cleanly expose this API at current version — revisit before Epic 7 packaging [status_footer_bar.py]
- `on_watcher_status("ready")` race — if `watcher_status: ready` and `sync_progress` arrive concurrently, footer could reset to "All synced" while sync is ongoing; unlikely in practice given engine event ordering [window.py:on_watcher_status]
- GTK widget updates from potential non-main thread — if engine fires callbacks off-thread, `set_text`/`queue_draw`/`update_property` calls are undefined behaviour; pre-existing pattern — verify engine callback thread model in EngineClient [main.py, window.py]
- `set_state` accepts arbitrary strings — invalid states like "error"/"paused" silently show green dot; internal API with controlled callers for now [sync_pair_row.py:set_state]
- `StatusFooterBar` has no error/offline/paused state — footer shows stale state on engine disconnection; covered by Epic 5 error-state stories [status_footer_bar.py]
- `populate_pairs` with empty `pair_id` — two pairs missing `pair_id` collide at key "" in `_sync_pair_rows`; engine always assigns UUIDs in practice [window.py:populate_pairs]
- `_on_wizard_complete` passes `{}` when `_cached_session_data` is None — pre-existing from story 2-4; account header bar silently receives empty strings [main.py:_on_wizard_complete]

## Deferred from: code review of 2-8-syncprogresscard-and-detail-panel (2026-04-11)

- GLib timers (pulse + sync-complete) have no `do_dispose`/`do_unroot` cancel path — callbacks fire on dead widgets if window is closed mid-timer; GTK Python pattern limitation, pre-existing [sync_progress_card.py, pair_detail_panel.py]
- `populate_pairs` row-removal loop is O(n²) — `get_row_at_index(0)` + remove in `while True` loop; pre-existing pattern [window.py:220–224]
- `_fmt_relative_time` has no days/weeks display — values over 3600s show "N hours ago" indefinitely; acceptable for MVP [pair_detail_panel.py:17–28]
- `files_done > files_total` produces fraction > 1.0; GTK silently clamps but emits GLib warning — requires engine contract guarantee before adding assert [sync_progress_card.py:52]

## Deferred from: code review of 2-9-window-state-persistence (2026-04-11)

- No validation/clamping of restored geometry values — zero or negative integers are schema-legal and would be passed directly to `set_default_size`; impacts: `window.py` init
- `close-request` signal does not persist geometry on process crash or session logout — idiomatic fix would be `g_settings_bind` or explicit `Gio.Settings.sync()`; `window.py`
- `Gio.Settings.sync()` not called before process exit — narrow but real partial-write risk on abnormal termination; `window.py:_on_close_request`
- Tiled/snapped window state saves tiled dimensions as restore size — GTK4 `is_maximized()` returns False for tiling; standard GTK4 limitation; `window.py:_on_close_request`
- Unrealized window could save 0×0 if `close-request` fires pre-`present()` — GTK4 contract prevents under normal operation but no explicit guard; `window.py`
- Re-open path (reuse of existing window object) skips maximized-state re-application — only relevant if GTK keeps window alive after hide; current flow creates fresh window; `main.py:do_activate`
- No test for `get_width()`/`get_height()` returning 0 at close time — boundary not covered; `test_window_state_persistence.py`
- No test for `Gio.Settings` write failure — `set_int`/`set_boolean` can silently fail or raise; `test_window_state_persistence.py`
- `connect` not mocked in `TestGeometryRestore._make_window` — latent `AttributeError` if future tests call `__init__`; `test_window_state_persistence.py`
