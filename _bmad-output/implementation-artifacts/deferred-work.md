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

- Deletion propagation never implemented — local→remote and remote→local file deletions are silently skipped; the engine only syncs additions and modifications. Required behaviour: if a local file is deleted and `last_synced_at` is newer than the local deletion time (i.e. the file was previously synced), trash it on Proton Drive. Conversely, if a remote file is deleted after the last sync, delete the local copy. Needs: tracking deleted-file state in `sync_state`, SDK `trashNode` call, and a conflict rule when both sides are deleted. Tracked for Epic 4 [sync-engine.ts:337-356]
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

## Deferred from: code review of 2-11-key-password-derivation (2026-04-12)

- Remote change polling not implemented — files uploaded or modified via the Proton Drive web interface (or any other client) are only detected on the next app open or when a local file change triggers a sync cycle; there is no background poll. Add a periodic `startSyncAll()` timer (e.g. every 5 minutes) or integrate the Proton Drive Events API for push-based remote change detection [engine/src/main.ts:_activateSession]
- No sync pair management UI — the user cannot create additional pairs, edit, or delete existing sync pairs from within the app once the initial setup wizard has run; the wizard only fires on first launch (no configured pairs). Needs: an "Add pair" button in the main window that re-invokes the setup wizard flow, engine `update_pair` / `remove_pair` IPC commands + SQLite CRUD, FileWatcher restart on change, config.yaml rewrite, and a UI surface (e.g. gear/context menu on each SyncPairRow) for edit and delete actions [engine/src/main.ts, engine/src/state-db.ts, ui/src/protondrive/window.py, ui/src/protondrive/main.py]
- Block upload diagnostic log left in production code — `[FETCH-BLOB] storage upload:` line written via `process.stderr.write` in `fetchBlob`; should be removed or gated behind a debug flag before shipping [engine/src/sdk.ts:fetchBlob]
- `_sanitizeOpenpgpConfig` strips `ignoreSEIPDv2FeatureFlag` globally — if a future openpgp upgrade reintroduces this flag, the strip will silently no-op; add a comment with the openpgp version that dropped it so the workaround can be removed when safe [engine/src/sdk.ts:_sanitizeOpenpgpConfig]
- One user private key failed to decrypt (`decrypted 1/2 user keys`) — engine continues with partial key set; no user-visible warning is shown; if the undecrypted key is needed for a future file, the operation will fail silently [engine/src/sdk.ts:_activateSession]

## Deferred from: code review of 2-10-flatpak-build-validation (2026-04-11)

- Double `GLib.timeout_add` in `engine.py` `start()` — two concurrent `_attempt_connection` callbacks fire, potentially double-counting `_elapsed_ms` and causing premature timeout or concurrent socket connections [ui/src/protondrive/engine.py:147-155]
- Bun binary path not validated before `spawnv` — `get_engine_path()` returns `tuple[str, ...]`; `engine_argv[-1]` (script or compiled binary) is checked via `isfile`, but the `bun` binary itself (first element in dev 2-tuple) is not verified to be executable; a missing or broken Bun produces a generic `GLib.Error` with no root-cause hint [ui/src/protondrive/engine.py:28-34] *(updated from Node-specific wording post-3-0a migration)*

## Deferred from: smoke test of 3-0a-bun-runtime-migration (2026-04-14)

- Key password popup appears twice after WebKit MFA — after successful CAPTCHA/2FA, the "enter your Proton account password to decrypt PGP keys" popup fires twice, requiring the user to enter their password twice. Root cause: the WebKit auth cookie detector fires multiple token candidates; multiple `token_refresh` cycles both succeed and both call `handleUnlockKeys`; each generates a `session_ready` event; the UI presents the key-password dialog once per `session_ready`. Fix options: (a) UI deduplication — if the key-password dialog is already open or was already answered in this session, suppress subsequent `session_ready` triggers; (b) engine deduplication — once keys are successfully loaded in memory, skip `handleUnlockKeys` on subsequent `token_refresh` calls until session is invalidated. Neither option was in scope for 3-0a (migration-only story). Candidate fix: Story 3-0b or a dedicated UX polish story. Not a regression from the Bun migration itself — the auth token loop predates this story; however this was the first time the full re-auth + key-unlock path was exercised end-to-end in Flatpak.


## Deferred from: code review of 3-0a-bun-runtime-migration (2026-04-14)

- Flatpak build env lacks `bun` binary for `bun install` / `bun build --compile` steps — the Flatpak manifest (Group D) must install or bundle Bun before the engine build steps run; otherwise the build fails with command-not-found. To be verified during Group D review of `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`.

