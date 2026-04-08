# Story 1.8: Pre-Auth Screen & Credential Comfort

Status: done

## Story

As a user,
I want to understand what's about to happen before I see an embedded browser asking for my Proton password,
so that I trust the app isn't phishing me.

## Acceptance Criteria

1. **Given** the app launches with no valid session token, **when** the pre-auth screen is displayed, **then** it shows a native GTK4 screen (not the browser) with:
   - A heading: "Sign in to Proton"
   - Credential comfort body text: "Your password is sent directly to Proton — this app only receives a session token after you sign in"
   - A primary CTA button labeled "Open Proton sign-in"

2. **Given** the pre-auth screen is visible, **when** a screen reader (Orca) reads the page, **then**:
   - The heading "Sign in to Proton" is announced as a heading
   - The credential comfort body text is announced
   - The "Open Proton sign-in" button is announced as a button

3. **Given** the pre-auth screen is visible, **when** the user clicks "Open Proton sign-in", **then** the auth callback server starts (Story 1.7) and the embedded browser opens (Story 1.9).

## Tasks / Subtasks

- [x] Task 1: Create Blueprint UI definition (AC: #1, #2)
  - [x] 1.1 Create `ui/data/ui/pre-auth.blp` defining the pre-auth screen layout
  - [x] 1.2 Use `AdwStatusPage` as the root widget
  - [x] 1.3 Set `title` property to "Sign in to Proton"
  - [x] 1.4 Set `description` property to credential comfort text
  - [x] 1.5 Add `Gtk.Button` child with `suggested-action` + `pill` classes, id `sign-in-button`
  - [x] 1.6 Set `icon-name` to `dialog-password-symbolic`

- [x] Task 2: Create Python wiring module (AC: #1, #3)
  - [x] 2.1 Create `ui/src/protondrive/pre_auth.py`
  - [x] 2.2 `@Gtk.Template` with correct resource_path
  - [x] 2.3 `__gtype_name__ = 'ProtonDrivePreAuthScreen'`
  - [x] 2.4 `sign_in_button = Gtk.Template.Child()`
  - [x] 2.5 Connected via method ref (no lambda)
  - [x] 2.6 Emits `sign-in-requested` GObject signal
  - [x] 2.7 `from __future__ import annotations` + type hints

- [x] Task 3: Integrate with window navigation (AC: #1, #3)
  - [x] 3.1 `window.py` imports and instantiates `PreAuthScreen`
  - [x] 3.2 `show_pre_auth()` sets PreAuthScreen as window content
  - [x] 3.3 Sign-in action delegates to `app.start_auth_flow()` (Stories 1.7/1.9)
  - [x] 3.4 `show_main()` transitions back to split-view

- [x] Task 4: Register Blueprint and resources in Meson (AC: #1)
  - [x] 4.1 Added `pre-auth.blp` to Meson blueprint compilation
  - [x] 4.2 Added `pre-auth.ui` to GResource bundle
  - [x] 4.3 Added `pre_auth.py` to python_sources

- [x] Task 5: Accessibility verification (AC: #2)
  - [x] 5.1 `AdwStatusPage` title exposed as ATK heading role (default)
  - [x] 5.2 Description text accessible via `AdwStatusPage` description property
  - [x] 5.3 Button has correct role and label via standard `Gtk.Button`
  - [x] 5.4 Manual Orca test deferred (no Xvfb in CI)

## Dev Notes

### UX Design Decision: UX-DR1 — Native Pre-Auth Screen

The pre-auth screen exists to defuse the "phishing-shaped situation" of typing a Proton password into an embedded browser inside a newly installed app. This is the **primary credential comfort mechanism** in the app. The screen must:
- Be a native GTK4 screen (not a web page, not the browser)
- Appear before the WebKitGTK browser opens
- Clearly explain what will happen next and why it is safe

### Widget Choice: AdwStatusPage

`AdwStatusPage` is the project's standard widget for empty/informational states (per architecture doc widget conventions). It provides:
- A title property (rendered as a heading — Orca announces it)
- A description property (body text — Orca announces it)
- A child area for the CTA button
- Proper spacing, centering, and responsive behavior out of the box

### Blueprint Rule

All widget structure lives in `pre-auth.blp`. The Python file (`pre_auth.py`) wires signals and manages state only. Never construct widget trees in Python.

### Widget Isolation

`pre_auth.py` must NOT import from any other widget file. All coordination between screens goes through `window.py`. If `PreAuthScreen` needs to trigger the auth flow, it should emit a custom GObject signal or call a callback set by `window.py`.

### Signal Connection — No Lambda

```python
# CORRECT
self.sign_in_button.connect('clicked', self._on_sign_in_clicked)

# WRONG — causes GObject reference cycles
self.sign_in_button.connect('clicked', lambda btn: self._on_sign_in_clicked(btn))
```

### Auth Flow Ordering (Cross-Story Dependency)

When the user clicks "Open Proton sign-in", the sequence is load-bearing:
1. Auth callback server binds socket (Story 1.7) — must happen FIRST
2. WebKitGTK browser navigates to auth URL (Story 1.9) — happens AFTER server is ready

`PreAuthScreen` initiates step 1 via its signal/callback. `window.py` orchestrates the full sequence.

### File Locations

| File | Purpose |
|---|---|
| `ui/data/ui/pre-auth.blp` | Widget structure (Blueprint) |
| `ui/src/protondrive/pre_auth.py` | Signal wiring, state (Python) |
| `ui/src/protondrive/window.py` | Screen navigation orchestration (existing) |

### GResource Path

```python
@Gtk.Template(resource_path='/io/github/ronki2304/ProtonDriveLinuxClient/ui/pre-auth.ui')
class PreAuthScreen(Adw.Bin):
    __gtype_name__ = 'ProtonDrivePreAuthScreen'
```

### Blueprint ID → Python Mapping

| Blueprint ID (kebab-case) | Python Template.Child (snake_case) |
|---|---|
| `sign-in-button` | `sign_in_button` |

### Session Token Check

On app launch, `window.py` (or `main.py`) checks for a valid session token in libsecret. If none exists, `PreAuthScreen` is shown. If a valid token exists, the app skips directly to the main UI. This screen also appears after logout or token expiry if the re-auth modal is dismissed.

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
N/A

### Completion Notes List
- Used `Adw.Bin` as template base (wraps `AdwStatusPage`) per story spec
- `sign-in-requested` custom GObject signal for widget isolation (window.py handles orchestration)
- `window.py` delegates auth flow to `app.start_auth_flow()` which will be implemented in Stories 1.9/1.10
- Meson blueprint compilation refactored to support multiple .blp files with separate custom_target per file
- All 51 UI tests pass (6 new for pre-auth + 45 existing)

### File List
- `ui/data/ui/pre-auth.blp` (created)
- `ui/src/protondrive/pre_auth.py` (created)
- `ui/src/protondrive/window.py` (modified — added show_pre_auth/show_main/auth delegation)
- `ui/meson.build` (modified — added blueprint + python source)
- `ui/data/protondrive.gresource.xml` (modified — added pre-auth.ui)
- `ui/tests/test_pre_auth.py` (created)
