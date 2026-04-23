# Story 8.4: Actionable Decryption Error UX

Status: backlog

## Context

When the engine cannot decrypt a sync pair's remote folder — because a user private key failed to unlock (e.g. after a Proton password change that left old folder node keys sealed with a retired key) — the UI currently shows:

- Sidebar: red dot + "Sync error" (no detail)
- Detail panel error banner: raw SDK string `"Decryption error"` (not actionable)
- Footer: "Sync error in N pairs" (no guidance)

The user has no indication of what caused the error, which pairs are affected for what reason, or what action to take. In a multi-pair setup this is especially confusing: some pairs sync fine while others are silently broken.

Diagnosed during live testing: `[ENGINE] key decrypt failure (user keys): Error decrypting private key: Incorrect key passphrase` followed by `[ENGINE] decrypted 1/2 user keys`. The pair whose remote node key is sealed with the failed key enters permanent error state.

**User action that resolves this:** open `drive.proton.me` in a browser and browse the affected folder — Proton's web client re-wraps old node keys with the current active key, after which the Linux client can decrypt on the next sync cycle.

## Story

As a user with multiple sync pairs,
I want to see a clear, actionable message when a folder cannot be decrypted,
so that I know exactly which pair is affected and what to do — without needing to read engine logs.

## Acceptance Criteria

### AC1 — Engine detects key decrypt failure at startup and emits a session-level warning

**Given** `fetchAndDecryptKeys` decrypts fewer keys than the total available (`decrypted.length < allKeys.length`)
**When** the engine finishes key loading
**Then** a boolean `this._hasKeyDecryptionFailure = true` is set on the SDK/engine instance
**And** the engine emits `{ type: "key_decrypt_warning", payload: { decrypted: N, total: M } }` immediately after key loading
**And** `[ENGINE] key decrypt failure (user keys): ...` is still logged as today

### AC1b — UI shows a session-level warning banner on key decrypt failure

**Given** the engine emits `key_decrypt_warning`
**When** the UI receives it
**Then** a persistent `Adw.Banner` at the top of the main window (above the pair list) is revealed with the title:
```
"One or more account keys could not be unlocked — some folders may be inaccessible. Open Proton Drive in your browser to restore access."
```
**And** the banner has a button labelled `"Open Browser"` that launches `https://drive.proton.me` via `Gio.AppInfo.launch_default_for_uri`
**And** the banner is dismissed automatically when the engine emits `sync_complete` for a previously-errored pair that is now clean (indicating the key is now accessible)
**And** the banner persists across pair selection changes (it is a session-level indicator, not per-pair)

### AC2 — `reconcilePair` detects `Decryption error` and emits an actionable message

**Given** `reconcilePair` throws an error whose message is `"Decryption error"` (case-insensitive match)
**When** the reconcile catch block handles it
**Then** instead of emitting the raw SDK string, it emits:
```
"Could not decrypt folder contents — open Proton Drive in your browser and browse this folder to restore access"
```
**And** the event type remains `{ type: "error", payload: { code: "sync_cycle_error", message: <above>, pair_id: ... } }`

**Given** `reconcilePair` throws any other non-network, non-auth error
**When** the catch block handles it
**Then** the existing generic message path is unchanged

### AC3 — Sidebar pair row subtitle shows a short error reason

**Given** a pair transitions to `"error"` state via `row.set_state("error")`
**When** the state is set
**Then** the row subtitle shows `"Sync error · Decryption"` (for decryption errors) or `"Sync error · <short reason>"` for other known codes
**And** for unknown errors the subtitle falls back to `"Sync error"` (current behaviour)

**Implementation note:** `set_state("error")` gains an optional `reason: str = ""` parameter; `window.py` extracts a short label from the stored message and passes it through.

### AC4 — Detail panel error banner shows the actionable message

**Given** a pair is in decryption error state and the user selects it
**When** the detail panel opens
**Then** `error_banner` title is set to the full actionable message from AC2
**And** the banner is revealed (existing behaviour via `set_error_state`)

This AC is satisfied automatically if AC2 produces the correct message string — no new wiring needed beyond what Story 6-0d already ships.

### AC5 — Retry button in the detail panel error banner

