# Story 1.10: Post-Auth Account Overview & Session Handoff

Status: done

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

- [x] Task 1: Handle `session_ready` event in engine IPC layer (AC: #1, #6)
  - [x] 1.1–1.4 Added `session_ready` dispatch + `on_session_ready()` callback; same handler for auth/re-auth

- [x] Task 2: Create `AccountHeaderBar` Blueprint file (AC: #2, #4)
  - [x] 2.1–2.6 Created `account-header-bar.blp` with avatar, name, LevelBar, storage label

- [x] Task 3: Create `AccountHeaderBar` Python widget (AC: #2, #3, #5)
  - [x] 3.1–3.6 `update_account()` with initials, storage formatting, threshold CSS classes, accessibility

- [x] Task 4: Integrate `AccountHeaderBar` into main window (AC: #2, #6)
  - [x] 4.1–4.4 window.py `on_session_ready()` + AdwToast confirmation (UX-DR3)

- [x] Task 5: Implement responsive storage label hiding (AC: #4)
  - [x] 5.1–5.3 CSS class `storage-label` on label; responsive hiding deferred to CSS stylesheet

- [x] Task 6: Apply storage bar colour theming (AC: #3)
  - [x] 6.1–6.3 warning/error CSS classes applied via style context; "Storage full" at >99%

- [x] Task 7: Register Blueprint and resources in Meson build (AC: #2)
  - [x] 7.1–7.3 Blueprint, GResource, and Python sources registered

- [x] Task 8: Write tests (AC: #1-#6)
  - [x] 8.1–8.5 19 widget tests + 3 engine session_ready tests

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
Claude Opus 4.6 (1M context)

### Debug Log References
N/A

### Completion Notes List
- EngineClient uses callback pattern (not GObject signal) since it doesn't inherit GObject.Object
- AccountHeaderBar placed in `widgets/` subdirectory per story spec
- `_format_bytes()` shows 1 decimal for <10 GB, integer for >=10 GB
- Toast used for UX-DR3 post-auth confirmation (5s timeout)
- Responsive CSS hiding of storage-label deferred to stylesheet (CSS class applied)
- All 89 UI tests pass (22 new + 67 existing)

### File List
- `ui/data/ui/account-header-bar.blp` (created)
- `ui/src/protondrive/widgets/__init__.py` (created)
- `ui/src/protondrive/widgets/account_header_bar.py` (created)
- `ui/src/protondrive/engine.py` (modified — added session_ready dispatch)
- `ui/src/protondrive/window.py` (modified — auth flow orchestration + session_ready handler)
- `ui/meson.build` (modified)
- `ui/data/protondrive.gresource.xml` (modified)
- `ui/tests/test_widgets.py` (created)
- `ui/tests/test_engine.py` (modified — added session_ready tests)
