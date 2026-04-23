# Testing ProtonDrive Linux Client

This document is the manual validation protocol for the ProtonDrive Linux Client MVP. It covers
installation, all five PRD user journeys, distro matrix tracking, accessibility validation, and
integration test prerequisites.

---

## Prerequisites

### Phase 1 — To write or update this document

- A valid Proton account (free tier is sufficient)
- `flatpak` and `flatpak-builder` installed

### Phase 2 — To execute the validation runs

All Epic 7 stories must be fully implemented and marked `done` before Phase 2 validation can begin:

- 7-0a: Startup indicator state
- 7-0b: Targeted debt cleanup
- 7-1: Flatpak manifest + PERMISSIONS.md
- 7-2: AppStream metainfo + desktop file + README.md
- 7-3: CI/CD pipelines + CONTRIBUTING.md

### Distro matrix

| Distro | Version | Architecture | Desktop |
|--------|---------|-------------|---------|
| Fedora | 43 | x86_64 | GNOME |
| Ubuntu | 24.04 LTS | x86_64 | GNOME |
| Ubuntu | 25.04 | x86_64 | GNOME |
| Bazzite | latest | x86_64 | KDE |
| Arch Linux | rolling | x86_64 | varies |

> **x86_64 only.** aarch64 is excluded from the MVP validation matrix due to WebKitGTK JIT
> instability on ARM in the Flatpak sandbox (dev-only limitation; x86_64 is the production target).
> See Known Limitations.

---

## Installation

### Local build + install (development / pre-release validation)

```bash
flatpak-builder --user --install --force-clean builddir \
  flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml
flatpak run io.github.ronki2304.ProtonDriveLinuxClient
```

### From .flatpak bundle (release candidate validation)

```bash
flatpak install --user ./io.github.ronki2304.ProtonDriveLinuxClient.flatpak
flatpak run io.github.ronki2304.ProtonDriveLinuxClient
```

### Uninstall between test runs (clean state)

```bash
flatpak uninstall --user io.github.ronki2304.ProtonDriveLinuxClient
# Clear sync config, state database, and debug log.
# The Flatpak sandbox stores data under ~/.var/app/<app-id>/, not the host $XDG_* paths.
FLATPAK_APP_DIR="$HOME/.var/app/io.github.ronki2304.ProtonDriveLinuxClient"
rm -rf "$FLATPAK_APP_DIR/config/protondrive"  # config.yaml + sync pairs
rm -rf "$FLATPAK_APP_DIR/data/protondrive"    # state.db + fallback keyrings
rm -rf "$FLATPAK_APP_DIR/cache/protondrive"   # engine.log (debug mode)
# Window geometry (GSettings/dconf) does not need cleanup between runs.
```

---

## User Journey Checklists

Run all five journeys on each distro in the matrix. Fill in the Distro Matrix section as you go.

### Journey 1: First Run

**Goal:** Install, launch, authenticate, configure first sync pair, verify sync starts.

| # | Step | Pass/Fail |
|---|------|-----------|
| 1 | Install via one of the methods above. | |
| 2 | Launch: `flatpak run io.github.ronki2304.ProtonDriveLinuxClient` | |
| 3 | The startup indicator (grey dot) appears immediately before the first sync event. | |
| 4 | Pre-auth screen is displayed; click **Sign in**. | |
| 5 | The embedded WebKitGTK browser opens and loads the Proton login page. | |
| 6 | Complete Proton login including MFA (TOTP or hardware key). | |
| 7 | Auth completes; the callback is received on `http://127.0.0.1:44925/callback`; the browser closes. | |
| 8 | The first-run wizard appears; use the **local folder picker** to select a local folder. | |
| 9 | Use the **remote folder picker** to select a ProtonDrive folder. Use an empty folder or one dedicated to testing — a folder with pre-existing files will sync immediately and may trigger false conflicts in Journey 2. | |
| 10 | Confirm; the sync pair appears in the sidebar. | |
| 11 | The progress indicator is visible and sync activity begins. | |
| 12 | After initial sync completes, **"Last synced X seconds ago"** appears in the status footer. | |
| ✓ | **Auth success note:** confirm the auth flow completed without error (DonnieDice comparison — see Distro Matrix). | |

---

### Journey 2: Conflict

**Goal:** Verify conflict copy is created, named correctly, and the in-app notification works.

**Setup:** App must be running with at least one sync pair active and sync idle.

