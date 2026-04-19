# Deferred Work

## Open Items (triaged Epic 4 retrospective 2026-04-18)

The following items are real risks that require future attention.
All other items from Epics 1–4 have been closed (fixed, scoped to planned epics, or won't-fix).

_Items scoped to planned epics (Epic 5, Epic 6) or future stories have been removed — see sprint-status.yaml and epic-4-retro-2026-04-18.md for full triage._

- **[4-0b W1]** Unbounded retry on persistent `delete_local` failures (EPERM/EACCES): `sync_state` is preserved on non-ENOENT errors so next cycle retries, but there is no retry counter or dead-letter mechanism — a permanently unreadable file will retry forever. Established engine pattern; no bounding mechanism exists yet. `engine/src/sync-engine.ts`
- **[4-0b W2]** Local file modified + remote deleted → `delete_local` silently discards unsaved edits: `computeWorkList` does not compare `state.local_mtime` vs current `local.mtime` before pushing `delete_local`. A local edit after the last sync + a remote deletion in the same cycle will destroy the user's local changes without surfacing a conflict. `engine/src/sync-engine.ts`
- **[2-5]** `walkLocalTree` follows symlinks without restriction — symlink cycle causes infinite recursion; add `followSymlinks: false` or visited-set before supporting symlinked folder trees. `engine/src/sync-engine.ts`
- **[2-5]** `walkRemoteTree` unbounded recursion — no max-depth or cycle guard for circular folder references (e.g. Proton shared folders); risk is present today on every cold start via `startSyncAll`/`computeWorkList`, not gated on multi-user scenarios. Add depth cap. `engine/src/sync-engine.ts`
- **[4-2/4-3]** Same-day conflict copy overwrite — `rename()` atomically replaces `<path>.conflict-YYYY-MM-DD` if it already exists from an earlier same-day collision. First conflict copy is silently destroyed. Known MVP limitation. `engine/src/sync-engine.ts`

---

## Deferred from: code review of 5-2-re-auth-modal-with-queued-change-count (2026-04-19)

- **[5-2 D1]** No default body in Blueprint — `reauth-dialog.blp` has no `body:` property; if any future call site calls `present()` without first calling `set_queued_changes()`, the dialog shows an empty body. Current code always calls `set_queued_changes()` before `present()`, so this is a latent footgun, not an active bug. `ui/data/ui/reauth-dialog.blp`
- **[5-2 D2]** Stale queued-change count with rapid `token_expired` events — if the engine fires `token_expired` twice in quick succession, the second event's `queued_changes` count is not reflected in the already-showing dialog (idempotency guard blocks creation of a second dialog). Engine-level concern; engine should not emit `token_expired` more than once per session expiry. `ui/src/protondrive/main.py`

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
- **[5-0 CR W2]** `conflictCopyPath` uniqueness probe loop (`while (true)`) has no max-`n` iteration cap — re-probes `stat()` until it throws; an adversarial filesystem state or a directory with many existing `.conflict-*` entries could spin indefinitely. `engine/src/sync-engine.ts:271-283`

---

---

## Deferred from: code review of 5-1-401-detection-and-sync-halt (2026-04-19)

- **[5-1 CR W1]** Banner has no re-auth action button — `Adw.Banner` in `window.blp` has no `button-label`/`action-name`; Story 5-2 will add the re-auth modal trigger from the banner. `ui/data/ui/window.blp`
- **[5-1 CR W2]** `startSyncAll` comment misleads about 401 path — comment "NetworkMonitor will trigger a fresh drain on reconnect" is accurate for network-failure but does not note that 401 (`onTokenExpired`) does not reconnect-drain; documentation smell only. `engine/src/sync-engine.ts:~132`
- **[5-1 CR W3]** Banner `revealed` state not reset on `logout()` — `logout()` hides main view via `show_pre_auth()` so banner is not visible; `on_session_ready` clears it on re-auth; only a gap if user somehow reaches main view without `on_session_ready`. `ui/src/protondrive/main.py`
- **[5-1 CR W4]** `TestTokenExpiredResetsWatcherStatus` tests call `_on_token_expired` with full-message-shaped payload — pre-existing; old tests pass `{"payload": {...}}` while correct shape is `{"queued_changes": N}` directly; old tests don't check extracted values so pass regardless; harmless inconsistency. `ui/tests/test_main.py`
- **[5-1 CR W5]** 401 during conflict download leaves orphaned `.conflict-YYYY-MM-DD` file — conflict copy written and `conflict_detected` emitted before download; if download throws `AuthExpiredError`, copy is orphaned on disk; next reconcile after re-auth may create a second conflict copy for the same file. `engine/src/sync-engine.ts:~335`

## Deferred from: code review of 5-3-change-queue-replay-after-re-auth (2026-04-19)

- **[5-3 CR W1]** `failed` return value from `drainQueue` never asserted in any 5-3 test — stat errors (EACCES, EPERM, EIO) route to `failed`; counter is silently unchecked. `engine/src/sync-engine.test.ts`
- **[5-3 CR W2]** `change_type='deleted'` queued during expiry window not covered — `trashNode` / `dequeue` paths in `processQueueEntry` are not exercised by the post-reauth drain tests. `engine/src/sync-engine.test.ts`
- **[5-3 CR W3]** New file (no `sync_state`) queued during expiry not tested — `state === undefined && remote === undefined` → upload path not covered by Story 5-3 tests. `engine/src/sync-engine.test.ts`
- **[5-3 CR W4]** ENOENT during drain mid-replay not tested — local file deleted between enqueue and drain routes to conflict in `processQueueEntry`; outcome unverified. `engine/src/sync-engine.test.ts`
- **[5-3 CR W5]** `tmpDir` collision risk via `Date.now()` in test setup — two tests starting in the same millisecond share the same base path; `Math.random()` suffix reduces but does not eliminate risk. Pre-existing pattern across all test suites. `engine/src/sync-engine.test.ts`
- **[5-3 CR W6]** `afterEach` cleanup ordering: if `db.close()` throws, `rmSync`/`mock.restore()` are skipped — pre-existing pattern across all test suites. `engine/src/sync-engine.test.ts`
- **[5-3 CR W7]** AC4 UI toast coverage (`on_queue_replay_complete` → `AdwToast`) not verifiable from the Story 5-3 diff alone — pre-existing tests cited in Dev Note §7 (`test_window_routing.py:310–370`, `test_main.py:97–132`) cover this path; no action needed unless those tests are removed.

---

_Won't-fix items from Epics 1–4 closed during Epic 4 retrospective 2026-04-18 — see epic-4-retro-2026-04-18.md for full list._
