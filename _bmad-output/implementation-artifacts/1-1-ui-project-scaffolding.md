# Story 1.1: UI Project Scaffolding

Status: done

## Story

As a developer,
I want a working GTK4/Libadwaita project scaffold with Meson build, Blueprint UI files, and Flatpak manifest stub,
so that all subsequent UI stories have a buildable foundation to work from.

## Acceptance Criteria

1. **Given** the project scaffold has been created, **when** `meson setup builddir && meson compile -C builddir` is run, **then** the project compiles without errors.

2. **Given** the compiled project, **when** inspecting all manifests, GSettings schema, GResource paths, desktop file, and AppStream metainfo stub, **then** the Flatpak App ID `io.github.ronki2304.ProtonDriveLinuxClient` is set consistently in all of them.

3. **Given** the app is launched, **when** the main window renders, **then** an empty `AdwNavigationSplitView` window is displayed with mandatory dark theme (`ADW_COLOR_SCHEME_FORCE_DARK`) and teal accent (`#0D9488` via `AdwAccentColor` API), with minimum size 360x480px and default size 780x520px.

4. **Given** the project structure, **when** inspecting the source tree, **then**:
   - `ui/src/protondrive/` contains `__init__.py`, `main.py`, `window.py`
   - `ui/data/ui/` contains `window.blp`
   - `ui/data/` contains the GSettings schema XML and app icon SVGs
   - All widget structure is defined in Blueprint `.blp` files, never in Python

## Tasks / Subtasks