| # | Step | Pass/Fail |
|---|------|-----------|
| 1 | Close the app. | |
| 2 | Edit a synced file locally (add a line of text). | |
| 3 | Edit the **same file** on ProtonDrive web with different content. | |
| 4 | Open the app; wait for sync to run (watch the status footer — it will update to **"Last synced X seconds ago"** when the cycle completes). | |
| 5 | Verify a conflict copy was created: `ls <local-sync-folder>/*.conflict-*` — at least one result expected. | |
| 6 | Verify the conflict copy filename prefix format: `<filename>.<ext>.conflict-YYYY-MM-DD-` (millisecond timestamp follows; an optional random collision-avoidance suffix may also appear after the timestamp). The `.conflict-*` suffix is always appended **after** the extension — e.g. `notes.md.conflict-2026-04-23-1776988800000`, never `notes.conflict-2026-04-23.md`. | |
| 7 | Verify the in-app conflict notification (toast or banner) is visible. | |
| 8 | Click **Reveal in Files**. | |
| 9 | File manager opens to the conflict copy's location. | |

---

### Journey 3: Token Expiry

**Goal:** Verify the re-auth modal appears with queued change count, re-auth succeeds, and no false conflicts are created for the replayed changes.

**Setup:** App running with a sync pair active.

| # | Step | Pass/Fail |
|---|------|-----------|
| 1 | Edit one or more files in the local sync folder (add text to existing files). | |
| 2 | Watch the status footer — confirm the edits have **not** yet synced (the footer has not updated to "Last synced…" since the edits were made). If sync runs immediately, make another edit and observe again. | |
| 3 | **While unsynchronised edits exist:** open Proton web → Account → Security → Active Sessions → revoke the current app session. | |
| 4 | Return to the app; the **re-auth modal** appears showing the queued change count. | |
| 5 | Re-authenticate through the embedded browser. | |
| 6 | Queued changes are replayed; sync completes. | |
| 7 | Verify **no false conflicts** were created for the replayed changes: `ls <local-sync-folder>/*.conflict-*` returns empty (or shows only conflicts that pre-existed from Journey 2, if not cleaned up). | |
| 8 | Verify file contents in the sync folder match the edits made before token expiry. | |
| 9 | Verify no extra/unexpected files appeared in the ProtonDrive web folder. | |

> **Forcing token expiry.** The recommended method is revoking the session via Proton web
> (Step 3). There is no in-app "force expire" button. The `secret-tool store` approach to
> corrupt the token is unreliable inside Flatpak — the Secret Portal stores credentials under
> the Flatpak ID and `secret-tool` targeting `application=protondrive` will silently miss the
> portal-managed entry, leaving the real token intact. Use the revoke-from-web method.

---

### Journey 4: Contributor

**Goal:** Verify SDK boundary compliance, PERMISSIONS.md exists, and credential storage errors are surfaced gracefully on non-GNOME desktops.

| # | Step | Pass/Fail |
|---|------|-----------|
| 1 | Verify SDK boundary: `grep -r "@protontech/drive-sdk" engine/src/ \| grep -v sdk.ts` returns empty. | |
| 2 | Verify `flatpak/PERMISSIONS.md` exists and explains the `--filesystem=home` inotify limitation. | |
| 3 | **Non-GNOME credential test (run on Bazzite — ships KDE by default):** launch the app on a KDE session. If KWallet is not unlocked or credential storage fails via the Secret Portal, verify the app displays a clear error message rather than crashing silently. | |

---

### Journey 5: Sync Pair Removal

**Goal:** Verify removing a sync pair leaves local and remote files untouched.

**Setup:** Two sync pairs active; at least one file present in the pair you will remove.

| # | Step | Pass/Fail |
|---|------|-----------|
| 1 | Note the local folder path of the pair you will remove. | |
| 2 | **Before removal baseline:** `ls <local-folder>` — record the file listing. Confirm at least one file is present. | |
| 3 | Click the **remove** button on that pair in the sidebar. | |
| 4 | The confirmation dialog shows the correct pair name (matches exactly the pair name as displayed in the sidebar in Step 3). | |
| 5 | Confirm the removal. | |
| 6 | The pair disappears from the sidebar. | |
| 7 | **Verify local files untouched:** `ls <local-folder>` returns the same files as the baseline in Step 2. | |
| 8 | **Verify remote files untouched:** open ProtonDrive web; the remote folder shows the same files as before removal. | |

---

## Distro Matrix

Fill in each cell as journeys are executed. Use **P** (pass), **F** (fail), or **—** (not run).

