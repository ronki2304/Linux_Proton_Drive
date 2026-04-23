# Story 7.4: End-to-End MVP Validation & Manual Test Protocol

Status: in-progress

## Story

As a developer,
I want a manual validation checklist that walks through all 5 user journeys on the target distro matrix,
so that the MVP is verified as a complete, working product before Flathub submission.

## Acceptance Criteria

1. **All 5 PRD user journeys pass manually** — Journey 1 (First Run), Journey 2 (Conflict), Journey 3 (Token Expiry), Journey 4 (Contributor), Journey 5 (Sync Pair Removal).
2. **Distro matrix coverage** — All 5 journeys validated on: Fedora 43, Ubuntu 24, Ubuntu 25, Bazzite, Arch (x86_64 only).
3. **Auth passes on all target distros** — Journey 1 auth specifically succeeds on the distros where DonnieDice fails.
4. **`TESTING.md` at project root** — Step-by-step instructions for each journey; integration test prerequisites; known limitations.
5. **Accessibility validation** — Journeys 1, 2, and 3 completed using keyboard-only; Orca screen reader correctly announces all interactive elements, status changes, and error states.

## Tasks / Subtasks

- [x] **Task 1 — Create `TESTING.md` skeleton** (AC: 4)
  - [x] 1.1 Create `TESTING.md` at project root (new file, do NOT create inside `ui/`, `engine/`, or `flatpak/`)
  - [x] 1.2 Add header: document purpose, prerequisites — distinguish Phase 1 prerequisites (valid Proton account; Flatpak + flatpak-builder installed) from Phase 2 prerequisites (all Epic 7 stories implemented and marked `done`); distro matrix table
  - [x] 1.3 Add **Installation** section: local Flatpak build + install command; `flatpak run` command; uninstall command for clean re-test
  - [x] 1.4 Add **Known Limitations** section: no automated integration tests (CAPTCHA); aarch64 WebKit JIT instability (dev-only — x86_64 is the production target); E2E automation deferred post-MVP

- [x] **Task 2 — Write the 5 user journey checklists** (AC: 1, 4)
  - [x] 2.1 **Journey 1: First Run** — Install Flatpak → launch app → authenticate via embedded WebKit browser (Proton login + MFA) → first-run wizard: pick local folder → pick remote folder via folder picker → confirm → verify sync starts with progress indicator → verify "Last synced X seconds ago" appears in footer; note auth success specifically (DonnieDice comparison)
  - [x] 2.2 **Journey 2: Conflict** — App running with a sync pair → close app → edit a synced file locally → edit the same file on ProtonDrive web (different content) → open app → verify conflict copy created (format: `filename.ext.conflict-YYYY-MM-DD-<timestamp>` where timestamp is ms since epoch; use `ls *.conflict-*` to locate it — an optional random collision-avoidance suffix may also appear) → verify in-app conflict notification (toast or banner) → click "Reveal in Files" → verify file manager opens to conflict copy location
  - [x] 2.3 **Journey 3: Token Expiry** — With app running and a sync pair active: **create queued changes first** — edit one or more files in the local sync folder (add text to an existing file), confirm the engine has NOT yet synced them (watch footer — if "Last synced" updates immediately, wait for the next edit), then **while unsynchronised edits exist**: force token expiry (revoke session from Proton web settings: Account → Security → Sessions → revoke the active session) → verify re-auth modal appears displaying queued change count → re-authenticate → verify queued changes replay → verify no false conflicts created for the replayed changes (operationalized: `ls <sync-folder>/*.conflict-*` returns empty; file contents in sync folder match the edits made before token expiry; no extra files appear in ProtonDrive web)
  - [x] 2.4 **Journey 4: Contributor** — Verify SDK boundary: `grep -r "@protontech/drive-sdk" engine/src/ | grep -v sdk.ts` returns empty → verify `flatpak/PERMISSIONS.md` exists and explains `--filesystem=home` inotify limitation → **non-GNOME credential test (run this step on Bazzite, which ships KDE by default — use the Bazzite column in the distro matrix):** attempt auth on a KDE session: verify app shows an error rather than crashing silently if KWallet is not unlocked or credential storage fails
  - [x] 2.5 **Journey 5: Sync Pair Removal** — Add two sync pairs → **before removal**: note the file listing of the pair's local folder (`ls <local-folder>`) and confirm at least one file is present → remove one pair via sidebar remove button → confirm dialog shows correct pair name → after confirmation: pair disappears from sidebar → **verify local files untouched**: `ls <local-folder>` returns same files as before removal → verify remote files on ProtonDrive web are untouched (same files visible in the remote folder)

