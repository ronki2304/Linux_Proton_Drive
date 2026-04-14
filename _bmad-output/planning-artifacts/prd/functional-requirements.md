# Functional Requirements

## Authentication & Session Management

- **FR1:** User can authenticate with ProtonDrive via an embedded browser on first launch or after logout — the browser handles CAPTCHA and 2FA
- **FR2:** User can view their ProtonDrive account overview (account name, storage used) after successful authentication
- **FR3:** The system validates the stored session token silently on launch and prompts re-authentication immediately if it has expired
- **FR4:** User is prompted to re-authenticate when their session token expires during an active session, without losing queued local changes
- **FR5:** User can see the count of queued local changes pending sync within the re-authentication prompt
- **FR6:** User can log out; the session token is removed and locally synced files are preserved
- **FR7:** User can view their ProtonDrive account info (name, storage, plan) at any time from within the application

## Sync Pair Management

- **FR8:** User completes first sync pair setup on first launch via a step-by-step onboarding wizard (authenticate → select local folder → select remote folder → confirm and start sync)
- **FR9:** User can add a new sync pair (local folder ↔ ProtonDrive folder) from the main application window at any time after first run
- **FR10:** User can manage at least 5 independent sync pairs simultaneously
- **FR11:** User can remove a sync pair without affecting local or remote files
- **FR12:** User sees an explicit confirmation when removing a sync pair, stating no files will be deleted on either side

## Sync Engine & File Operations

- **FR13:** The system routes to the first-run onboarding wizard when no valid session token is stored; any other state — including an authenticated session with no sync pairs configured — routes to the main application screen
- **FR14:** The system syncs file changes two-way continuously while the app is open
- **FR15:** The system displays first-sync progress including file count, bytes transferred, and estimated time remaining
- **FR16:** The system queues local file changes made while offline or during session expiry
- **FR17:** The system replays queued local changes on reconnect by fetching current remote metadata (mtime) for each queued file and comparing against the remote mtime stored at last sync; files changed only locally are uploaded without conflict; files changed on both sides since the last sync point trigger the conflict copy pattern
- **FR18:** The system displays global sync status including in-progress operations and last synced timestamp
- **FR19:** The system displays per-pair sync status including last synced time, in-progress state, and conflict state for each sync pair
- **FR20:** The system displays an offline state and last-synced timestamp when the app opens with no network available
- **FR21:** The system shows an offline indicator and queues changes when network drops mid-session
- **FR22:** The system resumes sync automatically when network becomes available, without user action
- **FR23:** The system applies exponential backoff when rate-limited by the API and surfaces the rate-limited state to the user
- **FR24:** The system shows a specific error message with an actionable resolution when sync fails for reasons other than network or auth. Known failure categories and expected messages: disk full ("Free up space on [drive] to continue syncing"), permission denied ("Check folder permissions for [path]"), inotify watch limit exceeded ("Too many files to watch — close other apps or increase system inotify limit"), file locked by another process ("[file] is in use — sync will retry when it's released"), SDK/API error ("Sync error [code] — try again or check ProtonDrive status"). Each error message identifies the cause and provides one actionable next step

## Conflict Management

- **FR25:** The system detects sync conflicts by comparing the current local mtime against the stored local mtime at last sync, and the current remote mtime against the stored remote mtime at last sync; where mtime resolution is ambiguous (same-second modification), the system falls back to a locally-computed content hash compared against the hash stored at last sync — no live remote fetch is performed for conflict detection
- **FR25a:** Files with no StateDB entry (never previously synced) are checked for remote path collisions before upload; if a remote file exists at the same relative path, the local file is renamed to `filename.ext.conflict-YYYY-MM-DD`, both versions are preserved, and the user is notified — consistent with the standard conflict copy pattern
- **FR26:** The system creates a conflict copy named `filename.ext.conflict-YYYY-MM-DD` — never silently overwrites
- **FR27:** User is notified in-app when one or more sync conflicts occur
- **FR27a:** The system sends a desktop notification when a sync conflict is detected while the application window is open (foreground notification — does not require the background daemon)
- **FR28:** User can view a log of all sync conflicts within the application
- **FR29:** User can locate conflict copies from within the application without opening a file manager; the conflict log provides a "Reveal in Files" action for each entry, implemented via `org.freedesktop.portal.OpenURI`

## Background Sync & Notifications *(V1)*

*Background sync daemon, system tray, and background notifications are coupled — they ship together in V1.*

- **FR30:** The system continues syncing files in the background after the main window is closed *(V1)*
- **FR31:** User can approve the application's request to run in the background via the system Background Portal *(V1)*
- **FR32:** User can view sync status from the system tray without opening the main window *(V1)*
- **FR33:** User receives desktop notifications for sync events and conflicts that occur while the app window is closed *(V1 — background notifications; foreground notifications covered by FR27a)*
- **FR33a:** User can configure the maximum number of concurrent file transfers from application settings *(V1)*

## Security & Credential Management

- **FR34:** The system stores the ProtonDrive session token via the OS credential store and reuses it on subsequent launches without requiring re-authentication
- **FR35:** The system falls back to an encrypted local credential store if the OS credential store is unavailable
- **FR36:** The system surfaces an explicit error if no credential storage method is available
- **FR37:** The system makes no network connections of its own — all network I/O is delegated to the ProtonDrive SDK

## Application & Platform

- **FR38:** User can select sync folders via the system file chooser dialog
- **FR39:** The application window size and position are preserved between sessions
- **FR40:** The system respects system proxy settings for all network operations
- **FR41:** The application source code is publicly available under MIT license
- **FR42:** The application receives updates exclusively through Flathub — no in-app update mechanism
