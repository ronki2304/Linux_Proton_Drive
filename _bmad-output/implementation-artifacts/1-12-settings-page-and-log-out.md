# Story 1.12: Settings Page & Log Out

Status: done

## Story

As a user,
I want to view my account details and log out when needed,
so that I can verify my account info and securely end my session.

## Acceptance Criteria

1. **Given** the user navigates to Settings (gear icon in `AdwHeaderBar`), **when** the settings page opens, **then** it displays account info: display name, email, storage usage (with `AdwLevelBar`), and plan type.

2. **Given** the settings page is open, **when** the user inspects the account section, **then** a "Manage account at Proton" external link is present that opens `https://account.proton.me` in the system browser via `Gtk.show_uri()`, **and** no password fields exist anywhere in the settings UI.

3. **Given** the user clicks "Log out" (destructive-action styled button), **when** the confirmation dialog appears, **then** it is an `AdwAlertDialog` with heading "Sign out?" and body: "Sign out of your Proton account? Your synced local files will not be deleted. You will need to sign in again to resume sync.", **and** two buttons: "Cancel" (default/escape, `suggested-action` style) and "Sign out" (`destructive-action` style).

4. **Given** the user confirms logout by clicking "Sign out", **when** the logout completes, **then** the session token is removed from the libsecret credential store via Secret portal, **and** local files and sync pair config (YAML + SQLite) are untouched, **and** the engine receives `shutdown` command, **and** the UI transitions to the pre-auth screen.

5. **Given** the settings page, **when** navigating via keyboard only, **then** all elements are reachable via Tab and actionable via Enter/Space, **and** Escape closes the settings page.

6. **Given** the About dialog (via `...` menu in header bar), **when** it opens, **then** it is an `AdwAboutWindow` showing: MIT license with GitHub link, SDK version in use (`@protontech/drive-sdk` version from engine), Flatpak App ID (`io.github.ronki2304.ProtonDriveLinuxClient`), and link to Flatpak manifest.

## Tasks / Subtasks

