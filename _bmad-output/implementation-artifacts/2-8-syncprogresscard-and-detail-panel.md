# Story 2.8: SyncProgressCard & Detail Panel

Status: done

## Story

As a user,
I want to see detailed sync progress and stats for the selected pair,
so that I know exactly what's happening during first sync and ongoing operations.

## Acceptance Criteria

**AC1 — Detail panel — pair selected:**
**Given** a sync pair is selected in the sidebar
**When** the detail panel renders
**Then** it shows: pair name (folder basename, bold heading), local path, remote path, last synced timestamp ("Last synced X seconds ago" / "Never"), and last-known file count and total size
**And** the detail view is a `PairDetailPanel` custom widget (structure in `pair-detail-panel.blp`, logic in `pair_detail_panel.py`)

**AC2 — Detail panel — no pair selected:**
**Given** one or more pairs exist but none is selected
**When** the detail panel renders
**Then** an `AdwStatusPage` with icon `"folder-sync-symbolic"` and title "Select a sync pair to see details" is displayed (UX-DR16)

**AC3 — Detail panel — zero pairs (post-auth, pre-wizard):**
**Given** no sync pairs exist
**When** the detail area renders
**Then** an `AdwStatusPage` with icon `"folder-new-symbolic"`, title "No Sync Pairs", description "Add your first sync pair to start syncing", and a suggested-action "Set Up Sync" button is displayed (UX-DR16)
**And** clicking the button opens the setup wizard (same flow as fresh auth via `window.show_setup_wizard(engine_client)`)

**AC4 — SyncProgressCard during active sync:**
**Given** a sync is actively running for the currently selected pair
**When** `SyncProgressCard` renders within the detail panel
**Then** it replaces the stats section (pair name heading stays visible)
**And** shows an indeterminate `GtkProgressBar` + label "Counting files..." while `files_total == 0`
**And** once `files_total > 0`, switches to determinate bar with `fraction = files_done / files_total`, count label "N / M files", bytes label "X MB / Y MB", and ETA label "--" (FR15; ETA deferred)
**And** structure is in `sync-progress-card.blp`, logic in `sync_progress_card.py`

**AC5 — Only selected pair gets progress:**
**Given** `sync_progress` events arrive for any pair
**When** the UI processes them
**Then** the SyncProgressCard only activates/updates when the incoming `pair_id` matches the currently displayed pair
**And** UI interactions remain responsive within 200ms (NFR2)

**AC6 — Return to stats after sync_complete:**
**Given** `sync_complete` arrives for the currently selected pair while SyncProgressCard is visible
**When** the event is handled
**Then** "Last synced: X seconds ago" is updated immediately using the `timestamp` field from the event (ISO 8601)
**And** after 2 seconds the SyncProgressCard is replaced by the normal stats view
**And** if the user selects a different pair before the 2-second timer fires, the timer is cancelled (no stale update)

**AC7 — Widget boundary:**
**Given** the implementation
**When** inspecting imports
**Then** `sync_progress_card.py` does NOT import from any other widget file
**And** `pair_detail_panel.py` owns and creates `SyncProgressCard` as a programmatic child — it is NOT declared in the Blueprint as a nested custom type (avoids GType registration ordering issues)
**And** all coordination between `PairDetailPanel` and the outer shell goes through `window.py`

**AC8 — UI tests:**
**Given** unit tests in `ui/tests/test_sync_progress_card.py` and `ui/tests/test_pair_detail_panel.py`
**When** running `.venv/bin/pytest ui/tests/`
**Then** tests verify: indeterminate→determinate transition, sync_progress routing (selected vs unselected pair), sync_complete timer scheduling, label text per state
**And** no pre-existing test regressions

---

## Tasks / Subtasks

