# Epic 3: Offline Resilience & Network Handling

User always knows when they're offline, changes queue automatically and persist to disk, and sync resumes without user action when network returns. Rate limiting is surfaced visibly. The app never appears frozen or broken during network disruptions.

## Story 3.1: Offline Detection & UI Indicators

As a user,
I want to clearly see when the app is offline,
So that I understand why sync isn't happening and trust that my changes are safe.

**Acceptance Criteria:**

**Given** the app launches with no network available
**When** the main window renders
**Then** an offline banner is displayed with last-synced timestamps per pair — never a blank screen or hanging spinner (FR20)
**And** the `StatusFooterBar` shows "Offline — changes queued" with a grey dot

**Given** the network drops mid-session
**When** the engine detects the loss
**Then** the engine emits an `offline` push event
**And** the UI immediately shows an offline indicator (FR21)
**And** each `SyncPairRow` in the sidebar shifts to the offline state: grey dot with accessible label "[pair name] — offline"

**Given** the network is restored
**When** the engine detects connectivity
**Then** the engine emits an `online` push event
**And** the UI clears the offline indicator and pair rows return to their previous states

**Given** the offline state
**When** a screen reader reads the sidebar
**Then** each pair announces its offline state: "Documents — offline"
**And** the `StatusFooterBar` announces "Offline — changes queued" via AT-SPI2 (polite)

---

## Story 3.2: Offline Change Queue (Persistent)

As a user,
I want my local file changes to be queued while offline,
So that nothing is lost and changes sync when the connection returns.

**Acceptance Criteria:**

**Given** the app is offline (network unavailable or session expired)
**When** local files are modified in a watched sync pair folder
**Then** the changes are added to the `change_queue` table in SQLite (FR16)
**And** the queue is persisted to disk — survives application crashes (NFR14)

**Given** the change queue has entries
**When** the UI queries status via `get_status`
**Then** the response includes the count of queued changes per pair

**Given** the app crashes while offline with queued changes
**When** the app restarts
**Then** all previously queued changes are still present in the `change_queue` table
**And** no queued change is silently lost

**Given** the change queue
**When** inspecting the storage
**Then** each entry records: `pair_id`, `relative_path`, `change_type` (created/modified/deleted), `queued_at` (ISO 8601)

---

## Story 3.3: Queue Replay & Auto-Resume on Reconnect

As a user,
I want my queued changes to sync automatically when the connection returns,
So that I don't have to manually trigger sync after being offline.

**Acceptance Criteria:**

**Given** the network is restored after an offline period
**When** the engine receives the `online` event
**Then** sync resumes automatically without user action (FR22)

**Given** queued local changes exist
**When** the queue is replayed
**Then** for each queued file, the engine fetches the current remote metadata (mtime) and compares it against the remote mtime stored at last sync (FR17)
**And** files changed only locally (remote mtime unchanged since last sync) are uploaded without conflict
**And** files changed on both sides since the last sync point trigger the conflict copy pattern (deferred to Epic 4 for full implementation — in this story, both-sides-changed files are skipped and kept in the queue)
**And** for skipped files, the `StatusFooterBar` shows a temporary indicator: "N files need conflict resolution" so the user knows files are pending, not lost

**Given** the queue replay completes
**When** all queued changes are processed
**Then** successfully synced entries are removed from the `change_queue` table
**And** the `StatusFooterBar` updates to reflect the new sync state
**And** a toast "N files synced" is shown via `AdwToastOverlay` (auto-dismiss 3s)

**Given** queue replay
**When** a file in the queue no longer exists locally (deleted while offline)
**Then** the deletion is synced to the remote (if the remote file is unchanged since last sync)
**And** the queue entry is removed

---

## Story 3.4: Rate Limit Handling & UI

As a user,
I want to know when ProtonDrive is rate-limiting my sync,
So that I understand why sync is paused and know it will resume automatically.

**Acceptance Criteria:**

**Given** the SDK returns a 429 (rate limited) response
**When** the engine processes it
**Then** the engine applies exponential backoff on retries (FR23)
**And** emits a `rate_limited` push event with `{resume_in_seconds}`

**Given** the UI receives a `rate_limited` event
**When** rendering the rate-limited state
**Then** the `StatusFooterBar` shows "Sync paused — resuming in Xs" with a countdown or paused indicator
**And** the footer auto-clears when the engine resumes sync

**Given** the rate-limited state
**When** the countdown expires
**Then** the engine automatically retries the operation
**And** the UI transitions back to the syncing or synced state

**Given** the rate-limited state
**When** the user inspects the UI
**Then** no error is shown — rate limiting is presented as a temporary pause, not a failure

---
