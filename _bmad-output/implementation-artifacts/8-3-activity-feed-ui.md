# Story 8.3: Activity Feed UI

Status: done

## Story

As a user,
I want to see a live activity feed in the Details panel showing what the app synced,
so that I know the app is working and can see which files were recently transferred.

## Acceptance Criteria

1. **New event row on `file_synced`** — When a `file_synced` IPC event arrives and the Details panel is open, a new row appears at the top of the activity feed within 1 second. Each row shows: file name, direction indicator (↑ upload / ↓ download), relative timestamp ("just now" / "X min ago" / "X hr ago"), and the pair's short folder name (basename of local path). All pairs interleaved in one feed ordered by arrival time (newest at top).

2. **Empty state** — When no `file_synced` events have been received since app launch, the feed shows: "No recent activity. Files you sync will appear here." The panel is never a blank white rectangle.

3. **100-item cap (ring buffer)** — When a new event arrives that would push the feed past 100 items, the oldest item is removed. The UI does not scroll-jump if the user has scrolled down to review older history.

4. **Memory-only** — The feed is not persisted to disk. It resets to empty on app restart or `clear_session()`.

5. **Reconcile progress spinner** — When any pair has an active reconcile phase (`"scanning"` | `"uploading"` | `"downloading"`), a spinner appears at the top of the activity feed section. It disappears when:
   - All active pair phases reach `"idle"` (all phases cleared in `_pair_phase`)
   - An `error` event is received for the last active pair (Story 8-2a handles row indicator; feed spinner follows)
   - The watchdog fires clearing the last active pair (Story 8-2a watchdog fires → `_pair_phase[pair_id]` deleted → spinner off)

6. **No regression** — All 681 existing UI tests pass. Engine tests untouched.

7. **New tests** — `ui/tests/test_activity_feed.py` covers: row rendering, empty state, 100-item cap, multi-pair interleaving, spinner show/hide.

## Tasks / Subtasks

- [x] **Task 1 — Add `activity_slot` to `pair-detail-panel.blp`** (AC: 1, 2, 5)
  - [x] 1.1 In `ui/data/ui/pair-detail-panel.blp`, inside the `"detail"` `Gtk.StackPage`, in the `detail_box` `Gtk.Box`, add after the `progress_slot` box and before `remove_pair_row`:
    ```blueprint
    // activity_slot: ActivityFeed widget appended here programmatically
    Gtk.Box activity_slot {
      orientation: vertical;
      margin-top: 8;
    }
    ```
  - [x] 1.2 In `ui/src/protondrive/widgets/pair_detail_panel.py`, add `activity_slot: Gtk.Box = Gtk.Template.Child()` after the `progress_slot` child declaration.

- [x] **Task 2 — Create `ui/data/ui/activity-feed.blp`** (AC: 1, 2, 5)

  Create new file `ui/data/ui/activity-feed.blp`:
  ```blueprint
  using Gtk 4.0;
  using Adw 1;

  template $ProtonDriveActivityFeed: Adw.Bin {
    child: Gtk.Box {
      orientation: vertical;

      Gtk.Box {
        orientation: horizontal;
        spacing: 8;

        Gtk.Label {
          label: _("Recent Activity");
          halign: start;
          hexpand: true;
          styles ["heading"]
        }

        Gtk.Spinner activity_spinner {
          spinning: false;
          visible: false;
          valign: center;
        }
      }

      Gtk.Stack activity_stack {
        transition-type: crossfade;
        margin-top: 8;

        Gtk.StackPage {
          name: "empty";
          child: Gtk.Label empty_label {
            label: _("No recent activity. Files you sync will appear here.");
            halign: start;
            wrap: true;
            styles ["dim-label"]
          };
        }

        Gtk.StackPage {
          name: "feed";
          child: Gtk.ScrolledWindow {
            min-content-height: 120;
            max-content-height: 300;
            propagate-natural-height: true;
            child: Gtk.ListBox activity_list {
              selection-mode: none;
              styles ["boxed-list"]
            };
          };
        }
      }
    };
  }
  ```

