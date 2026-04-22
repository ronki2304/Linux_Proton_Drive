# Deferred Work

## Infrastructure — Meson wrapper loop bug (documented Epic 5 retrospective 2026-04-19)

**Root cause:** `~/.local/bin/meson` is a distrobox-generated wrapper that enters the LinuxProtonDrive container and calls `/usr/local/bin/meson`. That inner script is a **malformed heredoc artifact** — it starts with leading spaces (invalid shebang), then contains the lines `#!/bin/sh`, `exec /usr/bin/meson "$@"`, `EOF`, and `chmod +x /usr/local/bin/meson` as literal text. The kernel rejects the malformed shebang; the shell falls back to line-by-line execution; the `EOF` token triggers a heredoc-input wait — **an infinite hang** from the Claude Code sandbox.

**Workaround (in use since Epic 2):** Call `/usr/bin/meson` directly via distrobox — documented in `project-context.md` "Meson invocation from Claude Code sandbox" section.

**Status:** Workaround is sufficient for all current dev work. Root fix would be regenerating the wrapper via distrobox, but this requires Jeremy's terminal and is low priority. **Do not attempt to fix `/usr/local/bin/meson` from the Claude Code sandbox** — the container path is not writable from the Bash tool.

**Impact:** Only affects Claude Code Bash tool invocations. User's own terminal is unaffected.

---

## Open Items (triaged Epic 4 retrospective 2026-04-18)