## Deferred from: code review of 3-0a-bun-runtime-migration Group C (2026-04-14)

- `expect(!expr).toBeTruthy()` / `expect(x >= N).toBeTruthy()` patterns in test files give opaque failure messages — pre-existing from original `assert.ok()`. Improve to `.not.toContain()`, `.toBeGreaterThanOrEqual()`, etc. Affects `sdk.test.ts` (highest density), `watcher.test.ts`, `sync-engine.test.ts`.
- `expect(true).toBe(false)` sentinel pattern in `sdk.test.ts` try/catch blocks — replace with `throw new Error("unreachable")` for better diagnostics. Pre-existing pattern.
- Timing-dependent tests in `watcher.test.ts` using hard-coded `setTimeout(r, 100)` for 50 ms debounce — fragile under slow CI. Replace with deterministic signaling. Pre-existing pattern.

## Deferred from: code review of 3-0a-bun-runtime-migration Group D (2026-04-14)

- Flatpak: `bun` binary not in `org.gnome.Sdk` build sandbox — builds work locally because flatpak-builder inherits the host PATH when `--share=network` is set, but this will break for any CI or contributor machine that builds Flatpak. Fix: add a `type: file` source that downloads a pinned Bun binary into the build sandbox, or document the prerequisite explicitly. Note: Flathub would require an offline-sources approach anyway.
- `bun build --compile` in Flatpak manifest has no `--target` flag — produces a native-arch binary only. x86_64 is the only supported arch for now; add `--target=bun-linux-x64` when multi-arch support is added.
- `get_engine_path()` return type `tuple[str, ...]` is less precise than `tuple[str] | tuple[str, str]`; both are functionally equivalent but the more precise union type gives better type-checker enforcement.


## Deferred from: code review of 3-0b-targeted-debt-fixes (2026-04-14)

- **W1** — Migration runner lacks null guard on PRAGMA user_version result (`engine/src/state-db.ts:128`): `this.db.query("PRAGMA user_version").get()` is cast directly without a null check. SQLite guarantees this PRAGMA always returns a row, so in practice this is safe. Defensive improvement: add `if (!row) throw new Error(...)` before accessing `.user_version`. Pre-existing pattern.
- **W2** — `onChangesDetected` reject handler casts non-Error rejections to Error (`engine/src/watcher.ts:84`): `.catch((e) => debugLog(\`...: ${(e as Error).message}\`))` — if `onChangesDetected` rejects with a non-Error value (string, null, etc.), `.message` returns `undefined` and the actual error value is lost. Fix: use `String(e)` or `e instanceof Error ? e.message : String(e)`. Pre-existing; watcher.ts is out of scope for 3-0b.
- **W3** — `object.__new__(Application)` pattern in test_main.py is fragile (`ui/tests/test_main.py:23`): bypasses `Application.__init__` entirely and manually sets attributes. If `_on_token_expired` or `logout` are refactored to access new attributes, tests will fail with AttributeError instead of a meaningful assertion error. Established project pattern for GTK-bypass testing; accepted as-is for now.

## Deferred from: code review of 3-2-offline-change-queue-persistent (2026-04-14)

- TOCTOU race: `existsSync` called after rename event — file state may have changed before stat; fundamental Linux inotify limitation; `change_type` may be wrong for rapid create-then-delete or delete-then-recreate sequences [engine/src/watcher.ts:89]
- Online→offline transition during active debounce window — if a sync was scheduled while online and the debounce timer fires after going offline, `scheduleSync` triggers against an offline connection; Story 3-3 queue replay will reduce impact [engine/src/watcher.ts:52-56]
- Cross-pair symlink aliasing — if two pairs have directories linked by symlinks, inotify events could be attributed to the wrong pair_id; pre-existing architectural gap; mitigated by Story 6-2 (nesting/overlap validation) [engine/src/watcher.ts:setupPairWatches]
- `local_path` trailing-slash storage convention unspecified — `state-db.ts` has no normalization on insert; if a path is stored with trailing slash, `relPath` string-slice in `queueFileChange` will skip one character even after F2 (path.relative) fix; enforce no-trailing-slash invariant at `insertPair` time in a future story [engine/src/state-db.ts]

## Deferred from: code review of 3-1-offline-detection-and-ui-indicators (2026-04-14)