- [x] **Task 3 — Create `ui/src/protondrive/widgets/activity_feed.py`** (AC: 1, 2, 3, 4, 5)

  Create new file. `ActivityFeedRow` is a plain `Adw.ActionRow` subclass (no `.blp` — follows `ConflictLogRow` pattern). `ActivityFeed` is a `@Gtk.Template`-driven `Adw.Bin`.

  ```python
  """ActivityFeed widget — live feed of file_synced events (Story 8-3)."""

  from __future__ import annotations

  import os
  from datetime import datetime, timezone
  from typing import Any

  from gi.repository import Adw, GObject, Gtk

  _MAX_FEED_ITEMS = 100


  def _fmt_activity_time(iso_timestamp: str) -> str:
      """Format ISO 8601 UTC timestamp as human-relative string for the feed.

      Returns "just now" (<60s), "X min ago" (<60 min), "X hr ago" (>=60 min).
      Distinct from _fmt_relative_time in pair_detail_panel.py (which returns
      "N seconds ago" — different wording required by Story 8-3 AC1).
      """
      try:
          dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
          delta = datetime.now(timezone.utc) - dt
          secs = max(0, int(delta.total_seconds()))
          if secs < 60:
              return "just now"
          if secs < 3600:
              return f"{secs // 60} min ago"
          return f"{secs // 3600} hr ago"
      except Exception:
          return ""


  class ActivityFeedRow(Adw.ActionRow):
      """One row in the activity feed.

      AdwActionRow with programmatic prefix arrow and no suffix.
      Created dynamically from file_synced event dicts.
      """

      __gtype_name__ = "ProtonDriveActivityFeedRow"

      def __init__(self, event: dict[str, Any], **kwargs: object) -> None:
          super().__init__(**kwargs)
          file_name = event.get("file_name", "")
          direction = event.get("direction", "")
          timestamp = event.get("timestamp", "")
          pair_name = event.get("pair_name", "")

          # Direction arrow prefix.
          arrow = Gtk.Label()
          arrow.set_text("↑" if direction == "upload" else "↓")
          arrow.set_valign(Gtk.Align.CENTER)
          css_class = "success" if direction == "upload" else "accent"
          arrow.add_css_class(css_class)
          self.add_prefix(arrow)

          self.set_title(file_name)
          subtitle_parts = [p for p in [pair_name, _fmt_activity_time(timestamp)] if p]
          self.set_subtitle("  ·  ".join(subtitle_parts))


  @Gtk.Template(
      resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/activity-feed.ui"
  )
  class ActivityFeed(Adw.Bin):
      """Live activity feed showing the last 100 file_synced events."""

      __gtype_name__ = "ProtonDriveActivityFeed"

      activity_spinner: Gtk.Spinner = Gtk.Template.Child()
      activity_stack: Gtk.Stack = Gtk.Template.Child()
      activity_list: Gtk.ListBox = Gtk.Template.Child()

      def __init__(self, **kwargs: object) -> None:
          super().__init__(**kwargs)
          self._events: list[dict[str, Any]] = []

      def add_event(self, event: dict[str, Any]) -> None:
          """Prepend a file_synced event row; discard oldest if over cap."""
          row = ActivityFeedRow(event)
          self.activity_list.prepend(row)
          self._events.insert(0, event)

          if len(self._events) > _MAX_FEED_ITEMS:
              # Remove oldest row (last in the ListBox after prepends).
              tail = self.activity_list.get_row_at_index(_MAX_FEED_ITEMS)
              if tail is not None:
                  self.activity_list.remove(tail)
              self._events.pop()

          if self.activity_stack.get_visible_child_name() != "feed":
              self.activity_stack.set_visible_child_name("feed")

      def set_syncing(self, active: bool) -> None:
          """Show or hide the spinner at the top of the feed header."""
          self.activity_spinner.set_spinning(active)
          self.activity_spinner.set_visible(active)

      def clear(self) -> None:
          """Remove all rows — called on clear_session()."""
          self._events.clear()
          child = self.activity_list.get_first_child()
          while child is not None:
              nxt = child.get_next_sibling()
              self.activity_list.remove(child)
              child = nxt
          self.activity_stack.set_visible_child_name("empty")
          self.set_syncing(False)
  ```

