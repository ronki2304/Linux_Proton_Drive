# Epic 8: SDK Compliance & Incremental Sync + Activity Log

User sees a live activity feed showing what the engine synced, and the sync engine uses event-driven incremental reconciliation instead of full-tree polling. The Details panel displays a scrollable list of the last 100 sync events with file name, direction, and timestamp — no blank screen.

## Story 8.1: Event-Based Incremental Reconciliation

As a developer,
I want the sync engine to reconcile using change events instead of full-tree polls,
So that sync is faster, uses less memory, and scales to large folder trees without degrading.

**Acceptance Criteria:**

**Given** a sync pair is active and a file changes locally or remotely
**When** the engine receives a change event (inotify locally, SDK event or poll delta remotely)
**Then** only the changed subtree is reconciled — not the full folder tree
**And** the engine does not re-walk unchanged directories

**Given** the engine starts up or reconnects after being offline
**When** the initial reconciliation pass runs
**Then** it performs a full-tree reconciliation to catch any missed changes
**And** subsequent reconciliations are event-driven

**Given** multiple rapid changes arrive in a short window
**When** the engine processes them
**Then** changes are debounced (coalesced within a short window, e.g. 500ms) before reconciling
**And** no change is silently dropped

**Given** an incremental reconciliation completes for a file
**When** the engine reports progress
**Then** a `reconcile_progress` IPC event is emitted with `{ pairId, phase, filesProcessed, filesTotal }`
**And** a `file_synced` IPC event is emitted per completed file with `{ pairId, fileName, direction: "upload" | "download", timestamp }`

**Given** the existing unit tests for the sync engine
**When** this story is complete
**Then** all existing tests continue to pass
**And** new unit tests cover: event debouncing, incremental-only reconciliation path, `reconcile_progress` emission, `file_synced` emission

---

## Story 8.2: IPC Activity Events

As a developer,
I want the engine to emit structured activity events over IPC,
So that the UI can display a live feed of what was synced without polling the engine.

**Acceptance Criteria:**

**Given** the IPC protocol definition
**When** this story is complete
**Then** two new event types are defined in the protocol schema:
  - `reconcile_progress`: `{ type: "reconcile_progress", pairId: string, phase: "scanning" | "uploading" | "downloading" | "idle", filesProcessed: number, filesTotal: number }`
  - `file_synced`: `{ type: "file_synced", pairId: string, fileName: string, direction: "upload" | "download", timestamp: string }` (ISO 8601)

**Given** the engine completes a file sync operation
**When** it emits a `file_synced` event
**Then** `fileName` is the bare file name (not the full path — no PII leakage)
**And** `direction` is `"upload"` for local→remote and `"download"` for remote→local
**And** `timestamp` is an ISO 8601 UTC string

**Given** the engine is in an incremental reconciliation pass
**When** it emits `reconcile_progress`
**Then** `phase` reflects the current operation
**And** `filesProcessed` / `filesTotal` are best-effort estimates (0/0 is valid when unknown)

**Given** the UI is not connected (engine running headless)
**When** the engine would emit these events
**Then** the events are emitted anyway — the IPC layer drops them if no listener

**Given** the existing IPC handler tests
**When** this story is complete
**Then** all existing tests continue to pass
**And** new unit tests cover: `file_synced` payload shape, `reconcile_progress` phase transitions

---

## Story 8-2a: Reconcile Progress — Clean State on Error

As a user,
I want the sync progress indicator to always reach a resting state even when a sync error occurs,
So that I never see a permanently spinning indicator after a failure.

**Background:** Story 8-2 implemented `reconcile_progress` phase events. On clean paths, `idle`
is the terminal phase — the only signal that truly clears the indicator. All other non-clean exits
leave the pair in a **paused** state: sync is halted but will resume when the blocking condition
is resolved. Two engine signals trigger the paused state:

- `{ type: "error", payload: { pair_id, code } }` — pair-scoped block (DISK_FULL, PERMISSION_DENIED,
  etc.). Indicator pauses until the user resolves the condition; the engine will retry and emit new
  phase events when sync resumes.
- `{ type: "token_expired" }` — session-wide auth expiry; ALL pair indicators pause. After re-auth
  the engine relaunches automatically and emits fresh `scanning` events that resume the indicators.
  No watchdog for this path — re-auth is the resume mechanism.

A watchdog (30s no update) acts as a safety net for paused pairs where the `error` signal may not
have been emitted (e.g. reconcilePair exception). The watchdog fully clears the indicator rather
than pausing it, since the root cause is unknown. It does NOT apply to `token_expired`-paused pairs.