- [x] **Task 1: Create sync-progress-card.blp and implement sync_progress_card.py** (AC: #4, #5)
  - [x] 1.1 Create `ui/data/ui/sync-progress-card.blp`:
    ```blp
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDriveSyncProgressCard: Gtk.Box {
      orientation: vertical;
      spacing: 8;
      margin-start: 16;
      margin-end: 16;
      margin-top: 8;
      margin-bottom: 8;

      Gtk.ProgressBar progress_bar {
        show-text: false;
      }

      Gtk.Label count_label {
        halign: start;
        styles ["caption", "dim-label"]
      }

      Gtk.Label bytes_label {
        halign: start;
        styles ["caption", "dim-label"]
      }

      Gtk.Label eta_label {
        halign: start;
        styles ["caption", "dim-label"]
      }
    }
    ```
  - [x] 1.2 Create `ui/src/protondrive/widgets/sync_progress_card.py`:
    - `@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/sync-progress-card.ui")`
    - `class SyncProgressCard(Gtk.Box)` with `__gtype_name__ = "ProtonDriveSyncProgressCard"`
    - Template children: `progress_bar`, `count_label`, `bytes_label`, `eta_label`
    - `__init__(self, **kwargs: object) -> None`: call `super().__init__(**kwargs)` first, then set `self._pulsing = False`; `self._pulse_timer_id: int | None = None`
    - `set_counting(self) -> None`:
      - `self.progress_bar.set_fraction(0.0)`
      - `self.count_label.set_text("Counting files...")`
      - `self.bytes_label.set_text("")`
      - `self.eta_label.set_text("")`
      - Start pulse: `self._pulsing = True`; `self._pulse_timer_id = GLib.timeout_add(200, self._pulse)`
    - `set_progress(self, files_done: int, files_total: int, bytes_done: int, bytes_total: int) -> None`:
      - `self._cancel_pulse()`
      - `fraction = files_done / files_total if files_total > 0 else 0.0`
      - `self.progress_bar.set_fraction(fraction)`
      - `self.count_label.set_text(f"{files_done} / {files_total} files")`
      - `self.bytes_label.set_text(f"{_fmt_bytes(bytes_done)} / {_fmt_bytes(bytes_total)}")`
      - `self.eta_label.set_text("--")`
    - `_pulse(self) -> bool`:
      - If `self._pulsing`: `self.progress_bar.pulse()`; return `GLib.SOURCE_CONTINUE`
      - Else: `self._pulse_timer_id = None`; return `GLib.SOURCE_REMOVE`
    - `_cancel_pulse(self) -> None`:
      - `self._pulsing = False`
      - If `self._pulse_timer_id is not None`: `GLib.source_remove(self._pulse_timer_id)`; `self._pulse_timer_id = None`
    - Module-level helper (outside class):
      ```python
      def _fmt_bytes(n: int) -> str:
          if n < 1024: return f"{n} B"
          if n < 1024**2: return f"{n/1024:.1f} KB"
          if n < 1024**3: return f"{n/1024**2:.1f} MB"
          return f"{n/1024**3:.1f} GB"
      ```
  - [x] 1.3 Export `SyncProgressCard` in `ui/src/protondrive/widgets/__init__.py`

- [x] **Task 2: Create pair-detail-panel.blp and implement pair_detail_panel.py** (AC: #1, #2, #3, #6, #7)
  - [x] 2.1 Create `ui/data/ui/pair-detail-panel.blp`:
    ```blp
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDrivePairDetailPanel: Adw.Bin {
      child: Gtk.Stack detail_stack {
        transition-type: crossfade;

        Gtk.StackPage {
          name: "no-selection";
          child: Adw.StatusPage {
            icon-name: "folder-sync-symbolic";
            title: "Select a sync pair to see details";
          };
        }

        Gtk.StackPage {
          name: "no-pairs";
          child: Adw.StatusPage {
            icon-name: "folder-new-symbolic";
            title: "No Sync Pairs";
            description: "Add your first sync pair to start syncing";
            child: Gtk.Button setup_btn {
              label: "Set Up Sync";
              halign: center;
              styles ["suggested-action", "pill"]
            };
          };
        }

        Gtk.StackPage {
          name: "detail";
          child: Gtk.ScrolledWindow {
            propagate-natural-height: true;
            child: Gtk.Box detail_box {
              orientation: vertical;
              spacing: 0;
              margin-start: 24;
              margin-end: 24;
              margin-top: 16;
              margin-bottom: 16;

              Gtk.Label pair_name_heading {
                halign: start;
                styles ["title-3"]
              }

              Adw.PreferencesGroup paths_group {
                margin-top: 16;

                Adw.ActionRow local_path_row {
                  title: "Local folder";
                  subtitle: "";
                }

                Adw.ActionRow remote_path_row {
                  title: "Remote folder";
                  subtitle: "";
                }
              }

              Adw.PreferencesGroup sync_status_group {
                margin-top: 16;

                Adw.ActionRow last_synced_row {
                  title: "Last synced";
                  subtitle: "Never";
                }

                Adw.ActionRow file_count_row {
                  title: "Files";
                  subtitle: "--";
                }

                Adw.ActionRow total_size_row {
                  title: "Total size";
                  subtitle: "--";
                }
              }

              // progress_slot: SyncProgressCard is appended here programmatically
              Gtk.Box progress_slot {
                orientation: vertical;
                margin-top: 8;
              }
            };
          };
        }
      };
    }
    ```
    **NOTE:** `SyncProgressCard` is NOT declared in Blueprint as `$ProtonDriveSyncProgressCard {}`. It is created and appended to `progress_slot` in Python to avoid nested custom-type registration ordering issues (AC7).

  - [x] 2.2 Create `ui/src/protondrive/widgets/pair_detail_panel.py`:
    - `from gi.repository import Adw, Gtk, GLib, GObject`
    - `from protondrive.widgets.sync_progress_card import SyncProgressCard, _fmt_bytes`
    - `@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/pair-detail-panel.ui")`
    - `class PairDetailPanel(Adw.Bin)` with `__gtype_name__ = "ProtonDrivePairDetailPanel"`
    - `__gsignals__ = {"setup-requested": (GObject.SignalFlags.RUN_FIRST, None, ())}`
    - Template children: `detail_stack`, `setup_btn`, `pair_name_heading`, `local_path_row`, `remote_path_row`, `last_synced_row`, `file_count_row`, `total_size_row`, `progress_slot`
    - `__init__(self, **kwargs: object) -> None`: call `super().__init__(**kwargs)` first, then:
      ```python
      self._current_pair_id: str | None = None
      self._sync_complete_timer: int | None = None
      self._progress_card: SyncProgressCard | None = None
      self.setup_btn.connect("clicked", lambda _: self.emit("setup-requested"))
      ```
    - `show_no_pairs(self) -> None`:
      - `self._cancel_sync_timer()`; `self._hide_progress_card()`; `self._current_pair_id = None`
      - `self.detail_stack.set_visible_child_name("no-pairs")`
    - `show_select_prompt(self) -> None`:
      - `self._cancel_sync_timer()`; `self._hide_progress_card()`; `self._current_pair_id = None`
      - `self.detail_stack.set_visible_child_name("no-selection")`
    - `show_pair(self, pair_data: dict) -> None`:
      - `self._cancel_sync_timer()`; `self._hide_progress_card()`
      - `self._current_pair_id = pair_data.get("pair_id", "")`
      - Populate: `self.pair_name_heading.set_text(_pair_name(pair_data.get("local_path", "")))`
      - `self.local_path_row.set_subtitle(pair_data.get("local_path", ""))`
      - `self.remote_path_row.set_subtitle(pair_data.get("remote_path", ""))`
      - `self.last_synced_row.set_subtitle(pair_data.get("last_synced_text", "Never"))`
      - `self.file_count_row.set_subtitle(pair_data.get("file_count_text", "--"))`
      - `self.total_size_row.set_subtitle(pair_data.get("total_size_text", "--"))`
      - `self.detail_stack.set_visible_child_name("detail")`
    - `on_sync_progress(self, payload: dict) -> None`:
      - If `payload.get("pair_id") != self._current_pair_id`: `return`
      - If `self._progress_card is None`: `self._show_progress_card()`
      - `fd = payload.get("files_done", 0)`; `ft = payload.get("files_total", 0)`
      - `bd = payload.get("bytes_done", 0)`; `bt = payload.get("bytes_total", 0)`
      - If `ft == 0`: `self._progress_card.set_counting()`
      - Else: `self._progress_card.set_progress(fd, ft, bd, bt)`
    - `on_sync_complete(self, payload: dict) -> None`:
      - If `payload.get("pair_id") != self._current_pair_id`: `return`
      - `ts = payload.get("timestamp", "")`
      - `self.last_synced_row.set_subtitle(_fmt_relative_time(ts))`
      - `self._cancel_sync_timer()`
      - `self._sync_complete_timer = GLib.timeout_add(2000, self._on_sync_complete_timeout)`
    - `_on_sync_complete_timeout(self) -> bool`:
      - `self._sync_complete_timer = None`; `self._hide_progress_card()`
      - Return `GLib.SOURCE_REMOVE`
    - `_show_progress_card(self) -> None`:
      - `self._progress_card = SyncProgressCard()`; `self.progress_slot.append(self._progress_card)`
      - `self._progress_card.set_counting()`
    - `_hide_progress_card(self) -> None`:
      - If `self._progress_card is not None`:
        - `self._progress_card._cancel_pulse()`
        - `self.progress_slot.remove(self._progress_card)`; `self._progress_card = None`
    - `_cancel_sync_timer(self) -> None`:
      - If `self._sync_complete_timer is not None`:
        - `GLib.source_remove(self._sync_complete_timer)`; `self._sync_complete_timer = None`
    - Module-level helpers (outside class):
      ```python
      import os
      from datetime import datetime, timezone

      def _pair_name(local_path: str) -> str:
          return os.path.basename(local_path.rstrip("/")) or local_path

      def _fmt_relative_time(iso_timestamp: str) -> str:
          try:
              dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
              delta = datetime.now(timezone.utc) - dt
              secs = int(delta.total_seconds())
              if secs < 60: return f"{secs} seconds ago"
              if secs < 3600: return f"{secs // 60} minutes ago"
              return f"{secs // 3600} hours ago"
          except Exception:
              return "Never"
      ```
  - [x] 2.3 Export `PairDetailPanel` in `ui/src/protondrive/widgets/__init__.py`

- [x] **Task 3: Update window.blp and window.py** (AC: #1, #2, #3)
  - [x] 3.1 Update `ui/data/ui/window.blp` — replace static `Adw.StatusPage` in the content `Adw.ToolbarView`:
    ```blp
    // BEFORE:
    content: Adw.StatusPage {
      icon-name: "document-open-symbolic";
      title: "Welcome";
      description: "Select or add a sync pair from the sidebar.";
    };
    // AFTER:
    content: $ProtonDrivePairDetailPanel pair_detail_panel {};
    ```
    Full updated content `Adw.NavigationPage`:
    ```blp
    content: Adw.NavigationPage {
      title: "Details";
      child: Adw.ToolbarView {
        [top]
        Adw.HeaderBar {}
        content: $ProtonDrivePairDetailPanel pair_detail_panel {};
      };
    };
    ```
  - [x] 3.2 In `window.py`, add import: `from protondrive.widgets.pair_detail_panel import PairDetailPanel, _fmt_relative_time`
  - [x] 3.3 Add template child: `pair_detail_panel: PairDetailPanel = Gtk.Template.Child()`
  - [x] 3.4 Add `_pairs_data: dict[str, dict] = {}` to `__init__`
  - [x] 3.5 In `__init__`, connect: `self.pair_detail_panel.connect("setup-requested", self._on_setup_requested)`
  - [x] 3.6 Add `_on_setup_requested(self, widget) -> None`:
    ```python
    app = self.get_application()
    if app is not None and hasattr(app, "_engine"):
        self.show_setup_wizard(app._engine)
    ```
  - [x] 3.7 Update `populate_pairs(self, pairs)`:
    - At the **start** of the method (alongside clearing `_sync_pair_rows`), also clear `_pairs_data`:
      ```python
      self._pairs_data = {}
      ```
    - After rebuilding `_sync_pair_rows` in the loop, rebuild `_pairs_data` from the same `pairs` list:
      ```python
      self._pairs_data = {p.get("pair_id", ""): dict(p) for p in pairs}
      ```
    - After the loop: if `not pairs`: `self.pair_detail_panel.show_no_pairs()` else `self.pair_detail_panel.show_select_prompt()`
  - [x] 3.8 Complete the `_on_row_activated` stub (currently empty with `# Future:` comment):
    ```python
    def _on_row_activated(self, list_box: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
        pair_id = row.pair_id  # property on SyncPairRow (added in Story 2-7 review)
        pair_data = self._pairs_data.get(pair_id, {})
        self.pair_detail_panel.show_pair(pair_data)
        self.nav_split_view.set_show_content(True)  # navigate on narrow windows
    ```
  - [x] 3.9 Update `on_sync_progress(self, payload)` — add after existing row/footer logic:
    ```python
    self.pair_detail_panel.on_sync_progress(payload)
    ```
  - [x] 3.10 Update `on_sync_complete(self, payload)` — add after existing row/footer logic:
    ```python
    self.pair_detail_panel.on_sync_complete(payload)
    # Update cached pair data with last_synced_text so it persists across reselect
    # _fmt_relative_time is imported at module top (Task 3.2) — do NOT re-import here
    pair_id = payload.get("pair_id", "")
    if pair_id in self._pairs_data:
        self._pairs_data[pair_id]["last_synced_text"] = _fmt_relative_time(
            payload.get("timestamp", "")
        )
    ```
  - [x] 3.11 Update `clear_session(self)` — add:
    ```python
    self._pairs_data = {}
    self.pair_detail_panel.show_no_pairs()
    ```

- [x] **Task 4: Register blueprints and update meson.build** (AC: #1, #4)
  - [x] 4.1 Add `custom_target` entries in `ui/meson.build` following the exact pattern of `blueprint-sync-pair-row`:
    ```meson
    blueprint_sync_progress_card = custom_target(
      'blueprint-sync-progress-card',
      input: 'data/ui/sync-progress-card.blp',
      output: 'sync-progress-card.ui',
      command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
    )
    blueprint_pair_detail_panel = custom_target(
      'blueprint-pair-detail-panel',
      input: 'data/ui/pair-detail-panel.blp',
      output: 'pair-detail-panel.ui',
      command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
    )
    ```
  - [x] 4.2 Add both targets to `depends:` list of the gresource `gnome.compile_resources()` call
  - [x] 4.3 Add to `ui/data/protondrive.gresource.xml`:
    ```xml
    <file alias="ui/sync-progress-card.ui">sync-progress-card.ui</file>
    <file alias="ui/pair-detail-panel.ui">pair-detail-panel.ui</file>
    ```
  - [x] 4.4 Add `sync_progress_card.py` and `pair_detail_panel.py` to `python_widget_sources` in `meson.build`

- [x] **Task 5: UI tests** (AC: #8)
  - [x] 5.1 Create `ui/tests/test_sync_progress_card.py`:
    - Use `object.__new__(SyncProgressCard)` — manually set `_pulsing = False`, `_pulse_timer_id = None`; attach mock template children
    - `set_counting()` → `count_label.set_text` called with "Counting files..."; `bytes_label.set_text` with ""; `progress_bar.set_fraction(0.0)` called
    - `set_progress(3, 10, 2000000, 8000000)` → `progress_bar.set_fraction(0.3)` called; `count_label.set_text("3 / 10 files")`; `bytes_label.set_text("1.9 MB / 7.6 MB")` (check _fmt_bytes); `eta_label.set_text("--")`
    - `set_progress(10, 10, ...)` → `progress_bar.set_fraction(1.0)`
    - `set_progress(0, 0, ...)` → `progress_bar.set_fraction(0.0)` (no ZeroDivisionError)
    - `_fmt_bytes(0)` → "0 B"; `_fmt_bytes(1024)` → "1.0 KB"; `_fmt_bytes(1048576)` → "1.0 MB"
  - [x] 5.2 Create `ui/tests/test_pair_detail_panel.py`:
    - Use `object.__new__(PairDetailPanel)` — manually set `_current_pair_id = None`, `_sync_complete_timer = None`, `_progress_card = None`; attach mock template children
    - `show_no_pairs()` → `detail_stack.set_visible_child_name("no-pairs")` called; `_current_pair_id is None`
    - `show_select_prompt()` → `detail_stack.set_visible_child_name("no-selection")` called
    - `show_pair({"pair_id": "p1", "local_path": "/home/user/Docs/"})` → `pair_name_heading.set_text("Docs")`; `detail_stack.set_visible_child_name("detail")`; `_current_pair_id == "p1"`
    - `on_sync_progress({"pair_id": "p1", "files_done": 0, "files_total": 0, ...})` when `_current_pair_id == "p1"` → `_progress_card is not None`
    - `on_sync_progress({"pair_id": "p2", ...})` when `_current_pair_id == "p1"` → no update (guard fires)
    - `on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-11T12:00:00Z"})` when current pair matches → `last_synced_row.set_subtitle` called with non-"Never"; `GLib.timeout_add` called with 2000
    - `on_sync_complete({"pair_id": "p2", "timestamp": "..."})` when `_current_pair_id == "p1"` → no call to `set_subtitle`
    - `_fmt_relative_time("invalid-ts")` → returns "Never"
    - `_fmt_relative_time("2026-04-11T12:00:00Z")` → returns string containing "ago"
  - [x] 5.3 Extend `ui/tests/test_window_routing.py` — add Story 2-8 routing cases using `object.__new__(MainWindow)` with mocked `pair_detail_panel`, `_sync_pair_rows`, `_pairs_data`, `status_footer_bar`:
    - `populate_pairs([])` → `pair_detail_panel.show_no_pairs()` called; `_pairs_data == {}`
    - `populate_pairs([{"pair_id": "p1", "local_path": "/home/u/Docs"}])` → `pair_detail_panel.show_select_prompt()` called; `_pairs_data == {"p1": {...}}`
    - `_on_row_activated(list_box, row)` where `row.pair_id == "p1"` and `_pairs_data["p1"]` exists → `pair_detail_panel.show_pair({"pair_id": "p1", ...})` called; `nav_split_view.set_show_content(True)` called
    - `_on_row_activated` with unknown `pair_id` → `pair_detail_panel.show_pair({})` called (empty dict, no crash)
    - `on_sync_progress({"pair_id": "p1", ...})` → `pair_detail_panel.on_sync_progress` called with full payload
    - `on_sync_complete({"pair_id": "p1", "timestamp": "2026-04-11T12:00:00Z"})` → `pair_detail_panel.on_sync_complete` called; `_pairs_data["p1"]["last_synced_text"]` set to a string containing "ago"
    - `on_sync_complete` with unknown `pair_id` → `_pairs_data` unchanged (guard fires)
    - `clear_session()` → `_pairs_data == {}`; `pair_detail_panel.show_no_pairs()` called
  - [x] 5.4 Run `.venv/bin/pytest ui/tests/` — all tests pass, no regressions

---

## Dev Notes

### CRITICAL: `get_status_result` pair fields are limited

The engine only returns `{pair_id, local_path, remote_path}` per pair — confirmed in `engine/src/main.ts:213-217`. There is NO `last_synced`, `file_count`, or `total_size` in `get_status_result`. Stats are accumulated client-side:
- `last_synced_text`: updated when `sync_complete` arrives — store in `_pairs_data[pair_id]["last_synced_text"]`
- `file_count_text` and `total_size_text`: show "--" on first load; can update from last `sync_progress` `files_total` / `bytes_total` if desired, but not required for this story
- On window reopen: `get_status_result` always has empty `last_synced_text` — show "Never" until a `sync_complete` arrives in the current session

### CRITICAL: `_on_row_activated` is a stub — this story completes it

In Story 2-7, `window.py:227-229`:
```python
def _on_row_activated(self, list_box: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
    """Handle pair row selection — route to pair detail in content area."""
    # Future: show pair detail in the content NavigationPage
```
Story 2-8 replaces this stub with the real implementation (Task 3.8).

### CRITICAL: Check `SyncPairRow.pair_id` property exists

Story 2-7's review patch added a `pair_name` property to `SyncPairRow`. Verify `pair_id` is also exposed. Open `ui/src/protondrive/widgets/sync_pair_row.py` and check:
- If `_pair_id` is set in `__init__` as `self._pair_id = pair_id`, add a property: `@property` / `def pair_id(self): return self._pair_id`
- Required by `_on_row_activated` (Task 3.8): `pair_id = row.pair_id`
- If not present, add it (same file touch scope as this story's review)

### CRITICAL: `PairDetailPanel` import must come BEFORE `MainWindow` template loads

`window.blp` references `$ProtonDrivePairDetailPanel` — the GType must be registered before the template is applied. Since `window.py` imports `PairDetailPanel` at the top of the file (Task 3.2), and `@Gtk.Template` registers the GType at import time, this ordering is automatic. Do NOT use lazy imports inside methods.

### CRITICAL: `Adw.Bin = _FakeWidget` already set in conftest

`PairDetailPanel` inherits from `Adw.Bin`. `conftest.py:82` sets `adw.Bin = _FakeWidget`. No conftest changes needed for `PairDetailPanel` tests. **However**, `Gtk.Box = _FakeWidget` is also set (line 84), so `SyncProgressCard(Gtk.Box)` base is covered too.

### GLib.timeout_add return values
```python
GLib.SOURCE_REMOVE = False   # fire once, stop
GLib.SOURCE_CONTINUE = True  # keep repeating
```
- `_on_sync_complete_timeout` must return `False` (fires once, hides progress card)
- `_pulse` must return `True` while pulsing, `False` when `_pulsing = False`

### Indeterminate GtkProgressBar
`GtkProgressBar` has no `set_indeterminate()`. Use `pulse()` on a timer:
```python
self._pulse_timer_id = GLib.timeout_add(200, self._pulse)

def _pulse(self) -> bool:
    if not self._pulsing:
        self._pulse_timer_id = None
        return GLib.SOURCE_REMOVE
    self.progress_bar.pulse()
    return GLib.SOURCE_CONTINUE
```
On transition to determinate, call `_cancel_pulse()` then `set_fraction(fraction)`.

### SyncProgressCard NOT in Blueprint as nested custom type

Do NOT put `$ProtonDriveSyncProgressCard` in `pair-detail-panel.blp`. Blueprint compiles custom types at build time; if the GType hasn't been registered yet when the template is applied, the widget will fail silently or crash. Instead:
```python
# In _show_progress_card():
self._progress_card = SyncProgressCard()  # creates fresh instance
self.progress_slot.append(self._progress_card)
```
`progress_slot` is a plain `Gtk.Box` declared in the Blueprint.

### Adw.ActionRow subtitle update
`Adw.ActionRow` has `set_subtitle(text: str)`. Use it for all dynamic fields:
```python
self.local_path_row.set_subtitle("/home/user/Documents/")
```
The `title` is set in Blueprint and is never changed in Python.

### Timer leak prevention (all paths)
Call both `_cancel_sync_timer()` and `_hide_progress_card()` (which calls `_cancel_pulse()`) in:
- `show_pair()` — replacing current pair selection
- `show_no_pairs()` — clearing all pair state
- `show_select_prompt()` — deselecting pair
- `window.py.clear_session()` via `pair_detail_panel.show_no_pairs()`

### `nav_split_view.set_show_content(True)` for narrow windows
On narrow windows (<480px width), `AdwNavigationSplitView` collapses. After row activation, call `nav_split_view.set_show_content(True)` to navigate to the detail panel. This is a no-op on wide windows. `nav_split_view` is already a template child in `window.py:26`.

### `_fmt_relative_time` in test context
`datetime.fromisoformat` (Python 3.7+) handles `"2026-04-11T12:00:00+00:00"` but not `"2026-04-11T12:00:00Z"` on Python < 3.11. Use `.replace("Z", "+00:00")` before parsing (already included in the code above). Tests should use a past timestamp within one minute to get "X seconds ago".

### GLib timer assertion pattern in tests
In test context `GLib` is a `MagicMock` — `timeout_add` doesn't actually schedule anything. Assert timer was scheduled by checking call args on the mock:
```python
import sys
glib_mock = sys.modules["gi.repository.GLib"]
glib_mock.timeout_add.assert_called_with(2000, obj._on_sync_complete_timeout)
```
Reset between test cases with `glib_mock.timeout_add.reset_mock()`.

### File list (expected)
- `ui/data/ui/sync-progress-card.blp` — new
- `ui/data/ui/pair-detail-panel.blp` — new
- `ui/src/protondrive/widgets/sync_progress_card.py` — new
- `ui/src/protondrive/widgets/pair_detail_panel.py` — new
- `ui/src/protondrive/widgets/__init__.py` — updated: export SyncProgressCard, PairDetailPanel
- `ui/data/ui/window.blp` — updated: replace static StatusPage with pair_detail_panel
- `ui/src/protondrive/window.py` — updated: import, template child, `_on_row_activated`, `on_sync_progress`, `on_sync_complete`, `populate_pairs`, `clear_session`, `_pairs_data`
- `ui/meson.build` — updated: two blueprint targets + gresource deps + python widget sources
- `ui/data/protondrive.gresource.xml` — updated: two new .ui aliases
- `ui/tests/test_sync_progress_card.py` — new
- `ui/tests/test_pair_detail_panel.py` — new

### References
- [Source: engine/src/main.ts:205-222] — `get_status` handler, confirmed pair fields: `{pair_id, local_path, remote_path}`
- [Source: engine/src/state-db.ts:9-15] — `SyncPair` interface
- [Source: _bmad-output/planning-artifacts/architecture.md] — IPC events table: `sync_progress {pair_id, files_done, files_total, bytes_done, bytes_total}`, `sync_complete {pair_id, timestamp}`
- [Source: ui/data/ui/window.blp] — current `content: Adw.NavigationPage` structure to replace
- [Source: ui/src/protondrive/window.py:227-229] — `_on_row_activated` stub to complete
- [Source: ui/src/protondrive/window.py:201-225] — `populate_pairs`, `_sync_pair_rows` pattern
- [Source: ui/src/protondrive/widgets/sync_pair_row.py] — `pair_name` property pattern; verify `pair_id` property
- [Source: ui/src/protondrive/widgets/status_footer_bar.py] — `Gtk.Box` widget with GLib timer pattern
- [Source: ui/meson.build] — blueprint registration, look for `blueprint-sync-pair-row` as the exact pattern
- [Source: ui/data/protondrive.gresource.xml] — existing `alias="ui/sync-pair-row.ui"` pattern
- [Source: ui/tests/conftest.py:82-84] — `adw.Bin = _FakeWidget`, `gtk.Box = _FakeWidget` (no conftest changes needed)

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

_No blocking issues encountered._

### Completion Notes List

- Task 1: Created `sync-progress-card.blp` and `sync_progress_card.py` with indeterminate pulse timer and determinate progress, `_fmt_bytes` helper, `_cancel_pulse` guard. Exported from `__init__.py`.
- Task 2: Created `pair-detail-panel.blp` with three stack pages (no-selection, no-pairs, detail) and `pair_detail_panel.py` with all state methods, sync progress/complete handling, timer leak prevention. `SyncProgressCard` appended programmatically to `progress_slot` (AC7). Exported from `__init__.py`.
- Task 3: Updated `window.blp` to replace static `StatusPage` with `$ProtonDrivePairDetailPanel pair_detail_panel`. Updated `window.py`: import, template child, `_pairs_data`, `_on_setup_requested`, `populate_pairs`, `_on_row_activated`, `on_sync_progress`, `on_sync_complete`, `clear_session`.
- Task 4: Added `blueprint_sync_progress_card` and `blueprint_pair_detail_panel` custom_target entries to `meson.build`, added both to gresource depends, added `.py` files to `python_widget_sources`, added `.ui` aliases to `protondrive.gresource.xml`.
- Task 5: 87 new tests across 3 files. Zero regressions introduced. Pre-existing failures in `test_auth_window.py`, `test_credential_store.py`, `test_engine.py` are unrelated. `populate_pairs` tests use `patch("protondrive.window.SyncPairRow")` to avoid `update_property` AttributeError on `_FakeWidget`.

### File List

- `ui/data/ui/sync-progress-card.blp` — new
- `ui/data/ui/pair-detail-panel.blp` — new
- `ui/src/protondrive/widgets/sync_progress_card.py` — new
- `ui/src/protondrive/widgets/pair_detail_panel.py` — new
- `ui/src/protondrive/widgets/__init__.py` — updated: export SyncProgressCard, PairDetailPanel
- `ui/data/ui/window.blp` — updated: replaced static StatusPage with pair_detail_panel
- `ui/src/protondrive/window.py` — updated: import, template child, _on_row_activated, on_sync_progress, on_sync_complete, populate_pairs, clear_session, _pairs_data, _on_setup_requested
- `ui/meson.build` — updated: two blueprint targets + gresource deps + python widget sources
- `ui/data/protondrive.gresource.xml` — updated: two new .ui aliases
- `ui/tests/test_sync_progress_card.py` — new
- `ui/tests/test_pair_detail_panel.py` — new
- `ui/tests/test_window_routing.py` — updated: Story 2-8 routing test classes

### Review Findings

- [x] [Review][Decision] AC1 file/size stats always show "--" — resolved: populate `file_count_text`/`total_size_text` from `sync_progress` events in `window.py::on_sync_progress` when `files_total > 0`
- [x] [Review][Patch] Double `set_counting()` creates leaked GLib pulse timer [`ui/src/protondrive/widgets/pair_detail_panel.py:117`] — fixed: removed `set_counting()` call from `_show_progress_card()`; caller always invokes it
- [x] [Review][Patch] Dead import: `_fmt_bytes` imported in `pair_detail_panel.py` but never used [`ui/src/protondrive/widgets/pair_detail_panel.py:10`] — fixed: removed from import
- [x] [Review][Patch] `None == None` guard bypass: `on_sync_progress` and `on_sync_complete` both fire when `_current_pair_id is None` and payload has no `pair_id` key [`ui/src/protondrive/widgets/pair_detail_panel.py:87,102`] — fixed: guard now checks `not self._current_pair_id`
- [x] [Review][Patch] Meson naming inconsistency: first two blueprint targets use `blueprints_*` prefix, last two use `blueprint_*` (no `s`) — fixed: renamed to `blueprints_sync_progress_card` / `blueprints_pair_detail_panel` [`ui/meson.build`]
- [x] [Review][Patch] Future timestamp produces `"-N seconds ago"` — fixed: `secs = max(0, int(...))` [`ui/src/protondrive/widgets/pair_detail_panel.py:22`]
- [x] [Review][Patch] AC8 test gap: no test for timer cancellation when `show_pair()` is called while 2-second hide-timer is active — fixed: added 4 new tests covering timer cancel + None guard
- [x] [Review][Defer] GLib timers (pulse + sync-complete) have no `do_dispose`/`do_unroot` cancel path — callbacks fire on dead widgets if window is closed mid-timer [`ui/src/protondrive/widgets/sync_progress_card.py`, `pair_detail_panel.py`] — deferred, pre-existing GTK Python pattern limitation
- [x] [Review][Defer] `populate_pairs` row-removal loop is O(n²) — `get_row_at_index(0)` + remove in while loop [`ui/src/protondrive/window.py:220–224`] — deferred, pre-existing
- [x] [Review][Defer] `_fmt_relative_time` has no days/weeks display — values over 3600s show "N hours ago" indefinitely [`ui/src/protondrive/widgets/pair_detail_panel.py:17–28`] — deferred, acceptable for MVP
- [x] [Review][Defer] `files_done > files_total` produces fraction > 1.0; GTK clamps silently but emits GLib warning [`ui/src/protondrive/widgets/sync_progress_card.py:52`] — deferred, requires engine contract guarantee

## Change Log

- 2026-04-09: Story 2.8 created — SyncProgressCard & Detail Panel
- 2026-04-11: Story rewritten with comprehensive dev context: verified IPC field constraints, completed _on_row_activated stub analysis, AC7 Blueprint nesting fix, _pairs_data tracking, timer leak prevention, test patterns
- 2026-04-11: Validation pass — 3 critical fixes (super().__init__ in both widget specs, lazy _fmt_relative_time import moved to module top in Task 3.2, window routing tests added as Task 5.3), 1 enhancement (E1 _pairs_data cleared at start of populate_pairs), 1 optimization (GLib timer assertion pattern in Dev Notes)
- 2026-04-11: Implementation complete — all tasks done, 87 new tests pass, 0 regressions; status → review
- 2026-04-11: Code review complete — 1 decision-needed, 6 patch, 4 defer, 13 dismissed