- [x] **Task 4 — Wire `ActivityFeed` into `PairDetailPanel`** (AC: 1, 2, 3, 4, 5)
  - [x] 4.1 In `ui/src/protondrive/widgets/pair_detail_panel.py`:
    - Add import: `from protondrive.widgets.activity_feed import ActivityFeed`
    - In `__init__()`, after `self._conflict_log = None`, add:
      ```python
      self._activity_feed: ActivityFeed | None = None
      ```
  - [x] 4.2 Add `_ensure_activity_feed()` private helper (lazy-creates on first use):
    ```python
    def _ensure_activity_feed(self) -> ActivityFeed:
        if self._activity_feed is None:
            self._activity_feed = ActivityFeed()
            self.activity_slot.append(self._activity_feed)
        return self._activity_feed
    ```
  - [x] 4.3 Add `on_file_synced(payload: dict) -> None` — called from `window.py`:
    ```python
    def on_file_synced(self, payload: dict) -> None:
        """Prepend a file_synced event row to the activity feed."""
        self._ensure_activity_feed().add_event(payload)
    ```
  - [x] 4.4 Add `set_activity_syncing(active: bool) -> None` — controls the feed spinner:
    ```python
    def set_activity_syncing(self, active: bool) -> None:
        """Show or hide the reconcile-progress spinner in the activity feed."""
        if self._activity_feed is not None:
            self._activity_feed.set_syncing(active)
    ```
  - [x] 4.5 In `show_no_pairs()` and `show_select_prompt()`, these already call `_hide_progress_card()`. The activity feed persists across pair selection (it accumulates from all pairs) — do NOT call `feed.clear()` here.
  - [x] 4.6 In `clear_session()` context: the feed must clear when the session ends. However `clear_session()` is on `MainWindow`, not `PairDetailPanel`. The panel's `show_no_pairs()` is the closest hook. Add clear support: in `show_no_pairs()`, add:
    ```python
    if self._activity_feed is not None:
        self._activity_feed.clear()
    ```
    **Rationale:** `show_no_pairs()` is called from `window.py.clear_session()` → `populate_pairs([])`. This is the correct session-reset hook. The feed must start empty on every re-login.
  - [x] 4.7 In `_make_panel()` test fixture in `test_pair_detail_panel.py`, add the new attributes:
    - This is in the test file; the fixture must include `panel.activity_slot = MagicMock()` and `panel._activity_feed = None`.

- [x] **Task 5 — Wire `file_synced` event in `main.py`** (AC: 1)
  - [x] 5.1 In `Application.do_startup()`, after the `reconcile_progress` line (line 102):
    ```python
    self._engine.on_event("file_synced", self._on_file_synced)
    ```
  - [x] 5.2 Add handler after `_on_reconcile_progress()`:
    ```python
    def _on_file_synced(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        if self._window is not None:
            self._window.on_file_synced(payload)
    ```

- [x] **Task 6 — Add `on_file_synced()` to `MainWindow` and update `on_reconcile_progress()`** (AC: 1, 5)
  - [x] 6.1 In `window.py`, add after `on_reconcile_progress()`:
    ```python
    def on_file_synced(self, payload: dict[str, Any]) -> None:
        """Route file_synced event to the activity feed in the detail panel."""
        pair_id = payload.get("pair_id", "")
        # Resolve pair display name from row or pair data.
        row = self._sync_pair_rows.get(pair_id)
        pair_name = row.pair_name if row is not None else ""
        if not pair_name:
            local_path = self._pairs_data.get(pair_id, {}).get("local_path", "")
            pair_name = os.path.basename(local_path.rstrip("/")) if local_path else pair_id
        enriched = dict(payload)
        enriched["pair_name"] = pair_name
        self.pair_detail_panel.on_file_synced(enriched)
    ```
  - [x] 6.2 In `window.py.on_reconcile_progress()`, at the end of both branches (after updating `_pair_phase`), add a spinner update call. Insert this at the VERY END of the method (after both `if/elif` branches):
    ```python
        # Update activity feed spinner — show if any pair is actively reconciling.
        has_active = any(v == "active" for v in self._pair_phase.values())
        self.pair_detail_panel.set_activity_syncing(has_active)
    ```
    **Placement:** After the final `elif phase == "idle":` block closes. Both branches (`scanning/uploading/downloading` and `idle`) update `_pair_phase` before this line runs, so `has_active` reflects the updated state.
  - [x] 6.3 In `window.py.on_pair_error()`, after setting `self._pair_phase[pair_id] = "paused"` or `row.set_state("error")`, add spinner update (error pauses or clears the phase, so spinner may need to turn off):
    ```python
        has_active = any(v == "active" for v in self._pair_phase.values())
        self.pair_detail_panel.set_activity_syncing(has_active)
    ```
    Insert at the end of `on_pair_error()`, after `self._update_footer_error_state()`.
  - [x] 6.4 In `window.py._on_watchdog_fired()`, after `self._apply_resting_state(pair_id)`, add:
    ```python
        has_active = any(v == "active" for v in self._pair_phase.values())
        self.pair_detail_panel.set_activity_syncing(has_active)
    ```
  - [x] 6.5 In `window.py.on_token_expired_phase_pause()`, after the loop, add:
    ```python
        self.pair_detail_panel.set_activity_syncing(False)
    ```
    When all pairs are paused by token_expired, no pair is "active".

