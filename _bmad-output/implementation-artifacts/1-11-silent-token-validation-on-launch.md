# Story 1.11: Silent Token Validation on Launch

Status: ready-for-dev

## Story

As a returning user,
I want the app to automatically validate my stored token on launch,
so that I go straight to the main window without re-authenticating every time.

## Acceptance Criteria

1. **Given** the app launches and a session token is stored in the credential store, **when** the token is loaded, **then** it is sent to the engine via IPC `token_refresh` command without showing the auth browser.

2. **Given** the engine validates the token, **when** the SDK accepts it, **then** a `session_ready` event is emitted and the UI transitions to the main window (not the wizard).

3. **Given** the engine validates the token, **when** the SDK rejects it (expired or invalid), **then** the UI immediately shows the pre-auth screen for re-authentication (FR3), **and** no error banner is shown -- token expiry at launch is treated as a normal routing decision, not an error.

4. **Given** the app launches with no stored token, **when** the credential store is empty, **then** the UI routes to the first-run wizard (pre-auth screen).

## Tasks / Subtasks

- [ ] Task 1: Implement launch routing logic in `window.py` (AC: #1, #2, #3, #4)
  - [ ] 1.1 After engine `ready` event is received and protocol version validated (Story 1.5), check credential store for stored token via `auth.py` helper
  - [ ] 1.2 If token exists: send `token_refresh` IPC command to engine with the stored token; show `Gtk.Spinner` loading state (no browser, no wizard)
  - [ ] 1.3 If no token exists: route directly to pre-auth screen (first-run wizard landing)
  - [ ] 1.4 Handle `session_ready` event: transition to main window, store account info (display_name, email, storage_used, storage_total, plan) for header/settings
  - [ ] 1.5 Handle `token_expired` event during launch validation: route to pre-auth screen silently (no error banner, no toast)
  - [ ] 1.6 Ensure FR13 wizard resume: if token is valid (`session_ready` received) but no sync pairs exist (`get_status` returns empty `pairs[]`), check wizard state -- if wizard was interrupted after auth, resume at folder selection step; otherwise show main screen with empty state

- [ ] Task 2: Add token retrieval helper to `auth.py` (AC: #1)
  - [ ] 2.1 Add `get_stored_token() -> str | None` method that reads from libsecret (or fallback store per Story 1.6)
  - [ ] 2.2 Return `None` if no token stored or credential store unavailable -- caller treats this as "no token" routing case
  - [ ] 2.3 Token must never appear in logs, stdout, or stderr (NFR6)

- [ ] Task 3: Wire `token_refresh` command in `engine.py` IPC client (AC: #1, #2, #3)
  - [ ] 3.1 Add `send_token_refresh(token: str)` method to engine IPC client
  - [ ] 3.2 `token_refresh` is a special command: it does NOT return a `_result` -- response comes as push event (`session_ready` or `token_expired`); do NOT register a result callback for this command
  - [ ] 3.3 Ensure command includes UUID `id` field per protocol spec

- [ ] Task 4: Handle engine-side `token_refresh` command in `ipc.ts` (AC: #2, #3)
  - [ ] 4.1 Route incoming `token_refresh` command to `sdk.ts` `DriveClient` wrapper
  - [ ] 4.2 On SDK success: emit `session_ready` push event with `{display_name, email, storage_used, storage_total, plan}`
  - [ ] 4.3 On SDK rejection (401/expired): emit `token_expired` push event with `{queued_changes: 0}` (no queued changes at launch)
  - [ ] 4.4 Token must never appear in engine logs or error messages

- [ ] Task 5: Write UI tests for launch routing (AC: #1, #2, #3, #4)
  - [ ] 5.1 Test: stored token + `session_ready` response -> main window transition
  - [ ] 5.2 Test: stored token + `token_expired` response -> pre-auth screen, no error banner
  - [ ] 5.3 Test: no stored token -> pre-auth screen directly (no `token_refresh` sent)
  - [ ] 5.4 Test: `session_ready` with empty pairs + wizard-interrupted state -> wizard resumes at folder selection
  - [ ] 5.5 Test: `session_ready` with empty pairs + no wizard state -> main screen with empty state
  - [ ] 5.6 All tests mock IPC socket (never spawn real engine per project convention)

- [ ] Task 6: Write engine tests for `token_refresh` handling (AC: #2, #3)
  - [ ] 6.1 Test: valid token -> `session_ready` event emitted with account info
  - [ ] 6.2 Test: expired token -> `token_expired` event emitted
  - [ ] 6.3 Test: `token_refresh` does NOT produce a `_result` response
  - [ ] 6.4 Tests use `node:test` + `node:assert/strict`; mock `DriveClient` at SDK wrapper boundary

## Dev Notes

### Launch Routing Flow

The complete launch sequence is:

```
App start
  -> main.py: spawn engine (Story 1.4)
  -> engine.py: connect to IPC socket, receive `ready` event (Story 1.5)
  -> window.py: validate protocol_version
  -> window.py: send `get_status` (per Story 1.5 -- on every `ready`)
  -> auth.py: get_stored_token()
  -> BRANCH:
      A) Token exists:
         -> engine.py: send `token_refresh` with token
         -> UI shows loading spinner (no browser)
         -> Wait for push event:
            -> `session_ready` -> transition to main window
            -> `token_expired` -> show pre-auth screen (silent, not an error)
      B) No token:
         -> Show pre-auth screen (first-run wizard)
```

### FR13 Routing Logic (Full Decision Tree)

| State | Route To |
|---|---|
| No stored token | First-run wizard (pre-auth screen) |
| Stored token, engine rejects (expired) | Pre-auth screen (silent re-auth, no error banner) |
| Stored token, engine accepts, has pairs | Main window |
| Stored token, engine accepts, no pairs, wizard was interrupted | Wizard at folder selection step |
| Stored token, engine accepts, no pairs, clean state | Main screen with empty `AdwStatusPage` |

Wizard-interrupted state detection: check if a persisted flag exists (e.g., GSettings key `wizard-auth-complete` set `true` during auth but before pair configuration). If this flag is `true` and `pairs[]` is empty, the wizard was interrupted.

### Token Flow (One-Directional, Security-Critical)

```
libsecret -> auth.py (get_stored_token) -> window.py -> engine.py (IPC client)
  -> Unix socket -> ipc.ts -> sdk.ts -> @protontech/drive-sdk
```

Token never flows back. Engine never reads libsecret. Token never appears in logs, stdout, stderr, IPC error payloads, or debug output.

### `token_refresh` Is a Special IPC Command

Unlike normal commands (`add_pair`, `get_status`, etc.) that return `<command>_result`, `token_refresh` responds via push events:
- Success: `session_ready` with `{display_name, email, storage_used, storage_total, plan}`
- Failure: `token_expired` with `{queued_changes}`

Do NOT build a generic "wait for `_result`" handler for `token_refresh`. This is explicitly called out in `project-context.md` and `architecture.md`.

### `session_ready` Fires on Both Initial Auth and Re-Auth

The same `session_ready` handler in `window.py` must handle:
1. Launch-time token validation (this story)
2. Re-auth after mid-session token expiry (Story covered by `reauth_dialog.py`)

Both transitions lead to the main window. Do not create separate handlers.

### Expired Token at Launch Is Not an Error

When `token_expired` arrives during launch validation, the UI routes to the pre-auth screen as a normal routing decision. No `AdwToastOverlay`, no error banner, no `AdwDialog`. This is distinct from mid-session token expiry (which shows `reauth_dialog.py` with queued change count).

### Dependency Chain

This story wires together three prior stories:
- **Story 1.4** (Engine Spawn & Socket Connection): engine process is running, socket connected
- **Story 1.5** (Protocol Handshake & Engine Lifecycle): `ready` event received, protocol validated, `get_status` sent
- **Story 1.6** (Credential Storage): `get_stored_token()` reads from libsecret/fallback

All three must be complete before this story can be implemented.

### Python/GTK4 Conventions

- All widget structure in Blueprint `.blp` files; Python handles signal wiring and state only
- Loading state uses `Gtk.Spinner` (per project UX conventions)
- No `lambda` in signal connections (GObject reference cycle risk)
- `from __future__ import annotations` in all Python files
- Type hints on all public functions including signal handlers
- IPC reads via `Gio.DataInputStream` only (never block GTK main loop)
- Use `GLib.idle_add()` for any state transition triggered by async IPC events

### Engine/TypeScript Conventions

- `token_refresh` handler in `ipc.ts` delegates to `sdk.ts` `DriveClient` wrapper
- `sdk.ts` is the only file that imports `@protontech/drive-sdk`
- Throw typed `EngineError` subclasses, never plain `Error` or strings
- IPC payloads use `snake_case` on both sides (no camelCase transformation)
- `async/await` everywhere; no `.then()/.catch()` chains

### GSettings Key for Wizard State

Add a `wizard-auth-complete` boolean key (default `false`) to the GSettings schema. Set to `true` after successful auth in the wizard flow (before pair configuration). Reset to `false` after first pair is configured. This enables FR13 wizard resume detection on next launch.

### NFR1 Compliance

The main window must be interactive within 3 seconds of launch, independent of network availability. The token validation is a network operation -- if it takes longer than expected, the UI must remain responsive (spinner visible, not frozen). Consider a timeout: if no `session_ready` or `token_expired` arrives within a reasonable window (e.g., 10s), route to pre-auth screen.

### File Locations

| File | Role |
|---|---|
| `ui/src/protondrive/window.py` | Launch routing logic, `session_ready`/`token_expired` handlers |
| `ui/src/protondrive/auth.py` | `get_stored_token()` method (reads libsecret) |
| `ui/src/protondrive/engine.py` | `send_token_refresh()` IPC method |
| `ui/data/ui/window.blp` | Loading spinner widget for validation state |
| `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` | `wizard-auth-complete` key |
| `engine/src/ipc.ts` | `token_refresh` command routing |
| `engine/src/sdk.ts` | Token validation via SDK |
| `ui/tests/test_auth.py` | Token retrieval tests |
| `ui/tests/test_widgets.py` | Launch routing state transition tests |
| `engine/src/ipc.test.ts` | `token_refresh` command handling tests |

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 616-641 -- Story 1.11]
- [Source: _bmad-output/planning-artifacts/epics.md, lines 32-34 -- FR3, FR13]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 125-134 -- IPC commands, token_refresh]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 144 -- session_ready event]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 178 -- Token flow]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 536 -- Auth boundary]
- [Source: _bmad-output/project-context.md -- Token expiry cross-process workflow, GTK4 rules]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