**Given** a pair's error banner is visible
**When** the user clicks "Retry"
**Then** the engine receives a `start_sync` IPC command scoped to that pair's `pair_id`
**And** the banner hides and the row transitions to `"syncing"` state immediately (optimistic)
**And** if the retry cycle also fails, the error banner reappears with the same message

**Implementation note:** `error_banner` (an `Adw.Banner`) supports a button label via `set_button_label`. Add `"Retry"` label and connect `response` signal → IPC `start_sync { pair_id }`. Engine already handles `start_sync` for individual pairs.

### AC6 — Error clears automatically after a clean cycle

**Given** the user opens the affected folder in the Proton Drive web client (re-wrapping the node key)
**And** the engine starts a new sync cycle (via polling or app restart)
**When** `reconcilePair` succeeds for that pair
**Then** `on_sync_complete` fires a clean cycle → error state clears as per Story 6-0d's existing logic
**And** the sidebar row returns to `"synced"` and the banner hides

No new code needed — this is existing behaviour; stated here to define the expected end-to-end flow.

### AC7 — Footer message unchanged

The footer already shows "Sync error in N pairs" — no change needed. This story does not alter footer behaviour.

### AC8 — Tests

**Given** all AC1–AC5 changes
**When** the story ships
**Then**:
- `engine/src/sdk.test.ts` — new test: `fetchAndDecryptKeys` partial failure sets `_hasKeyDecryptionFailure` and emits `key_decrypt_warning` with correct counts
- `engine/src/sync-engine.test.ts` — new test: `reconcilePair` receiving `Error("Decryption error")` emits `sync_cycle_error` with the AC2 message string
- `ui/tests/test_window_routing.py` — new test: `key_decrypt_warning` event → session banner revealed with correct title; `on_pair_error` called with AC2 message string → `row.set_state` receives correct short reason label (AC3)
- `ui/tests/test_pair_detail_panel.py` — new test: `set_error_state` with AC2 message → banner title matches; Retry button present
- `bun test` and `.venv/bin/pytest ui/tests/` pass with zero failures and zero regressions

### AC9 — Story stops at `review`

## Tasks / Subtasks

- [ ] **T1 — Engine: decryption-aware error message** (`engine/src/sync-engine.ts`)
  - [ ] In reconcile catch block, detect `err.message` matching `/decryption error/i`
  - [ ] Substitute actionable message string (AC2)
  - [ ] Unit test in `sync-engine.test.ts`

- [ ] **T2 — Engine: key decrypt failure flag + event** (`engine/src/sdk.ts`, `engine/src/sync-engine.ts`)
  - [ ] Set `this._hasKeyDecryptionFailure` when `decrypted.length < allKeys.length` (AC1)
  - [ ] Emit `{ type: "key_decrypt_warning", payload: { decrypted: N, total: M } }` after key loading (AC1)
  - [ ] Unit test in `sdk.test.ts`

- [ ] **T2b — UI: session-level key warning banner** (`ui/src/protondrive/window.py`)
  - [ ] Add `key_warning_banner: Adw.Banner` to main window (above pair list)
  - [ ] Handle `key_decrypt_warning` IPC event → reveal banner with AC1b title and "Open Browser" button
  - [ ] "Open Browser" button → `Gio.AppInfo.launch_default_for_uri("https://drive.proton.me")`
  - [ ] Auto-dismiss banner when a previously-errored pair completes a clean cycle
  - [ ] Unit test in `test_window_routing.py`

- [ ] **T3 — UI: sidebar row short reason** (`ui/src/protondrive/widgets/sync_pair_row.py`, `window.py`)
  - [ ] Add optional `reason: str = ""` to `set_state("error", reason=...)`
  - [ ] Extract short label from message in `window.py` `on_pair_error`
  - [ ] Render as subtitle in pair row (AC3)
  - [ ] Unit test

- [ ] **T4 — UI: Retry button in error banner** (`ui/src/protondrive/widgets/pair_detail_panel.py`)
  - [ ] Set `error_banner.set_button_label("Retry")`
  - [ ] Connect `response` signal → IPC `start_sync { pair_id }`
  - [ ] Optimistic state reset: hide banner, set row to syncing (AC5)
  - [ ] Unit test

- [ ] **T5 — Run full test suite; confirm zero regressions**

## Dev Agent Record

_To be filled by implementing agent._

## File List

_To be filled by implementing agent._