- [x] **Task 7 — Register new widget in build system** (required for meson compile to succeed)
  - [x] 7.1 In `ui/meson.build`, after `blueprints_add_pair_dialog = custom_target(...)` block (line ~119), add:
    ```meson
    blueprints_activity_feed = custom_target(
      'blueprint-activity-feed',
      input: files('data/ui/activity-feed.blp'),
      output: 'activity-feed.ui',
      command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
    )
    ```
  - [x] 7.2 In the `gnome.compile_resources(...)` call (line ~123), add `blueprints_activity_feed` to the `dependencies` list.
  - [x] 7.3 In `ui/data/protondrive.gresource.xml`, add after `add-pair-dialog.ui`:
    ```xml
    <file alias="ui/activity-feed.ui" preprocess="xml-stripblanks">activity-feed.ui</file>
    ```
  - [x] 7.4 In `ui/meson.build` `python_widget_sources` list (line ~157), add:
    ```
    'src/protondrive/widgets/activity_feed.py',
    ```

- [x] **Task 8 — Unit tests in `ui/tests/test_activity_feed.py`** (AC: 7)

  Create new test file. Use `object.__new__` bypass pattern.

  **Fixture:**
  ```python
  from unittest.mock import MagicMock, patch
  from protondrive.widgets.activity_feed import ActivityFeed, ActivityFeedRow, _fmt_activity_time

  def _make_feed() -> ActivityFeed:
      feed = object.__new__(ActivityFeed)
      feed._events = []
      feed.activity_spinner = MagicMock()
      feed.activity_stack = MagicMock()
      feed.activity_list = MagicMock()
      feed.activity_list.get_row_at_index = MagicMock(return_value=MagicMock())
      feed.activity_list.get_first_child = MagicMock(return_value=None)
      return feed
  ```

  **Tests:**
  - [x] 8.1 **`_fmt_activity_time` — under 60s returns "just now"**
  - [x] 8.2 **`_fmt_activity_time` — 2 min returns "2 min ago"**
  - [x] 8.3 **`_fmt_activity_time` — 90 min returns "1 hr ago"**
  - [x] 8.4 **`_fmt_activity_time` — invalid timestamp returns empty string**
  - [x] 8.5 **`add_event` — prepends row to `activity_list`**:
    - Call `feed.add_event({"file_name": "a.txt", "direction": "upload", "timestamp": "2026-04-25T12:00:00Z", "pair_name": "Docs"})`
    - Assert `feed.activity_list.prepend.called`
    - Assert `len(feed._events) == 1`
  - [x] 8.6 **`add_event` — switches stack to "feed" on first item**:
    - Call `feed.add_event({...})`
    - Assert `feed.activity_stack.set_visible_child_name.called_with("feed")`
  - [x] 8.7 **`add_event` — 100-item cap removes tail**:
    - Pre-populate `feed._events` with 100 dicts and ensure `activity_list.get_row_at_index` returns a mock
    - Call `feed.add_event({...})`
    - Assert `len(feed._events) == 100`
    - Assert `feed.activity_list.remove.called`
  - [x] 8.8 **`add_event` — 99 items does NOT remove tail** (boundary check):
    - Pre-populate with 99 items; add 1 more → total 100, no `remove` call
  - [x] 8.9 **`set_syncing(True)` — spinner becomes visible and spinning**:
    - Call `feed.set_syncing(True)`
    - Assert `feed.activity_spinner.set_spinning(True)` and `feed.activity_spinner.set_visible(True)`
  - [x] 8.10 **`set_syncing(False)` — spinner hidden**:
    - Call `feed.set_syncing(False)`
    - Assert `feed.activity_spinner.set_visible(False)`
  - [x] 8.11 **`clear()` — resets events, switches to "empty", stops spinner**:
    - Populate with 2 events; call `feed.clear()`
    - Assert `feed._events == []`
    - Assert stack shows "empty"
    - Assert spinner not spinning
  - [x] 8.12 **`PairDetailPanel.on_file_synced` — lazy-creates feed and delegates**:
    - Use `_make_panel()` from existing `test_pair_detail_panel.py` fixture pattern
    - Add `panel.activity_slot = MagicMock()`; set `panel._activity_feed = None`
    - Mock `ActivityFeed` class
    - Call `panel.on_file_synced({"pair_id": "p1", "file_name": "x.txt", "direction": "download", "timestamp": "...", "pair_name": "Docs"})`
    - Assert `ActivityFeed` was instantiated and `add_event` called on it
  - [x] 8.13 **`PairDetailPanel.set_activity_syncing` — delegates to feed if exists**:
    - Attach a mock `_activity_feed` to panel; call `panel.set_activity_syncing(True)`
    - Assert `mock_feed.set_syncing.called_with(True)`
  - [x] 8.14 **`PairDetailPanel.set_activity_syncing` — no-op if feed not yet created**:
    - `panel._activity_feed = None`; call `panel.set_activity_syncing(True)` → no error

