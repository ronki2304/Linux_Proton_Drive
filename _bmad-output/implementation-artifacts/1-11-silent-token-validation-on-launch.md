# Story 1.11: Silent Token Validation on Launch

Status: done

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

- [x] Task 1: Implement launch routing logic in `main.py` (AC: #1, #2, #3, #4)
  - [x] 1.1–1.6 Launch routing in Application class: token check → token_refresh or pre-auth

- [x] Task 2: Token retrieval via CredentialManager (AC: #1)
  - [x] 2.1–2.3 `_get_stored_token()` in Application, returns None safely

- [x] Task 3: Wire `token_refresh` command in `engine.py` (AC: #1, #2, #3)
  - [x] 3.1–3.3 `send_token_refresh(token)` with UUID id, queued if not ready

- [x] Task 4: Handle engine-side `token_refresh` in `main.ts` (AC: #2, #3)
  - [x] 4.1–4.4 Routes to session_ready/token_expired push events (no _result)

- [x] Task 5: Write UI tests (AC: #1, #2, #3, #4)
  - [x] 5.1–5.6 6 tests: token_refresh send, queuing, token_expired dispatch, source verification

- [x] Task 6: Write engine tests (AC: #2, #3)
  - [x] 6.1–6.4 2 tests: session_ready for valid token, token_expired for missing token

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
Claude Opus 4.6 (1M context)

### Debug Log References
N/A

### Completion Notes List
- Launch routing lives in Application class (main.py), not window.py — Application owns engine + credentials
- token_refresh handled in engine main.ts with placeholder SDK call (real SDK validation in Story 1-13)
- token_expired handler deletes stale credential and shows pre-auth silently
- wizard-auth-complete GSettings key added for FR13 wizard resume
- All 95 UI tests pass + 11 engine tests pass

### File List
- `ui/src/protondrive/main.py` (rewritten — full launch routing + engine wiring)
- `ui/src/protondrive/engine.py` (modified — send_token_refresh + token_expired dispatch)
- `engine/src/main.ts` (modified — token_refresh command handler)
- `engine/src/main.test.ts` (created — 2 tests)
- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` (modified — wizard-auth-complete)
- `ui/tests/test_launch_routing.py` (created — 6 tests)
