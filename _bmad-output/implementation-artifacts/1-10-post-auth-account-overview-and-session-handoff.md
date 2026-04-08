# Story 1.10: Post-Auth Account Overview & Session Handoff

Status: ready-for-dev

## Story

As a user,
I want to see my account name and storage usage immediately after authentication,
so that I know auth worked and I'm connected to the right account.

## Acceptance Criteria

1. **Given** authentication completes successfully, **when** the token is sent to the engine via IPC `token_refresh` command, **then** the engine validates the token with the SDK and emits a `session_ready` event with `{display_name, email, storage_used, storage_total, plan}`.

2. **Given** the UI receives the `session_ready` event, **when** rendering the post-auth state, **then** the `AccountHeaderBar` component is displayed showing: avatar (28px circle with initials), account name (13px, medium weight), storage bar (`AdwLevelBar`, min-width 140px), and storage label ("X GB / Y GB", 10px). A post-auth confirmation line reads: "Signed in as [account name] -- your password was never stored by this app" (UX-DR3).

3. **Given** storage usage exceeds 90% of total, **when** the `AccountHeaderBar` renders, **then** the storage bar shifts to `@warning_color` (amber) with amber label. **When** usage exceeds 99%, the bar shifts to error colour with "Storage full" label.

4. **Given** window width is less than 480px, **when** the `AccountHeaderBar` renders, **then** the storage text label is hidden; the storage bar remains visible.

5. **Given** the `AccountHeaderBar` is visible, **when** a screen reader (Orca) reads it, **then** it announces "Signed in as [name], [X] of [Y] storage used".

6. **Given** the `session_ready` event, **when** it fires on both initial auth AND re-auth, **then** both cases are handled by the same handler -- no separate code paths.

## Tasks / Subtasks