- [x] **Task 3 — Distro matrix tracking table** (AC: 2, 3)
  - [x] 3.1 Add a **Distro Matrix** section to `TESTING.md` with a pass/fail table: rows = Journeys 1–5 + Auth sub-step + Accessibility (J1/2/3); columns = Fedora 43, Ubuntu 24, Ubuntu 25, Bazzite, Arch
  - [x] 3.2 Add a "DonnieDice comparison" note on the Auth row — auth is our key differentiator and must succeed on all distros

- [x] **Task 4 — Accessibility testing section** (AC: 5)
  - [x] 4.1 Add **Accessibility** section to `TESTING.md`
  - [x] 4.2 Keyboard-only subsection: Tab/Shift+Tab navigation; Space/Enter activation; all buttons and modals reachable without mouse; modal dialogs trap focus correctly (re-auth modal, conflict dialog, pair removal confirmation)
  - [x] 4.3 Orca subsection: start/stop Orca commands; navigate through Journeys 1, 2, and 3; list what Orca must announce: sync status labels, progress indicator, error banners, re-auth modal queued count, conflict toast, pair removal confirmation dialog
  - [x] 4.4 Note known minor gap: stale error banner title may persist on hide (not announced while hidden — harmless; deferred per deferred-work.md [6-0d CR W2])

- [x] **Task 5 — Integration test prerequisites section** (AC: 4)
  - [x] 5.1 Add **Integration Tests** section to `TESTING.md`
  - [x] 5.2 Document manual token acquisition: launch app → authenticate → retrieve token; reference `CONTRIBUTING.md` for exact `secret-tool lookup` command and `PROTON_TEST_TOKEN` / `PROTON_TEST_FOLDER` export — do NOT duplicate command details from CONTRIBUTING.md
  - [x] 5.3 Document token expiry warning: integration tests fail with 401 when token expires; repeat manual auth flow; no programmatic refresh possible (CAPTCHA)
  - [x] 5.4 Document `afterAll` cleanup requirement: integration tests create real files on Proton servers; cleanup failure must be reported, not swallowed

- [ ] **Task 6 — Human validation pass** (AC: 1, 2, 3, 5) ⚠️ Human task — dev agent cannot execute cross-distro testing
  - [ ] 6.1 Execute all 5 journeys on Fedora 43; fill in distro matrix
  - [ ] 6.2 Execute all 5 journeys on Ubuntu 24; fill in distro matrix
  - [ ] 6.3 Execute all 5 journeys on Ubuntu 25; fill in distro matrix
  - [ ] 6.4 Execute all 5 journeys on Bazzite; fill in distro matrix
  - [ ] 6.5 Execute all 5 journeys on Arch; fill in distro matrix
  - [ ] 6.6 Execute keyboard-only + Orca accessibility testing for Journeys 1, 2, and 3 on Fedora 43 minimum
  - [ ] 6.7 All journeys pass on all distros → set story status to `review`

---

## Dev Notes

### CRITICAL: Two-phase story — dev agent does Phase 1 only

**Phase 1 (dev agent):** Create `TESTING.md` (Tasks 1–5). Documentation-only — no Python, TypeScript, Blueprint, GSettings, or manifest changes.

**Phase 2 (human — Jeremy):** Execute the cross-distro validation runs (Task 6). Dev agent cannot perform this work. Mark story `in-progress`, complete Phase 1, then STOP and notify Jeremy that TESTING.md is ready and Phase 2 validation is required.

### Prerequisites before Phase 2 validation can start

All prior Epic 7 stories must be fully implemented and marked `done`:
- 7-0a: Startup indicator state
- 7-0b: Targeted debt cleanup  
- 7-1: Flatpak manifest + PERMISSIONS.md ← already `review`
- 7-2: AppStream metainfo + desktop file + README.md
- 7-3: CI/CD pipelines + CONTRIBUTING.md (CONTRIBUTING.md is the source of truth for test commands)

TESTING.md may be written before these are done. Phase 2 validation is blocked until all are `done`.

### Installation commands (include verbatim in TESTING.md)

