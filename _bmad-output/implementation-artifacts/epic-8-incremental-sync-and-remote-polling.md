# Epic 8: Incremental Sync & Remote Change Polling

## Problem Statement

After the first sync, every subsequent app startup re-walks the entire remote tree from scratch for every sync pair. For large repositories (e.g. a Documents folder containing a git repo, GnuCash files, and Home Assistant configs), this takes minutes to hours and triggers HTTP 429 rate limits on Proton's public-keys endpoint for pre-2024 nodes.

This forces users to leave the app running permanently to avoid the startup penalty — the opposite of expected desktop app behaviour.

Additionally, while the app is running, remote changes made on ProtonDrive Web or another device are only detected at the next startup. There is no live remote-change detection.

## User Goal

> "After my first sync, restarting the app should be fast. And if I change a file on ProtonDrive Web, I want it to appear on my Linux machine within a minute — not only after the next time I relaunch the app."

## Success Criteria

- **Fast startup**: after first run, reconciliation at next launch completes in seconds regardless of repository size
- **Live remote changes**: a file edited on ProtonDrive Web appears locally within ~1 minute while the app is open
- **No regression**: local-side sync (inotify) and conflict detection are unaffected
- **First run per pair**: full tree walk happens when a pair has no saved event ID — on clean install or when a new pair is added; all subsequent startups for that pair use the delta path

## Out of Scope

- Background sync without the app window open (tray icon) — separate future epic
- Sub-second real-time sync
- `x-pm-appversion` header correction — deferred to story 8-2 after Proton SDK team confirmation

## Technical Approach

The SDK ships `VolumeEventManager` with `getEvents(eventId)` and `getLatestEventId()`. The same mechanism covers both use cases:

1. **Startup delta** — at launch, call `getEvents(last_saved_event_id)` instead of full tree walk; process only `NodeCreated / NodeUpdated / NodeDeleted` events; fall back to full walk on `TreeRefresh`
2. **Polling loop** — while the app is running, call `getEvents(current_event_id)` every ~30 seconds to pick up remote changes made since last check

Both paths update the persisted `last_event_id` in the state DB after each successful pass.

## Stories

| ID | Title | Status |
|----|-------|--------|
| 8-1 | Event-based incremental reconciliation (startup delta) | backlog |
| 8-2 | Remote change polling loop (live detection while running) | backlog |
| 8-3 | `x-pm-appversion` header correction | deferred |
| 8-4 | Actionable decryption error UX | backlog |

## Dependencies & Risks

- **SDK stability**: `VolumeEventManager` is in the SDK dist but not re-exported from its public `index.js`. Confirm with Proton SDK team it is a supported interface before building on it. If not supported, an alternative approach (e.g. polling folder `ModifiedAt` timestamps) would be needed.
- **Event log retention window (unknown)**: if the app is closed longer than Proton's retention window, `getEvents(saved_id)` returns `TreeRefresh` and the engine falls back to a full walk — silently losing the fast-startup benefit for that session. No data loss, but UX degrades. The retention period is undocumented; must be confirmed with the SDK team. If the window is short (e.g. 3–7 days), users who open the app after a long absence will still experience the slow startup.
- **Pre-2024 node 429s**: incremental sync reduces but may not eliminate 429s on first run. Tracked as a separate question to the SDK team (public key caching).
- **SDK is pre-release**: version-pinned at `^0.14.3`; treat every bump as potentially breaking.

## Notes

- SDK compliance: Proton's technical requirements state "Use event-based sync — do not poll the API or perform frequent recursive traversals of the file tree." Epic 8 brings the client into compliance, but UX improvement is the primary driver.
- Epic does not require Proton SDK team confirmation to begin story 8-1 in development, but the story should not ship to Flathub until confirmation is received.
