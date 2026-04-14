# Epic 4: Conflict Detection & Resolution

User's files are never silently overwritten. Conflicts create date-stamped copies, trigger both in-app and desktop notifications, and are discoverable via the conflict log with "Reveal in Files." Both file versions are always preserved.

## Story 4.1: Conflict Detection (Existing Files)

As a user,
I want the sync engine to detect when a file has been changed on both my machine and ProtonDrive since the last sync,
So that neither version is silently overwritten.

**Acceptance Criteria:**

**Given** a file exists in `sync_state` with stored `local_mtime` and `remote_mtime`
**When** a sync cycle runs
**Then** the engine compares current local mtime against stored local mtime AND current remote mtime against stored remote mtime
**And** if both have changed since last sync, the file is flagged as a conflict (FR25)

**Given** both mtimes changed but are within the same second (ambiguous resolution)
**When** conflict detection runs
**Then** the engine falls back to comparing a locally-computed content hash against the hash stored at last sync (FR25)
**And** no live remote fetch is performed for hash comparison — uses the stored hash only

**Given** only the local mtime changed (remote unchanged)
**When** a sync cycle runs
**Then** the file is uploaded normally — no conflict

**Given** only the remote mtime changed (local unchanged)
**When** a sync cycle runs
**Then** the file is downloaded normally — no conflict

**Given** unit tests for `conflict.ts`
**When** running `node --import tsx --test engine/src/conflict.test.ts`
**Then** tests cover: both-sides-changed, same-second mtime with differing hashes, same-second mtime with same hash (no conflict), local-only change, remote-only change

---

## Story 4.2: New-File Collision Detection

As a user,
I want the sync engine to handle collisions when I add a new file that already exists remotely,
So that neither my local file nor the remote file is lost.

**Acceptance Criteria:**

**Given** a new local file has no entry in `sync_state` (never previously synced)
**When** the engine prepares to upload it
**Then** it checks for remote path collisions — whether a remote file exists at the same relative path (FR25a)

**Given** a remote file exists at the same relative path
**When** the collision is detected
**Then** the local file is renamed to `filename.ext.conflict-YYYY-MM-DD`
**And** both versions are preserved (local conflict copy + remote original)
**And** the user is notified via the standard conflict notification pattern

**Given** no remote file exists at the same relative path
**When** the new file is uploaded
**Then** it proceeds as a normal upload — no conflict copy created

---

## Story 4.3: Conflict Copy Creation

As a user,
I want conflict copies to be created with a clear, consistent naming pattern,
So that I can easily identify and find them.

**Acceptance Criteria:**

**Given** a conflict is detected
**When** a conflict copy is created
**Then** it is named `filename.ext.conflict-YYYY-MM-DD` — suffix appended AFTER the extension (FR26)
**And** example: `notes.md` → `notes.md.conflict-2026-04-08`

**Given** a conflict copy is created
**When** the file is written
**Then** it uses atomic write: write to `<path>.protondrive-tmp-<timestamp>` then `rename()` on success (NFR12)
**And** the original file at the destination path is never overwritten before the conflict copy is safely written

**Given** a conflict is detected
**When** the conflict copy is created
**Then** a `conflict_detected` push event is emitted with `{pair_id, local_path, conflict_copy_path}`

**Given** zero file data loss is required (NFR11)
**When** any conflict scenario occurs
**Then** a conflict copy is ALWAYS created before any local file is overwritten
**And** this holds across app restarts, network interruptions, and session expiry

---

## Story 4.4: In-App Conflict Notification & Pair Status

As a user,
I want to see conflict notifications inside the app and on the affected sync pair,
So that I notice conflicts without checking my filesystem manually.

**Acceptance Criteria:**

**Given** a `conflict_detected` event is received by the UI
**When** the notification renders
**Then** an `AdwBanner` appears with amber styling: "1 conflict in [pair name]" (FR27)
**And** the banner is persistent and user-dismissible (not auto-dismiss)

**Given** a conflict exists on a sync pair
**When** the sidebar renders
**Then** the affected `SyncPairRow` shows an amber dot with accessible label "[pair name] — 1 conflict"
**And** the `StatusFooterBar` shows "N conflicts need attention" with an amber dot (UX-DR7)

**Given** the `StatusFooterBar` priority logic
**When** both conflicts and syncing are active
**Then** conflict state takes priority over syncing state (Conflict > Syncing > All synced)

**Given** a conflict is resolved (conflict copy deleted by user in file manager)
**When** the next sync cycle detects the deletion
**Then** the conflict state clears — pair dot returns to green, banner dismissed, footer updates

---

## Story 4.5: Desktop Notification for Conflicts

As a user,
I want a desktop notification when a conflict is detected while the app is open,
So that I notice conflicts even if the app window isn't in focus.

**Acceptance Criteria:**

**Given** a `conflict_detected` event is received
**When** the application window is open (foreground notification — no background daemon required)
**Then** a desktop notification is sent via the GNOME notification API (FR27a)
**And** the notification body includes the filename and pair name

**Given** the desktop notification
**When** the user clicks it
**Then** the app window is brought to focus with the affected pair selected in the sidebar

---

## Story 4.6: Conflict Log & Reveal in Files

As a user,
I want to view a log of all conflicts and locate conflict copies from within the app,
So that I can find and resolve them without opening a file manager.

**Acceptance Criteria:**

**Given** one or more conflicts have occurred
**When** the user opens the conflict log (via "View conflict log" button in detail panel)
**Then** a list of all conflicts is displayed (FR28)

**Given** each entry in the conflict log
**When** it renders
**Then** a `ConflictLogRow` component is displayed with: warning icon + filename (bold, amber) + pair name + timestamp + "Reveal in Files" action link (UX-DR10)

**Given** an unresolved conflict entry
**When** the user clicks "Reveal in Files"
**Then** `org.freedesktop.portal.OpenURI` opens the system file manager at the conflict copy location (FR29)

**Given** a conflict copy has been deleted by the user (resolved manually)
**When** the next sync cycle runs and detects the deletion
**Then** the `ConflictLogRow` transitions to resolved state: dimmed, strikethrough filename, auto-detected

**Given** the conflict log panel
**When** navigating via keyboard
**Then** Tab moves between conflict entries, Enter activates "Reveal in Files"
**And** screen reader announces: conflict filename, pair name, timestamp, and "Reveal in Files" action

**Given** all widget structure
**When** inspecting implementation
**Then** structure is in `ui/data/ui/conflict-log.blp` with Python wiring in `ui/src/protondrive/widgets/conflict_log.py`

---
