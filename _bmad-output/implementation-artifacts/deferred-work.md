# Deferred Work

## Infrastructure — Meson wrapper loop bug (documented Epic 5 retrospective 2026-04-19)

**Root cause:** `~/.local/bin/meson` is a distrobox-generated wrapper that enters the LinuxProtonDrive container and calls `/usr/local/bin/meson`. That inner script is a **malformed heredoc artifact** — it starts with leading spaces (invalid shebang), then contains the lines `#!/bin/sh`, `exec /usr/bin/meson "$@"`, `EOF`, and `chmod +x /usr/local/bin/meson` as literal text. The kernel rejects the malformed shebang; the shell falls back to line-by-line execution; the `EOF` token triggers a heredoc-input wait — **an infinite hang** from the Claude Code sandbox.

**Workaround (in use since Epic 2):** Call `/usr/bin/meson` directly via distrobox — documented in `project-context.md` "Meson invocation from Claude Code sandbox" section.

**Status:** Workaround is sufficient for all current dev work. Root fix would be regenerating the wrapper via distrobox, but this requires Jeremy's terminal and is low priority. **Do not attempt to fix `/usr/local/bin/meson` from the Claude Code sandbox** — the container path is not writable from the Bash tool.

**Impact:** Only affects Claude Code Bash tool invocations. User's own terminal is unaffected.

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

---

## Open — UI State & Multi-Pair

- **[6-4 D2]** DB write succeeds / config.yaml write fails → state inconsistency — all three mutating commands (`add_pair`, `remove_pair`, `update_pair_path`) write DB first, config.yaml second with no rollback. Pre-existing architectural pattern; requires a transactional write strategy or DB-as-canonical-truth approach. `engine/src/main.ts`, `engine/src/config.ts`
- **[6-0d CR W1]** `_error_pair_ids` and `_error_messages` not reset in `populate_pairs` — stale error IDs could collide with new pair IDs after re-login. Pre-existing structural gap; `clear_session()` normally prevents this. `ui/src/protondrive/window.py:391-403`
- **[6-0d CR W2]** Stale banner title persists on hide — `error_banner.set_title()` not called in the `set_error_state(False)` branch; invisible but potentially surfaced by screen readers. Harmless in current code paths. `ui/src/protondrive/widgets/pair_detail_panel.py`
- **[6-0d CR W3]** Early `on_pair_error` message silently dropped before `populate_pairs` — the `row is None` guard returns before `_error_messages[pair_id]` is set. Pre-existing behavior consistent with all other event-drop logic. `ui/src/protondrive/window.py:540-543`
- **[6-0c CR D2]** Missing test: multiple pairs in mixed error/conflict/synced states simultaneously — footer priority logic (error > conflict > synced) implemented but not multi-state tested. `ui/tests/test_window_routing.py`
- **[6-0c CR D3]** Missing test: rapid session-ready → token-expired sequence. `ui/tests/test_window_routing.py`
- **[6-1 CR D1]** `_update_add_button` not wired to remote path changes — button sensitivity not re-evaluated if user changes the remote path after local folder selection. Edge case: root "/" local path → button stays insensitive even after valid remote path typed. Requires `path-changed` signal on `RemoteFolderPicker`. `ui/src/protondrive/widgets/add_pair_dialog.py`
- **[6-1 PM D1]** Spinner show/hide in `_on_add_pair_clicked` not covered by unit tests. `ui/tests/test_add_pair_dialog.py`

---

## Open — Engine Correctness & Safety