```bash
# Local build + install (development / pre-release validation)
flatpak-builder --user --install --force-clean builddir \
  flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml
flatpak run io.github.ronki2304.ProtonDriveLinuxClient

# From .flatpak bundle (release candidate validation)
flatpak install --user ./io.github.ronki2304.ProtonDriveLinuxClient.flatpak
flatpak run io.github.ronki2304.ProtonDriveLinuxClient

# Uninstall between test runs (clean state)
flatpak uninstall --user io.github.ronki2304.ProtonDriveLinuxClient
# Also clear state between runs:
rm -rf "$XDG_CONFIG_HOME/protondrive" "$XDG_DATA_HOME/protondrive" "$XDG_STATE_HOME/protondrive" "$XDG_CACHE_HOME/protondrive"
```

### DonnieDice reference

"DonnieDice" is a competing Linux ProtonDrive client known to have auth reliability issues on certain distros. Our differentiator: embedded WebKitGTK + localhost callback (`http://127.0.0.1:44925/callback`) is the canonical approach per ProtonDrive SDK team (GitHub issue closed 2026-04-16). Journey 1 auth success on all 4 target distros is a primary quality signal — not just "does the app launch" but "does Proton authentication actually complete."

### Forcing token expiry (Journey 3 mechanism)

No in-app "force expire" button exists. Three options:
1. **Revoke from Proton web** (recommended): Proton web → Account → Security → Active Sessions → revoke the session while app is running with queued changes. Most realistic simulation.
2. **Corrupt stored token (unreliable under Flatpak):** `secret-tool store --label="ProtonDrive" application protondrive <<< "invalid_token_value"` — **caveat:** the Flatpak Secret Portal stores credentials under the app's Flatpak ID (`io.github.ronki2304.ProtonDriveLinuxClient`), not the plain `application=protondrive` attribute. `secret-tool` targeting that attribute will silently miss the portal-managed entry, leaving the real token intact. This option is only viable outside Flatpak (bare Python dev runs). Prefer Option 1.
3. **Wait for natural expiry:** Proton session tokens expire after extended inactivity — impractical for testing.

Option 1 is preferred: it produces the real 401 path cleanly.

### Journey 4 — credential error on non-GNOME desktop

Journey 4 "credential storage error handling" is an exploratory test. Options:
- **KDE Plasma session:** install on KDE desktop; KWallet integration via Secret portal; verify libsecret portal fallback works (or if KWallet is not running, that app shows a clear error rather than crashing)
- **XFCE session:** no native keyring daemon; libsecret portal may fail; verify app displays error banner rather than unhandled exception
- **Minimum acceptance:** app surfaces an error message the user can act on rather than crashing silently. The Python error handling chain: libsecret throws `AuthError` → caught in `signal handler` → displayed as app-level banner.

### Conflict copy naming — Journey 2 verification

Per `engine/src/sync-engine.ts:383,469,1116` (conflict copy path generation — not `conflict.ts`, which is detection-only): the conflict copy format is `filename.ext.conflict-YYYY-MM-DD-<ms>` where `<ms>` is `Date.now()` milliseconds. A collision-avoidance random suffix (e.g. `-3e7m4k`) may be appended if the timestamped path already exists. Example: `notes.md` → `notes.md.conflict-2026-04-23-1745438400000`. Use `ls *.conflict-*` to locate the file rather than matching the exact timestamp. Testers must verify the prefix format (`filename.ext.conflict-YYYY-MM-DD-`), not an exact filename, and must confirm the suffix is appended AFTER the extension (never `notes.conflict-2026-04-23.md`).

### Orca screen reader — what to verify

| UI element | Expected Orca announcement |
|------------|---------------------------|
| Sync status footer | Label text (e.g., "Syncing 3 files" / "Last synced 5 seconds ago") |
| Error banner | Banner title text when banner receives focus |
| Re-auth modal | Dialog title + queued changes count label |
| Conflict toast (`AdwToast`) | Toast message text when toast appears |
| Pair removal dialog | Dialog title + pair name in body |
| Spinner | May announce as "progress indicator" or spinner role — verify Orca reads something |

Note: `[6-0d CR W2]` in deferred-work.md documents that a stale error banner title can persist on hide. This is invisible while the banner is hidden and not announced by Orca in practice — document as known minor gap in TESTING.md, not a blocking failure.