- [x] **Task 9 — Validate** (AC: 6, 7)
  - [x] 9.1 meson compile succeeded — `blueprint-activity-feed` at step 16/18, gresource bundle at 18/18. Note: builddir required `--wipe` as `/usr/bin/meson` had moved to `/home/jeremy/.local/bin/meson` in the container.
  - [x] 9.2 695 passed in 10.47s, 0 failed (681 baseline + 14 new tests)
  - [x] 9.3 Set story status to `review`

## Dev Notes

### Architecture: `ActivityFeed` follows the `ConflictLog` pattern

`ConflictLog` and `ActivityFeed` both follow the same pattern:
- Own `.blp` template file → own widget class
- Lazy-created and appended to a named slot in `pair-detail-panel.blp`
- Managed by `PairDetailPanel` (lazy-init, delegate calls)

Do NOT inline the feed as raw labels or boxes constructed in Python — Blueprint rule applies.

### `ActivityFeedRow` follows `ConflictLogRow` pattern

`ConflictLogRow` subclasses `Adw.ActionRow` with programmatic prefix/suffix widgets (no `.blp` for individual rows). `ActivityFeedRow` does the same. This is the established pattern for dynamic list rows in this codebase.

### Arrow prefix: ↑ and ↓

Use Unicode arrows directly as `Gtk.Label` text — no icon required. Apply `"success"` CSS class for uploads (green), `"accent"` CSS class for downloads (teal). These are Libadwaita named colors.

### Relative timestamp: "just now" ≠ existing `_fmt_relative_time`

`pair_detail_panel._fmt_relative_time` returns `"N seconds ago"` for < 60s, whereas Story 8-3 AC1 requires `"just now"`. Create a new `_fmt_activity_time()` in `activity_feed.py`. Do NOT import or reuse `_fmt_relative_time` from `pair_detail_panel.py` — widget isolation rule forbids cross-widget imports.

### 100-item cap and scroll preservation

`Gtk.ListBox.prepend()` adds items to position 0. GTK4 `Gtk.ScrolledWindow` adjusts the `vadjustment.value` when content height changes to preserve the viewport position for non-zero scroll positions. When the user is at the top (`vadjustment.value == 0`), new items appear above and the view naturally stays at the top showing the latest. No manual scroll management is needed.

To remove the oldest item, use:
```python
tail = self.activity_list.get_row_at_index(_MAX_FEED_ITEMS)
if tail is not None:
    self.activity_list.remove(tail)
self._events.pop()  # pop last element
```

`get_row_at_index(_MAX_FEED_ITEMS)` fetches item at index 100 (0-indexed) — the 101st item, which is one past the cap.

### Spinner is driven by `_pair_phase` membership, not phase value

The spinner shows when `any(v == "active" for v in self._pair_phase.values())`. Pairs in `"paused"` or `"paused_token"` do NOT light the spinner — they are blocked, not actively working. This is consistent with 8-2a: `"active"` = engine is scanning/uploading/downloading.

### When does the spinner turn off?