- **[6-0a CR D1]** / **[6-0x CR W2]** Silent depth cap for deep remote trees — `walkRemoteTree` returns empty maps with only a `debugLog` at depth >= 50. Indistinguishable from an empty remote folder; could cause engine to interpret deep remote files as deleted and propagate deletions locally. `engine/src/sync-engine.ts:1109`
- **[6-0a CR D2]** `walkLocalTree` stat() race silently skips files — file deleted between `readdir` and `stat` is silently skipped with only a `debugLog`, leaving stale `sync_state` rows. Pre-existing behavior. `engine/src/sync-engine.ts:1084`
- **[6-0a CR D3]** `cleanTmpFilesInDir` exported with optional `depth` parameter — external callers could pass non-zero depth, causing unexpected early cap. Theoretical; only internal caller uses default. `engine/src/main.ts:608`
- **[6-0b CR D1]** `trash_remote` catch missing PERMISSION_DENIED/FILE_LOCKED routing — blanket-routes to SDK_ERROR. Pre-existing gap. `engine/src/sync-engine.ts`
- **[6-0b CR D2]** Orphaned conflict copy on non-auth download errors — if `downloadOne` fails with DISK_FULL or PERMISSION_DENIED after conflict copy is created, `unlink(conflictCopyPath)` is not called. `engine/src/sync-engine.ts`
- **[6-0x CR D3]** `walkLocalTree` cycle guard uses string path, not inode — bind mounts mapping the same physical directory to two different paths defeat the `visited` Set. `engine/src/sync-engine.ts:1088-1103`
- **[6-0x CR W1]** Symlink skip in `walkLocalTree` is silent — users who symlink directories into their sync root get no feedback that those files are excluded. `engine/src/sync-engine.ts:1095`
- **[6-0x CR W3]** ENOSPC emission path not guarded by `inotifyExhausted` — duplicate `INOTIFY_LIMIT` events may be emitted before the flag is set. `engine/src/watcher.ts:65-76`
- **[5-4 CR W3]** `runCrashRecovery` clears dirty flag without try/finally guard — if `cleanTmpFilesInDir` ever throws, flag is cleared despite incomplete cleanup. `engine/src/main.ts:runCrashRecovery`
- **[5-4 CR W4]** `unlink` error suppression hides EACCES/EBUSY — bare `catch` silences all unlink errors; return count undercounts failures. `engine/src/main.ts:cleanTmpFilesInDir`
- **[6-5 CR D1]** Pre-seed crash window — process crash after `upsertSyncState` but before queue entry creation leaves state row with `content_hash: null` and no queue entry; file silently skipped on next reconcile. Inherent race without transactional DB writes. `engine/src/sync-engine.ts ~618`
- **[6-5 CR D2]** `deleteRevision` failure in `uploadFileRevision` falls through to `mapSdkError`, potentially triggering false offline transition. Acceptable failure mode. `engine/src/sdk.ts ~494`
- **[6-5 CR D3]** ENOENT in def/undef upload path returns `"conflict"` without dequeue — dead-letters after `MAX_DRAIN_ATTEMPTS` with no user-visible explanation. Pre-existing pattern. `engine/src/sync-engine.ts ~928`
- **[6-3 CR D1]** No sync/queue drain before `deletePair` — in-flight operations for removed pair may race with DB deletion. Requires per-pair pause/drain API. `engine/src/main.ts`
- **[6-3 CR D2]** `readConfigYaml` reads from disk on every call — concurrent writes produce last-writer-wins with no file locking. Pre-existing design. `engine/src/config.ts`
- **[6-3 CR D3]** DB delete succeeds / config write fails → torn state on restart — explicitly documented as acceptable trade-off in Story 6-3. `engine/src/main.ts`
- **[6-3 CR D4]** `fileWatcher.initialize()` errors swallowed via `void` — consistent with `add_pair` handler pattern. `engine/src/main.ts`
- **[6-0c CR D1]** Test gap: error event arriving after `on_queue_replay_complete` `.clear()` but before `on_sync_complete` — correct by design but untested timing. `ui/src/protondrive/window.py:522`

---

## Open — Validation & Path Safety

- **[6-2 CR D1]** Path traversal `..` not normalized — `normLocal`/`normRemote` strip trailing slashes only. Not a realistic vector (paths come from GTK file picker and ProtonDrive API). `engine/src/main.ts:normLocal, normRemote`
- **[6-2 CR D2]** Symlink resolution not performed — two paths resolving to the same directory via symlink can both be accepted. Explicitly out of scope per AC6. `engine/src/main.ts:validateNewPair`
- **[6-2 CR D3]** `normRemote("//")` returns `"//"` instead of `"/"` — not a realistic input from remote folder picker. `engine/src/main.ts:normRemote`
- **[6-2 CR D4]** Whitespace-only path inputs bypass falsy guard — `" "` is truthy in JS. Not a realistic input from GTK file picker. `engine/src/main.ts:add_pair handler`
- **[6-2 CR D5]** First-match-wins with 3+ existing pairs not covered by tests. `engine/src/main.test.ts`
- **[6-2 D1]** Reverse remote overlap not checked — `validateNewPair` detects new path inside existing, but NOT existing path inside new. A user can create pair A (`remote: /Documents/Work`) then pair B (`remote: /Documents`), ending up with B's root containing A's entire tree. Descoped from 6-2 ACs; requires new `remote_overlap` error code and UI message. `engine/src/main.ts:validateNewPair`

---

## Open — Test Coverage Gaps

