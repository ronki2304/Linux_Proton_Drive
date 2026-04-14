# Epic 6: Multi-Pair Management & Validation

User can confidently manage multiple sync pairs — add subsequent pairs from the main window without re-running the wizard, remove pairs with explicit no-delete confirmation, and trust that nesting/overlap validation prevents configuration errors. Missing local folders are detected and recoverable.

## Story 6.1: Add Subsequent Sync Pair

As a user,
I want to add more sync pairs from the main window at any time,
So that I can sync multiple folders without re-running the setup wizard.

**Acceptance Criteria:**

**Given** the main window is displaying with at least one existing sync pair
**When** the user clicks "[+ Add Pair]" pinned at the bottom of the sidebar
**Then** a lightweight add-pair flow opens — no wizard chrome (FR9)
**And** it shows the XDG File Chooser portal for local folder selection, then the RemoteFolderPicker for remote folder selection

**Given** the user confirms the new pair
**When** the `add_pair` IPC command is sent
**Then** the engine generates a new `pair_id` (UUID v4), stores the pair in SQLite, and returns it in `add_pair_result`
**And** the pair is added to `config.yaml`
**And** the new pair appears in the sidebar immediately and sync starts

**Given** the user has multiple sync pairs configured
**When** managing them
**Then** at least 5 independent sync pairs can operate simultaneously (FR10)
**And** each pair syncs independently — an error in one pair does not affect others

**Given** the add-pair flow
**When** navigating via keyboard
**Then** all inputs and buttons are reachable via Tab and actionable via Enter/Space

---

## Story 6.2: Nesting & Overlap Validation

As a user,
I want the app to prevent me from creating sync pairs that overlap or nest inside each other,
So that I don't accidentally cause duplicate syncing or file conflicts.

**Acceptance Criteria:**

**Given** the user attempts to add a new sync pair
**When** the new local path is inside an existing pair's local path
**Then** the pair is rejected with inline error: "This folder is inside your '[existing pair name]' sync pair — syncing a subfolder separately would cause duplicate files" (UX-DR14)

**Given** the user attempts to add a new sync pair
**When** an existing pair's local path is inside the new local path
**Then** the pair is rejected with inline error naming the conflicting pair and explaining the overlap risk

**Given** the user attempts to add a new sync pair
**When** the new remote path is inside an existing pair's remote path
**Then** the pair is rejected with inline error naming the conflicting pair

**Given** the user attempts to add a new sync pair
**When** the new remote path points to the same remote folder as an existing pair
**Then** the pair is rejected with inline error: "Already in use by [pair name]"

**Given** validation errors
**When** they are displayed
**Then** errors are shown inline below the relevant field — never a separate error dialog
**And** errors name the specific conflicting pair and suggest a resolution

**Given** all four validation checks
**When** they run
**Then** they execute at confirmation time, not on every keystroke

---

## Story 6.3: Remove Sync Pair with Confirmation

As a user,
I want to remove a sync pair with a clear confirmation that no files will be deleted,
So that I can reorganize my sync setup without fear of data loss.

**Acceptance Criteria:**

**Given** the user clicks "Remove pair" in the detail panel
**When** the confirmation dialog appears
**Then** it is an `AdwAlertDialog` with heading "Stop syncing this folder pair?" and body: "Local files in `[local path]` will not be affected. Remote files in `ProtonDrive/[remote path]` will not be affected. Sync will simply stop." (FR12, UX-DR15)
**And** two buttons: "Cancel" (default/escape, suggested-action style) and "Remove" (destructive-action style)

**Given** the user confirms removal
**When** the removal is processed
**Then** the `remove_pair` IPC command is sent with `{pair_id}`
**And** the pair is removed from SQLite and `config.yaml`
**And** local files remain untouched (FR11)
**And** remote files remain untouched
**And** the pair disappears from the sidebar

**Given** the "Remove pair" button
**When** inspecting its position relative to other buttons
**Then** it is never adjacent to a primary (suggested-action) button — always separated by distance or a divider (UX-DR17)

**Given** only one pair exists and is removed
**When** the sidebar is empty
**Then** the detail area shows the `AdwStatusPage` empty state: "Add your first sync pair to start syncing"

---

## Story 6.4: Local Folder Missing Detection & Recovery

As a user,
I want the app to detect when my synced local folder has been moved or deleted,
So that I can fix the issue instead of the pair silently failing.

**Acceptance Criteria:**

**Given** a sync pair's local folder path no longer exists on the filesystem
**When** the engine detects this (at startup or during a sync cycle)
**Then** the affected pair shows a dedicated error state in the sidebar — not a global error (FR45)

**Given** the missing folder error state
**When** the detail panel renders for the affected pair
**Then** it displays: "Local folder not found at `[path]`. Was it moved?" with two action buttons: "Update path" and "Remove pair"

**Given** the user clicks "Update path"
**When** the action is triggered
**Then** the XDG File Chooser portal opens for the user to select a new local folder
**And** on selection, the pair's `local_path` is updated in both SQLite and `config.yaml`
**And** sync resumes with the new path

**Given** the user clicks "Remove pair"
**When** the action is triggered
**Then** the standard removal confirmation dialog from Story 6.3 is shown

**Given** a missing folder
**When** the pair is displayed in the sidebar
**Then** the `SyncPairRow` shows a dedicated error indicator (distinct from sync errors)
**And** the pair is never silently dropped from the list

---