### XDG state cleanup between test runs

The app creates XDG dirs on first run. For a clean-slate Journey 1 retest:
```bash
rm -rf "$XDG_CONFIG_HOME/protondrive"    # config.yaml, sync pairs
rm -rf "$XDG_DATA_HOME/protondrive"      # state.db
rm -rf "$XDG_STATE_HOME/protondrive"     # window state
rm -rf "$XDG_CACHE_HOME/protondrive"     # engine.log (debug mode)
```
The Flatpak sandbox uses `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/` as the XDG root — always matches the sandbox env vars, not the host defaults.

### Files to create

| File | Action | Notes |
|------|--------|-------|
| `TESTING.md` | Create | Project root; new file |

No code changes in this story.

### Project Structure Notes

- `TESTING.md` goes at project root alongside `README.md` and `CONTRIBUTING.md` (both created in earlier Epic 7 stories)
- Do NOT create `TESTING.md` inside `ui/`, `engine/`, `flatpak/`, or `docs/`
- TESTING.md references CONTRIBUTING.md for integration test token commands — do not duplicate those command details

### References

- Epic 7 story 7.4 spec: `_bmad-output/planning-artifacts/epics/epic-7-packaging-distribution.md#story-74`
- Project context (test commands, XDG paths, distro matrix): `_bmad-output/project-context.md`
- CONTRIBUTING.md source of truth for test commands: created by Story 7-3 (`_bmad-output/implementation-artifacts/7-3-ci-cd-pipelines.md`)
- Flatpak permission doc: `flatpak/PERMISSIONS.md` (Story 7-1) — reference from Journey 4
- Known deferred items relevant to accessibility: `_bmad-output/implementation-artifacts/deferred-work.md` — [6-0d CR W2] stale banner title
- WebKit aarch64 limitation: `_bmad-output/implementation-artifacts/deferred-work.md#webkit-aarch64-jit-instability`

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (Bob SM, create-story workflow — 2026-04-23)
claude-sonnet-4-6 (Amelia Dev, dev-story workflow — 2026-04-23)

### Debug Log References

None — documentation-only story; no code changes.

### Completion Notes List

✅ Phase 1 complete (2026-04-23): Created `TESTING.md` at project root covering all five PRD
user journeys, distro matrix tracking table (Fedora 43, Ubuntu 24, Ubuntu 25, Bazzite, Arch),
accessibility testing (keyboard-only + Orca), integration test prerequisites, installation
commands, and known limitations. Tasks 1–5 done; Task 6 is a human validation task and remains
open pending Jeremy's cross-distro execution runs.

No automated tests written — story is documentation-only (no Python, TypeScript, Blueprint, or
GSettings changes). `TESTING.md` references `CONTRIBUTING.md` for integration test token commands
rather than duplicating them.

✅ CR Pass 2 + Party-Mode Session 3 complete (2026-04-23): 5 patches applied to TESTING.md
(Flatpak XDG cleanup path fix, J1 Step 9 remote folder guidance, J5 Step 4 pair name clarity,
example timestamp correction, Escape key accessibility row). Party-mode surfaced 3 additional
findings: removed dead `state/protondrive` rm (app never writes XDG_STATE), added footer signal
to J2 Step 4, confirmed inline comment covers Flatpak path explanation. 4 items deferred to
deferred-work.md. All 16 total findings across both passes marked [x].

⏳ Phase 2 blocked on: all Epic 7 stories marked `done` (currently 7-4 itself is `in-progress`).
Story status intentionally left `in-progress` — Task 6 requires human execution.

### File List

- `TESTING.md` (created)

---

## Party-Mode Validation Record

**Session 1:** 2026-04-23 — agents: Bob (SM), Quinn (QA), Winston (Architect), Paige (Tech Writer), Amelia (Dev)
**Session 2:** 2026-04-23 — agents: Bob (SM), Quinn (QA), Winston (Architect), Paige (Tech Writer) — autonomous re-validation pass
**Session 3:** 2026-04-23 — agents: Bob (SM), Quinn (QA), Winston (Architect), Paige (Tech Writer), Amelia (Dev) — post-CR-pass-2 autonomous validation

### Findings