- **W1** — `on_online()` resets "syncing" rows to "synced" (`ui/src/protondrive/window.py:287`): per spec, "Returning to 'synced' is the correct safe default — engine immediately pushes `sync_progress`/`sync_complete` to correct state within seconds." No action needed unless UX testing shows the flash is jarring.
- **W2** — `get_status` snapshot races with push event (`engine/src/main.ts:555` + `ui/src/protondrive/main.py:283`): if a push `offline` event arrives between `get_status` dispatch and `_on_get_status_result` processing, UI calls `on_offline()` twice. Idempotent; low practical impact. Story 3-3 queue replay will improve resilience.
- **W3** — `defaultOnlineCheck` internal 3-s timer/socket not cancellable by `NetworkMonitor.stop()` (`engine/src/network-monitor.ts:4-21`): `stop()` clears `NetworkMonitor.timer` but the TCP socket and its local `setTimeout` inside `defaultOnlineCheck` run to completion (≤3s). Acceptable for current scope; revisit if engine shutdown latency becomes an issue.
- **W4** — `_pairs_data` relative timestamps go stale during long offline periods (`ui/src/protondrive/window.py:282`): `last_synced_text` is computed at `populate_pairs()` time. After a long offline period, the displayed "Offline · 5m ago" will be wrong on the next offline transition. Corrected on next `sync_complete` event.
- **W5** — `_setNetworkMonitorForTests` doesn't stop previous monitor before replacing (`engine/src/main.ts:196`): if a test sets a monitor, starts it, then calls `_setNetworkMonitorForTests` again without stopping the first, the old timer leaks. Tests are responsible for calling `monitor.stop()` in `afterEach`; this is the established project pattern.
- **W6** — Test "emits online after offline" first-monitor block is dead code (`engine/src/network-monitor.test.ts:40-50`): the first monitor is started, verified offline, and stopped — but this duplicates the "emits offline immediately" test. The actual scenario (offline→online transition) is in `monitor2`. Low severity cleanup opportunity.

## Deferred from: code review of 3-4-rate-limit-handling-and-ui (2026-04-17)

- Unreachable `throw new SyncError("withBackoff: exhausted retries")` at bottom of `withBackoff()` [engine/src/sync-engine.ts] — loop always returns or throws before reaching it; added to satisfy TypeScript's control-flow analysis. Could be replaced with a `/* c8 ignore next */` pragma or removed once TypeScript narrows the exhaustive case.
- Non-numeric `resume_in_seconds` guard in `on_rate_limited` [ui/src/protondrive/window.py:353-354] — `or 0` guards None, but a string or object value would raise TypeError when compared `> 0`; trusted internal engine→UI boundary makes this effectively unreachable; a `isinstance(resume_in, (int, float))` guard would make it robust to engine bugs.

---

## Cross-Epic Tech Debt — Story 2-12: Unified Queue Drainer Refactor

**Identified:** 2026-04-15 during Story 3-3 party-mode review
**Status:** Tracked as `2-12-unified-queue-drainer-refactor: backlog` in sprint-status.yaml
**Story file:** `_bmad-output/implementation-artifacts/2-12-unified-queue-drainer-refactor.md`
**Precursor:** Story 3-3 (must be done first)
**Scope estimate:** 3.5–5.5 days (2–3× typical story size)
**Epic 2 status:** stays `done`; 2-12 is cross-epic tech debt discovered after Epic 2's retrospective shipped (2026-04-12), and will carry its own standalone retrospective.

### The insight (Jeremy, during 3-3 review)

> *"Why don't you put file updates in the same queue instead of a new process?"*

The observation: the current engine has **two sync pathways** — `startSyncAll()` (tree-walk-driven) and `replayQueue()` (queue-driven, new in Story 3-3). They race in concurrency edge cases, duplicate conflict-detection logic, and double the test surface. Collapsing them into **one queue with multiple producers and one consumer** eliminates the race by construction, unifies Story 5-3's re-auth replay path with Story 3-3's reconnect replay path, and halves the test surface.

### Winston's architectural model — 3 producers, 1 consumer

- **Producer A — `FileWatcher`:** always enqueues to `change_queue` (offline OR online). Story 3-2 implemented the offline path; 2-12 extends to always-enqueue.
- **Producer B — Reconciliation walker:** runs on cold start and periodically, walks local + remote trees, diffs against `sync_state`, enqueues any deltas. Replaces `startSyncAll`'s discovery phase as a clean, named concept.
- **Producer C — Remote change detector** (future Epic 5 work, out of scope for 2-12): polls SDK events or periodic remote walk, enqueues remote-side deltas.
- **Single consumer — `drainQueue()`:** processes `change_queue` entries sequentially. Offline = paused. Online = draining. Single `isDraining` boolean lock replaces Story 3-3's `busy` enum.