| Journey / Check | Fedora 43 | Ubuntu 24 | Ubuntu 25 | Bazzite | Arch |
|-----------------|-----------|-----------|-----------|---------|------|
| J1 — First Run | | | | | |
| J1 — Auth success (DonnieDice comparison) | | | | | |
| J2 — Conflict | | | | | |
| J3 — Token Expiry | | | | | |
| J4 — Contributor | | | | | |
| J5 — Sync Pair Removal | | | | | |
| Accessibility — J1 keyboard-only | | — | — | — | — |
| Accessibility — J2 keyboard-only | | — | — | — | — |
| Accessibility — J3 keyboard-only | | — | — | — | — |
| Accessibility — J1 Orca | | — | — | — | — |
| Accessibility — J2 Orca | | — | — | — | — |
| Accessibility — J3 Orca | | — | — | — | — |

> **Auth differentiator.** Journey 1 auth success is the primary quality signal vs. DonnieDice.
> DonnieDice has known auth reliability failures on certain distros. The embedded WebKitGTK
> browser with localhost callback (`http://127.0.0.1:44925/callback`) is the canonical approach
> per ProtonDrive SDK team (GitHub issue closed 2026-04-16). Auth must succeed on all five distros.

---

## Accessibility

Accessibility testing is required for Journeys 1, 2, and 3 at minimum. Run on Fedora 43 as the primary reference.

### Keyboard-only navigation

For each of Journeys 1, 2, and 3:

| Check | Expected |
|-------|----------|
| **Tab / Shift+Tab** cycles through all interactive elements. | Every button, picker, and input is reachable. |
| **Space / Enter** activates focused elements. | Buttons trigger; checkboxes toggle. |
| **Modal focus trap** — when a dialog is open (re-auth modal, conflict dialog, pair removal confirmation), Tab cycles within the dialog only. | Tab does not escape the open dialog. |
| **Escape** closes cancelable dialogs (pair removal confirmation, conflict detail). | Dialog closes; focus returns to the element that opened it. |
| All buttons and modals are reachable without a mouse. | No interactive element is mouse-only. |

### Orca screen reader

**Start Orca:** `orca &` or `orca --replace &`

**Stop Orca:** `orca --quit`

Run Orca during Journeys 1, 2, and 3. Verify the following are announced:

| UI Element | Expected Orca Announcement |
|------------|---------------------------|
| Sync status footer | Label text — e.g. "Syncing 3 files" or "Last synced 5 seconds ago" |
| Progress indicator (spinner) | "progress indicator" role or spinner role — Orca reads something |
| Error banner | Banner title text when the banner receives focus |
| Re-auth modal | Dialog title + queued changes count label |
| Conflict toast (`AdwToast`) | Toast message text when the toast appears |
| Pair removal confirmation dialog | Dialog title + pair name in body |

**Known minor gap:** A stale error banner title may persist after the banner is hidden (deferred
per `deferred-work.md [6-0d CR W2]`). The stale title is not announced by Orca while the banner
is hidden — this is harmless and not a blocking failure.

---

## Integration Tests

Integration tests talk to the live Proton Drive API. They require manual token acquisition and
cannot be fully automated.

### Token acquisition

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the exact `secret-tool lookup` command and the
`PROTON_TEST_TOKEN` / `PROTON_TEST_FOLDER` export steps. Do not duplicate those details here —
CONTRIBUTING.md is the authoritative source.

### Token expiry

Integration tests fail with HTTP 401 when the token expires. Repeat the manual auth flow in
CONTRIBUTING.md to get a fresh token. Automation is impossible — the Proton auth flow requires
CAPTCHA and 2FA.

### Cleanup requirement

Each integration test file must call `afterAll` to delete any files or folders it created on
Proton servers. Cleanup failure must be reported, not swallowed — a leaked remote state will
cause the next test run to fail with unexpected file-exists errors.

---

## Known Limitations

| Limitation | Detail |
|-----------|--------|
| No automated integration tests | The Proton auth flow requires CAPTCHA and 2FA; fully automated end-to-end tests are not possible for MVP. E2E automation is deferred post-MVP. |
| aarch64 WebKitGTK JIT instability | WebKitGTK JIT is unstable on aarch64 inside the Flatpak sandbox (dev-only observation). x86_64 is the production target; aarch64 is excluded from the MVP validation matrix. |
| Stale error banner title on hide | A dismissed error banner may retain its title attribute while hidden. Not announced by Orca while hidden; harmless. Deferred: `deferred-work.md [6-0d CR W2]`. |
| Token corruption via `secret-tool` unreliable under Flatpak | `secret-tool store` targeting `application=protondrive` misses the Secret Portal-managed entry (stored under the Flatpak ID). Use the revoke-from-web method for Journey 3. |