- [x] **[CRITICAL] F1 — Conflict copy naming format wrong in Task 2.2 and Dev Notes**
  Story stated `filename.ext.conflict-YYYY-MM-DD` (date only). Actual code (`sync-engine.ts:364,450,1097`) produces `filename.ext.conflict-YYYY-MM-DD-<ms>` with optional random collision-avoidance suffix. Testers following the old description would grep for files that don't exist. **Resolution:** Updated Task 2.2 to use glob-based verification (`ls *.conflict-*`) and rewrote Dev Notes conflict copy naming section with correct format, correct source file reference (`sync-engine.ts`, not `conflict.ts`), and an example with the timestamp component.

- [x] **[CRITICAL] F2 — Dev Notes reference `conflict.ts` for copy naming (wrong file)**
  `engine/src/conflict.ts` is the conflict DETECTION module (pure logic, no path generation). All conflict copy path construction is in `sync-engine.ts`. **Resolution:** Corrected file reference in Dev Notes section header and body.

- [x] **[ENHANCEMENT] F3 — Journey 3 "no false conflicts" verification not operationalized**
  "Verify no false conflicts created" gave testers no concrete action. **Resolution:** Added operationalized check to Task 2.3: `ls <sync-folder>/*.conflict-*` returns empty; file contents match pre-expiry edits; no extra files in ProtonDrive web.

- [x] **[ENHANCEMENT] F4 — Journey 5 local file verification not operationalized**
  "Verify local files in removed pair folder are untouched" is untestable without a baseline. **Resolution:** Updated Task 2.5 to require a before-removal `ls` baseline and an after-removal comparison.

- [x] **[ENHANCEMENT] F5 — Task 1.2 prerequisite wording conflates Phase 1 and Phase 2 prerequisites**
  "All Epic 7 stories complete" is a Phase 2 prerequisite only; TESTING.md can be written before Epic 7 is done. **Resolution:** Updated Task 1.2 to distinguish Phase 1 prerequisites (Proton account, Flatpak builder) from Phase 2 prerequisites (all Epic 7 stories done).

- [x] **[ENHANCEMENT] F6 — Journey 3 "queued changes" setup not specified**
  Task 2.3 opened with "With app running and queued changes" without telling the tester how to produce that state. Without explicit setup steps, a tester might revoke the token before making any changes, testing the wrong path (immediate 401 on launch, not queued-change replay). **Resolution:** Updated Task 2.3 to add explicit setup: edit local files in the sync folder, confirm they have not yet synced (watch footer), then revoke — ensuring the re-auth flow tests the change-replay path. Decision: used footer status as the sync-confirmation signal rather than network disconnect (simpler, no extra setup, closer to the real user scenario).

- [x] **[ENHANCEMENT] F7 — Journey 4 non-GNOME step has no distro anchor**
  Task 2.4 said "on a non-GNOME session (KDE or XFCE)" with no guidance on which matrix distro to use. Fedora/Ubuntu default to GNOME; Arch is unconstrained; only Bazzite ships KDE by default. Testers had no mapping from "non-GNOME" to a specific matrix column. **Resolution:** Updated Task 2.4 to explicitly call out Bazzite (KDE) as the target for the credential-storage step, tied to the Bazzite distro matrix column.

- [x] **[ENHANCEMENT] F8 — Dev Notes Option 2 (corrupt stored token) silently fails under Flatpak**
  Dev Notes listed `secret-tool store --label="ProtonDrive" application protondrive` as Option 2. The Flatpak Secret Portal stores credentials under the app's Flatpak ID, not the `application=protondrive` attribute — `secret-tool` targeting that attribute misses the entry entirely, leaving the token intact. A tester following Option 2 inside Flatpak would believe they corrupted the token when they hadn't. **Resolution:** Added a caveat noting the Flatpak portal key-path mismatch and that Option 2 is only viable for bare dev runs (non-Flatpak). Option 1 remains recommended.

---

### CR Pass 2 Findings (2026-04-23 — Amelia Dev, Blind Hunter, Edge Case Hunter, Acceptance Auditor)

- [x] **[HIGH] CR2-P1 — Uninstall cleanup commands wrong for Flatpak host context** [TESTING.md:59-65]
  The `rm -rf "$XDG_CONFIG_HOME/protondrive"` commands use host `$XDG_*` vars, which do NOT point to the Flatpak sandbox data at `~/.var/app/…`. Running cleanup from the host terminal would silently delete nothing (or the wrong directory on systems that happen to set `XDG_*` pointing at different paths). **Resolution:** Replaced with explicit `$HOME/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/{config,data,state,cache}/protondrive` paths.