### Why this collapses bugs

1. **Eliminates Story 3-3 C1 entirely.** One worker = no race. The `busy` enum shrinks to a single boolean.
2. **Unifies Story 5-3.** Post-2-12, re-auth replay is just another call to `drainQueue()` — same method the watcher and network monitor use.
3. **Halves test surface.** Testing today requires seeding `sync_state` + faking tree walks + mocking SDK. Testing `drainQueue()` requires seeding `change_queue` rows and calling `drain()`.
4. **Makes missed-events recovery explicit.** Reconciliation walker is named and documented, not a side-effect of opportunistic tree-walks.

### Mary's cross-epic pattern observation

> *"If I'd spotted this in Epic 2 planning, Story 2-5 would have looked completely different. The pattern also predicts Epic 5 will hit the exact same issues when Story 5-3 reuses replayQueue — race with initial sync, conflict-pending carry-over, etc."*

### Barry's pragmatic framing

> *"Ship 3-3 as planned. Then open 2-12. Refactor with full context. The refactor is better-informed after 3-3 ships because you'll have learned exactly where replayQueue feels awkward next to startSyncAll, and those specific pain points will shape the unification better than any upfront design."*

### Why 2-12 is NOT in Story 3-3

1. **Story 2-5 is done and tested** — recent fixes (upload block, download hang, subfolders, empty dirs, last-synced persistence) are at risk from a core refactor under Epic 3 pressure.
2. **3-3 is unblocked and ready** — shipping it unblocks Epic 3 and provides real replay behaviour observable in production before refactoring.
3. **Refactor is better-informed post-3-3** — pain points from running the split architecture in production will shape the unification.
4. **Scope exceeds typical story** (3.5–5.5 days) — needs its own focused sprint slot and regression-test budget.

### Implementation hints when picked up

Story 3-3's `replayQueue()` is **intentionally shaped as the seed** of the future `drainQueue()`. It is:
- Sequential per entry (not Promise.all batched)
- Idempotent per entry (upsert + dequeue atomic)
- Re-entrancy-safe via `busy` enum + `replayPending`
- Fully self-contained per entry (no cross-entry state beyond the `remoteFiles` snapshot)

When 2-12 is activated, run `bmad-create-story` against the **codebase at that time** to refresh the ACs and implementation plan. The ACs in `2-12-unified-queue-drainer-refactor.md` are starter scaffolding, not final specs.

### Retrospective intent