The following items are real risks that require future attention.
All other items from Epics 1–4 have been closed (fixed, scoped to planned epics, or won't-fix).

_Items scoped to planned epics (Epic 5, Epic 6) or future stories have been removed — see sprint-status.yaml and epic-4-retro-2026-04-18.md for full triage._

- **[4-0b W2]** Local file modified + remote deleted → `delete_local` silently discards unsaved edits: `computeWorkList` does not compare `state.local_mtime` vs current `local.mtime` before pushing `delete_local`. A local edit after the last sync + a remote deletion in the same cycle will destroy the user's local changes without surfacing a conflict. `engine/src/sync-engine.ts`
- **[4-2/4-3]** Same-day conflict copy overwrite — `rename()` atomically replaces `<path>.conflict-YYYY-MM-DD` if it already exists from an earlier same-day collision. First conflict copy is silently destroyed. Known MVP limitation. `engine/src/sync-engine.ts`

---

## Deferred from: code review of 5-5-actionable-error-disk-full (2026-04-19)

- **[5-5 D2]** Multi-pair error: `on_pair_error` overwrites footer with last errored pair name — second DISK_FULL event for a different pair silently replaces the first. Story 5-9 priority ordering. `ui/src/protondrive/window.py`
- **[5-5 D6]** No multi-entry test for `queue_replay_failed` suppression — if a later queue entry fails non-ENOSPC after DISK_FULL entries, both codes get emitted. Low risk / out of scope. `engine/src/sync-engine.test.ts`

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

## Deferred from: code review of 5-0-pre-epic-5-debt-cleanup (2026-04-18)

- **[5-0 CR W1]** `newFileCollisionItems` loop has same same-day overwrite gap as `conflictItems` but no uniqueness counter — uses bare `rename(localFilePath, conflictCopyPath)` with no existence probe; a second same-day collision on the same filename silently clobbers the first conflict copy. The kept [4-2/4-3] open item documents the `conflictItems` path but does not capture this parallel gap. `engine/src/sync-engine.ts:341-343`

---

## Deferred from: code review of 5-3-change-queue-replay-after-re-auth (2026-04-19)

- **[5-3 CR W5]** `tmpDir` collision risk via `Date.now()` in test setup — two tests starting in the same millisecond share the same base path; `Math.random()` suffix reduces but does not eliminate risk. Pre-existing pattern across all test suites. `engine/src/sync-engine.test.ts`
- **[5-3 CR W6]** `afterEach` cleanup ordering: if `db.close()` throws, `rmSync`/`mock.restore()` are skipped — pre-existing pattern across all test suites. `engine/src/sync-engine.test.ts`
- **[5-3 CR W7]** AC4 UI toast coverage (`on_queue_replay_complete` → `AdwToast`) not verifiable from the Story 5-3 diff alone — pre-existing tests cited in Dev Note §7 (`test_window_routing.py:310–370`, `test_main.py:97–132`) cover this path; no action needed unless those tests are removed.

---

## Deferred from: code review of 5-9-actionable-error-sdk-api-error-and-error-state-components (2026-04-19)

- ~~**[5-9 CR W1]**~~ **RESOLVED by Story 6-0c** — `_error_pending_cycle` cleared in `on_offline()` and `on_queue_replay_complete()`. `ui/src/protondrive/window.py`

---

## Deferred from: code review of 5-4-dirty-session-flag-and-crash-recovery (2026-04-19)

- **[5-4 CR W3]** `runCrashRecovery` clears dirty flag without try/finally guard — latent: `cleanTmpFilesInDir` swallows all errors so it cannot currently throw; if it ever does, flag is cleared despite incomplete cleanup. `engine/src/main.ts:runCrashRecovery`
- **[5-4 CR W4]** `unlink` error suppression hides EACCES/EBUSY — bare `catch` silences all unlink errors; return count undercounts failures; return value unused by callers so no current functional impact. `engine/src/main.ts:cleanTmpFilesInDir`

---

## Deferred from: code review of 6-0d-per-pair-error-detail-ux (2026-04-20)

- **[6-0d CR W1]** `_error_pair_ids` and `_error_messages` not reset in `populate_pairs` — if re-login causes `populate_pairs` to run while stale error IDs happen to collide with new pair IDs, `_on_row_activated` will incorrectly restore the error banner; `clear_session()` normally prevents this, but `populate_pairs` has no direct guard. Pre-existing structural gap. `ui/src/protondrive/window.py:391-403`
- **[6-0d CR W2]** Stale banner title persists on hide — `error_banner.set_title()` is only called in the `has_error=True` branch; when hidden via `set_error_state(False)` the widget title is not cleared, leaving stale text in the DOM (invisible, but potentially surfaced by screen readers or future banner reuse). Pre-existing pattern; harmless in current code paths since banner is never re-revealed without a matching `set_title` call. `ui/src/protondrive/widgets/pair_detail_panel.py`
- **[6-0d CR W3]** Early `on_pair_error` message silently dropped before `populate_pairs` — the `row is None` guard returns before `self._error_messages[pair_id] = message` is reached; an engine error event arriving before the UI has populated pair rows is discarded, so re-selecting the pair later calls `set_error_state` with an empty-string fallback. Pre-existing behavior consistent with all other on_pair_error event-drop logic. `ui/src/protondrive/window.py:540-543`

---

## Deferred from: code review of 6-2-nesting-and-overlap-validation (2026-04-22)

- **[6-2 CR D1]** Path traversal `..` not normalized — `normLocal`/`normRemote` strip trailing slashes only; `..` components are not resolved. Not a realistic vector since local paths come from GTK file picker (canonical) and remote paths are virtual ProtonDrive API paths. Harden if the validation ever accepts untrusted IPC input from outside the app. `engine/src/main.ts:normLocal, normRemote`
- **[6-2 CR D2]** Symlink resolution not performed — paths are compared as strings; two paths that resolve to the same physical directory via a symlink can both be accepted. Explicitly out of scope per dev notes (AC6 prohibits filesystem access in validation). Revisit if symlink-aware sync is ever added. `engine/src/main.ts:validateNewPair`
- **[6-2 CR D3]** `normRemote("//")` returns `"//"` instead of `"/"` — double-slash remote paths would evade root-path detection. Not a realistic input from the remote folder picker API. Add a `path.replace(/\/+/g, "/")` normalization pass if remote paths ever accept user-typed strings. `engine/src/main.ts:normRemote`
- **[6-2 CR D4]** Whitespace-only path inputs bypass `!localPath || !remotePath` falsy guard — `" "` is truthy in JS; would proceed past validation and fail at remote ID resolution with a less helpful error. GTK file picker cannot produce whitespace paths; not a realistic input. `engine/src/main.ts:add_pair handler`
- **[6-2 CR D5]** First-match-wins with 3+ existing pairs not covered by tests — the `validateNewPair` linear scan is trivially correct, but no test inserts 2+ conflicting pairs and verifies which conflict is reported first. `engine/src/main.test.ts`

---

## Deferred from: party-mode validation of 6-2-nesting-and-overlap-validation (2026-04-22)

- **[6-2 D1]** Reverse remote overlap not checked — `validateNewPair` detects when the *new* remote path is inside an *existing* pair's remote path (`remote_nesting`) but does NOT detect the inverse: when an *existing* pair's remote path is a strict subdirectory of the *new* remote path. A user can create pair A (`remote: /Documents/Work`) then create pair B (`remote: /Documents`), ending up with B's root containing A's entire tree — a silent duplicate-sync hazard. The UX spec (UX-DR14) and ACs only specified the 4 implemented checks; this direction was explicitly descoped. A `remote_overlap` error code and corresponding UI message would be needed. `engine/src/main.ts:validateNewPair`

---

## Deferred from: party-mode validation of 6-1-add-subsequent-sync-pair (2026-04-22)

- **[6-1 PM D1]** Spinner show/hide behavior in `_on_add_pair_clicked` not covered by unit tests — Task 3.9 specifies `add_pair_button` disabled + spinner shown/started + `error_label` hidden on click, but no test in Task 8 verifies the spinner state transitions. Scope-expanding to add now; carry into 6-1 test pass or address in a future test-gap closure story. `ui/tests/test_add_pair_dialog.py`

---

_Won't-fix items from Epics 1–4 closed during Epic 4 retrospective 2026-04-18 — see epic-4-retro-2026-04-18.md for full list._

---

## Deferred from: code review of 6-0a-unbounded-loop-recursion-safety (2026-04-20)

- **[6-0a CR D1]** Silent depth cap for deep remote trees gives no user-visible error — `walkRemoteTree` returns an empty map with only a `debugLog` when depth >= 50. Users with legitimate remote folder trees >50 levels deep will silently lose sync coverage with no UI signal. `engine/src/sync-engine.ts:1109`

- **[6-0a CR D2]** `walkLocalTree` stat() race silently skips files — pre-existing behavior. A file deleted between `readdir` and `stat` is silently skipped with only a `debugLog`, leaving stale `sync_state` rows. `engine/src/sync-engine.ts:1084`

- **[6-0a CR D3]** `cleanTmpFilesInDir` exported with optional `depth` parameter — external callers could pass a non-zero depth, causing unexpected early cap at `MAX_CLEAN_DEPTH - depth` levels instead of 50. Theoretical; only internal caller uses the default. `engine/src/main.ts:608`

---

## Deferred from: code review of 6-0b-error-code-routing-correctness (2026-04-20)

- **[6-0b CR D1]** `trash_remote` catch missing PERMISSION_DENIED/FILE_LOCKED routing — handler only checks `isAuthExpired()` then blanket-routes to SDK_ERROR; a permission-denied or locked remote trash operation produces an indistinguishable error. Pre-existing gap; out of scope for this story. `engine/src/sync-engine.ts`

---

## Deferred from: code review 6-0x cross-story (2026-04-20)

- **[6-0x CR D3]** `walkLocalTree` cycle guard uses string path, not inode — bind mounts mapping the same physical directory to two different mount points produce different path strings and defeat the `visited` Set. Requires `stat()` per directory to compare `dev:ino` pairs. Exotic edge case (bind mounts inside a user's sync root); acceptable risk for now. `engine/src/sync-engine.ts:1088-1103`
- **[6-0x CR W1]** Symlink skip in `walkLocalTree` is silent — `entry.isSymbolicLink()` skips entries with no logging or user-facing event. Users who symlink directories into their sync root get no feedback that those files are excluded. `engine/src/sync-engine.ts:1095`
- **[6-0x CR W2]** `walkRemoteTree` depth cap returns empty maps — indistinguishable from a legitimately empty remote folder. Could cause sync engine to interpret deep remote files as "deleted" and propagate deletions locally. Same item as [6-0a CR D1] but from a data-loss angle. `engine/src/sync-engine.ts:1109`
- **[6-0x CR W3]** ENOSPC emission path not guarded by `inotifyExhausted` — the `INOTIFY_LIMIT` error event emission is guarded by `!this.stopped` but not by `inotifyExhausted`; if the error fires multiple times before the flag is set, duplicate events may be emitted. `engine/src/watcher.ts:65-76`
- **[6-0x CR W4]** `[5-9 CR W1]` in deferred-work.md describes the exact bug fixed by Story 6-0c — should be marked resolved. Housekeeping gap, not a code issue.

---

## Deferred from: code review of 6-0c-ui-state-correctness (2026-04-20)

- **[6-0c CR D1]** Test gap: error event arriving after `on_queue_replay_complete` `.clear()` but before `on_sync_complete` — code handles this correctly by design (new error re-adds to `_error_pending_cycle`; next sync_complete keeps it one more cycle), but no test exercises the specific timing. `ui/src/protondrive/window.py:522`

- **[6-0c CR D2]** Missing test: multiple pairs in mixed error/conflict/synced states simultaneously — footer priority logic (error > conflict > synced) is implemented but no test covers all three states active at once. Pre-existing coverage gap. `ui/tests/test_window_routing.py`

- **[6-0c CR D3]** Missing test: rapid session-ready → token-expired sequence — `clear_token_expired_warning` followed immediately by `show_token_expired_warning(N)` is not tested. Current implementation handles it correctly (`set_revealed` always sets state). Pre-existing coverage gap. `ui/tests/test_window_routing.py`
- **[6-0b CR D2]** Orphaned conflict copy on non-auth download errors — if `downloadOne` fails with DISK_FULL or PERMISSION_DENIED (not AuthExpiredError), the conflict copy is already on disk but `unlink(conflictCopyPath)` is not called; orphan persists. Story §5 dev note explicitly excludes this; rollback requires `rename(conflictCopyPath, localFilePath)`. Pre-existing gap. `engine/src/sync-engine.ts`

---

## Deferred from: code review of 6-0e-test-gap-closure (2026-04-20)

- **[6-0e CR D1]** Site 3 DISK_FULL test doesn't assert `downloadFile` NOT called — when `rename` throws ENOSPC at Site 3, `downloadFile` should not be invoked; test only checks DISK_FULL emitted, not that download was skipped. Secondary assertion quality gap. `engine/src/sync-engine.test.ts`
- **[6-0e CR D2]** `mock.module` accumulates in Bun's registry across tests — `mock.restore()` does not unregister `mock.module` registrations; DISK_FULL/PD describe blocks are last in file so no subsequent tests are contaminated, but future appended tests would inherit stale module mocks. Bun limitation; injectable fs would resolve. `engine/src/sync-engine.test.ts`
- **[6-0e CR D3]** PERMISSION_DENIED Site 1 loop short-circuit not verified — test uses a single conflict item; doesn't confirm that the conflictItems loop continues to the next item (vs. aborts entirely) after a PERMISSION_DENIED on one item. Out of scope for 6-0e. `engine/src/sync-engine.test.ts`
- **[6-0e CR D4]** EPERM variant of `isPermissionDenied` untested — all PD tests throw EACCES; the EPERM code path through `isPermissionDenied` has no test coverage. Pre-existing gap. `engine/src/sync-engine.ts:33`
- **[6-0e CR D5]** No multi-pair DISK_FULL loop-abort test — when `diskFull=true` on pair 1, subsequent pairs are skipped; single-pair tests cannot verify this. Multi-pair scenario is Epic 6 scope. `engine/src/sync-engine.ts`
- **[6-0e CR D6]** No `mkdir` ENOSPC test in `downloadOne` — `mkdir(dirname(dest), { recursive: true })` can throw ENOSPC before `downloadFile` is called; this path propagates correctly to DISK_FULL handling but has no dedicated test. `engine/src/sync-engine.ts`
- **[6-0e CR D7]** No `attempt_count` dead-lettering drain test — `drainQueue` dequeues entries that fail `MAX_DRAIN_ATTEMPTS` times; no test exercises this dead-letter path. `engine/src/sync-engine.ts`

---

## Deferred from: code review of 6-1-add-subsequent-sync-pair (2026-04-22)

- **[6-1 CR D1]** `_update_add_button` not wired to remote path changes — `AddPairDialog` calls `_update_add_button()` once after local folder selection (using default pre-fill path); if user then changes the remote path, the button sensitivity is not re-evaluated. Happy path is unaffected (default `/{basename}` pre-fill makes button sensitive on folder selection). Edge case: local folder at root "/" defaults remote to "/" → button stays insensitive even after valid remote path is typed. Fix requires adding a path-changed signal to `RemoteFolderPicker` (scope-expanding). `ui/src/protondrive/widgets/add_pair_dialog.py`, `ui/src/protondrive/widgets/remote_folder_picker.py`

---

## Deferred from: code review of 6-3-remove-sync-pair-with-confirmation (2026-04-22)

- **[6-3 CR D1]** No sync/queue drain before `deletePair` — in-flight engine sync operations for the removed pair may race with DB deletion. SQLite `ON DELETE CASCADE` handles orphaned rows, but the engine may log errors for the now-deleted pair until its operation completes. Pre-existing architectural concern; fix requires per-pair pause/drain API in SyncEngine. `engine/src/main.ts`
- **[6-3 CR D2]** `readConfigYaml` reads from disk on every call — concurrent writes to config.yaml produce last-writer-wins with no file locking. This is the same pre-existing design as `writeConfigYaml`. A file lock or in-memory config manager would eliminate the race. `engine/src/config.ts`
- **[6-3 CR D3]** DB delete succeeds / config write fails → torn state on restart — if `removeFromConfigYaml` throws after `stateDb.deletePair` succeeds, the pair is gone from DB but still in config.yaml; on cold-start the engine re-imports from YAML. The `config_write_failed` error is surfaced to UI (user must retry). Explicitly documented as acceptable trade-off in Story 6-3 Task 2.4. `engine/src/main.ts`
- **[6-3 CR D4]** `fileWatcher.initialize()` errors swallowed via `void` — if inotify limit or permission issue prevents the new FileWatcher from initializing after pair removal, the error is silently discarded and the client sees a success response. Consistent with the same pattern in the `add_pair` handler. `engine/src/main.ts`