**Acceptance Criteria:**

**Given** the engine emits `{ type: "error", payload: { pair_id, code } }` for a pair
**When** the UI receives it
**Then** the phase indicator for that `pair_id` transitions to a **paused** state (visually distinct
  from active and from idle — sync is blocked, not finished)
**And** the existing error state UI for that pair (error banner/row) explains why sync is paused
**And** when the engine resumes and emits `reconcile_progress { phase: "scanning"|"uploading"|"downloading" }`
  for that pair, the paused indicator transitions to active (watchdog resets)
**And** when the engine emits `reconcile_progress { phase: "idle" }` for that pair (clean cycle
  completed after retry), the indicator is fully cleared — `idle` exits pause the same as it exits
  active: it is the only true clean-finish terminal state

**Given** the engine emits `{ type: "token_expired" }`
**When** the UI receives it
**Then** the phase indicator for ALL active pairs transitions to a **paused** state (visually distinct
  from both active and idle — sync is halted, not finished)
**And** the re-auth modal (existing, Story 5-2) takes over
**And** when the engine restarts after re-auth it emits `reconcile_progress { phase: "scanning" }`
  which the normal event handler uses to transition paused → active — no special `session_ready`
  handling required in this story

**Given** a pair is in an active or paused phase (but NOT paused by `token_expired`)
**When** no `reconcile_progress` event for that pair has been received for 30 seconds
**Then** the UI fully clears the phase indicator (watchdog — safety net when cause is unknown)
**And** no error or paused state is shown (the watchdog clears silently)
**Note:** The watchdog is NOT armed for pairs paused by `token_expired` — re-auth auto-relaunches
sync and emits fresh phase events when the session resumes.

**Given** the UI later receives `{ type: "reconcile_progress", phase: "idle" }` for a pair whose
indicator was already cleared by an error event, token_expired, or the watchdog
**When** the UI processes the event
**Then** it is a no-op — the pair is already at rest, no visual change occurs

**Given** the UI test suite
**When** this story is complete
**Then** new tests cover:
  - `error` event for pair_id → indicator transitions to paused; watchdog armed
  - `reconcile_progress { phase: active }` after `error` → paused indicator resumes active (engine retried)
  - `reconcile_progress { phase: "idle" }` after `error` → indicator fully cleared (clean cycle completed)
  - `token_expired` → all pair indicators enter paused state; no watchdog set
  - `reconcile_progress { phase: "scanning" }` after `token_expired` → paused indicator transitions
    back to active (no special session_ready handler — the normal event flow covers it)
  - Watchdog fires after 30s without update → indicator fully cleared (not paused)
  - `reconcile_progress` event received → watchdog timer reset for that pair
  - `idle` → indicator cleared (the only true clean-finish terminal state)

---

## Story 8-4b: Actionable Decryption Error UX

As a user with multiple sync pairs,
I want to see a clear, actionable message when a folder cannot be decrypted,
so that I know exactly which pair is affected and what to do — without needing to read engine logs.

**Background:** When `fetchAndDecryptKeys` decrypts fewer keys than available (e.g. after a Proton password change that retired old node keys), affected pairs enter permanent error state with raw SDK string `"Decryption error"` — not actionable. User action that resolves this: open `drive.proton.me` and browse the affected folder so Proton's web client re-wraps old node keys.

**Acceptance Criteria:** See `_bmad-output/implementation-artifacts/8-4b-actionable-decryption-error-ux.md` for full spec (AC1–AC9, T1–T5).

---

## Story 8.5: License Alignment (GPL-3.0)

As a maintainer,
I want the project license declarations aligned with the GPL-3.0 requirement imposed by `@protontech/drive-sdk`,
So that the Flatpak submission passes Flathub license review and the distributed binary has accurate license metadata.

**Background:** `@protontech/drive-sdk@0.14.3` is GPL-3.0. Since `bun build --compile` embeds the SDK into the distributed binary, the combined work is a GPL-3.0 derivative. All other bundled runtime dependencies (bcryptjs, js-yaml, undici: MIT; openpgp: LGPL-3.0+) are GPL-3.0 compatible. No proprietary or AGPL dependencies were found in the 56-package audit.

**Acceptance Criteria:**

**Given** the root `LICENSE` file
**When** the story is complete
**Then** it contains the standard GNU General Public License Version 3 text
**And** the MIT license text is removed

**Given** `engine/package.json`
**When** the story is complete
**Then** `"license"` is `"GPL-3.0-only"`