- [ ] Task 1: Handle `session_ready` event in engine IPC layer (AC: #1, #6)
  - [ ] 1.1 In `engine.py`: register handler for `session_ready` push event in the IPC event dispatch
  - [ ] 1.2 Parse payload fields: `display_name`, `email`, `storage_used`, `storage_total`, `plan` (all `snake_case` per IPC wire format)
  - [ ] 1.3 Emit a GObject signal (e.g., `session-ready`) on the engine client with parsed account data
  - [ ] 1.4 Ensure the same handler runs for both initial auth and re-auth -- no conditional branching by auth type

- [ ] Task 2: Create `AccountHeaderBar` Blueprint file (AC: #2, #4)
  - [ ] 2.1 Create `ui/data/ui/account-header-bar.blp` with `GtkBox` root (horizontal, 48px height)
  - [ ] 2.2 Add avatar widget: `GtkLabel` inside a 28px `GtkBox` circle (CSS-rounded), displaying initials, `id: avatar-label`
  - [ ] 2.3 Add account name `GtkLabel` (13px, medium weight, `id: account-name-label`)
  - [ ] 2.4 Add `AdwLevelBar` for storage (min-width 140px, `id: storage-bar`) with thresholds at 0.9 and 0.99
  - [ ] 2.5 Add storage text `GtkLabel` ("X GB / Y GB", 10px, `id: storage-label`)
  - [ ] 2.6 Add CSS class `storage-label` to the text label for responsive hiding at <480px

- [ ] Task 3: Create `AccountHeaderBar` Python widget (AC: #2, #3, #5)
  - [ ] 3.1 Create `ui/src/protondrive/widgets/account_header_bar.py`
  - [ ] 3.2 Wire `@Gtk.Template` to `account-header-bar.blp` via `resource_path='/io/github/ronki2304/ProtonDriveLinuxClient/ui/account-header-bar.ui'`
  - [ ] 3.3 Set `__gtype_name__` to match Blueprint template class name exactly
  - [ ] 3.4 Declare `Gtk.Template.Child()` for: `avatar_label`, `account_name_label`, `storage_bar`, `storage_label`
  - [ ] 3.5 Implement `update_account(display_name, email, storage_used, storage_total, plan)` method:
    - Extract initials from `display_name` (first letter of first+last name, uppercase)
    - Set `account_name_label` text to `display_name`
    - Calculate storage fraction and set `storage_bar` value
    - Format storage label as "X GB / Y GB" (convert bytes to human-readable)
    - Apply warning/critical CSS classes based on thresholds (>90% = `warning`, >99% = `error`)
    - Set "Storage full" text when >99%
  - [ ] 3.6 Set accessible label via `gtk_accessible_update_property()`: "Signed in as [name], [X] of [Y] storage used"

- [ ] Task 4: Integrate `AccountHeaderBar` into main window (AC: #2, #6)
  - [ ] 4.1 In `window.blp`: add `AccountHeaderBar` as first child of main window content area, below `AdwHeaderBar`
  - [ ] 4.2 In `window.py`: connect engine client `session-ready` signal to handler that calls `account_header_bar.update_account()`
  - [ ] 4.3 Show post-auth confirmation line (UX-DR3): "Signed in as [name] -- your password was never stored by this app" via `AdwToastOverlay` toast or inline label (transient, dismissible)
  - [ ] 4.4 Ensure same handler fires for both initial auth and re-auth `session_ready` events

- [ ] Task 5: Implement responsive storage label hiding (AC: #4)
  - [ ] 5.1 Add CSS rule in app stylesheet: hide `.storage-label` when `AccountHeaderBar` width <480px
  - [ ] 5.2 Use `GtkWidget.notify::width` or `Gtk.LayoutManager` to toggle label visibility based on allocated width
  - [ ] 5.3 Storage bar must remain visible at all widths

- [ ] Task 6: Apply storage bar colour theming (AC: #3)
  - [ ] 6.1 Define CSS classes for storage bar states: normal (teal `#0D9488`), warning (`@warning_color` amber at >90%), critical (`@error_color` at >99%)
  - [ ] 6.2 Set `AdwLevelBar` offset values: `warning` at 0.9, `critical` at 0.99
  - [ ] 6.3 Update label text to "Storage full" when >99% and apply error colour to label

- [ ] Task 7: Register Blueprint and resources in Meson build (AC: #2)
  - [ ] 7.1 Add `account-header-bar.blp` to Blueprint compilation list in `meson.build`
  - [ ] 7.2 Add compiled `.ui` file to GResource bundle
  - [ ] 7.3 Verify `meson compile -C builddir` succeeds with the new file

- [ ] Task 8: Write tests (AC: #1-#6)
  - [ ] 8.1 In `ui/tests/test_widgets.py`: test `AccountHeaderBar.update_account()` sets correct labels, bar value, and accessible label
  - [ ] 8.2 Test storage warning threshold: verify CSS class at 91%, 99.5%, and 50%
  - [ ] 8.3 Test "Storage full" label appears at >99%
  - [ ] 8.4 In `ui/tests/test_engine.py`: test `session_ready` event parsing produces correct payload fields
  - [ ] 8.5 Test that re-auth `session_ready` updates the same `AccountHeaderBar` (no duplicate widgets)

## Dev Notes

### UX-DR3: Post-Auth Confirmation

Display "Signed in as [account name] -- your password was never stored by this app" immediately after first auth. This is a trust-building signal. Use a transient notification (e.g., `AdwToast` via `AdwToastOverlay`) or an inline label that fades after a few seconds. It must also appear after re-auth.

### UX-DR5: AccountHeaderBar Component Specs

| Element | Spec |
|---|---|
| Avatar | 28px circle, initials (first letter of first+last name), CSS `border-radius: 50%` |
| Account name | 13px, medium weight (`font-weight: 500`) |
| Storage bar | `AdwLevelBar`, min-width 140px, continuous mode |
| Storage label | "X GB / Y GB", 10px, secondary colour |
| Container | `GtkBox` horizontal, 48px height, first child below `AdwHeaderBar` |

### Storage Bar States

| State | Threshold | Bar Colour | Label |
|---|---|---|---|
| Normal | 0-90% | Teal `#0D9488` | "X GB / Y GB" |
| Warning | >90% | `@warning_color` (amber) | "X GB / Y GB" (amber text) |
| Critical | >99% | `@error_color` (red) | "Storage full" (error text) |

### Responsive Behaviour

Storage text label hidden at <480px window width. Storage bar remains visible at all widths. Use `GtkWidget` size allocation callback or CSS media query equivalent to toggle visibility.

### IPC Protocol Reference

`token_refresh` is a special command -- it does NOT get a `_result` response. Instead, the engine emits either `session_ready` or `token_expired` as push events.

`session_ready` payload: `{display_name: string, email: string, storage_used: number, storage_total: number, plan: string}`

All IPC fields use `snake_case` on both sides -- do NOT convert to `camelCase` in TypeScript or Python.

### session_ready Fires on Both Auth Paths

`session_ready` fires on initial auth AND re-auth. The handler in `window.py` must be identical for both -- call `account_header_bar.update_account()` in both cases. No conditional branching by auth type.

### Accessibility

- Set `gtk_accessible_update_property()` on `AccountHeaderBar` root with label: "Signed in as [name], [X] of [Y] storage used"
- Orca must announce this when the widget receives focus or appears
- Storage bar colour is never the sole state indicator -- always accompanied by text label

### Widget Isolation Rule

`account_header_bar.py` must NOT import from any other widget file. All coordination goes through `window.py`. The widget receives data via its `update_account()` method, called by the window.

### Blueprint and Naming Conventions

- Blueprint file: `account-header-bar.blp` (kebab-case)
- Widget IDs in Blueprint: `kebab-case` (e.g., `avatar-label`, `storage-bar`)
- Python `Gtk.Template.Child()`: `snake_case` (e.g., `avatar_label`, `storage_bar`) -- GTK auto-converts
- Python file: `account_header_bar.py` (snake_case)
- Python class: `AccountHeaderBar` (PascalCase)

### File Locations

| File | Path |
|---|---|
| Blueprint | `ui/data/ui/account-header-bar.blp` |
| Python widget | `ui/src/protondrive/widgets/account_header_bar.py` |
| Window integration | `ui/src/protondrive/window.py` |
| Engine IPC handler | `ui/src/protondrive/engine.py` |
| Widget tests | `ui/tests/test_widgets.py` |
| Engine event tests | `ui/tests/test_engine.py` |

### Key Constraints

- **Blueprint rule**: All widget structure in `.blp` -- Python only wires signals and updates state
- **No `lambda` in signal connections**: Use explicit method references
- **`from __future__ import annotations`** in all Python files
- **Type hints on all public functions** including `__init__` and signal handlers
- **Mock IPC socket in tests** -- never spawn real engine

## Dev Agent Record

### Agent Model Used
_(To be filled by dev agent)_

### Debug Log References
_(To be filled by dev agent)_

### Completion Notes List
_(To be filled by dev agent)_

### File List
_(To be filled by dev agent)_
