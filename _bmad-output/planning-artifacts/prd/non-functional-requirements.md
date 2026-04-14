# Non-Functional Requirements

## Performance

- **NFR1:** The application UI is ready for user interaction (main window rendered, stored token loaded from credential store) within 3 seconds of launch — independent of network availability or API response time
- **NFR2:** User interface interactions (button presses, navigation, dialog opens) respond within 200ms — the UI must never block on sync engine operations
- **NFR3:** Local file change detection (inotify event to sync queue entry) completes within 5 seconds of a file being modified — measured after initial inotify watch tree setup is complete
- **NFR3a:** inotify watch tree initialisation runs asynchronously and does not block user interaction; the UI remains responsive (NFR2) throughout watch tree setup; sync status shows a "Initializing file watcher…" indicator while setup is in progress
- **NFR4:** When not throttled or paused, sync throughput is limited only by network bandwidth and SDK capacity; the sync engine caps concurrent file transfers at a default maximum of 3 (user-configurable in V1 via FR33a) to bound CPU and memory usage under load
- **NFR5:** Application memory footprint during steady-state sync (no active transfers, inotify watches active) for a folder tree with up to 10,000 files does not exceed 150MB RSS

## Security

- **NFR6:** The session token must not appear in any log output, stdout, stderr, crash dump, or debug trace under any circumstances
- **NFR7:** The credential file (fallback store) must have `0600` permissions set before any content is written
- **NFR8:** The localhost auth server must bind exclusively to `127.0.0.1` on a randomly assigned ephemeral port and close immediately after the auth callback is received
- **NFR9:** No decrypted file content or file paths appear in any persistent log or diagnostic output
- **NFR10:** The application contains no HTTP client code outside `src/sdk/` — verifiable by static analysis (grep for network/fetch imports outside the SDK boundary)

## Reliability

- **NFR11:** Zero file data loss — a conflict copy must always be created before any local file is overwritten; this must hold across app restarts, network interruptions, and session expiry
- **NFR12:** All file writes use atomic rename (write to `.dl-tmp-<timestamp>-<random>`, then `rename()` on success) — partial writes must never appear at the destination path
- **NFR13:** The sync engine verifies file integrity after download before committing to the destination path — a corrupted download must not silently replace the user's file; integrity is verified using the SDK-returned content hash where available, falling back to a locally-computed hash; the specific mechanism is determined during SDK integration
- **NFR14:** The local change queue is persisted to disk and survives application crashes — no queued change is silently lost on unexpected termination
- **NFR15:** Sync state (last-known local mtime, remote mtime, and optional content hash per file per sync pair) is written to SQLite before a sync operation is considered complete — no in-memory-only state
- **NFR16:** The application recovers to a consistent sync state after a crash without user intervention — consistent state defined as: sync pairs intact, token present, last-known mtime preserved in SQLite, no partial files at destination paths; crash recovery is detected by the presence of incomplete `.dl-tmp-*` files at startup or a dirty-session flag in the state DB, and resolved before the first sync operation begins
- **NFR17:** Auth failure (401) is detected within one failed sync attempt; the sync engine immediately halts and triggers re-auth — no silent 401 retry

## Accessibility

- **NFR18:** The application exposes a complete AT-SPI2 accessibility tree — all interactive elements are reachable and operable by the Orca screen reader
- **NFR19:** All application functions are fully operable via keyboard navigation — no capability requires a pointer device
- **NFR20:** Text contrast ratios meet WCAG AA minimum (4.5:1 for body text, 3:1 for large text) — Libadwaita's default palette satisfies this; any custom colour usage must not regress it

## Open Questions

- **Pause/resume sync:** deferred — SDK does not expose interruption points for in-flight transfers; architecture phase confirmed no clean mechanism; revisit if SDK adds cancellation support in a future release
- **Bandwidth throttling (byte-rate):** deferred to V1+ — requires SDK rate-control support not yet available; concurrency-based throttling is resolved (NFR4: default cap of 3, user-configurable in V1); byte-rate throttling will be evaluated when SDK exposes rate controls
