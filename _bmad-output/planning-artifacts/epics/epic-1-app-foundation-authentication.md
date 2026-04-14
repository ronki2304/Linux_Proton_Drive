# Epic 1: App Foundation & Authentication

User can launch the app, authenticate with Proton via embedded browser, and see their account overview (name, storage, plan). Credentials persist via libsecret or fallback. The engine spawns, connects, and validates protocol. This is the "it actually works" moment.

## Story 1.1: UI Project Scaffolding

As a developer,
I want a working GTK4/Libadwaita project scaffold with Meson build, Blueprint UI files, and Flatpak manifest stub,
So that all subsequent UI stories have a buildable foundation to work from.

**Acceptance Criteria:**

**Given** the GNOME Builder Python/GTK4/Libadwaita template has been generated
**When** `meson setup builddir && meson compile -C builddir` is run
**Then** the project compiles without errors
**And** the Flatpak App ID `io.github.ronki2304.ProtonDriveLinuxClient` is set in all manifests, GSettings schema, GResource paths, desktop file, and AppStream metainfo stub

**Given** the app is launched
**When** the main window renders
**Then** an empty `AdwNavigationSplitView` window is displayed with mandatory dark theme (`ADW_COLOR_SCHEME_FORCE_DARK`) and teal accent (`#0D9488` via `AdwAccentColor` API)
**And** the window has a minimum size of 360x480px and default size of 780x520px

**Given** the project structure
**When** inspecting the source tree
**Then** `ui/src/protondrive/` contains `__init__.py`, `main.py`, `window.py`
**And** `ui/data/ui/` contains `window.blp`
**And** `ui/data/` contains the GSettings schema XML and app icon SVGs
**And** all widget structure is defined in Blueprint `.blp` files, never in Python

---

## Story 1.2: Engine Project Scaffolding

As a developer,
I want a TypeScript/Node project scaffold with strict tsconfig and the typed error hierarchy,
So that all subsequent engine stories have a buildable foundation with consistent error handling.

**Acceptance Criteria:**