- [x] Task 1: Generate GNOME Builder template and restructure (AC: #1, #4)
  - [x] 1.1 Use GNOME Builder Python/GTK4/Libadwaita template or create equivalent Meson project manually
  - [x] 1.2 Set up directory structure: `ui/src/protondrive/`, `ui/data/ui/`, `ui/data/icons/`
  - [x] 1.3 Create `__init__.py`, `main.py`, `window.py` in `ui/src/protondrive/`
  - [x] 1.4 Create `window.blp` in `ui/data/ui/`
  - [x] 1.5 Configure `meson.build` with GResource compilation, Blueprint compilation, GSettings schema install
  - [x] 1.6 Verify `meson setup builddir && meson compile -C builddir` succeeds

- [x] Task 2: Set App ID consistently across all files (AC: #2)
  - [x] 2.1 GSettings schema: `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml`
  - [x] 2.2 GResource paths: `/io/github/ronki2304/ProtonDriveLinuxClient/`
  - [x] 2.3 Desktop file: `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.desktop`
  - [x] 2.4 AppStream metainfo stub: `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
  - [x] 2.5 Flatpak manifest stub: `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
  - [x] 2.6 App icon SVGs named `io.github.ronki2304.ProtonDriveLinuxClient.svg` and `.symbolic.svg`

- [x] Task 3: Configure main window shell (AC: #3)
  - [x] 3.1 In `main.py`: Create `Adw.Application` entry point, enforce dark theme via `AdwStyleManager.set_color_scheme(ADW_COLOR_SCHEME_FORCE_DARK)`, set teal accent `#0D9488` via `AdwAccentColor` API
  - [x] 3.2 In `window.blp`: Define `AdwApplicationWindow` with `AdwNavigationSplitView` layout, sidebar placeholder (~220px), detail panel placeholder
  - [x] 3.3 In `window.py`: Wire `@Gtk.Template` to `window.blp`, set minimum size 360x480px, default size 780x520px
  - [x] 3.4 Initialize single `Gio.Settings` instance in Application class

- [x] Task 4: Create placeholder icon SVGs (AC: #2, #4)
  - [x] 4.1 Create `io.github.ronki2304.ProtonDriveLinuxClient.svg` (regular app icon)
  - [x] 4.2 Create `io.github.ronki2304.ProtonDriveLinuxClient-symbolic.svg` (symbolic icon)

## Dev Notes

### Architecture Constraints

- **Blueprint rule is absolute**: ALL widget structure lives in `.blp` files. Python files (`window.py`, `main.py`) contain only signal wiring, state management, and application logic. Never construct widget trees in Python (no `Gtk.Box()`, `Gtk.Label()`, etc.).
- **One `Gio.Settings` instance per app**: Held by `Application` class in `main.py`, passed to widgets via constructor. Never instantiate per-widget.
- **`from __future__ import annotations`**: Use in all Python files for forward references.
- **Type hints on all public functions**: Including `__init__` methods and signal handlers.
- **No `lambda` in signal connections**: Causes GObject reference cycles and memory leaks. Always use explicit method references.

### GResource Path Convention

All resources must be prefixed with `/io/github/ronki2304/ProtonDriveLinuxClient/`. The `@Gtk.Template` decorator in Python uses `resource_path` pointing to the compiled `.ui` file (Blueprint compiles `.blp` to `.ui` during Meson build):

```python
@Gtk.Template(resource_path='/io/github/ronki2304/ProtonDriveLinuxClient/ui/window.ui')
class MainWindow(Adw.ApplicationWindow):
    __gtype_name__ = 'ProtonDriveMainWindow'
```

The `__gtype_name__` must match the Blueprint `template` class name exactly.

### Blueprint File Conventions

- File naming: `kebab-case.blp` (e.g., `window.blp`, `auth-window.blp`)
- Widget IDs in Blueprint use `kebab-case` (e.g., `status-label`, `sync-button`)
- Blueprint `kebab-case` IDs auto-convert to `snake_case` in Python `Gtk.Template.Child()` (GTK handles conversion)
- Example: Blueprint `id: status-label` maps to Python `status_label = Gtk.Template.Child()`

### GSettings Schema

Create `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` with initial keys:
- `window-width` (integer, default 780)
- `window-height` (integer, default 520)

Keys use `kebab-case` per GNOME convention.

### Flatpak Manifest Stub

The stub in `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` should include:
- Runtime: `org.gnome.Platform//50`
- SDK: `org.gnome.Sdk//50`
- SDK extension: `org.freedesktop.Sdk.Extension.node22`
- Two-module structure (UI module + engine module placeholder)
- Build options with `append-path: /usr/lib/sdk/node22/bin`

Full permissions and finish-args are deferred to Epic 7 (Story 7.1).

### Desktop File Stub

`flatpak/io.github.ronki2304.ProtonDriveLinuxClient.desktop`:
- `Categories=Network;FileTransfer;`
- `StartupNotify=true`
- Icon: `io.github.ronki2304.ProtonDriveLinuxClient`
- Exec line appropriate for Flatpak

### AppStream Metainfo Stub

`flatpak/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`:
- Display name: `ProtonDrive Linux Client`
- Summary: `Unofficial open-source sync client for ProtonDrive on Linux`
- Full metainfo (screenshots, release notes, OARS) deferred to Epic 7 (Story 7.2)

### Dark Theme & Accent Color Implementation

In `main.py` Application `do_startup()` or `do_activate()`:

```python
style_manager = Adw.StyleManager.get_default()
style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)
```

For teal accent `#0D9488` — use `Adw.AccentColor` API. Note: Libadwaita 1.6+ (GNOME 47+) supports `AdwAccentColor`. GNOME 50 runtime includes Libadwaita 1.8, so this is available. Check exact API — it may be `Adw.StyleManager.set_accent_color()` with an `Adw.AccentColor` enum value, or a custom CSS approach if the enum doesn't include teal. Research the exact Libadwaita 1.8 API before implementing.

### Window Sizing

In `window.py` or `window.blp`:
- Set `default-width: 780` and `default-height: 520` on the `AdwApplicationWindow`
- Set `width-request: 360` and `height-request: 480` for minimum size
- Window state persistence (save/restore size) is deferred to Story 2.9

### AdwNavigationSplitView Layout

The `window.blp` should define:
- `AdwNavigationSplitView` as the main container
- Sidebar (`AdwNavigationPage`): ~220px width, placeholder content (empty `AdwStatusPage` with "Add your first sync pair" message is acceptable for scaffold)
- Content/detail panel (`AdwNavigationPage`): placeholder content
- Responsive collapse happens automatically at narrow widths (Libadwaita handles this)

### UX Specifications for Shell

- **Sidebar**: Fixed ~220px width, will contain scrollable `GtkListBox` in later stories
- **Detail panel**: Fills remaining width
- **Responsive**: `AdwNavigationSplitView` collapses below ~480px — sidebar hidden, back button appears
- **Footer**: `StatusFooterBar` (36px) deferred to Story 2.7
- **Header**: `AccountHeaderBar` deferred to Story 1.10
- **Empty state**: Use `AdwStatusPage` for placeholder panels (UX-DR16)

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Python files | `snake_case.py` | `main.py`, `window.py` |
| Python classes | `PascalCase` | `MainWindow`, `Application` |
| Python functions | `snake_case` | `do_activate()`, `on_clicked()` |
| Blueprint files | `kebab-case.blp` | `window.blp` |
| Blueprint widget IDs | `kebab-case` | `nav-split-view` |
| GSettings keys | `kebab-case` | `window-width` |

### App ID Propagation Checklist

The App ID `io.github.ronki2304.ProtonDriveLinuxClient` must appear in ALL of these locations — verify each one:

1. `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml` (schema id attribute)
2. `ui/meson.build` (application_id)
3. GResource XML (resource prefix)
4. `main.py` (application_id parameter to `Adw.Application`)
5. `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` (app-id)
6. `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.desktop` (desktop file name + icon)
7. `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` (component id)
8. Icon SVG filenames

### Project Structure Notes

Target structure after this story:

```
ui/
  meson.build
  meson_options.txt (if needed)
  src/
    protondrive/
      __init__.py
      main.py          # Adw.Application entry, dark theme, accent color, GSettings init
      window.py         # AdwApplicationWindow, @Gtk.Template wiring
  data/
    ui/
      window.blp        # AdwNavigationSplitView layout
    icons/
      io.github.ronki2304.ProtonDriveLinuxClient.svg
      io.github.ronki2304.ProtonDriveLinuxClient-symbolic.svg
    io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml
    protondrive.gresource.xml    # GResource manifest
flatpak/
  io.github.ronki2304.ProtonDriveLinuxClient.yml        # Flatpak manifest stub
  io.github.ronki2304.ProtonDriveLinuxClient.desktop     # Desktop file
  io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml # AppStream stub
```

### Testing

No automated tests for this story — it is a scaffolding story. Verification is:
1. `meson setup builddir && meson compile -C builddir` succeeds
2. App launches and displays the empty window with correct theme/accent/sizing
3. App ID is consistent across all files (manual grep verification)

UI test infrastructure (`conftest.py`, Xvfb setup) is established in later stories when there is testable behavior.

### References

- [Source: _bmad-output/planning-artifacts/epics.md § Story 1.1, lines 311-336]
- [Source: _bmad-output/planning-artifacts/architecture.md § Project Structure]
- [Source: _bmad-output/planning-artifacts/architecture.md § Mandatory Implementation Patterns]
- [Source: _bmad-output/planning-artifacts/architecture.md § Naming Conventions]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md § UX-DR11, UX-DR12, UX-DR13]
- [Source: _bmad-output/project-context.md § GTK4/Libadwaita rules, Blueprint rules, GSettings rules]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
None — scaffolding story, no runtime debugging needed.

### Completion Notes List
- Created full Meson project with Blueprint compilation, GResource bundling, GSettings schema
- App ID `io.github.ronki2304.ProtonDriveLinuxClient` verified consistent across all 9 file references
- `Adw.AccentColor.TEAL` confirmed available in Libadwaita 1.8 (GNOME runtime 50)
- `meson setup builddir && meson compile -C builddir` succeeds cleanly
- Blueprint compiles `window.blp` → `window.ui` with correct `ProtonDriveMainWindow` template class
- GResource uses `alias` attribute to map flat build output to `ui/window.ui` resource path
- No automated tests for this scaffolding story per Dev Notes

### Change Log
- 2026-04-08: Story 1-1 implemented — full UI project scaffold with Meson build, Blueprint, Flatpak manifest stub

### File List
- ui/meson.build (new)
- ui/src/protondrive/__init__.py (new)
- ui/src/protondrive/__main__.py (new)
- ui/src/protondrive/main.py (new)
- ui/src/protondrive/window.py (new)
- ui/data/ui/window.blp (new)
- ui/data/protondrive.gresource.xml (new)
- ui/data/io.github.ronki2304.ProtonDriveLinuxClient.gschema.xml (new)
- ui/data/icons/io.github.ronki2304.ProtonDriveLinuxClient.svg (new)
- ui/data/icons/io.github.ronki2304.ProtonDriveLinuxClient-symbolic.svg (new)
- flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml (new)
- flatpak/io.github.ronki2304.ProtonDriveLinuxClient.desktop (new)
- flatpak/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml (new)

### Review Findings
- [x] [Review][Decision] `show_main()` reparents template child `nav_split_view` into new ToastOverlay — FIXED: moved ToastOverlay into window.blp, template child in window.py
- [x] [Review][Patch] No executable entry point — FIXED: added `__main__.py` with entry point
- [x] [Review][Patch] `install_data` flattens `widgets/` subdirectory — FIXED: split into separate install_data calls with correct subdirectory
- [x] [Review][Defer] `_on_engine_error` is `pass` — deferred, explicit TODO for Story 5.x
- [x] [Review][Defer] `on_event("ready")` never dispatched to Application callback — deferred, engine.py bug in story 1-3/1-5
- [x] [Review][Defer] `start_auth_flow()` dead code — deferred, unreachable method
- [x] [Review][Defer] Logout/credential exception swallowing — deferred, credential store story scope
- [x] [Review][Defer] `_on_auth_completed` shows main before engine confirms session — deferred, auth flow story scope