| Trigger | `_pair_phase` state after | `has_active`? | Spinner |
|---|---|---|---|
| `reconcile_progress { phase: "idle" }` for last active pair | pair removed from dict | False | Off |
| `on_pair_error()` for last active pair | pair → `"paused"` | False | Off |
| `_on_watchdog_fired()` for last active pair | pair removed from dict | False | Off |
| `on_token_expired_phase_pause()` | all pairs → `"paused_token"` | False | Off (explicit call) |

The spinner update is appended at the end of `on_reconcile_progress()`, `on_pair_error()`, `_on_watchdog_fired()`, and `on_token_expired_phase_pause()`. It reads the FINAL state of `_pair_phase` after all mutations are complete.

### `on_file_synced()` enriches `pair_name` in `window.py`

The engine's `file_synced` payload contains only `pair_id`, `file_name`, `direction`, `timestamp`. `window.py.on_file_synced()` resolves `pair_name` from `SyncPairRow.pair_name` (first) or `_pairs_data[pair_id]["local_path"]` basename (fallback) before calling `panel.on_file_synced(enriched)`. The panel receives a complete dict.

### Isolation: panel doesn't import window state

The panel only receives enriched payloads from window.py. It does NOT access `_pair_phase`, `_sync_pair_rows`, or any window-level dict directly. This preserves the widget isolation rule.

### `clear_session()` integration

`MainWindow.clear_session()` → `populate_pairs([])` → `pair_detail_panel.show_no_pairs()`.

Story 8-3 adds `activity_feed.clear()` inside `PairDetailPanel.show_no_pairs()`. This is the correct hook because `show_no_pairs()` is called exactly once per session reset (logout or re-auth). The feed starts fresh on every new session.

### Deferred items from 8-2 that affect 8-3

From `8-2-ipc-activity-events.md` Review Findings:
- `drainQueue` idle hardcodes `files_processed: 0, files_total: 0` — the spinner turns off via `phase: "idle"` regardless; no feed impact.
- When all uploads fail → `pairsWithSuccess` empty → no `idle` from `drainQueue` — the spinner will be cleared by `on_pair_error()` (engine emits error before no-idle path) OR by the 30s watchdog. No extra handling needed in 8-3.
- `reconcilePair` exceptions after `scanning` → no idle emitted — same resolution: `on_pair_error()` fires or watchdog clears.

Story 8-3 does NOT need to add its own timeout for these deferred cases — Story 8-2a's watchdog (already implemented) covers them.

### Build system — 4 places to update

Every new `.blp` file in this codebase requires 4 coordinated changes:
1. `ui/meson.build` — new `custom_target` for blueprint compile
2. `ui/meson.build` `gnome.compile_resources()` dependencies list — add new target
3. `ui/data/protondrive.gresource.xml` — add `<file alias=...>` entry
4. `ui/meson.build` `python_widget_sources` list — add `.py` file

Missing any one of these causes a silent build failure or runtime resource-not-found crash.

### Test fixture — update `_make_panel()` in `test_pair_detail_panel.py`

The existing `_make_panel()` in `test_pair_detail_panel.py` creates a panel without GTK. Add the new attributes:
```python
panel.activity_slot = MagicMock()
panel._activity_feed = None
```
This prevents `AttributeError` if existing tests hit code paths that touch the new attributes. Place alongside the existing `panel._conflict_log = None` line.

### IPC wire format reminder

`file_synced` payload fields (snake_case wire format — do not camelCase):
- `pair_id: string`
- `file_name: string` — bare name, no path (PII constraint — enforced by engine in 8-2)
- `direction: "upload" | "download"`
- `timestamp: string` — ISO 8601 UTC

`pair_name` is added by `window.py.on_file_synced()` before passing to the panel — it is NOT in the engine payload.

### Project Structure Notes

New files:
| File | Type |
|---|---|
| `ui/data/ui/activity-feed.blp` | Blueprint template (new) |
| `ui/src/protondrive/widgets/activity_feed.py` | Widget implementation (new) |
| `ui/tests/test_activity_feed.py` | Test file (new) |