- [x] **[MEDIUM] CR2-P2 — Journey 1 Step 9: no guidance on remote folder state** [TESTING.md:J1-Step-9]
  Selecting a remote folder with pre-existing files causes an immediate sync and can trigger false conflicts in Journey 2. Testers were not warned. **Resolution:** Updated Step 9 to note "use an empty folder or one dedicated to testing."

- [x] **[LOW] CR2-P3 — Journey 5 Step 4: "correct pair name" ambiguous** [TESTING.md:J5-Step-4]
  "Correct" had no definition; two pairs with similar names would be untestable. **Resolution:** Clarified to "matches exactly the pair name as displayed in the sidebar in Step 3."

- [x] **[LOW] CR2-P4 — Example conflict timestamp mismatch** [TESTING.md:J2-Step-6]
  Example showed `notes.md.conflict-2026-04-23-1745438400000` but `1745438400000` ms corresponds to April 2025, not April 2026. Exact value is illustrative but inconsistency could confuse careful readers. **Resolution:** Updated example to `1776988800000` (≈ April 23, 2026).

- [x] **[LOW] CR2-P5 — Escape key behavior undefined in keyboard-only accessibility section** [TESTING.md:Accessibility]
  Keyboard-only table specified Tab focus trap but said nothing about Escape. Testers had no pass/fail criterion for dismiss-via-Escape. **Resolution:** Added a row: "Escape closes cancelable dialogs; focus returns to the opener."

- [x] **[DEFER] CR2-D1 — Port 44925 availability not checked pre-test** [TESTING.md:J1-Step-7]
  If another service occupies port 44925, auth fails with no clear error surfaced in the testing doc. Pre-existing infra concern; fix requires app-level port-conflict handling. Deferred to deferred-work.md.

- [x] **[DEFER] CR2-D2 — No timeout guidance for Journey 2/3 sync wait steps** [TESTING.md:J2-Step-4, J3-Step-2]
  No "wait up to N seconds then fail" guidance. Acceptable for MVP manual testing. Deferred.

- [x] **[DEFER] CR2-D3 — Session revocation propagation delay (Journey 3)** [TESTING.md:J3-Step-3]
  Revocation may take seconds to propagate; app may complete the current sync cycle before the 401 arrives, causing Step 4 (re-auth modal) to be missed. Beyond scope of a testing doc; fix requires app-level retry/backoff. Deferred.

- [x] **[DEFER] CR2-D4 — Journey 4 credential error message not formally defined** [TESTING.md:J4-Step-3]
  "Clear error message" has no formal definition; minimal MVP acceptance. Deferred.

---

### Party-Mode Session 3 Findings (2026-04-23 — Winston, Quinn, Paige, Bob, Amelia)

- [x] **[MEDIUM] PF1 — `state/protondrive` cleanup is a dead rm** [TESTING.md:uninstall]
  App never calls `$XDG_STATE_HOME` — no Python or TypeScript code uses that env var. Window geometry persists to GSettings (dconf), not a file under `state/protondrive`. The original comment "window state" was wrong and the rm removed a non-existent directory. **Resolution:** Removed `state/protondrive` from cleanup commands; added inline comment explaining GSettings window geometry does not need cleanup between runs. Listed actual paths for each remaining rm: config.yaml + sync pairs, state.db + fallback keyrings, engine.log.

- [x] **[MEDIUM] PF2 — Journey 2 Step 4 lacks observable completion signal** [TESTING.md:J2-Step-4]
  "Wait for sync to run" gave testers no way to know when sync finished. A tester running J2 after a fresh install may not know the footer is the signal (learned in J1 but not stated in J2). **Resolution:** Updated Step 4 to "watch the status footer — it will update to 'Last synced X seconds ago' when the cycle completes."

- [x] **[LOW] PF3 — Explanatory context for explicit Flatpak paths** [TESTING.md:uninstall]
  P1 patch removed the Flatpak XDG root note. Inline comment in the bash block now explains the path rationale ("The Flatpak sandbox stores data under ~/.var/app/..., not the host $XDG_* paths"). Sufficient — no additional callout block needed. **Resolution:** Confirmed inline comment is adequate; no further change required.