- **[5-3 CR W6]** `afterEach` cleanup ordering: if `db.close()` throws, `rmSync`/`mock.restore()` are skipped. Pre-existing pattern. `engine/src/sync-engine.test.ts`
- **[6-0e CR D1]** Site 3 DISK_FULL test doesn't assert `downloadFile` NOT called. `engine/src/sync-engine.test.ts`
- **[6-0e CR D2]** `mock.module` accumulates in Bun's registry across tests — `mock.restore()` does not unregister `mock.module` registrations. Bun limitation. `engine/src/sync-engine.test.ts`
- **[6-0e CR D3]** PERMISSION_DENIED Site 1 loop short-circuit not verified — single conflict item doesn't confirm loop continues vs. aborts after one PD. `engine/src/sync-engine.test.ts`
- **[6-0e CR D4]** EPERM variant of `isPermissionDenied` untested — all PD tests throw EACCES only. `engine/src/sync-engine.ts:33`
- **[6-0e CR D5]** No multi-pair DISK_FULL loop-abort test — single-pair tests cannot verify `diskFull=true` skips subsequent pairs. `engine/src/sync-engine.ts`
- **[6-0e CR D6]** No `mkdir` ENOSPC test in `downloadOne`. `engine/src/sync-engine.ts`
- **[6-0e CR D7]** No `attempt_count` dead-lettering drain test — no test exercises the dead-letter path after `MAX_DRAIN_ATTEMPTS`. `engine/src/sync-engine.ts`

---

---

## Open — Story 7.2 AppStream / Metainfo Enhancements

These were surfaced during the party-mode validation of Story 7.2 (2026-04-23). All are improvements beyond the story's current ACs; none block Flathub submission.

- **[7-2 D1] Full OARS 1.1 field expansion** — The story includes 7 explicit OARS content-attribute fields (the most important social-* and money-* fields). The GNOME OARS generator emits a complete list (~20+ fields). Expanding to the full list would match what `flatpak-external-data-checker` generates and is more future-proof. However it requires running the [OARS generator](https://hughsie.github.io/oars/generate.html) against the app's content. Defer to a pre-Flathub-review cleanup pass. `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
- **[7-2 D2] `<keywords>` element in metainfo** — AppStream supports `<keywords><keyword>sync</keyword>...</keywords>` for search ranking in GNOME Software / KDE Discover. Flathub recommends it but does not require it. Low effort (~3 lines). Defer to a polish pass before Flathub submission. `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
- **[7-2 D3] `<url type="vcs-browser">` in metainfo** — AppStream 1.0 supports a VCS browser URL (`https://github.com/ronki2304/ProtonDrive-LinuxClient`) which appears in GNOME Software's "Development" links. Not required by Flathub. One line. Defer to polish pass. `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`

---

## Deferred from: code review of 7-0a/7-0b (2026-04-23)

- **[7-0 CR D1]** No integration test for pending rows through full `populate_pairs → on_offline → on_online` cycle — the three new tests cover individual state transitions but not the full sequence under a real window lifecycle. Scope-expanding beyond 7-0 ACs. `ui/tests/test_window_routing.py`
- **[7-0 CR D2]** Pending rows created after `on_watcher_status("ready")` fires have no transition path — watcher fires once at startup before any pairs exist in normal flow, but edge case (pair added post-ready, before next watcher cycle) leaves row visually grey. Pre-existing architectural constraint; not actionable without per-row ready tracking. `ui/src/protondrive/window.py:841-843`
- **[7-0 CR D3]** Accessibility label `"pending"` persists via AT-SPI2 until first `set_state()` call — `_set_accessible_label("pending")` is accurate for the ~<1s pending window, but screen readers reading the label during startup see a state string that has no accessible description. Pre-existing AT-SPI2 gap. `ui/src/protondrive/widgets/sync_pair_row.py:33`

---

## Deferred from: code review of 7-1 (2026-04-23)

- **[7-1 CR D1]** DoH resolver hardcodes Cloudflare `1.1.1.1` and ignores `http_proxy`/`https_proxy` env vars — proxy users behind corporate firewalls blocking Cloudflare get no connectivity; no fallback DNS server. Pre-existing architectural choice. `engine/src/main.ts`
- **[7-1 CR D2]** DoH resolver `https.request()` has no socket timeout — hangs indefinitely if `1.1.1.1` is unreachable; only bounded by OS TCP timeout (~2 min on Linux). Pre-existing. `engine/src/main.ts`
- **[7-1 CR D3]** Inotify watcher exhaustion (`ENOSPC`) sets `inotifyExhausted` but does not reinitialise when descriptors become available again — broken detection until engine restart. Pre-existing. `engine/src/watcher.ts`
- **[7-1 CR D4]** `CredentialManager` not re-probed after startup — if Secret portal D-Bus service crashes mid-session, all subsequent credential operations fail without recovery. Pre-existing. `ui/src/protondrive/credential_store.py`
- **[7-1 CR D5]** `_get_stored_token()` returns `None` for both "token not found" and backend errors — conflates transient keyring failure with no-token state; user sent to pre-auth screen on transient error. Pre-existing. `ui/src/protondrive/main.py`

---

_Resolved items removed during Epic 6 retrospective (2026-04-23):_
_[4-0b W2], [4-2/4-3], [5-0 CR W1] — solved; Story 2-12 — done; [6-4 D1] — deleted (not relevant); [6-4 D3] — already works; [5-9 CR W1] — fixed by Story 6-0c; [6-0x CR W4] — housekeeping, resolved._