When 2-12 ships, run a **standalone mini-retrospective** in the story file. Do NOT fold into any epic retrospective. The learnings are refactor-flavoured (test migration, regression safety, "designed-for-future-unification" dev notes' real-world value) and don't align with any single epic's user-facing theme.

---

## Deferred from: code review of 3-3-queue-replay-and-auto-resume-on-reconnect (2026-04-16)

- Boot-time drain when engine restarts with pre-existing queue entries and network already online — no `online` transition fires, queue sits idle. Explicitly deferred to Story 5-3 per 3-3 spec.
- No coordination between in-flight `replayQueue` and `token_refresh` / `SIGTERM` handlers — pre-existing shutdown / token-rotation pattern, not unique to 3-3.
- UI `_conflict_pending_count` not persisted across UI restart — footer may flash "All synced" despite queue having real conflicts; no persistence mechanism in this story's scope.
- Test 4.11 (per-entry failure isolation) doesn't assert `queue_replay_complete` payload nor AC6a emission ordering under partial failure — test gap, not a functional bug.
- No state-cycle tests for StatusFooterBar (conflict → syncing → conflict, etc.) — CSS-class drift during unusual transitions is not exercised.
- `queue_replay_complete` payload omits `failed` count — per AC6 contract the shape is `{synced, skipped_conflicts}`, but pure-failure replays give the user no toast/footer signal. Worth a product call during Epic 5.
- Orphan queue entries if a pair is deleted with FK cascade disabled — relies on `ON DELETE CASCADE` being in place; no defensive guard.
- Upload OK but subsequent `upsertSyncState` hits `SQLITE_BUSY` from concurrent watcher write — currently counted as `failed` despite remote success; retry logic is pre-existing gap.
- `on_sync_progress` has no `_conflict_pending_count` regression guard — syncing temporarily overrides amber, as documented in 3-3 Dev Notes Regression Risk #2.
- New folder created by one upload mid-replay isn't retrievable by subsequent entries in the same pair (stale `remoteFolders` map) — routed to `failed`, next replay resolves. Same root cause as the in-loop `remoteFiles` patch.
- `on_online` force-resets active `syncing` rows to `synced` — pre-existing Story 3-1 behaviour, not introduced by 3-3.

---

## WebKit aarch64 JIT Instability — Dev Environment Only

**Discovered:** 2026-04-16 during embedded auth flow testing on Fedora 43 aarch64 VM (party-mode session with Winston/Amelia/Quinn).
**Status:** Known dev-environment limitation. **Zero production impact** — confirmed target is x86_64.
**Action:** No fix planned. Document, work around in dev, revisit only if ARM Linux is ever promoted to a supported target.

### Symptom

`WebKitWebProcess` (the renderer subprocess of the embedded auth WebView in `ui/src/protondrive/auth_window.py`) crashes intermittently during the Proton sign-in flow — sometimes before the user enters the password, sometimes during MFA, sometimes mid-typing. From the user's perspective the auth window appears to "freeze" because the GTK4 Python parent process stays alive while the renderer dies, leaving a frozen WebView rectangle on screen.

### Evidence

- **17 coredumps in a single day** on the Fedora aarch64 VM (`coredumpctl list --since=today`):
  - Mix of `SIGSEGV` (8), `SIGABRT` (8), `SIGTRAP` (1)
  - All from `/usr/libexec/webkitgtk-6.0/WebKitWebProcess`, sizes ~22–30 MB
- **Stack traces consistently land inside JavaScriptCore JIT'd code:**
  - Crash signature: frame at offset `+0x1a8940` in `libjavascriptcoregtk-6.0.so.1.7.10` (the JIT entry trampoline)
  - 10–20 frames above it in *anonymous executable memory* (the JIT code heap)
  - Bottom of stack: libc `abort`/`raise`
- **Runtime:** `org.gnome.Platform/aarch64/50` ships `libwebkitgtk-6.0.so.4.16.6`; binaries compiled without build-ids, so symbolicated backtraces are unavailable.
- **VM has broken GPU passthrough** (irrelevant to the JIT crash itself but contributes to general instability):
  ```
  libEGL warning: failed to get driver name for fd -1
  MESA: error: ZINK: failed to choose pdev
  libEGL warning: egl: failed to create dri2 screen
  ```

### What we ruled out

- **OOM/memory pressure:** `dmesg` empty for OOM; `free -h` showed 4 GiB available, swap untouched (1 MiB of 5.8 GiB used). The earlier 2 GB VM RAM bump was a coincidence — it changed timing enough that crashes became less frequent in casual testing, but did not address the root cause. *We chased the wrong ghost for one round.*
- **Our code:** crash is entirely inside `libjavascriptcoregtk` and JIT'd JS pages — no frames in `auth_window.py` or in the engine.
- **Host-level / VM-level instability:** the VM stayed responsive throughout (load average ~0.3); only the renderer subprocess died.

### What didn't work

- **`JSC_useJIT=0`** — broke app startup entirely. Confirmed via `flatpak override --user --env=JSC_useJIT=0`: the app fails to launch. Cause: `JSC_*` debug env vars are stripped from release WebKitGTK builds in the GNOME runtime. There is **no public WebKitGTK 6.0 API** to disable the JIT at runtime; it is a build-time choice made upstream.

### What partially helped (but did not prevent crashes)

```bash
flatpak override --user \
  --env=WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  --env=LIBGL_ALWAYS_SOFTWARE=1 \
  io.github.ronki2304.ProtonDriveLinuxClient
```

This combo silenced the EGL/Mesa errors and let the auth flow reach the MFA stage at least once before crashing again. Currently retained in the user's flatpak override as the dev-VM baseline.

### Why this is dev-only

The crash signature is **JavaScriptCore JIT codegen on aarch64** — well-known instability surface for WebKitGTK on ARM64, particularly under VM environments with broken GPU passthrough. The same WebKit + Proton login flow runs without these crashes on x86_64 desktops (anecdotal: confirmed during prior story testing in Stories 1-9, 2-2-5, 2-11). Production audience is x86_64 desktops → no shipped users hit this.

### Future paths if ARM Linux ever becomes a real target

Two options surfaced during the party-mode discussion. Neither is scheduled work.

- **Path A — Dev-mode token bypass** (small, ~30 lines, dev-only):
  Add `PROTONDRIVE_DEV_TOKEN_FILE=~/.protondrive-dev-token` env support in the engine and UI to skip the embedded auth entirely when a token file is present. Lets developers exercise sync engine / queue / UI work on aarch64 without ever opening WebKit. Token captured once on x86_64 (or between aarch64 crashes) and reused. Would NOT ship to users.
- **Path B — System-browser auth** (real user-facing feature, ~1 story-week):
  Replace the embedded `WebKit.WebView` with `Gio.AppInfo.launch_default_for_uri()` — open Proton's auth URL in the user's system browser, let the existing localhost callback (`http://127.0.0.1:44925/callback` from Story 1-7) catch the redirect. Eliminates the entire WebKit dependency for auth. Trade-off: must rework the JS-injected `protonCapture` password capture in `auth_window.py:100` (probably by handling SRP key derivation engine-side or by capturing salts via callback URL params). Proton's official desktop apps actually use this pattern. Would benefit hardware-key 2FA and password-manager autofill UX as a side effect.

If Path B is ever picked up, it becomes its own epic ("Alternative Auth Flow & ARM Linux Support") — at which point this deferred entry should be migrated into that epic's discovery section.

### Workaround for the developer (you, today)

Live with intermittent renderer crashes during auth-flow testing on the aarch64 VM. Keep the two graphics env vars in the flatpak override. When auth-flow work is actively painful, revisit Path A as a small dev-quality story.



## Deferred from: code review of 2-12-unified-queue-drainer-refactor (2026-04-17)

- **remote_id resolved in-memory but not persisted to SQLite** — reconcilePair() resolves an empty remote_id via resolveRemoteId() and stores it in a local variable, but never writes the resolved value back to the DB. Every cold start re-resolves remote_id. Pre-existing pattern from deleted syncPair(); not a regression.
- **drainQueue() return value discarded at watcher call sites** — watcher-triggered drainQueue() calls use `void`, so synced/failed counts are never surfaced to any observability layer for those code paths. Pre-existing pattern (same as old `void replayQueue()`). Consider logging or emitting counts in a follow-on observability story.


## Deferred from: code review of 4-0b-deletion-propagation (2026-04-17)

- **W1** — Unbounded retry on persistent `delete_local` failures (EPERM/EACCES): `sync_state` is preserved on non-ENOENT errors so next cycle retries, but there is no retry counter or dead-letter mechanism — a permanently unreadable file will retry forever. Established engine pattern; no bounding mechanism exists yet.
- **W2** — Local file modified + remote deleted → `delete_local` silently discards unsaved edits: `computeWorkList` does not compare `state.local_mtime` vs current `local.mtime` before pushing `delete_local`. A local edit after the last sync + a remote deletion in the same cycle will destroy the user's local changes without surfacing a conflict. Epic 4 conflict-detection scope (stories 4-1+).
- **W3** — `unlink` on directory path (EISDIR): if a directory path appears in `sync_state` (abnormal DB state), `unlink` fails with EISDIR, the error handler catches it as non-ENOENT, emits `sync_file_error`, and retries forever. Requires abnormal state to trigger; low practical risk.
- **W4** — `deleteSyncState` DB throw after successful I/O: `unlink` or `trashNode` succeeds but the subsequent `this.stateDb.deleteSyncState()` call has no try/catch — an uncaught DB exception propagates out of `reconcilePair`, aborting remaining work items. Pre-existing pattern across all DB calls in engine.
- **W5** — `trashNode` network failure doesn't trigger `onNetworkFailure` offline transition: a fetch/network error on `trashNode` is caught and emitted as `sync_cycle_error` but `this.onNetworkFailure()` is never called. Pre-existing architectural gap; same gap exists in other network-calling paths.
- **W6** — `sync_complete` emitted even when deletion items partially failed: `reconcilePair` always falls through to `sync_complete` regardless of `delete_local`/`trash_remote` error count. Pre-existing engine behavior — `sync_complete` means "cycle finished", not "cycle succeeded".
- **W7** — Local file modified between scan and `delete_local` execution: if a local file is written after `computeWorkList` captures `localFiles` but before `unlink` runs, the new write is silently deleted. Pre-existing race condition inherent to non-transactional FS + DB coupling; single-user desktop risk is low.

## Deferred from: code review of 4-1-conflict-detection-existing-files (2026-04-17)

- **trash_remote atomicity** — `trashNode` resolves (appears successful) but server may not have completed the operation (network cut post-ACK, eventual consistency); `sync_state` is deleted immediately on resolve with no idempotency guard. Pre-existing distributed-systems pattern across all engine I/O (uploads, downloads follow the same pattern). `engine/src/sync-engine.ts`
- **Re-download while local deletion pending in change_queue** — if a remote-only file triggers a download in `computeWorkList` but a `delete` change for the same path is already queued in `change_queue` and hasn't drained yet, the file gets re-downloaded before the queue processes the deletion. Pre-existing queue/sync-cycle architectural gap. `engine/src/sync-engine.ts`
- **`clear_state` for paths with pending queue entries** — `clear_state` WorkItem emitted for paths absent from both local and remote, but if `change_queue` has a pending entry for that path (e.g., queued upload for a file deleted before it synced), the queue entry is orphaned: `sync_state` is gone so `processQueueEntry` hits an unexpected code path on the next drain. Pre-existing queue/sync-cycle architectural gap. `engine/src/sync-engine.ts`

## Deferred from: code review of 4-2-new-file-collision-detection (2026-04-17)

- **`conflict` WorkItem only logs** — Story 4-3 handles copy creation and `conflict_detected` emission for the existing-file conflict case. The `conflictItems` loop in `reconcilePair` is intentionally stub-only. `engine/src/sync-engine.ts`
- **Rename success + download failure → orphaned conflict copy** — if `downloadOne` throws after `rename()` succeeds, the original file is at `<path>.conflict-date` and no `sync_state` exists. Next cycle recovers correctly (re-downloads remote, uploads conflict copy as new file). Documented in Dev Notes §13 as accepted MVP failure-mode. `engine/src/sync-engine.ts`
- **Same-day conflict copy path overwrites prior copy** — `rename()` atomically replaces `<path>.conflict-YYYY-MM-DD` if it already exists from an earlier same-day collision. First conflict copy is silently destroyed. Explicitly deferred in Dev Notes §12 as known MVP limitation. `engine/src/sync-engine.ts`
- **`new_file_collision` and `delete_local` + pending change_queue orphan** — if a local file has a pending `change_queue` entry when a collision or remote deletion is processed, the queue entry is never dequeued and may trigger spurious upload/conflict on next `drainQueue` pass. Pre-existing queue/sync-cycle architectural gap, same class as items deferred from 4-1 review. `engine/src/sync-engine.ts`
- **`hashLocalFile` partial-read race with active writer** — `createReadStream` on a file being actively written may read partial content without error, producing a hash of incomplete data. Conservative path (null hash → isConflict) protects against false "unchanged" but not false "conflict". `engine/src/sync-engine.ts`
- **`stat(destPath)` after collision download may record coarse mtime** — on ext4/btrfs with 1-second mtime resolution, the mtime stored in `upsertSyncState` after a collision download may not round-trip correctly, causing spurious `localChanged` on next cycle. Pre-existing pattern identical to the regular download path. `engine/src/sync-engine.ts`

## Deferred from: code review of 4-4-in-app-conflict-notification-and-pair-status (2026-04-17)

- Upload `commitUpload` records `local_mtime` as `remote_mtime` — pre-existing; if server assigns a different mtime, hash-verified record may trigger spurious conflict on next cycle [`engine/src/sync-engine.ts`]
- `newFileCollisionItems` loop uses `rename()` directly; raises EXDEV on cross-filesystem pairs — pre-existing; error caught and `sync_file_error` emitted, pair re-attempts next cycle [`engine/src/sync-engine.ts`]
- `upsertSyncState` not atomic with preceding `hashLocalFile` — pre-existing pattern; crash between hash compute and DB write causes re-sync on restart, not data loss [`engine/src/sync-engine.ts`]
- User-moved conflict copy treated as resolved by `os.path.exists` check — design choice per Dev Notes §4; spec intent is "user deletes"; moving is an edge case with no spec guidance [`ui/src/protondrive/window.py`]
- `_get_pair_name` returns `pair_id` as fallback for root-path local folders (`/`) — pre-existing minor edge case; `os.path.basename("") == ""` → falls back to `pair_id` [`ui/src/protondrive/window.py`]

## Deferred from: code review of 4-3-conflict-copy-creation (2026-04-17)

- `stat()`/`hashLocalFile()` failure after successful download skips `upsertSyncState` — file is re-synced on next cycle; pre-existing pattern in `newFileCollisionItems` loop [`engine/src/sync-engine.ts`]
- `hashLocalFile()` doesn't distinguish ENOENT vs EACCES on read failure — pre-existing, not introduced by this story [`engine/src/sync-engine.ts`]
- Same-day conflict copy overwrite — documented in Dev Notes §14 as known MVP limitation; `rename()` atomically replaces earlier conflict copy if two conflicts occur same calendar day [`engine/src/sync-engine.ts`]
- Error handling style differs between `conflictItems` and `newFileCollisionItems` loops — different design intent (copy+download vs rename+download); not a bug [`engine/src/sync-engine.ts`]
- Date formatting duplicated in two loop sites — minor code smell, extract to helper if both sites diverge [`engine/src/sync-engine.ts`]
- Failure test doesn't verify tmp file cleanup — directory EACCES prevents `copyFile` from creating `tmpPath` at all; nothing to clean up in the chmod test scenario [`engine/src/sync-engine.test.ts`]
- Local file deleted between conflict detection and `copyFile` — ENOENT caught, `sync_file_error` emitted, `continue`; correct per AC5 [`engine/src/sync-engine.ts`]
- `conflict_detected` emitted before `downloadOne`; no rollback event if download subsequently fails — design choice per spec; conflict copy preserved so user data is safe; UI inconsistency is minor [`engine/src/sync-engine.ts`]
- `copyFile` fails mid-write, `unlink(tmpPath)` silently fails — best-effort cleanup; zombie tmp file leaves no DB reference and is bounded in size [`engine/src/sync-engine.ts`]
- `Date.now()` collision producing identical `tmpPath` names under concurrent sync cycles — blocked by `isDraining` guard; theoretical only [`engine/src/sync-engine.ts`]
- AC6 download-failure-after-copy path has no explicit test — not required by AC9; conflict copy preserves user data, sync_file_error emitted; low test gap [`engine/src/sync-engine.test.ts`]

## Deferred from: code review of 4-5-desktop-notification-for-conflicts (2026-04-18)

- Post-activation pair selection lost if window destroyed before notification click [main.py:_on_show_conflict_pair] — `activate()` is async; `if self._window is not None` guard fires before window is ready, so `select_pair` is skipped. Edge case: user closes window then clicks a queued desktop notification. Window re-opens but pair not pre-selected. Canonical GTK two-check pattern; no MVP fix needed.
- Silent early return on missing pair_id in `_send_conflict_notification` [main.py] — matches existing codebase no-debug-logging style; complicates diagnosing silent notification failures. Not a bug.
- `set_conflict_state(pair_id, 0, name)` in `select_pair` when no active conflicts [window.py] — mirrors `_on_row_activated` identical path; behavior relies on `set_conflict_state(…, 0, …)` correctly hiding the banner; not explicitly tested for notification-click zero-conflict case. Pre-existing in Story 4-4.

## Deferred from: code review of 4-0-pre-epic-4-debt-cleanup (2026-04-17)

- **No test covering non-None captured credentials** — `test_auth_completion.py` assertions for `send_token_refresh` only verify the `None` case for `login_password` and `captured_salts`. A bug that ignores actual credential values (passing empty string or wrong structure) would go undetected. Add a test variant with real non-None values once credential forwarding is exercised.
- **`_LoadEventVal.value_nick` uses lowercase vs production enum behavior** — `conftest.py` sets `COMMITTED = _LoadEventVal("committed")` (lowercase) while the old mock used `"COMMITTED"` (uppercase). If any production code compares `event.value_nick` by case-sensitive string, this will silently fail in tests. Verify `auth_window.py` never does string-equality on `value_nick`.
- **`_make_window()` missing `_completed = False` initialization** — The test fixture in `test_auth_window.py` does not set `_completed`. If any test invokes code paths that read `self._completed` (e.g., `_poll_for_auth_cookie`), the result is AttributeError or silent wrong-path behavior. Low risk today but will bite if polling tests are added.


## Deferred from: code review of 4-6-conflict-log-and-reveal-in-files (2026-04-18)

- **`_conflict_log_entries` unbounded growth** — resolved entries are never evicted from the list until logout (`clear_session`). On long sessions with many sync cycles the list grows without bound. The `set_entries` clear loop is O(n²) which compounds this. Acceptable for v1; consider a rolling cap (e.g., max 200 entries, dropping oldest resolved) in a later story.
- **Hardcoded amber hex `#f0a020` in Pango markup** — the unresolved row title uses `<span color="#f0a020">` which does not adapt to dark/high-contrast themes. The CSS class `.conflict-warning-icon` handles the icon prefix but not the title text. Cosmetic; spec says "amber" without requiring CSS-adaptive implementation. Revisit when theming is addressed.
- **Date regex accepts invalid calendar dates** — `r'\.conflict-(\d{4}-\d{2}-\d{2})$'` matches sequences like `2026-13-45`. Deferred because the engine invariant guarantees valid ISO dates in conflict copy suffixes; validation in the UI layer would be over-engineering.
- **Symlink conflict copy path** — `os.path.dirname()` returns the symlink's parent directory, not the symlink target's parent. Deferred because conflict copies are real files created by the engine (not symlinks); this case is theoretical in normal operation.