**Given** `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
**When** the story is complete
**Then** `<project_license>GPL-3.0-only</project_license>` is declared
**And** `appstream-util validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` passes with no errors

**Given** `README.md`
**When** the story is complete
**Then** both MIT license badge occurrences are replaced with a GPL-3.0 badge:
  `[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)`
**And** the license section reads: `GPL-3.0-only — see [LICENSE](./LICENSE). Bundles @protontech/drive-sdk (GPL-3.0) and openpgp (LGPL-3.0+).`

**Given** the npm dependency audit
**When** the story is complete
**Then** a brief comment block exists in `CONTRIBUTING.md` under a "License" section documenting:
  - Project license: GPL-3.0-only
  - Reason: @protontech/drive-sdk is GPL-3.0; bundled binary is a GPL-3.0 derivative
  - Other runtime dep licenses: bcryptjs/js-yaml/undici (MIT), openpgp (LGPL-3.0+, compatible)
  - No proprietary or AGPL dependencies

**Given** the Flatpak build
**When** `flatpak-builder` runs after these changes
**Then** the build succeeds with no license-related warnings

---

## Story 8.3: Activity Feed UI

As a user,
I want to see a live activity feed in the Details panel showing what the app synced,
So that I know the app is working and can see which files were recently transferred.

**Acceptance Criteria:**

**Given** the Details panel is open and a file sync completes
**When** a `file_synced` IPC event arrives
**Then** a new row appears at the top of the activity feed within 1 second
**And** the row shows: file name, direction indicator (↑ upload / ↓ download), and a human-readable relative timestamp ("just now", "2 min ago")
**And** the feed keeps the last 100 items in memory — older items are discarded
**And** the feed is not persisted to disk (memory-only)

**Given** the Details panel is opened for the first time (no prior activity)
**When** no `file_synced` events have been received
**Then** the panel shows an empty-state message: "No recent activity. Files you sync will appear here."
**And** the panel is never a blank white rectangle

**Given** multiple sync pairs are active
**When** events arrive from different pairs
**Then** the activity feed shows events from all pairs interleaved by timestamp
**And** each row is labeled with its pair name (or local folder short name)

**Given** the activity feed has 100+ items
**When** a new event arrives
**Then** the oldest item is removed (ring buffer / capped list)
**And** the UI does not scroll-jump if the user has scrolled up to review history

**Given** a `reconcile_progress` event arrives with `phase: "scanning" | "uploading" | "downloading"`
**When** the engine is actively working
**Then** a spinner or subtle progress indicator appears at the top of the feed
**And** it disappears when any of the following occur:
  - `phase` transitions to `"idle"` for that pair
  - An `error` event is received for that pair (handled by Story 8-2a — indicator enters paused state)
  - The watchdog timer fires (30s without update, handled by Story 8-2a — indicator cleared silently)

**Given** the UI test suite
**When** this story is complete
**Then** new tests cover: activity row rendering, empty state, 100-item cap, multi-pair interleaving

---

## Story 8-6: SDK Client Identification — x-pm-appversion Header

As a maintainer,
I want all Proton API requests to carry the correct x-pm-appversion header,
So that the app accurately identifies itself and does not spoof another Proton client.

**Background:** `ProtonHTTPClient` in `sdk.ts` previously injected `"web-drive@5.0.0.0"` — the Proton web client's identity. Proton's API policy requires external clients to use the format `{client-id}@{version}` and prohibits spoofing or falsifying this value. This app's correct identity is `ronki230-ProtonDriveLinuxClient@{version}`.

**Acceptance Criteria:**

**Given** any Proton API request (`fetchJson` or `fetchBlob` to a `proton.me/drive` or `protonmail.com` host)
**When** the engine makes an API call
**Then** the `x-pm-appversion` header is set to `ronki230-ProtonDriveLinuxClient@{version}`
**And** `{version}` matches the `"version"` field in `engine/package.json`

**Given** a `fetchBlob` request to a storage host (e.g. `fra-storage.proton.me`)
**When** the engine uploads a file block
**Then** `x-pm-appversion` is NOT set (storage servers reject Proton API headers)

**Given** the string `"web-drive@5.0.0.0"` in the codebase
**When** this story is complete
**Then** it does not appear anywhere in `engine/src/`

**Given** the engine test suite
**When** this story is complete
**Then** new unit tests cover:
  - `fetchJson` path: `x-pm-appversion` header set to correct value
  - `fetchBlob` Proton-host path: `x-pm-appversion` header set to correct value
  - `fetchBlob` storage-host path: `x-pm-appversion` header absent
