# Epic 5: Token Expiry & Error Recovery

User can recover from expired sessions with zero data loss — queued changes are preserved and replayed without false conflicts. Crash recovery is automatic with an informational toast. Sync errors are actionable with specific resolution guidance.

## Story 5.1: 401 Detection & Sync Halt

As a user,
I want the sync engine to immediately stop retrying when my session expires,
So that it doesn't loop on failed requests and instead prompts me to re-authenticate.

**Acceptance Criteria:**

**Given** the SDK returns a 401 (unauthorized) response
**When** the engine processes it
**Then** sync halts immediately — no retry on 401 (NFR17)
**And** the engine emits a `token_expired` push event with `{queued_changes}` (count of locally-changed files pending sync)

**Given** a `token_expired` event is emitted
**When** the UI processes it
**Then** the window header shifts to a warning state
**And** local file changes continue to be queued to the `change_queue` table (they are not dropped)

**Given** the 401 detection
**When** it occurs within one failed sync attempt
**Then** the engine does not silently retry — detection is immediate, not after N retries

---

## Story 5.2: Re-Auth Modal with Queued Change Count

As a user,
I want to see how many changes are waiting and re-authenticate easily,
So that I know my data is safe and can resume sync quickly.

**Acceptance Criteria:**

**Given** a `token_expired` event is received
**When** the app window is visible
**Then** an `AdwAlertDialog` modal appears with: heading "Session expired" and body "Your Proton session has expired — this can happen after a password change or routine token refresh. [N] local changes are waiting to sync. Sign in to resume." (FR4, FR5)

**Given** the app window is minimized when token expires
**When** the user brings the window forward
**Then** the re-auth modal is shown immediately

**Given** the re-auth modal
**When** the user clicks "Sign in"
**Then** the embedded WebKitGTK auth browser opens (same flow as first-run auth)
**And** on successful auth, the new token is stored in the credential store and sent to the engine via `token_refresh` IPC command

**Given** re-auth completes
**When** the engine validates the new token
**Then** a `session_ready` event is emitted
**And** the modal closes and the UI transitions to normal state
**And** the `session_ready` handler is the same handler used for initial auth — no separate code path

**Given** re-auth fails (e.g., network error during auth)
**When** the auth browser encounters an error
**Then** an error is shown within the modal with a "Retry" option

**Given** the re-auth modal
**When** inspecting implementation
**Then** structure is in `ui/data/ui/reauth-dialog.blp` with Python wiring in `ui/src/protondrive/widgets/reauth_dialog.py`

---

## Story 5.3: Change Queue Replay After Re-Auth

As a user,
I want my queued changes to sync automatically after I re-authenticate,
So that I don't lose any work that happened while my session was expired.

**Acceptance Criteria:**

**Given** re-auth completes successfully (`session_ready` received)
**When** queued changes exist in the `change_queue` table
**Then** the engine replays them against the current remote state

**Given** a queued file where only the local version changed (remote mtime unchanged since last sync)
**When** the queue replays
**Then** the file is uploaded without creating a conflict copy — no false conflicts (FR17)

**Given** a queued file where both local and remote changed since last sync
**When** the queue replays
**Then** a conflict copy is created following the standard conflict pattern (Epic 4)

**Given** all queued changes are replayed
**When** the replay completes
**Then** successfully synced entries are removed from the `change_queue` table
**And** the `StatusFooterBar` shows "N files synced" toast

---

## Story 5.4: Dirty-Session Flag & Crash Recovery

As a user,
I want the app to recover cleanly from crashes without losing data or requiring manual cleanup,
So that I can trust the app even if something goes wrong.

**Acceptance Criteria:**

**Given** a sync operation begins
**When** the engine starts processing
**Then** a dirty-session flag is set in the StateDB (e.g., `PRAGMA user_version` metadata or a `session_state` table entry)

**Given** a sync operation completes normally
**When** the operation finishes
**Then** the dirty-session flag is cleared

