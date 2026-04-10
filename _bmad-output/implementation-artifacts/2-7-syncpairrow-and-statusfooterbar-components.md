# Story 2.7: SyncPairRow & StatusFooterBar Components

Status: ready-for-dev

## Story

As a user,
I want to see the sync status of each pair in the sidebar and a global status bar at the bottom,
So that I know what's happening at a glance without clicking into anything.

## Acceptance Criteria

**AC1 — SyncPairRow widget:**
**Given** a sync pair exists
**When** the sidebar renders
**Then** a `SyncPairRow` widget is displayed per pair with: 8px status dot + pair name (folder basename) + optional status text
**And** states: `synced` (dot uses `@success_color`), `syncing` (dot uses teal accent with CSS pulse animation)
**And** the row is a `GtkListBoxRow` subclass — structure in `sync-pair-row.blp`, signals in `sync_pair_row.py`

**AC2 — StatusFooterBar widget:**
**Given** the main window renders with at least one sync pair
**When** the footer renders
**Then** a `StatusFooterBar` is visible at the bottom of the window (36px height min)
**And** states: "All synced" (green dot), "Syncing N files in [pair name]..." (teal dot, animated)
**And** priority: Syncing state overrides All synced when any pair is actively syncing

**AC3 — Sidebar GtkListBox wiring:**
**Given** `window.py` receives a `get_status_result` payload with non-empty `pairs` list
**When** the main view renders
**Then** the sidebar `GtkListBox` is populated with one `SyncPairRow` per pair
**And** clicking a row emits a `row-selected` signal consumed by `window.py` to show pair detail in content area

**AC4 — sync_progress and sync_complete event handling:**
**Given** the engine emits `sync_progress`
**When** the event arrives
**Then** `window.py` calls `row.set_state('syncing')` on the matching `SyncPairRow`
**And** calls `status_footer_bar.set_syncing(pair_name, files_done, files_total)`
**Given** the engine emits `sync_complete`
**When** the event arrives
**Then** `window.py` calls `row.set_state('synced')` on the matching `SyncPairRow`
**And** calls `status_footer_bar.update_all_synced()`

**AC5 — Accessibility:**
**Given** the `SyncPairRow` status changes
**When** AT-SPI2 is queried
**Then** the row's accessible label announces: "[pair name] — synced" or "[pair name] — syncing" — never colour alone
**Given** `StatusFooterBar` state changes
**When** AT-SPI2 is queried
**Then** state text uses `GTK_ACCESSIBLE_STATE_LIVE` (polite)

**AC6 — Widget boundary:**
**Given** the implementation
**When** inspecting imports
**Then** `sync_pair_row.py` and `status_footer_bar.py` do NOT import from each other
**And** all coordination goes through `window.py`

**AC7 — UI tests:**
**Given** unit tests in `ui/tests/test_sync_pair_row.py` and `ui/tests/test_status_footer_bar.py`
**When** running `meson test -C builddir`
**Then** tests verify: state transitions, accessible labels, signal emission, `window.py` event routing

## Tasks / Subtasks

