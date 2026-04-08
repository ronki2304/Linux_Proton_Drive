# Story 1.8: Pre-Auth Screen & Credential Comfort

Status: ready-for-dev

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

- [ ] Task 1: Create Blueprint UI definition (AC: #1, #2)
  - [ ] 1.1 Create `ui/data/ui/pre-auth.blp` defining the pre-auth screen layout
  - [ ] 1.2 Use `AdwStatusPage` as the root widget — it provides heading, description, and child button layout matching the credential comfort pattern
  - [ ] 1.3 Set `title` property to "Sign in to Proton" (rendered as heading, announced by Orca)
  - [ ] 1.4 Set `description` property to "Your password is sent directly to Proton — this app only receives a session token after you sign in"
  - [ ] 1.5 Add a `Gtk.Button` child with label "Open Proton sign-in", CSS class `suggested-action` + `pill`, and id `sign-in-button`
  - [ ] 1.6 Optionally set `icon-name` on `AdwStatusPage` to an appropriate Proton/lock icon (e.g., `dialog-password-symbolic` or app icon)

- [ ] Task 2: Create Python wiring module (AC: #1, #3)
  - [ ] 2.1 Create `ui/src/protondrive/pre_auth.py`
  - [ ] 2.2 Define `PreAuthScreen` class with `@Gtk.Template` decorator, `resource_path` pointing to compiled `pre-auth.ui`
  - [ ] 2.3 Set `__gtype_name__ = 'ProtonDrivePreAuthScreen'` — must match Blueprint template class name
  - [ ] 2.4 Declare `sign_in_button = Gtk.Template.Child()` (kebab→snake auto-conversion from `sign-in-button`)
  - [ ] 2.5 Connect `sign_in_button` `clicked` signal to `self._on_sign_in_clicked` — no lambda
  - [ ] 2.6 `_on_sign_in_clicked` emits a custom signal or calls a callback provided by `window.py` to trigger auth flow
  - [ ] 2.7 Add `from __future__ import annotations` and type hints on all public methods

- [ ] Task 3: Integrate with window navigation (AC: #1, #3)
  - [ ] 3.1 In `window.py`, import and instantiate `PreAuthScreen`
  - [ ] 3.2 On app launch with no valid session token, display `PreAuthScreen` as the window content
  - [ ] 3.3 Wire the sign-in action so clicking the CTA triggers: auth server bind (Story 1.7) → browser open (Story 1.9)
  - [ ] 3.4 After successful auth, transition away from `PreAuthScreen` to the main UI

- [ ] Task 4: Register Blueprint and resources in Meson (AC: #1)
  - [ ] 4.1 Add `pre-auth.blp` to the Blueprint sources list in `ui/data/ui/meson.build` (or equivalent)
  - [ ] 4.2 Ensure the compiled `pre-auth.ui` is included in the GResource bundle
  - [ ] 4.3 Verify `meson compile -C builddir` succeeds with the new file

- [ ] Task 5: Accessibility verification (AC: #2)
  - [ ] 5.1 Verify `AdwStatusPage` title is exposed as ATK heading role (it does this by default)
  - [ ] 5.2 Verify description text is accessible to screen readers
  - [ ] 5.3 Verify the button has correct ATK button role and accessible label "Open Proton sign-in"
  - [ ] 5.4 Manual test with Orca if Xvfb widget tests are available

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
<!-- Agent fills in model identifier -->

### Debug Log References
<!-- Links to debug logs if needed -->

### Completion Notes List
<!-- Agent records implementation decisions and deviations here -->

### File List
<!-- Agent records all created/modified files here -->
