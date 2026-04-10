# Story 2.8: SyncProgressCard & Detail Panel

Status: ready-for-dev

## Story

As a user,
I want to see detailed sync progress and stats for the selected pair,
So that I know exactly what's happening during first sync and ongoing operations.

## Acceptance Criteria

**AC1 — Detail panel — pair selected:**
**Given** a sync pair is selected in the sidebar
**When** the detail panel renders
**Then** it shows: pair name (folder basename), local path, remote path, last synced timestamp (or "Never" if none), status

**AC2 — Detail panel — no pair selected:**
**Given** no sync pair is selected
**When** the detail panel renders
**Then** an `AdwStatusPage` is displayed: "Select a sync pair to see details" with a folder icon

**AC3 — Detail panel — zero pairs (post-auth, pre-wizard):**
**Given** no sync pairs exist and the wizard has not been completed
**When** the detail area renders
**Then** an `AdwStatusPage` is displayed with a teal CTA button "Add your first sync pair" that opens the setup wizard (UX-DR16)

**AC4 — SyncProgressCard during active sync:**
**Given** a sync is actively running for the selected pair
**When** the `SyncProgressCard` is visible
**Then** it shows an indeterminate `GtkProgressBar` + "Counting files..." while `files_total == 0`
**And** once `files_total > 0`, it switches to determinate bar + "{files_done}/{files_total} files" + "{bytes_done}/{bytes_total}" + ETA label (FR15)
**And** after `sync_complete` arrives, the card transitions back to normal detail view after 2 seconds

**AC5 — sync_progress event updates:**
**Given** `sync_progress` IPC events arrive
**When** the selected pair is the one syncing
**Then** the progress card updates in real time: determinate bar progress = `files_done / files_total`, labels update
**And** UI interactions remain responsive within 200ms during updates (NFR2)

**AC6 — sync_complete event:**
**Given** `sync_complete` arrives for the selected pair
**When** the event is handled
**Then** "Last synced: X seconds ago" replaces the progress card after 2 seconds (FR18, FR19)
**And** the timestamp from the event payload is used

**AC7 — Widget boundary:**
**Given** the implementation
**When** inspecting imports
**Then** `sync_progress_card.py` does NOT import from any other widget file

**AC8 — UI tests:**
**Given** unit tests in `ui/tests/test_sync_progress_card.py`
**When** running `meson test -C builddir`
**Then** tests verify: indeterminate → determinate transition, `sync_complete` schedules 2s transition, label text is correct per progress state

## Tasks / Subtasks