- [x] Task 1: Create settings Blueprint UI (AC: #1, #2, #5)
  - [x] 1.1–1.6 Created `settings.blp` with AdwPreferencesPage, account rows, storage bar, manage link, logout button

- [x] Task 2: Create settings Python widget (AC: #1, #2, #4, #5)
  - [x] 2.1–2.6 `settings.py` with account population, storage thresholds, Gtk.show_uri for external link

- [x] Task 3: Implement logout confirmation dialog (AC: #3, #4)
  - [x] 3.1–3.3 AdwAlertDialog with cancel/sign-out responses, correct styling

- [x] Task 4: Implement logout sequence (AC: #4)
  - [x] 4.1–4.5 Application.logout(): delete_token + send_shutdown + show_pre_auth; no file deletion

- [x] Task 5: Wire settings into main window (AC: #1, #5)
  - [x] 5.1–5.3 show_settings() in window.py passes cached session_data

- [x] Task 6: Implement About dialog (AC: #6)
  - [x] 6.1–6.3 show_about() in window.py with AdwAboutWindow, MIT license, Flatpak manifest link

- [x] Task 7: Tests (AC: #1-#6)
  - [x] 7.1–7.5 15 tests: account population, storage thresholds, logout dialog, manage account link

## Dev Notes

### Architecture Constraints

- **Blueprint rule is absolute**: All widget structure in `settings.blp`. Python `settings.py` handles only signal wiring and state updates. Never construct widgets in Python.
- **Widget isolation**: `settings.py` must not import from other widget files. All coordination through `window.py`.
- **One `Gio.Settings` instance per app**: Passed from Application class via constructor, not instantiated in settings widget.
- **No `lambda` in signal connections**: Use explicit method references to avoid GObject reference cycles.
- **`from __future__ import annotations`** in all Python files.
- **Type hints on all public functions** including `__init__` and signal handlers.

### File Locations

| Artifact | Path |
|----------|------|
| Blueprint UI | `ui/data/ui/settings.blp` |
| Python widget | `ui/src/protondrive/widgets/settings.py` |
| Tests | `ui/tests/test_settings.py` |
| Window wiring | `ui/src/protondrive/window.py` (gear button + About dialog) |
| Window Blueprint | `ui/data/ui/window.blp` (gear icon + three-dot menu additions) |

### GResource & Template Wiring

```python
@Gtk.Template(resource_path='/io/github/ronki2304/ProtonDriveLinuxClient/ui/settings.ui')
class SettingsPage(Adw.PreferencesWindow):
    __gtype_name__ = 'ProtonDriveSettingsPage'
```

`__gtype_name__` must match the Blueprint `template` class name exactly. Blueprint `kebab-case` IDs (e.g., `storage-bar`) auto-convert to `snake_case` in Python `Gtk.Template.Child()` (e.g., `storage_bar`).

### Account Data Source

Account info comes from the `session_ready` IPC push event, which fires after engine validates token:

```
session_ready: {display_name, email, storage_used, storage_total, plan}
```

`window.py` should cache this payload and pass it to settings when opened. No separate IPC command needed to fetch account info — it arrives on every successful auth/re-auth.

### Destructive Action Pattern (UX-DR15)

The logout dialog follows the project-wide destructive action pattern:

1. User clicks `destructive-action` styled "Log out" button
2. `AdwAlertDialog` appears immediately
3. Heading names the action: "Sign out?"
4. Body copy explicitly states what will and will not happen to files
5. Two buttons only: **Cancel** (default/escape, `suggested-action` style) and **Sign out** (`destructive-action` style)
6. No "I understand" checkbox — the copy is the safeguard

**Exact dialog copy:**
- Heading: `"Sign out?"`
- Body: `"Sign out of your Proton account? Your synced local files will not be deleted. You will need to sign in again to resume sync."`

### Button Hierarchy (UX-DR17)

- Cancel is always the default response AND the close response (Escape key)
- The destructive action ("Sign out") is never the default
- `suggested-action` style on Cancel, `destructive-action` style on "Sign out"

### AdwAlertDialog API Pattern

```python
dialog = Adw.AlertDialog(
    heading="Sign out?",
    body="Sign out of your Proton account? Your synced local files will not be deleted. You will need to sign in again to resume sync."
)
dialog.add_response("cancel", "Cancel")
dialog.add_response("sign-out", "Sign out")
dialog.set_response_appearance("sign-out", Adw.ResponseAppearance.DESTRUCTIVE)
dialog.set_response_appearance("cancel", Adw.ResponseAppearance.SUGGESTED)
dialog.set_default_response("cancel")
dialog.set_close_response("cancel")
dialog.connect("response", self._on_logout_response)
dialog.present(self.get_root())
```

### Logout Sequence

1. Remove token from libsecret via `Secret.password_clear()` (async via `Gio`)
2. Send `shutdown` command to engine over IPC (engine responds via socket close, not `_result`)
3. Clear cached `session_ready` data in UI
4. Transition UI to pre-auth screen
5. Do NOT: delete local files, remove sync pair YAML config, drop SQLite state DB

The `shutdown` command is an exception to the normal `_result` response pattern — it responds via socket close. Do not wait for a `shutdown_result` message.

### Credential Removal

Use libsecret Secret portal (same API used for token storage in Story 1.9):

```python
Secret.password_clear(
    PROTONDRIVE_SCHEMA,
    {"account": "default"},
    None,  # GCancellable
    self._on_credentials_cleared
)
```

Never block the GTK main loop — use the async variant with callback.

### "Manage Account at Proton" Link

Opens system default browser via GTK:

```python
Gtk.show_uri(self.get_root(), 'https://account.proton.me', Gdk.CURRENT_TIME)
```

No in-app browser. No password fields in this app — ever. Account management is Proton's responsibility.

### AdwAboutWindow

Standard GNOME About dialog, created in `window.py` (not a separate widget file):

```python
about = Adw.AboutWindow(
    application_name="ProtonDrive Linux Client",
    application_icon="io.github.ronki2304.ProtonDriveLinuxClient",
    version=APP_VERSION,
    license_type=Gtk.License.MIT_X11,
    issue_url="https://github.com/ronki2304/ProtonDrive-LinuxClient/issues",
    website="https://github.com/ronki2304/ProtonDrive-LinuxClient",
    transient_for=self,
)
about.add_link("Flatpak Manifest", "https://github.com/ronki2304/ProtonDrive-LinuxClient/blob/main/flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml")
about.present()
```

Include in the debug info section: SDK version (`@protontech/drive-sdk` version), Flatpak App ID.

### Settings Widget Components

Use `AdwPreferencesGroup` for section grouping within the settings page:

| Section | Widget | Content |
|---------|--------|---------|
| Account | `AdwPreferencesGroup` | Display name row, email row, plan type row |
| Storage | `AdwPreferencesGroup` | `AdwLevelBar` + label ("47 GB / 200 GB") |
| External | `AdwActionRow` | "Manage account at Proton" with external link icon |
| Session | `AdwPreferencesGroup` | "Log out" button (`destructive-action`) |

### Storage Bar Thresholds

Configure `AdwLevelBar` with three visual zones matching the `AccountHeaderBar` pattern:
- Normal (0-90%): teal fill
- Warning (>90%): `@warning_color` (amber)
- Critical (>99%): error colour + "Storage full" label

### Keyboard Navigation

- All interactive elements (rows, buttons, links) must be reachable via Tab
- Enter/Space activates focused element
- Escape closes settings page (wire to close/pop navigation)
- Standard GTK4 focus ring — never suppressed via CSS

### No Password Fields

This is a deliberate design decision, not an omission. The app does not own the user's Proton credentials. Authentication happens exclusively through the embedded WebKitGTK browser (Story 1.7). The settings page shows read-only account info only.

### Testing Strategy

- Mock IPC socket, never spawn real engine
- Mock `Secret.password_clear()` to verify it's called during logout
- Mock `Gtk.show_uri()` to verify external link behavior
- Use mock `session_ready` payload fixture for account data population
- Widget tests via Xvfb (CI-optional with `CI_SKIP_WIDGET_TESTS=1`)
- Run via `meson test -C builddir` (never raw `python -m pytest`)

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Blueprint file | `kebab-case.blp` | `settings.blp` |
| Blueprint widget IDs | `kebab-case` | `storage-bar`, `logout-button`, `account-name-row` |
| Python file | `snake_case.py` | `settings.py` |
| Python class | `PascalCase` | `SettingsPage` |
| Python methods | `snake_case` | `_on_logout_clicked()`, `_on_logout_response()` |
| Test file | `test_<module>.py` | `test_settings.py` |

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 643-677 (Story 1.12)]
- [Source: _bmad-output/planning-artifacts/architecture.md § IPC Protocol — `session_ready` event, `shutdown` command]
- [Source: _bmad-output/planning-artifacts/architecture.md § Project Structure — `settings.py` + `settings.blp`]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md § Destructive Action Pattern]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md § Button Hierarchy]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md § Widget Component Library — `AdwPreferencesGroup`, `AdwAlertDialog`, `AdwAboutWindow`]
- [Source: _bmad-output/project-context.md § GTK4/Libadwaita rules, Blueprint rules, Widget isolation, libsecret]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
N/A

### Completion Notes List
- Settings uses Adw.Bin wrapping AdwPreferencesPage (not AdwPreferencesWindow) for inline display
- Logout sequence in Application.logout() resets wizard-auth-complete flag
- About dialog in window.py (not separate widget per GNOME convention)
- Manage account opens system browser via Gtk.show_uri
- Settings receives cached session_data from window.py on open
- All 110 UI tests pass (15 new + 95 existing)

### File List
- `ui/data/ui/settings.blp` (created)
- `ui/src/protondrive/widgets/settings.py` (created)
- `ui/src/protondrive/window.py` (modified — show_settings, show_about, logout wiring)
- `ui/src/protondrive/main.py` (modified — logout method)
- `ui/meson.build` (modified — added blueprint + python source)
- `ui/data/protondrive.gresource.xml` (modified — added settings.ui)
- `ui/tests/test_settings.py` (created)