- [ ] **Task 1: Create sync-pair-row.blp** (AC: #1)
  - [ ] 1.1 Create `ui/data/ui/sync-pair-row.blp`:
    ```blp
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDriveSyncPairRow: Gtk.ListBoxRow {
      child: Gtk.Box {
        orientation: horizontal;
        margin-start: 12;
        margin-end: 12;
        margin-top: 8;
        margin-bottom: 8;
        spacing: 8;

        Gtk.DrawingArea status_dot {
          width-request: 8;
          height-request: 8;
          valign: center;
        }

        Gtk.Box {
          orientation: vertical;
          valign: center;
          hexpand: true;

          Gtk.Label pair_name_label {
            halign: start;
            xalign: 0;
          }

          Gtk.Label status_label {
            halign: start;
            xalign: 0;
            styles ["caption", "dim-label"]
          }
        }
      };
    }
    ```
  - [ ] 1.2 Add CSS in `ui/data/style.css` (or equivalent) for dot pulse animation:
    ```css
    .sync-dot-syncing {
      animation: sync-pulse 1.5s ease-in-out infinite;
    }
    @keyframes sync-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    ```
    If no `style.css` exists, create it and load it in `main.py` via `Gtk.CssProvider`.

- [ ] **Task 2: Implement sync_pair_row.py** (AC: #1, #5, #6)
  - [ ] 2.1 Create `ui/src/protondrive/widgets/sync_pair_row.py`:
    - `@Gtk.Template(resource_path=".../ui/sync-pair-row.ui")`
    - `class SyncPairRow(Gtk.ListBoxRow)` with `__gtype_name__ = "ProtonDriveSyncPairRow"`
    - `GObject.Signal('row-selected')` — emitted when row is activated
    - Template children: `status_dot`, `pair_name_label`, `status_label`
    - Constructor args: `pair_id: str`, `pair_name: str` (basename of local_path)
    - `set_state(state: str)` — accepts `'synced'` or `'syncing'`; updates dot colour via `DrawingArea.queue_draw()` and CSS class; updates `status_label.set_text()`; sets accessible label
    - Dot colour drawn in `on_draw` callback (DrawingArea): green (`#33b74a` or `@success_color` parsed) for synced, teal (`#1da1a0`) for syncing — draw filled circle
    - Accessible label: `self.set_accessible_label(f"{pair_name} — {state}")`
    - `@Gtk.Template.Callback` for row activation → emit `row-selected`
  - [ ] 2.2 Export `SyncPairRow` in `ui/src/protondrive/widgets/__init__.py`

- [ ] **Task 3: Create status-footer-bar.blp and implement status_footer_bar.py** (AC: #2, #5)
  - [ ] 3.1 Create `ui/data/ui/status-footer-bar.blp`:
    ```blp
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDriveStatusFooterBar: Gtk.Box {
      orientation: horizontal;
      spacing: 8;
      margin-start: 12;
      margin-end: 12;
      height-request: 36;
      valign: end;

      Gtk.DrawingArea footer_dot {
        width-request: 8;
        height-request: 8;
        valign: center;
      }

      Gtk.Label footer_label {
        valign: center;
        styles ["caption"]
      }
    }
    ```
  - [ ] 3.2 Create `ui/src/protondrive/widgets/status_footer_bar.py`:
    - `class StatusFooterBar(Gtk.Box)` with `__gtype_name__ = "ProtonDriveStatusFooterBar"`
    - `set_syncing(pair_name: str, files_done: int, files_total: int)` — updates label to "Syncing {files_done}/{files_total} in {pair_name}..."; dot to teal; adds CSS pulse class; sets `GTK_ACCESSIBLE_STATE_LIVE` (polite)
    - `update_all_synced()` — sets label to "All synced"; dot to green; removes pulse class
    - `_on_dot_draw(area, cr, width, height)` — draw filled 8px circle with current colour
  - [ ] 3.3 Export `StatusFooterBar` in `__init__.py`

- [ ] **Task 4: Update window.blp to include StatusFooterBar** (AC: #2, #3)
  - [ ] 4.1 Modify `ui/data/ui/window.blp`:
    - Replace static sidebar content (`Adw.StatusPage "No Sync Pairs"`) with:
      ```blp
      content: Adw.ToolbarView {
        [top]
        Adw.HeaderBar {}
        content: Gtk.ScrolledWindow {
          child: Gtk.ListBox pairs_list {
            selection-mode: single;
          };
        };
        [bottom]
        $ProtonDriveStatusFooterBar status_footer_bar {}
      };
      ```
    - Add `pairs_list` and `status_footer_bar` as template children

- [ ] **Task 5: Update window.py to wire SyncPairRow and StatusFooterBar** (AC: #3, #4, #6)
  - [ ] 5.1 Import `SyncPairRow`, `StatusFooterBar` at top of `window.py`
  - [ ] 5.2 Add template children: `pairs_list: Gtk.ListBox`, `status_footer_bar: StatusFooterBar`
  - [ ] 5.3 Add `_sync_pair_rows: dict[str, SyncPairRow] = {}` to `__init__`
  - [ ] 5.4 Add `populate_pairs(pairs: list[dict])` method:
    - Remove all existing rows from `pairs_list`
    - For each pair: create `SyncPairRow(pair['pair_id'], basename(pair['local_path']))`, connect `row-selected`, append to `pairs_list`
    - Store in `_sync_pair_rows`
    - Call from `on_get_status_result` (Story 2-4) when pairs is non-empty
  - [ ] 5.5 In `engine.py` event routing (via `main.py`):
    - `sync_progress` → `window.on_sync_progress(payload)`
    - `sync_complete` → `window.on_sync_complete(payload)`
  - [ ] 5.6 Add `on_sync_progress(self, payload)`:
    - `row = self._sync_pair_rows.get(payload['pair_id'])`; `row.set_state('syncing')` if found
    - `self.status_footer_bar.set_syncing(pair_name, payload['files_done'], payload['files_total'])`
  - [ ] 5.7 Add `on_sync_complete(self, payload)`:
    - `row = self._sync_pair_rows.get(payload['pair_id'])`; `row.set_state('synced')` if found
    - If all rows are 'synced': `self.status_footer_bar.update_all_synced()`

- [ ] **Task 6: Register blueprints and update meson.build** (AC: #1, #2)
  - [ ] 6.1 Add `custom_target` for `blueprint-sync-pair-row` and `blueprint-status-footer-bar` in `ui/meson.build`
  - [ ] 6.2 Add both targets to `depends` of the gresource target
  - [ ] 6.3 Add `<file alias="ui/sync-pair-row.ui">sync-pair-row.ui</file>` and `status-footer-bar.ui` to `ui/data/protondrive.gresource.xml`
  - [ ] 6.4 Add `sync_pair_row.py` and `status_footer_bar.py` to `python_widget_sources` in `meson.build`

- [ ] **Task 7: UI tests** (AC: #7)
  - [ ] 7.1 Create `ui/tests/test_sync_pair_row.py`:
    - Mock engine; use `object.__new__(SyncPairRow)` to bypass GTK init
    - Test `set_state('syncing')` sets `_state` to 'syncing'
    - Test `set_state('synced')` sets `_state` to 'synced'
    - Test accessible label is set correctly for each state
  - [ ] 7.2 Create `ui/tests/test_status_footer_bar.py`:
    - Test `set_syncing` updates label text
    - Test `update_all_synced` updates label text
  - [ ] 7.3 `meson test -C builddir` — all tests pass

## Dev Notes

### DrawingArea dot rendering
Use `DrawingArea.set_draw_func()` (GTK4 API, NOT `connect('draw', ...)`):
```python
self.status_dot.set_draw_func(self._draw_dot)

def _draw_dot(self, area, cr, width, height):
    import math
    if self._state == 'syncing':
        cr.set_source_rgb(0.11, 0.63, 0.63)  # teal
    else:
        cr.set_source_rgb(0.20, 0.72, 0.29)  # green (approximate @success_color)
    cx, cy, r = width / 2, height / 2, min(width, height) / 2
    cr.arc(cx, cy, r, 0, 2 * math.pi)
    cr.fill()
```
`queue_draw()` after state change to trigger redraw.

### CSS pulse animation loading
```python
# In main.py or application init:
css_provider = Gtk.CssProvider()
css_provider.load_from_data(CSS_STRING, -1)
Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(),
    css_provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
)
```
The CSS class `sync-dot-syncing` must be added/removed via `widget.add_css_class('sync-dot-syncing')` / `remove_css_class`.

Note: CSS animations on a `DrawingArea` will NOT work — the animation class only affects CSS-rendered widgets (boxes, labels, etc.). For the animated dot effect, use a `GLib.timeout_add(100, callback)` to periodically `queue_draw()` and toggle opacity manually in `_draw_dot`, OR use a `Gtk.Spinner` styled as a dot, OR use a static dot colour without animation. Implement whichever is simplest that satisfies the AC.

### window.blp StatusFooterBar placement
The `[bottom]` toolbar slot in `Adw.ToolbarView` puts the footer bar below the list:
```blp
child: Adw.ToolbarView {
  [top]
  Adw.HeaderBar {}
  content: Gtk.ScrolledWindow { ... }
  [bottom]
  $ProtonDriveStatusFooterBar status_footer_bar {}
};
```
`$ProtonDriveStatusFooterBar` requires the custom type to be registered — it will be, via `@Gtk.Template` on the class.

### No widget-to-widget imports
```python
# ✓ correct — window.py coordinates
from protondrive.widgets.sync_pair_row import SyncPairRow
from protondrive.widgets.status_footer_bar import StatusFooterBar
# ✗ forbidden — sync_pair_row.py MUST NOT import status_footer_bar.py
```

### References
- [Source: ui/data/ui/window.blp] — current window structure to extend
- [Source: ui/src/protondrive/window.py] — show_main(), event routing to extend
- [Source: ui/src/protondrive/widgets/settings.py] — widget class pattern
- [Source: ui/data/ui/settings.blp] — Blueprint syntax reference
- [Source: ui/meson.build] — blueprint registration pattern
- [Source: ui/tests/conftest.py] — test isolation patterns

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `ui/data/ui/sync-pair-row.blp` — new: SyncPairRow Blueprint
- `ui/data/ui/status-footer-bar.blp` — new: StatusFooterBar Blueprint
- `ui/src/protondrive/widgets/sync_pair_row.py` — new: SyncPairRow widget
- `ui/src/protondrive/widgets/status_footer_bar.py` — new: StatusFooterBar widget
- `ui/data/ui/window.blp` — update: add pairs_list GtkListBox, status_footer_bar
- `ui/src/protondrive/window.py` — update: wire SyncPairRow, StatusFooterBar, event routing
- `ui/meson.build` — add blueprint targets
- `ui/data/protondrive.gresource.xml` — add new ui files
- `ui/tests/test_sync_pair_row.py` — new: unit tests
- `ui/tests/test_status_footer_bar.py` — new: unit tests

## Change Log

- 2026-04-09: Story 2.7 created — SyncPairRow & StatusFooterBar Components