**Given** `npm init` has been run in `engine/`
**When** inspecting `tsconfig.json`
**Then** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride` are all `true`
**And** `target` is `ES2022`, `module` is `NodeNext`, `moduleResolution` is `NodeNext`

**Given** `engine/src/errors.ts` exists
**When** inspecting its imports
**Then** it has zero internal imports from other engine files
**And** it exports `EngineError` base class and typed subclasses: `SyncError`, `NetworkError`, `IpcError`, `ConfigError`

**Given** `@protontech/drive-sdk` is added to `package.json`
**When** inspecting the version
**Then** it is pinned to exact version `0.14.3` (no `^` or `~` prefix)

**Given** `openpgp` is added to `package.json`
**When** inspecting the version
**Then** it is pinned to exact version `^6.3.0`

**Given** the engine project
**When** running `npx tsc --noEmit`
**Then** the project compiles without errors

---

## Story 1.3: IPC Protocol & Socket Server

As a developer,
I want the engine to start a Unix socket server with length-prefixed JSON framing and emit a `ready` event,
So that the UI process can establish a reliable communication channel with the sync engine.

**Acceptance Criteria:**

**Given** the engine starts via `node --import tsx src/main.ts`
**When** initialization completes
**Then** a Unix socket is created at `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock`
**And** the engine emits a `ready` event with `{version, protocol_version}` payload

**Given** the `MessageReader` class in `ipc.ts`
**When** processing incoming data
**Then** it correctly handles 4-byte big-endian length prefix + JSON payload framing
**And** all commands carry a unique `id` field (UUID v4)
**And** responses echo `id` with `_result` suffix

**Given** unit tests for `MessageReader`
**When** running `node --import tsx --test engine/src/ipc.test.ts`
**Then** tests pass for: partial message, multiple messages in one chunk, message split across chunks, zero-length payload, oversized payload

**Given** an active connection exists
**When** a second client attempts to connect
**Then** the engine rejects it immediately with `ALREADY_CONNECTED` error and destroys the socket

**Given** the engine receives a `shutdown` command
**When** processing the command
**Then** the engine closes the socket and exits cleanly

---

## Story 1.4: Engine Spawn & Socket Connection

As a user,
I want the app to start the sync engine automatically and connect to it,
So that I don't need to manage processes manually.

**Acceptance Criteria:**

**Given** the app launches
**When** the UI process starts
**Then** it spawns the engine via `GLib.spawn_async()` using the correct `ENGINE_PATH` resolution (Flatpak: `/usr/lib/sdk/node22/bin/node` + `/app/lib/protondrive/engine.js`; dev: `GLib.find_program_in_path('node')` + project-relative `engine/dist/engine.js`)
**And** checks `GLib.spawn_async()` return value — `False` means spawn failed; surfaces clear error to user

**Given** the engine has been spawned
**When** the UI attempts to connect to the IPC socket
**Then** it uses `Gio.SocketClient` with exponential backoff for up to 10 seconds
**And** on successful connection, it reads messages via `Gio.DataInputStream` (never Python `socket.recv()`)

**Given** the engine is not found on `$PATH` (dev) or is missing from the bundle (Flatpak)
**When** the UI attempts to spawn it
**Then** a clear startup error is displayed: "Sync engine not found" — never a cryptic socket timeout

**Given** app launches cold
**When** engine connects and `ready` event is received
**Then** main window is interactive within 3 seconds (NFR1)

---

## Story 1.5: Protocol Handshake & Engine Lifecycle

As a user,
I want the app to verify engine compatibility and handle engine crashes gracefully,
So that I'm never left with a silently broken or stale sync engine.

**Acceptance Criteria:**

**Given** the UI receives the `ready` event from the engine
**When** processing the event
**Then** it validates `protocol_version` for compatibility
**And** if incompatible, shows a version mismatch error and refuses to proceed
**And** if compatible, transitions to the main window or wizard

**Given** the UI receives a `ready` event
**When** the handshake completes
**Then** the UI sends `get_status` command — on every `ready` event, not just first launch

**Given** commands are sent before the engine `ready` event
**When** the `ready` event is received
**Then** all buffered commands in `_pending_commands` are flushed in order

**Given** the user closes the app
**When** the shutdown sequence begins
**Then** the UI sends a `shutdown` command to the engine, waits for clean exit, and kills the process if timeout is exceeded

**Given** the engine process crashes unexpectedly
**When** the UI detects socket close
**Then** an app-level error banner is displayed with a restart button (fatal error display)
**And** no "restart" button is shown for non-fatal errors (those display inline on affected pair card)

---

## Story 1.6: Credential Storage (libsecret + Fallback)

As a user,
I want my session token stored securely so I don't need to re-authenticate every time I open the app,
So that launch is seamless after first-time setup.

**Acceptance Criteria:**

**Given** a valid session token is received after authentication
**When** the UI stores it
**Then** it is stored via libsecret Secret portal (GNOME Keyring) under the app's credential attributes

**Given** the Secret portal is unavailable (e.g., non-GNOME desktop, NixOS)
**When** the UI attempts to store the token
**Then** it falls back to an encrypted local credential store at `~/.var/app/$FLATPAK_ID/data/keyrings/`
**And** the credential file has `0600` permissions set immediately on creation, before any content is written (NFR7)
**And** the UI surfaces an explicit message about the fallback: "Credential storage unavailable via Secret portal — falling back to encrypted file store"

**Given** neither libsecret Secret portal nor the fallback store is available
**When** the UI attempts to store credentials
**Then** a clear error is surfaced: "No secure credential storage available" (FR36)

**Given** any code path in the application
**When** inspecting stdout, stderr, logs, debug traces, or crash dumps
**Then** the session token never appears in any output (NFR6)

---

## Story 1.7: Localhost Auth Callback Server

As a developer,
I want a secure localhost HTTP server that receives the auth callback token,
So that the embedded browser can complete authentication and pass the token to the app.

**Acceptance Criteria:**

**Given** the auth flow is initiated
**When** the auth callback server starts
**Then** it binds exclusively to `127.0.0.1` (never `0.0.0.0`) on a randomly assigned ephemeral port (NFR8)

**Given** the server is running
**When** the auth callback is received with a session token
**Then** the token is captured and passed to the credential storage layer
**And** the server closes immediately — no persistent open port

**Given** the auth server lifecycle
**When** the server has received one callback
**Then** it does not accept any further connections
**And** it is fully stopped before the auth flow transitions to the next step

**Given** the server is started
**When** the WebView navigates to `http://127.0.0.1:{port}/auth-start`
**Then** the server responds with an HTTP redirect (302) to `https://accounts.proton.me` with the appropriate auth parameters
**And** the redirect URL includes the callback URL pointing back to `http://127.0.0.1:{port}/callback`