**Given** the engine starts and detects a dirty-session flag
**When** initialization runs
**Then** the engine scans for incomplete `.dl-tmp-*` files at sync pair paths
**And** any found `.dl-tmp-*` files are deleted (they are incomplete downloads)
**And** the dirty-session flag is cleared
**And** crash recovery is resolved before the first sync operation begins (NFR16)

**Given** crash recovery completes
**When** the UI is informed
**Then** a transient toast notification is shown: "Recovered from unexpected shutdown — sync resuming" (FR44)
**And** no user action is required — recovery is automatic

**Given** the crash recovery process
**When** inspecting sync state after recovery
**Then** sync pairs are intact, token is present, last-known mtimes are preserved in SQLite, no partial files at destination paths (NFR16)

---

## Story 5.5: Actionable Error - Disk Full

As a user,
I want a clear message when sync fails because my disk is full,
So that I know exactly what to do to fix it.

**Acceptance Criteria:**

**Given** the sync engine encounters a disk full error during file write
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "DISK_FULL", message: "Free up space on [drive] to continue syncing", pair_id}`

**Given** the UI receives a `DISK_FULL` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card (non-fatal — not an app-level banner)
**And** the error message identifies the cause and provides one actionable next step

---

## Story 5.6: Actionable Error - Permission Denied

As a user,
I want a clear message when sync fails due to folder permissions,
So that I can fix the permissions and resume syncing.

**Acceptance Criteria:**

**Given** the sync engine encounters a permission denied error when reading/writing a file
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "PERMISSION_DENIED", message: "Check folder permissions for [path]", pair_id}`

**Given** the UI receives a `PERMISSION_DENIED` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card

---

## Story 5.7: Actionable Error - inotify Limit Exceeded

As a user,
I want a clear message when the system can't watch all my files,
So that I understand the limitation and know how to fix it.

**Acceptance Criteria:**

**Given** the inotify watcher encounters `ENOSPC` (watch limit exceeded)
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "INOTIFY_LIMIT", message: "Too many files to watch — close other apps or increase system inotify limit", pair_id}`

**Given** the UI receives an `INOTIFY_LIMIT` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card
**And** the watcher continues operating on already-registered directories — no crash

---

## Story 5.8: Actionable Error - File Locked

As a user,
I want to know when a file can't sync because it's in use by another program,
So that I understand the sync will retry automatically.

**Acceptance Criteria:**

**Given** the sync engine encounters a file locked error (EBUSY or similar)
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "FILE_LOCKED", message: "[file] is in use — sync will retry when it's released", pair_id}`

**Given** the UI receives a `FILE_LOCKED` error event
**When** rendering the error
**Then** the error is displayed inline on the affected sync pair card
**And** the engine retries the file on the next sync cycle

---

## Story 5.9: Actionable Error - SDK/API Error & Error State Components

As a user,
I want a clear message for unexpected sync errors,
So that I have a starting point for troubleshooting.

**Acceptance Criteria:**

**Given** the sync engine encounters an SDK or API error not covered by other error categories
**When** the error is processed
**Then** an `error` push event is emitted with `{code: "SDK_ERROR", message: "Sync error [code] — try again or check ProtonDrive status", pair_id}`

**Given** the UI receives any non-fatal error event with a `pair_id`
**When** rendering the error
**Then** the affected `SyncPairRow` shows a red dot with accessible label "[pair name] — error"
**And** the `StatusFooterBar` shows "Sync error in [pair name]" with a red dot
**And** the error priority is highest: Error > Conflict > Syncing > Offline > All synced

**Given** a fatal error (engine crash — socket close without `shutdown` command)
**When** the UI detects it
**Then** an app-level error banner with a restart button is shown — NOT the inline pair card error

**Given** the error state components
**When** a screen reader reads the sidebar and footer
**Then** pair error state is announced: "[pair name] — error"
**And** footer announces "Sync error in [pair name]"

---