Modified files:
| File | Change |
|---|---|
| `ui/data/ui/pair-detail-panel.blp` | Add `activity_slot` box |
| `ui/src/protondrive/widgets/pair_detail_panel.py` | Add `activity_slot` child, `_activity_feed`, `on_file_synced()`, `set_activity_syncing()`, feed clear on `show_no_pairs()` |
| `ui/src/protondrive/main.py` | Register `file_synced` event, add `_on_file_synced()` handler |
| `ui/src/protondrive/window.py` | Add `on_file_synced()`, spinner update calls in 4 existing methods |
| `ui/meson.build` | New blueprint target, resource dep, Python source entry |
| `ui/data/protondrive.gresource.xml` | New `<file>` entry for `activity-feed.ui` |
| `ui/tests/test_pair_detail_panel.py` | Update `_make_panel()` fixture with new attributes |

No changes to: engine files, `sdk.ts`, `ipc.ts`, `sync-engine.ts`, `state-db.ts`, GSettings schema.

### Anti-Patterns to Avoid

- **Never construct widget trees in Python** — all `ActivityFeed` widget structure must be in `activity-feed.blp`. Only `ActivityFeedRow` (dynamic row) uses programmatic prefix — this is the same exception as `ConflictLogRow`.
- **Never import `pair_detail_panel._fmt_relative_time` in `activity_feed.py`** — widget isolation rule; write a separate `_fmt_activity_time()`.
- **Never call `activity_feed.clear()` on pair selection** — the feed is global across all pairs; only `show_no_pairs()` (session reset) clears it.
- **Never access `window._pair_phase` from the panel** — the panel receives explicit `set_activity_syncing()` calls from window.py.
- **Never call `GLib.timeout_add()` in `activity_feed.py`** — the 30s watchdog is owned by `window.py` (Story 8-2a). The feed just responds to explicit calls.
- **Never import `@protontech/drive-sdk`** — this is a pure UI story; zero engine changes.
- **Never skip the meson.build / gresource.xml updates** — the blueprint file only compiles if registered in all 4 places; a missing registration causes a cryptic GLib resource error at runtime.

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-8-sdk-compliance-incremental-sync.md#Story 8.3] — authoritative AC
- [Source: _bmad-output/implementation-artifacts/8-2-ipc-activity-events.md#Tasks §1.1–1.2] — `FileSyncedPayload` and `ReconcileProgressPayload` wire shapes; `file_name` is bare basename per PII constraint
- [Source: _bmad-output/implementation-artifacts/8-2a-reconcile-progress-state-machine.md#Dev Notes §Phase State Machine Overview] — `_pair_phase` dict semantics; `"active"` vs `"paused"` vs `"paused_token"`
- [Source: _bmad-output/implementation-artifacts/8-2a-reconcile-progress-state-machine.md#Review Findings] — `_on_watchdog_fired` paused_token guard (already patched)
- [Source: _bmad-output/implementation-artifacts/8-2-ipc-activity-events.md#Review Findings] — deferred: error event is the terminal signal for stuck pairs; 8-2a watchdog covers; 8-3 does NOT need its own timeout
- [Source: ui/src/protondrive/widgets/conflict_log.py] — ConflictLogRow programmatic row pattern (prefix via add_prefix, no .blp for rows)
- [Source: ui/data/ui/conflict-log.blp] — ConflictLog blueprint structure: Stack with empty/list pages + ListBox
- [Source: ui/src/protondrive/widgets/pair_detail_panel.py:66–86] — `__init__` and lazy-widget pattern; `_progress_card`, `_conflict_log` lazy fields
- [Source: ui/src/protondrive/widgets/pair_detail_panel.py:103–114] — `show_conflict_log_page()` lazy-create pattern to follow
- [Source: ui/src/protondrive/window.py:806–830] — `on_reconcile_progress()` — add spinner update at end of both branches
- [Source: ui/src/protondrive/window.py:751–766] — `on_pair_error()` — add spinner update at end
- [Source: ui/src/protondrive/window.py:768–776] — `on_token_expired_phase_pause()` — add explicit spinner off at end
- [Source: ui/src/protondrive/window.py:515–523] — `_on_watchdog_fired()` — add spinner update after `_apply_resting_state`
- [Source: ui/src/protondrive/main.py:101–102] — event registration block; add `file_synced` after `reconcile_progress`
- [Source: ui/meson.build:100–126] — blueprint target and gresource dep pattern; follow exactly
- [Source: ui/data/protondrive.gresource.xml] — gresource file list; add `activity-feed.ui`
- [Source: ui/tests/test_pair_detail_panel.py:15–40] — `_make_panel()` fixture to update
- [Source: ui/tests/conftest.py] — GLib mock already set up; `GLib.source_remove`, `GLib.timeout_add_seconds` mocked
- [Source: _bmad-output/project-context.md §Blueprint rule] — all widget structure in `.blp`; no `Gtk.Box()` in Python except for dynamic row prefixes/suffixes
- [Source: _bmad-output/project-context.md §IPC Wire Format] — snake_case on both sides; pair_name is window-resolved, not in wire format

## Review Findings

- [x] [Review][Patch] Unused imports `os` and `GObject` in `activity_feed.py` [`ui/src/protondrive/widgets/activity_feed.py:5,9`] — Both `import os` and `GObject` from `gi.repository` are imported but never referenced in the file; `os.path.basename` lives in `window.py`, not here.
- [x] [Review][Patch] Missing multi-pair interleaving test — AC7 explicitly requires a test that adds events from two different `pair_name` values and asserts they interleave in a single feed; every `_event()` call in `test_activity_feed.py` uses `pair_name="Docs"`.
- [x] [Review][Patch] `test_reconcile_progress.py` never asserts `set_activity_syncing` is called — AC5 spinner dismissal paths (`on_reconcile_progress idle`, `on_pair_error`, `_on_watchdog_fired`) all call `pair_detail_panel.set_activity_syncing` but none of the 8 tests verify it; mock is present but unused for this assertion.
- [x] [Review][Defer] Default `↓` arrow for missing/unknown `direction` field [`ui/src/protondrive/widgets/activity_feed.py:52`] — `"↑" if direction == "upload" else "↓"` silently renders download arrow for any unrecognised or absent direction value; pre-existing wire-format assumption, acceptable for now. — deferred, pre-existing
- [x] [Review][Defer] `row.pair_name` attribute access not guarded against `AttributeError` [`ui/src/protondrive/window.py:on_file_synced`] — accesses `row.pair_name` without try/except; falls back on falsiness but not on exception; pre-existing interface contract assumption. — deferred, pre-existing

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None.

### Completion Notes List

- Implemented `ActivityFeed` (Adw.Bin + Blueprint) and `ActivityFeedRow` (Adw.ActionRow) following the ConflictLog pattern exactly.
- `_fmt_activity_time` is a new standalone function in `activity_feed.py` — does NOT reuse `_fmt_relative_time` from `pair_detail_panel.py` per widget isolation rule; wording differs ("just now" vs "N seconds ago").
- Spinner driven by `any(v == "active" for v in self._pair_phase.values())` — appended at end of `on_reconcile_progress`, `on_pair_error`, `_on_watchdog_fired`, and `on_token_expired_phase_pause` in `window.py`.
- Feed clear is hooked into `show_no_pairs()` (session reset path via `clear_session()` → `populate_pairs([])` → `show_no_pairs()`).
- All 4 build system locations updated: `meson.build` custom target, `meson.build` gresource dependencies, `gresource.xml` file entry, `meson.build` python_widget_sources.
- Builddir required `--wipe` during validation as the stored `/usr/bin/meson` path in `build.ninja` was stale; meson is now at `/home/jeremy/.local/bin/meson` in the container. Memory reference updated.
- 695 tests pass (681 baseline + 14 new in `test_activity_feed.py`).

### File List

- `ui/data/ui/activity-feed.blp` (new)
- `ui/data/ui/pair-detail-panel.blp` (modified — added `activity_slot` box)
- `ui/data/protondrive.gresource.xml` (modified — added `activity-feed.ui` entry)
- `ui/src/protondrive/widgets/activity_feed.py` (new)
- `ui/src/protondrive/widgets/pair_detail_panel.py` (modified — `activity_slot` child, `_activity_feed`, `_ensure_activity_feed`, `on_file_synced`, `set_activity_syncing`, feed clear in `show_no_pairs`)
- `ui/src/protondrive/main.py` (modified — register `file_synced` event, add `_on_file_synced` handler)
- `ui/src/protondrive/window.py` (modified — `on_file_synced`, spinner updates in `on_reconcile_progress`, `on_pair_error`, `_on_watchdog_fired`, `on_token_expired_phase_pause`)
- `ui/meson.build` (modified — `blueprints_activity_feed` target, gresource dep, python_widget_sources entry)
- `ui/tests/test_activity_feed.py` (new)
- `ui/tests/test_pair_detail_panel.py` (modified — `_make_panel` fixture updated with `activity_slot` and `_activity_feed`)