**Given** the auth callback server
**When** inspecting its implementation
**Then** it is in `ui/src/protondrive/auth.py` and uses Python stdlib `http.server` on a background thread

---

## Story 1.8: Pre-Auth Screen & Credential Comfort

As a user,
I want to understand what's about to happen before I see an embedded browser asking for my Proton password,
So that I trust the app isn't phishing me.

**Acceptance Criteria:**

**Given** the app launches with no valid session token
**When** the pre-auth screen is displayed
**Then** it shows a native GTK4 screen (not the browser) with credential comfort copy: "Your password is sent directly to Proton — this app only receives a session token after you sign in"
**And** a primary CTA button "Open Proton sign-in" is displayed

**Given** the pre-auth screen is visible
**When** a screen reader (Orca) reads the page
**Then** the heading "Sign in to Proton" and the credential comfort body text are announced
**And** the "Open Proton sign-in" button is announced as a button

**Given** the pre-auth screen
**When** the user clicks "Open Proton sign-in"
**Then** the auth callback server starts (Story 1.7) and the embedded browser opens (Story 1.9)

---

## Story 1.9: Embedded WebKitGTK Auth Browser

As a user,
I want to authenticate with Proton using their real login page in an embedded browser,
So that I can use CAPTCHA, 2FA, and all standard Proton auth flows without leaving the app.

**Acceptance Criteria:**

**Given** the user clicks "Open Proton sign-in" on the pre-auth screen
**When** the embedded browser opens
**Then** it loads `http://127.0.0.1:{port}/auth-start` which redirects to `accounts.proton.me`
**And** a read-only URL bar is visible showing `accounts.proton.me` so the user can verify the destination (UX-DR2)
**And** the auth callback server socket was bound BEFORE the WebView navigates (auth flow ordering is load-bearing)

**Given** the user completes authentication (including CAPTCHA and 2FA if required)
**When** Proton's auth flow sends the callback to localhost
**Then** the token is received by the auth callback server
**And** the WebView is cleaned up: `webview.try_close()` is called and the reference is set to `None`
**And** the WebView's network session and cached credentials are released

**Given** a network error occurs during authentication
**When** the browser cannot reach Proton
**Then** an error banner is displayed with a "Retry" button

**Given** the auth browser widget
**When** inspecting the implementation
**Then** WebKitGTK is imported as `gi.repository.WebKit` (not deprecated `WebKit2`)
**And** the widget is defined in `ui/data/ui/auth-window.blp` with Python wiring in `ui/src/protondrive/auth_window.py`

---

## Story 1.10: Post-Auth Account Overview & Session Handoff

As a user,
I want to see my account name and storage usage immediately after authentication,
So that I know auth worked and I'm connected to the right account.

**Acceptance Criteria:**

**Given** authentication completes successfully
**When** the token is sent to the engine via IPC `token_refresh` command
**Then** the engine validates the token with the SDK and emits a `session_ready` event with `{display_name, email, storage_used, storage_total, plan}`

**Given** the UI receives the `session_ready` event
**When** rendering the post-auth state
**Then** the `AccountHeaderBar` component is displayed showing: avatar (28px circle with initials), account name (13px, medium weight), storage bar (`AdwLevelBar`, min-width 140px), and storage label ("X GB / Y GB", 10px)
**And** post-auth confirmation line: "Signed in as [account name] — your password was never stored by this app" (UX-DR3)