- [ ] **Task 1: Create sync-progress-card.blp** (AC: #4)
  - [ ] 1.1 Create `ui/data/ui/sync-progress-card.blp`:
    ```blp
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDriveSyncProgressCard: Adw.Bin {
      child: Gtk.Box {
        orientation: vertical;
        spacing: 8;
        margin-start: 16;
        margin-end: 16;
        margin-top: 12;
        margin-bottom: 12;

        Gtk.Label progress_title_label {
          halign: start;
          styles ["heading"]
        }

        Gtk.ProgressBar progress_bar {
          show-text: false;
        }

        Gtk.Box {
          orientation: horizontal;
          Gtk.Label files_label { hexpand: true; halign: start; }
          Gtk.Label bytes_label { halign: end; }
        }

        Gtk.Label eta_label {
          halign: start;
          styles ["caption", "dim-label"]
        }
      };
    }
    ```

- [ ] **Task 2: Implement sync_progress_card.py** (AC: #4, #5, #6)
  - [ ] 2.1 Create `ui/src/protondrive/widgets/sync_progress_card.py`:
    - `class SyncProgressCard(Adw.Bin)` with `__gtype_name__ = "ProtonDriveSyncProgressCard"`
    - `GObject.Signal('sync-complete-displayed')` — emitted after 2s post-sync transition
    - Template children: `progress_title_label`, `progress_bar`, `files_label`, `bytes_label`, `eta_label`
    - `update_progress(files_done: int, files_total: int, bytes_done: int, bytes_total: int, started_at: datetime)`:
      - If `files_total == 0`: `progress_bar.set_fraction(0)` (indeterminate via CSS or pulse); `progress_title_label.set_text("Counting files...")`; `files_label.set_text("")`; `eta_label.set_text("")`
      - Else: `progress_bar.set_fraction(files_done / files_total)`; update labels; compute ETA from `started_at` and elapsed bytes
    - `on_sync_complete()`: schedule `GLib.timeout_add(2000, self._show_complete_transition)`
    - `_show_complete_transition()`: emit `sync-complete-displayed`; return `GLib.SOURCE_REMOVE`
  - [ ] 2.2 Export in `__init__.py`

- [ ] **Task 3: Create pair-detail-panel.blp** (AC: #1, #2, #3)
  - [ ] 3.1 Create `ui/data/ui/pair-detail-panel.blp`:
    ```blp
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDrivePairDetailPanel: Adw.Bin {
      child: Gtk.Stack detail_stack {
        transition-type: crossfade;

        Gtk.StackPage {
          name: "empty";
          child: Adw.StatusPage {
            icon-name: "folder-symbolic";
            title: "Select a sync pair to see details";
          };
        }

        Gtk.StackPage {
          name: "no-pairs";
          child: Adw.StatusPage {
            icon-name: "folder-remote-symbolic";
            title: "No Sync Pairs";
            description: "Add your first sync pair to start syncing.";
            child: Gtk.Button add_pair_button {
              label: "Add your first sync pair";
              halign: center;
              styles ["suggested-action", "pill"]
            };
          };
        }

        Gtk.StackPage {
          name: "detail";
          child: Gtk.Box {
            orientation: vertical;
            spacing: 0;

            Gtk.Box detail_header {
              orientation: vertical;
              margin-start: 16;
              margin-end: 16;
              margin-top: 16;
              margin-bottom: 8;
              Gtk.Label detail_pair_name { styles ["title-2"] halign: start; }
              Gtk.Label detail_local_path { styles ["caption", "dim-label"] halign: start; }
              Gtk.Label detail_remote_path { styles ["caption", "dim-label"] halign: start; }
            }

            $ProtonDriveSyncProgressCard progress_card {}

            Gtk.Label last_synced_label {
              margin-start: 16;
              margin-top: 8;
              halign: start;
              styles ["caption", "dim-label"]
            }
          };
        }
      };
    }
    ```
  - [ ] 3.2 `progress_card` visible only when actively syncing; `last_synced_label` visible when not syncing and a sync has completed

- [ ] **Task 4: Implement pair_detail_panel.py** (AC: #1, #2, #3, #4, #5, #6)
  - [ ] 4.1 Create `ui/src/protondrive/widgets/pair_detail_panel.py`:
    - `class PairDetailPanel(Adw.Bin)` with `__gtype_name__ = "ProtonDrivePairDetailPanel"`
    - Template children: `detail_stack`, `add_pair_button`, `detail_pair_name`, `detail_local_path`, `detail_remote_path`, `progress_card`, `last_synced_label`
    - `GObject.Signal('add-pair-requested')` — emitted when `add_pair_button` clicked
    - `show_no_pairs()` → `detail_stack.set_visible_child_name('no-pairs')`
    - `show_empty()` → `detail_stack.set_visible_child_name('empty')`
    - `show_pair(pair: dict)` → populate labels; `detail_stack.set_visible_child_name('detail')`; `progress_card.set_visible(False)`
    - `on_sync_progress(payload: dict)` → `progress_card.set_visible(True)`; call `progress_card.update_progress(...)`; track `_sync_started_at` if first call
    - `on_sync_complete(payload: dict)` → call `progress_card.on_sync_complete()`; connect `sync-complete-displayed` → `_on_progress_done(timestamp)`
    - `_on_progress_done(timestamp: str)` → `progress_card.set_visible(False)`; `last_synced_label.set_text(f"Last synced: {_format_timestamp(timestamp)}")`
    - `_format_timestamp(iso: str) -> str` → "X seconds ago" / "X minutes ago" / "X hours ago"
  - [ ] 4.2 Export in `__init__.py`

- [ ] **Task 5: Wire into window.py and window.blp** (AC: #1, #2, #3)
  - [ ] 5.1 Update `window.blp` content area: replace static `Adw.StatusPage "Welcome"` with `$ProtonDrivePairDetailPanel detail_panel {}`
  - [ ] 5.2 In `window.py`:
    - Add template child: `detail_panel: PairDetailPanel`
    - In `show_main()`: call `detail_panel.show_no_pairs()` if pairs is empty, else `show_empty()`
    - On `row-selected` from `SyncPairRow`: call `detail_panel.show_pair(pair_data)`
    - On `sync_progress` event for the currently selected pair: call `detail_panel.on_sync_progress(payload)`
    - On `sync_complete` event: call `detail_panel.on_sync_complete(payload)`
    - On `add-pair-requested` from `detail_panel`: show setup wizard

- [ ] **Task 6: Register blueprints** (AC: #4)
  - [ ] 6.1 Add `custom_target` for `blueprint-sync-progress-card` and `blueprint-pair-detail-panel` in `ui/meson.build`
  - [ ] 6.2 Add to gresource XML and meson depends list
  - [ ] 6.3 Add Python sources to `python_widget_sources`

- [ ] **Task 7: UI tests** (AC: #8)
  - [ ] 7.1 Create `ui/tests/test_sync_progress_card.py`:
    - `object.__new__(SyncProgressCard)` — bypass GTK init
    - Test: `update_progress(0, 0, 0, 0, ...)` sets indeterminate state (title = "Counting files...")
    - Test: `update_progress(1, 5, 1024, 10240, ...)` sets fraction = 0.2 and updates labels
    - Test: `on_sync_complete()` schedules timeout (verify `GLib.timeout_add` called or use mock)
  - [ ] 7.2 `meson test -C builddir` — all tests pass

## Dev Notes

### Indeterminate GtkProgressBar
`GtkProgressBar` does not have a built-in `set_indeterminate()` method. Use `progress_bar.pulse()` called on a timer for indeterminate animation:
```python
# During 'counting files' state:
self._pulse_timer = GLib.timeout_add(200, self._pulse_bar)

def _pulse_bar(self):
    self.progress_bar.pulse()
    return GLib.SOURCE_CONTINUE  # keep pulsing

# When transitioning to determinate, remove timer:
if self._pulse_timer:
    GLib.source_remove(self._pulse_timer)
    self._pulse_timer = None
```

### ETA calculation
```python
def _compute_eta(self, bytes_done: int, bytes_total: int, started_at: datetime) -> str:
    elapsed = (datetime.now() - started_at).total_seconds()
    if elapsed < 1 or bytes_done == 0:
        return "Calculating..."
    rate = bytes_done / elapsed  # bytes per second
    remaining = bytes_total - bytes_done
    eta_secs = remaining / rate
    if eta_secs < 60:
        return f"{int(eta_secs)}s remaining"
    return f"{int(eta_secs / 60)}m remaining"
```

### GLib.timeout_add for 2s post-sync transition
```python
def on_sync_complete(self) -> None:
    GLib.timeout_add(2000, self._show_complete_transition)

def _show_complete_transition(self) -> bool:
    self.emit('sync-complete-displayed')
    return GLib.SOURCE_REMOVE  # do not repeat
```

### Custom type in Blueprint
`$ProtonDriveSyncProgressCard` requires the class to be registered via `@Gtk.Template` before the Blueprint can reference it. Ensure `sync_progress_card.py` is imported in `window.py` or the application module before any template is loaded.

### References
- [Source: ui/data/ui/window.blp] — current content area to replace
- [Source: ui/src/protondrive/window.py] — event routing and widget lifecycle
- [Source: ui/meson.build] — blueprint registration pattern
- [Source: ui/tests/conftest.py] — `object.__new__` test isolation

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `ui/data/ui/sync-progress-card.blp` — new
- `ui/data/ui/pair-detail-panel.blp` — new
- `ui/src/protondrive/widgets/sync_progress_card.py` — new
- `ui/src/protondrive/widgets/pair_detail_panel.py` — new
- `ui/data/ui/window.blp` — update content area
- `ui/src/protondrive/window.py` — update: detail_panel wiring, event routing
- `ui/meson.build` — add blueprint targets
- `ui/data/protondrive.gresource.xml` — add new ui files
- `ui/tests/test_sync_progress_card.py` — new: unit tests

## Change Log

- 2026-04-09: Story 2.8 created — SyncProgressCard & Detail Panel