**Given** the storage usage
**When** usage exceeds 90% of total
**Then** the storage bar shifts to `@warning_color` (amber) with amber label
**And** when usage exceeds 99%, the bar shifts to error colour with "Storage full" label

**Given** window width is less than 480px
**When** the `AccountHeaderBar` renders
**Then** the storage text label is hidden; the storage bar remains visible

**Given** the `AccountHeaderBar` is visible
**When** a screen reader (Orca) reads it
**Then** it announces "Signed in as [name], [X] of [Y] storage used"

**Given** the `session_ready` event
**When** it fires on both initial auth AND re-auth
**Then** both cases are handled by the same handler — no separate code paths

---

## Story 1.11: Silent Token Validation on Launch

As a returning user,
I want the app to automatically validate my stored token on launch,
So that I go straight to the main window without re-authenticating every time.

**Acceptance Criteria:**

**Given** the app launches and a session token is stored in the credential store
**When** the token is loaded
**Then** it is sent to the engine via IPC `token_refresh` command without showing the auth browser

**Given** the engine validates the token
**When** the SDK accepts it
**Then** a `session_ready` event is emitted and the UI transitions to the main window (not the wizard)

**Given** the engine validates the token
**When** the SDK rejects it (expired or invalid)
**Then** the UI immediately shows the pre-auth screen for re-authentication (FR3)
**And** no error banner is shown — token expiry at launch is treated as a normal routing decision, not an error

**Given** the app launches with no stored token
**When** the credential store is empty
**Then** the UI routes to the first-run wizard (pre-auth screen)

---

## Story 1.12: Settings Page & Log Out

As a user,
I want to view my account details and log out when needed,
So that I can verify my account info and securely end my session.

**Acceptance Criteria:**

**Given** the user navigates to Settings (gear icon in `AdwHeaderBar`)
**When** the settings page opens
**Then** it displays account info: display name, email, storage usage, plan type
**And** a "Manage account at Proton" external link (opens in system browser via `Gtk.show_uri`)
**And** no password fields — ever

**Given** the user clicks "Log out"
**When** the confirmation dialog appears
**Then** it is an `AdwAlertDialog` with heading "Sign out?" and body: "Sign out of your Proton account? Your synced local files will not be deleted. You will need to sign in again to resume sync."
**And** two buttons: "Cancel" (default/escape, suggested-action style) and "Sign out" (destructive-action style)

**Given** the user confirms logout
**When** the logout completes
**Then** the session token is removed from the credential store
**And** local files and sync pair config are untouched
**And** the UI transitions to the pre-auth screen

**Given** the settings page
**When** navigating via keyboard only
**Then** all elements are reachable via Tab and actionable via Enter/Space
**And** Escape closes the settings page

**Given** the About dialog (via `⋯` menu in header bar)
**When** it opens
**Then** it is an `AdwAboutWindow` showing: MIT license with GitHub link, SDK version in use, Flatpak App ID, link to Flatpak manifest

---

## Story 1.13: SDK Boundary & No-App-Network Verification

As a security-conscious user,
I want to be certain the app makes no network connections of its own,
So that I can trust all network I/O goes through the ProtonDrive SDK.

**Acceptance Criteria:**

**Given** the complete UI codebase (`ui/src/`)
**When** inspecting for HTTP client code
**Then** no imports of `http.client`, `urllib`, `requests`, or any network library exist outside of `auth.py` (localhost-only server)

**Given** the complete engine codebase (`engine/src/`)
**When** inspecting for HTTP/fetch imports
**Then** no imports of `http`, `https`, `fetch`, `node-fetch`, `axios`, or any network library exist outside of `sdk.ts` (NFR10)

**Given** `engine/src/sdk.ts`
**When** inspecting its imports
**Then** it is the only file that imports `@protontech/drive-sdk`
**And** a boundary comment at the top of the file enforces this rule

**Given** any engine file other than `errors.ts`
**When** inspecting its imports
**Then** it does not import from `@protontech/drive-sdk` directly — only from `sdk.ts`

---
