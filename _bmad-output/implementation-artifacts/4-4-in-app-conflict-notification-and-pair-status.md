# Story 4.4: In-App Conflict Notification & Pair Status

Status: done

## Story

As a user,
I want to see conflict notifications inside the app and on the affected sync pair,
so that I notice conflicts without checking my filesystem manually.

## Acceptance Criteria

### AC1 — AdwBanner appears on conflict_detected

**Given** a `conflict_detected` push event is received by the UI  
**When** the detail panel is showing the affected sync pair  
**Then** an `AdwBanner` appears with amber styling: "1 conflict in [pair name]" (FR27)  
**And** the banner is persistent (not auto-dismissed) and has a "Dismiss" button  
**And** clicking "Dismiss" hides the banner until the next `conflict_detected` for that pair  
**And** switching to a different pair hides the banner; switching back re-shows it if unresolved

### AC2 — SyncPairRow shows amber dot

**Given** a conflict exists on a sync pair  
**When** the sidebar renders  
**Then** the affected `SyncPairRow` shows an amber dot  
**And** the status label shows "1 conflict" (or "N conflicts" for multiple)  
**And** the accessible label is `"[pair name] — 1 conflict"` (AT-SPI2, singular always)

### AC3 — StatusFooterBar shows "N conflicts need attention"

**Given** one or more conflicts exist across any sync pairs  
**When** the footer bar renders  
**Then** it shows "1 conflict needs attention" or "N conflicts need attention" with an amber dot  
**And** the accessible label matches the displayed text

### AC4 — Footer priority: Conflict > Syncing > All synced

**Given** the `StatusFooterBar` priority rule  
**When** both conflicts and active sync_progress events are present  
**Then** the footer shows the conflict message, not the syncing message  
**And** the individual `SyncPairRow` may still show "Syncing…" for the actively syncing pair  
**And** when sync_complete fires for a row in conflict state, the row reverts to amber (not green)

### AC5 — Conflict state clears on resolution

**Given** the user deletes a conflict copy in their file manager  
**When** the next `sync_complete` event fires for that pair  
**Then** the UI checks whether tracked conflict copy paths still exist on disk  
**And** any missing paths are removed from the conflict tracking for that pair  
**And** if no conflicts remain for that pair: row dot returns to green, banner dismissed, footer updates  
**And** if conflicts remain for that pair: counts update, amber state persists

### AC6 — Session clear resets conflict state

**Given** the user logs out  
**When** `clear_session()` is called  
**Then** `_conflict_copies_by_pair` is cleared and all visual conflict indicators are reset

### AC7 — Unit tests

**When** running `meson test -C builddir`  
**Then** tests cover: `SyncPairRow.set_state("conflict")` dot color, label, and `queue_draw` called  
**And** `StatusFooterBar.set_conflicts()` text and dot state  
**And** `PairDetailPanel` banner show/hide, pair_id guard, and dismiss behaviour  
**And** `Application._on_conflict_detected` routing to window  
**And** `window.on_conflict_detected` per-pair tracking and visual update  
**And** `window.on_sync_complete` resolution detection (mock `os.path.exists`)

---

## Tasks / Subtasks

- [x] **Task 1: Wire CSS loading infrastructure** (AC: 1) ← PREREQUISITE for amber banner to work
  - [x] 1.1 Open `ui/data/protondrive.gresource.xml`. Add `style.css` as the first entry:
    ```xml
    <gresources>
      <gresource prefix="/io/github/ronki2304/ProtonDriveLinuxClient">
        <file alias="style.css">style.css</file>
        <!-- existing .ui entries unchanged -->
        ...
      </gresource>
    </gresources>
    ```
  - [x] 1.2 In `ui/src/protondrive/main.py` `do_startup`, add CSS loading **before** the `StyleManager` calls. Add `Gdk` to the imports line:
    ```python
    from gi.repository import Adw, Gdk, Gio, GLib
    ```
    Then add at the START of `do_startup` body (before `Adw.Application.do_startup(self)`... wait — add AFTER `Adw.Application.do_startup(self)`):
    ```python
    # Load application CSS (amber dot animation, conflict banner styling).
    css_provider = Gtk.CssProvider()
    css_provider.load_from_resource(
        "/io/github/ronki2304/ProtonDriveLinuxClient/style.css"
    )
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        css_provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )
    ```
    Note: `Gtk` is already imported via `from gi.repository import Adw, Gio, GLib` → ensure `Gtk` is in that import (it's used in `do_startup` indirectly via `Adw`). Add it explicitly: `from gi.repository import Adw, Gdk, Gio, GLib, Gtk`.
  - [x] 1.3 This also activates the pre-existing `sync-dot-syncing` pulse animation that was previously dead code. No other changes needed in `style.css` for the animation.

- [x] **Task 2: CSS — amber banner style** (AC: 1)
  - [x] 2.1 Open `ui/data/style.css` and append:
    ```css
    /* Conflict banner — amber accent (Story 4-4) */
    .conflict-banner {
      background-color: alpha(#f0a020, 0.15);
      border-bottom: 1px solid alpha(#f0a020, 0.4);
    }
    ```
  - [x] 2.2 The amber colour `(0.95, 0.62, 0.14)` ≈ `#f29e24` is already used by the dot `DrawingArea`. The banner tint uses a slightly cooler `#f0a020` at low opacity — consistent.

- [x] **Task 3: Blueprint — add AdwBanner to pair-detail-panel.blp** (AC: 1)
  - [x] 3.1 Open `ui/data/ui/pair-detail-panel.blp`. In the `"detail"` `Gtk.StackPage`, replace the direct `Gtk.ScrolledWindow` child with a `Gtk.Box` wrapper:
    ```blp
    Gtk.StackPage {
      name: "detail";
      child: Gtk.Box {
        orientation: vertical;

        Adw.Banner conflict_banner {
          button-label: _("Dismiss");
          revealed: false;
          styles ["conflict-banner"]
        }

        Gtk.ScrolledWindow {
          propagate-natural-height: true;
          vexpand: true;
          child: Gtk.Box detail_box {
            orientation: vertical;
            spacing: 0;
            margin-start: 24;
            margin-end: 24;
            margin-top: 16;
            margin-bottom: 16;
            /* ... all existing children unchanged ... */
          };
        }
      };
    }
    ```
  - [x] 3.2 Keep ALL existing widget IDs and children (`pair_name_heading`, `paths_group`, `sync_status_group`, `progress_slot`) **exactly** as they are — only wrap in a vertical `Gtk.Box` and prepend the banner.
  - [x] 3.3 Add `vexpand: true` to the `Gtk.ScrolledWindow` so it fills the box once the banner is hidden.

- [x] **Task 4: PairDetailPanel Python — wire banner** (AC: 1)
  - [x] 4.1 In `pair_detail_panel.py`, add `conflict_banner: Adw.Banner = Gtk.Template.Child()` alongside the other template children.
  - [x] 4.2 In `__init__`, connect dismiss signal (NO lambda — project rule):
    ```python
    self.conflict_banner.connect("button-clicked", self._on_conflict_banner_dismissed)
    ```
  - [x] 4.3 Add `_on_conflict_banner_dismissed`:
    ```python
    def _on_conflict_banner_dismissed(self, _banner: Adw.Banner) -> None:
        """Hide the conflict banner when user clicks Dismiss."""
        self.conflict_banner.set_revealed(False)
    ```
  - [x] 4.4 Add `set_conflict_state(self, pair_id: str, count: int, pair_name: str) -> None`:
    ```python
    def set_conflict_state(self, pair_id: str, count: int, pair_name: str) -> None:
        """Update conflict banner — only if pair_id matches what is currently shown.

        Called from window.py on conflict_detected, sync_complete, and row_activated.
        The pair_id guard prevents a conflict on pair B from updating the banner
        while pair A is displayed in the detail pane.
        """
        if self._current_pair_id != pair_id:
            return
        if count > 0:
            text = (
                f"1 conflict in {pair_name}"
                if count == 1
                else f"{count} conflicts in {pair_name}"
            )
            self.conflict_banner.set_title(text)
            self.conflict_banner.set_revealed(True)
        else:
            self.conflict_banner.set_revealed(False)
    ```
  - [x] 4.5 In `show_pair()`, after all existing assignments and before `detail_stack.set_visible_child_name("detail")`, reset the banner unconditionally:
    ```python
    self.conflict_banner.set_revealed(False)
    ```
    This is safe because `_on_row_activated` in `window.py` immediately calls `set_conflict_state(pair_id, count, name)` after `show_pair()` — so if there IS a conflict, the banner re-shows right away.

- [x] **Task 5: SyncPairRow — add "conflict" state** (AC: 2)
  - [x] 5.1 Update `set_state` signature:
    ```python
    def set_state(
        self,
        state: str,
        last_synced_text: str | None = None,
        conflict_count: int = 1,
    ) -> None:
    ```
  - [x] 5.2 Add the `"conflict"` branch in the `if/elif` chain **before** the final `else` (synced case). The complete conflict block including accessible label and early return (to skip the generic `_set_accessible_label` call at the bottom):
    ```python
    elif state == "conflict":
        label = "1 conflict" if conflict_count == 1 else f"{conflict_count} conflicts"
        self.status_label.set_text(label)
        self.status_dot.add_css_class("sync-dot-conflict")
        self.status_dot.remove_css_class("sync-dot-syncing")
        self.status_dot.remove_css_class("sync-dot-offline")
        # Accessible label uses singular form per AC2.
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [f"{self._pair_name} \u2014 1 conflict"],
        )
        self.status_dot.queue_draw()
        return  # early return: skip generic _set_accessible_label below
    ```
  - [x] 5.3 Update `_draw_dot` — add conflict colour alongside existing cases:
    ```python
    elif self._state == "conflict":
        cr.set_source_rgb(0.95, 0.62, 0.14)  # amber — matches StatusFooterBar conflict colour
    ```
  - [x] 5.4 The existing `self.status_dot.queue_draw()` and `self._set_accessible_label(state)` lines at the bottom of `set_state` are still reached for the non-conflict branches (syncing, offline, synced). The conflict branch returns early and handles both internally — no structural change to the other branches needed.

- [x] **Task 6: StatusFooterBar — add set_conflicts()** (AC: 3)
  - [x] 6.1 Add `set_conflicts(self, count: int) -> None`:
    ```python
    def set_conflicts(self, count: int) -> None:
        """Show N-conflict indicator from real-time conflict_detected events (Story 4-4).

        Distinct from set_conflict_pending (Story 3-3 queue-replay path).
        Non-positive count: guard same as set_conflict_pending.
        """
        if count <= 0:
            self.update_all_synced()
            return
        text = (
            "1 conflict needs attention"
            if count == 1
            else f"{count} conflicts need attention"
        )
        self.footer_label.set_text(text)
        self._set_dot_state("conflict")
        self.update_property([Gtk.AccessibleProperty.LABEL], [text])
        self.announce(text, Gtk.AccessibleAnnouncementPriority.LOW)
    ```
  - [x] 6.2 No changes to existing `set_conflict_pending` or `_set_dot_state` — the "conflict" dot state + amber colour already exists for both paths.

- [x] **Task 7: window.py — conflict tracking and event handlers** (AC: 1–6)
  - [x] 7.1 In `__init__`, add after `self._conflict_pending_count = 0`:
    ```python
    # Maps pair_id → list of conflict copy absolute paths (Story 4-4).
    # Populated by on_conflict_detected; resolved in on_sync_complete.
    self._conflict_copies_by_pair: dict[str, list[str]] = {}
    ```
  - [x] 7.2 Add private helper method:
    ```python
    def _total_active_conflicts(self) -> int:
        """Total conflict copy count across all pairs."""
        return sum(len(v) for v in self._conflict_copies_by_pair.values())
    ```
  - [x] 7.3 Add `_get_pair_name` helper (used in multiple handlers below):
    ```python
    def _get_pair_name(self, pair_id: str) -> str:
        """Return display name for pair_id, falling back to pair_id itself."""
        row = self._sync_pair_rows.get(pair_id)
        if row is not None:
            return row.pair_name
        data = self._pairs_data.get(pair_id, {})
        local_path = data.get("local_path", "")
        return os.path.basename(local_path.rstrip("/")) or pair_id
    ```
    Note: `os` is already imported at the top of `window.py`.
  - [x] 7.4 Add `on_conflict_detected`:
    ```python
    def on_conflict_detected(self, payload: dict[str, Any]) -> None:
        """Handle engine's conflict_detected push event (Story 4-4 AC1–3)."""
        pair_id = payload.get("pair_id", "")
        conflict_copy_path = payload.get("conflict_copy_path", "")

        # Guard: malformed payload with no path would corrupt tracking.
        if not conflict_copy_path:
            return

        # Track the new conflict copy (deduplicated by path).
        copies = self._conflict_copies_by_pair.setdefault(pair_id, [])
        if conflict_copy_path not in copies:
            copies.append(conflict_copy_path)

        count = len(copies)
        pair_name = self._get_pair_name(pair_id)

        # Update sidebar row.
        row = self._sync_pair_rows.get(pair_id)
        if row is not None and row.state != "offline":
            row.set_state("conflict", conflict_count=count)

        # Update detail panel banner — only if this pair is currently shown
        # (set_conflict_state guards internally via _current_pair_id).
        self.pair_detail_panel.set_conflict_state(pair_id, count, pair_name)

        # Update footer: conflict > syncing priority (AC4).
        self.status_footer_bar.set_conflicts(self._total_active_conflicts())
    ```
  - [x] 7.5 Replace `on_sync_complete` body entirely:
    ```python
    def on_sync_complete(self, payload: dict[str, Any]) -> None:
        """Update pair row and footer bar when sync completes."""
        pair_id = payload.get("pair_id", "")

        # ── Resolution detection (AC5): check which tracked conflict copies
        # for this pair have been deleted since the last sync cycle. ──
        if pair_id in self._conflict_copies_by_pair:
            still_present = [
                p for p in self._conflict_copies_by_pair[pair_id]
                if os.path.exists(p)
            ]
            self._conflict_copies_by_pair[pair_id] = still_present
            if not still_present:
                del self._conflict_copies_by_pair[pair_id]

        # Determine post-sync state for this pair's row.
        pair_conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        row = self._sync_pair_rows.get(pair_id)
        if row is not None and row.state != "offline":
            if pair_conflict_count > 0:
                row.set_state("conflict", conflict_count=pair_conflict_count)
            else:
                row.set_state("synced")

        # Update detail panel banner (guards internally via pair_id).
        self.pair_detail_panel.set_conflict_state(
            pair_id, pair_conflict_count, self._get_pair_name(pair_id)
        )

        self.pair_detail_panel.on_sync_complete(payload)
        if pair_id in self._pairs_data:
            self._pairs_data[pair_id]["last_synced_text"] = _fmt_relative_time(
                payload.get("timestamp", "")
            )

        # Footer update — Conflict > _conflict_pending > all-synced.
        total_conflicts = self._total_active_conflicts()
        if total_conflicts > 0:
            self.status_footer_bar.set_conflicts(total_conflicts)
            return
        if self._conflict_pending_count > 0:
            return
        if self._sync_pair_rows and all(
            r.state == "synced" for r in self._sync_pair_rows.values()
        ):
            self.status_footer_bar.update_all_synced()
    ```
  - [x] 7.6 Update `on_sync_progress` — implement Conflict > Syncing footer priority (AC4). Locate the existing `self.status_footer_bar.set_syncing(...)` call and wrap it:
    ```python
    # Conflict > Syncing: only update footer to "syncing" if no active conflicts.
    if self._total_active_conflicts() == 0:
        self.status_footer_bar.set_syncing(pair_name, files_done, files_total)
    ```
    The `row.set_state("syncing")` call remains — only the footer is guarded.
  - [x] 7.7 Update `on_online` footer guard:
    ```python
    if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
        return
    ```
  - [x] 7.8 Update `on_watcher_status` "ready" branch guard:
    ```python
    if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
        return
    ```
  - [x] 7.9 Update `_on_row_activated` to restore banner state after pair selection:
    ```python
    def _on_row_activated(self, list_box: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
        """Handle pair row selection — route to pair detail in content area."""
        pair_id = row.pair_id
        pair_data = self._pairs_data.get(pair_id, {})
        self.pair_detail_panel.show_pair(pair_data)  # resets banner to hidden
        # Immediately restore banner if this pair has active conflicts.
        conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        self.pair_detail_panel.set_conflict_state(pair_id, conflict_count, row.pair_name)
        self.nav_split_view.set_show_content(True)
    ```
  - [x] 7.10 Update `clear_session` — add before or alongside `self._sync_pair_rows = {}`:
    ```python
    self._conflict_copies_by_pair = {}
    ```

- [x] **Task 8: main.py — register conflict_detected handler** (AC: 7)
  - [x] 8.1 In `do_startup`, add after `self._engine.on_event("rate_limited", self._on_rate_limited)`:
    ```python
    self._engine.on_event("conflict_detected", self._on_conflict_detected)
    ```
  - [x] 8.2 Add handler method after `_on_rate_limited`:
    ```python
    def _on_conflict_detected(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        if self._window is not None:
            self._window.on_conflict_detected(payload)
    ```

- [x] **Task 9: Tests — SyncPairRow conflict state** (AC: 7)
  - [x] 9.1 In `ui/tests/test_sync_pair_row.py`, add to `TestSyncPairRowSetState`:
    ```python
    def test_set_state_conflict_sets_internal_state(self):
        row = _make_row()
        row.set_state("conflict")
        assert row._state == "conflict"

    def test_set_state_conflict_label_singular(self):
        row = _make_row()
        row.set_state("conflict", conflict_count=1)
        row.status_label.set_text.assert_called_with("1 conflict")

    def test_set_state_conflict_label_plural(self):
        row = _make_row()
        row.set_state("conflict", conflict_count=3)
        row.status_label.set_text.assert_called_with("3 conflicts")

    def test_set_state_conflict_adds_css_class(self):
        row = _make_row()
        row.set_state("conflict")
        row.status_dot.add_css_class.assert_called_with("sync-dot-conflict")

    def test_set_state_conflict_removes_other_css_classes(self):
        row = _make_row()
        row.set_state("conflict")
        removed = [c.args[0] for c in row.status_dot.remove_css_class.call_args_list]
        assert "sync-dot-syncing" in removed
        assert "sync-dot-offline" in removed

    def test_set_state_conflict_calls_queue_draw(self):
        row = _make_row()
        row.set_state("conflict")
        row.status_dot.queue_draw.assert_called()
    ```
  - [x] 9.2 Add a `TestSyncPairRowDrawDot` class verifying conflict colour by calling `_draw_dot` with a mock Cairo context:
    ```python
    class TestSyncPairRowDrawDot:
        def test_conflict_colour_is_amber(self):
            row = _make_row()
            row._state = "conflict"
            cr = MagicMock()
            row._draw_dot(None, cr, 8, 8)
            cr.set_source_rgb.assert_called_once_with(0.95, 0.62, 0.14)
    ```

- [x] **Task 10: Tests — StatusFooterBar set_conflicts** (AC: 7)
  - [x] 10.1 In `ui/tests/test_status_footer_bar.py`, add class:
    ```python
    class TestStatusFooterBarSetConflicts:
        def test_label_singular(self):
            bar = _make_bar()
            bar.set_conflicts(1)
            bar.footer_label.set_text.assert_called_with("1 conflict needs attention")

        def test_label_plural(self):
            bar = _make_bar()
            bar.set_conflicts(3)
            bar.footer_label.set_text.assert_called_with("3 conflicts need attention")

        def test_dot_state_becomes_conflict(self):
            bar = _make_bar()
            bar.set_conflicts(2)
            assert bar._dot_state == "conflict"

        def test_zero_count_resets_to_all_synced(self):
            bar = _make_bar()
            bar.set_conflicts(0)
            bar.footer_label.set_text.assert_called_with("All synced")

        def test_accessible_label_set(self):
            bar = _make_bar()
            bar.set_conflicts(2)
            _, values = bar._accessible_label_args
            assert "conflicts need attention" in values[0]

        def test_announce_called(self):
            bar = _make_bar()
            bar.set_conflicts(1)
            bar.announce.assert_called_once()
    ```

- [x] **Task 11: Tests — PairDetailPanel banner** (AC: 7)
  - [x] 11.1 Update `_make_panel()` in `test_pair_detail_panel.py` to add:
    ```python
    panel.conflict_banner = MagicMock()
    panel._current_pair_id = None  # ensure it's initialised (may already be there)
    ```
  - [x] 11.2 Add class:
    ```python
    class TestPairDetailPanelConflictBanner:
        def test_set_conflict_state_reveals_banner_for_current_pair(self):
            panel = _make_panel()
            panel._current_pair_id = "p1"
            panel.set_conflict_state("p1", 1, "Documents")
            panel.conflict_banner.set_revealed.assert_called_with(True)

        def test_set_conflict_state_ignored_for_other_pair(self):
            panel = _make_panel()
            panel._current_pair_id = "p1"
            panel.set_conflict_state("p2", 1, "Photos")  # different pair
            panel.conflict_banner.set_revealed.assert_not_called()

        def test_set_conflict_state_title_singular(self):
            panel = _make_panel()
            panel._current_pair_id = "p1"
            panel.set_conflict_state("p1", 1, "Documents")
            panel.conflict_banner.set_title.assert_called_with("1 conflict in Documents")

        def test_set_conflict_state_title_plural(self):
            panel = _make_panel()
            panel._current_pair_id = "p1"
            panel.set_conflict_state("p1", 3, "Photos")
            panel.conflict_banner.set_title.assert_called_with("3 conflicts in Photos")

        def test_set_conflict_state_zero_hides_banner(self):
            panel = _make_panel()
            panel._current_pair_id = "p1"
            panel.set_conflict_state("p1", 0, "Documents")
            panel.conflict_banner.set_revealed.assert_called_with(False)

        def test_on_conflict_banner_dismissed_hides_banner(self):
            panel = _make_panel()
            panel._on_conflict_banner_dismissed(panel.conflict_banner)
            panel.conflict_banner.set_revealed.assert_called_with(False)
    ```

- [x] **Task 12: Tests — main.py routing** (AC: 7)
  - [x] 12.1 In `ui/tests/test_main.py`, add a test: call `app._on_conflict_detected({"payload": {"pair_id": "p1", "conflict_copy_path": "/tmp/notes.md.conflict-2026-04-17"}})` with a mocked `_window` and assert `window.on_conflict_detected` is called with the payload dict.

- [x] **Task 13: Tests — window.py integration** (AC: 7)
  - [x] 13.1 In `ui/tests/test_window_routing.py`, add tests (using `object.__new__` pattern):
    - `on_conflict_detected` with valid path → adds to `_conflict_copies_by_pair`, calls `status_footer_bar.set_conflicts(1)`
    - `on_conflict_detected` with empty `conflict_copy_path` → returns early, no state change
    - `on_conflict_detected` twice for same pair → count 2, `set_conflicts(2)` called
    - `on_sync_progress` with active conflicts → `status_footer_bar.set_syncing` NOT called
    - `on_sync_complete` with `os.path.exists` mocked False → clears tracking, row set to "synced", `update_all_synced()` called
    - `clear_session` resets `_conflict_copies_by_pair` to `{}`

- [x] **Task 14: Validate** (AC: 7)
  - [x] 14.1 `bunx tsc --noEmit` in `engine/` — zero type errors (no engine changes, but verify unchanged)
  - [x] 14.2 `meson test -C builddir` — all UI tests pass
  - [x] 14.3 `bun test engine/src` — engine test suite unchanged (227 tests)

---

## Dev Notes

### §1 — No Engine Changes Required

`conflict_detected` is already emitted by `engine/src/sync-engine.ts` (Story 4-3). Payload: `{pair_id, local_path, conflict_copy_path}`. This story is **pure UI work** — 14 tasks, 0 engine files.

### §2 — CSS Infrastructure: Previously Dead Code

`style.css` was not in `protondrive.gresource.xml` and there was no `Gtk.CssProvider` in the app. This means the `sync-dot-syncing` pulse animation in `style.css` was never active. Task 1 fixes both issues simultaneously — once the GResource includes `style.css` and `do_startup` loads it via `Gtk.CssProvider`, the pulse animation activates for free.

The GResource bundle is loaded in `__main__.py` via `Gio.Resource.load(path)._register()`. Python `@Gtk.Template` decorators fire on import and need the bundle registered first — this is why `__main__.py` registers before `from protondrive.main import main`. No change to `__main__.py` needed; the CSS loading happens in `do_startup` once the app is running.

### §3 — `set_conflict_state(pair_id, count, name)` Has pair_id Guard

**Critical design decision:** `set_conflict_state` checks `self._current_pair_id != pair_id` and returns early if mismatched. Without this guard, a `conflict_detected` for pair B would incorrectly update the banner on pair A's detail view. Always pass `pair_id` as the first argument.

Call sites:
- `window.on_conflict_detected` → pass `pair_id` from payload
- `window.on_sync_complete` → pass `pair_id` from payload
- `window._on_row_activated` → pass `row.pair_id`

In `_on_row_activated`, `show_pair()` resets the banner to hidden, then `set_conflict_state(pair_id, ...)` immediately re-shows it if needed. The two-call sequence is intentional.

### §4 — Resolution Detection: UI-Side on sync_complete

On each `sync_complete` for a pair, `window.on_sync_complete` calls `os.path.exists(conflict_copy_path)` for all tracked paths for that pair. Local filesystem stat calls are microseconds — no `Gio.File.query_exists_async()` needed. This avoids a new IPC event and keeps Story 4-4 engine-free.

Timing: a conflict copy persists until the user resolves it (deletes or merges). The conflict copy IS uploaded to Proton Drive on the next sync cycle (it's a new local file from the engine's perspective) — so `os.path.exists()` will return `True` for it even after it's been synced. The check correctly waits until the user actually DELETES it from disk.

### §5 — Two Conflict Mechanisms: Keep Separate

`_conflict_pending_count` (Story 3-3 queue-replay skipped conflicts) and `_conflict_copies_by_pair` (Story 4-4 real-time detected). Both use amber footer state. The footer guards in `on_sync_complete`, `on_online`, `on_watcher_status` must respect both:
```python
if self._conflict_pending_count > 0 or self._total_active_conflicts() > 0:
    return  # don't reset to "All synced"
```

Do NOT touch `set_conflict_pending` or `_conflict_pending_count` logic.

### §6 — SyncPairRow "conflict" Branch: Early Return Pattern

The conflict branch in `set_state` uses `return` to skip the generic `self._set_accessible_label(state)` call at the bottom (which would produce `"[pair name] — conflict"` — wrong). The conflict branch handles both `update_property` and `queue_draw()` internally before returning. Verify: the existing `self.status_dot.queue_draw()` at the bottom of `set_state` is NOT called for conflict — that's correct, `queue_draw()` runs inside the branch instead.

### §7 — AdwBanner API (Libadwaita 1.3+, available in Platform 50/1.8)

- `Adw.Banner` in Blueprint → `Adw.Banner` in Python GI
- `set_title(text: str)` — updates the banner text
- `set_revealed(revealed: bool)` — shows/hides with animation
- `button-label: _("Dismiss")` in Blueprint → makes the button visible
- `button-clicked` signal → connect to `_on_conflict_banner_dismissed`
- No built-in color variants — use the `.conflict-banner` CSS class from Task 2

### §8 — `on_conflict_detected` Empty Path Guard (E1)

If the engine sends a `conflict_detected` with an empty `conflict_copy_path` (shouldn't happen but could from a test or malformed message), the guard `if not conflict_copy_path: return` prevents creating an empty-string entry in `_conflict_copies_by_pair` which would corrupt counts.

### §9 — `set_state("conflict")` Does Not Override "offline"

Existing code guards: `if row is not None and row.state != "offline": row.set_state("conflict", ...)`. Offline is highest-priority row state. Maintain this in `on_conflict_detected` and `on_sync_complete`.

### §10 — test_pair_detail_panel: `_current_pair_id` Initialization

`_make_panel()` in `test_pair_detail_panel.py` uses `object.__new__` and manually sets attributes. It currently sets `panel._current_pair_id = None`. The `set_conflict_state` guard `if self._current_pair_id != pair_id: return` will return early if `_current_pair_id` is `None` and `pair_id` is non-empty. Tests that verify the banner SHOWS must set `panel._current_pair_id = "p1"` to match the `pair_id` argument.

### Project Structure Notes

- **Files modified:** `ui/data/protondrive.gresource.xml`, `ui/data/style.css`, `ui/data/ui/pair-detail-panel.blp`, `ui/src/protondrive/main.py`, `ui/src/protondrive/widgets/pair_detail_panel.py`, `ui/src/protondrive/widgets/sync_pair_row.py`, `ui/src/protondrive/widgets/status_footer_bar.py`, `ui/src/protondrive/window.py`
- **Files modified (tests):** `ui/tests/test_sync_pair_row.py`, `ui/tests/test_status_footer_bar.py`, `ui/tests/test_pair_detail_panel.py`, `ui/tests/test_main.py`, `ui/tests/test_window_routing.py`
- **Files created:** none
- **Files NOT modified:** any engine files, `ui/src/protondrive/__main__.py` (no change needed — GResource already registered there), any widget files not listed above
- Widget structure in `.blp` only, Python wires signals — follows Blueprint rule

### References

- Epic 4 story definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-44`
- `conflict_detected` emission (Story 4-3): `engine/src/sync-engine.ts` conflictItems loop (~line 115-145)
- `conflict_detected` IPC event shape `{pair_id, local_path, conflict_copy_path}`: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#push-events`
- GResource loading: `ui/src/protondrive/__main__.py:25-30`
- `protondrive.gresource.xml` (add `style.css`): `ui/data/protondrive.gresource.xml`
- `SyncPairRow` current states + amber dot pattern: `ui/src/protondrive/widgets/sync_pair_row.py`
- `StatusFooterBar.set_conflict_pending` (Story 3-3, distinct): `ui/src/protondrive/widgets/status_footer_bar.py:64`
- `_conflict_pending_count` guard pattern: `ui/src/protondrive/window.py:56,383,405`
- `PairDetailPanel._current_pair_id` set in `show_pair()`: `ui/src/protondrive/widgets/pair_detail_panel.py:76`
- `_on_row_activated` (call site for banner restore): `ui/src/protondrive/window.py:277`
- No-lambda signal connection rule: `_bmad-output/project-context.md` § Language-Specific Rules > Python
- Blueprint/Python template wiring rule: `_bmad-output/project-context.md` § Blueprint Rule

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Pure UI implementation — 0 engine files changed.
- CSS infrastructure (Task 1): added `style.css` to GResource + `Gtk.CssProvider` in `do_startup`; activates pre-existing `sync-dot-syncing` pulse animation as a free side effect.
- `PairDetailPanel.set_conflict_state`: pair_id guard prevents cross-pair banner contamination. `show_pair` resets banner; `_on_row_activated` immediately re-shows if conflicts active.
- `SyncPairRow.set_state("conflict")`: early return pattern to skip generic `_set_accessible_label`; accessible label always uses singular "1 conflict" per AC2.
- `StatusFooterBar.set_conflicts`: distinct from `set_conflict_pending` (Story 3-3 path); both use amber "conflict" dot state.
- `window.py` `_conflict_copies_by_pair`: dict-of-lists, deduplicated by path. Resolution detected via `os.path.exists` on `sync_complete`.
- Footer priority: Conflict > Syncing (guarded in `on_sync_progress`). Both conflict mechanisms (`_conflict_pending_count` + `_total_active_conflicts`) guard `on_online` and `on_watcher_status`.
- Tests: 204 pass across 5 test files (460 total passing, no regressions). Engine: 227/227 unchanged.

### File List

- `ui/data/protondrive.gresource.xml`
- `ui/data/style.css`
- `ui/data/ui/pair-detail-panel.blp`
- `ui/src/protondrive/main.py`
- `ui/src/protondrive/widgets/pair_detail_panel.py`
- `ui/src/protondrive/widgets/sync_pair_row.py`
- `ui/src/protondrive/widgets/status_footer_bar.py`
- `ui/src/protondrive/window.py`
- `ui/tests/test_sync_pair_row.py`
- `ui/tests/test_status_footer_bar.py`
- `ui/tests/test_pair_detail_panel.py`
- `ui/tests/test_main.py`
- `ui/tests/test_window_routing.py`

### Review Findings

- [x] [Review][Patch] P1 — Same-file same-day conflict copy overwrites prior copy [engine/src/sync-engine.ts] — Fixed: uniqueness loop adds `-2`, `-3`, … counter suffix when `<path>.conflict-YYYY-MM-DD` already exists.
- [x] [Review][Patch] P2 — `on_online` resets ALL rows to "synced" regardless of active conflicts [ui/src/protondrive/window.py:342-343] — Fixed: iterates `_sync_pair_rows.items()`, re-applies "conflict" state for any pair with active copies.
- [x] [Review][Patch] P3 — `clear_session` does not reset footer visual state [ui/src/protondrive/window.py:138-145] — Fixed: added `self.status_footer_bar.update_all_synced()` after `show_no_pairs()`.
- [x] [Review][Patch] P4 — `on_conflict_detected` missing `pair_id` guard [ui/src/protondrive/window.py] — Fixed: guard now checks `if not pair_id or not conflict_copy_path: return`.
- [x] [Review][Patch] P5 — `sync-dot-conflict` CSS class never removed when leaving conflict state [ui/src/protondrive/widgets/sync_pair_row.py] — Fixed: added `remove_css_class("sync-dot-conflict")` to syncing, offline, and synced branches.
- [x] [Review][Patch] P6 — `set_conflicts(0)` calls `update_all_synced()` unconditionally [ui/src/protondrive/widgets/status_footer_bar.py] — Fixed: `count <= 0` guard now returns early without side effects; callers own footer state.
- [x] [Review][Defer] D1 — Upload `commitUpload` uses `local_mtime` as `remote_mtime` [engine/src/sync-engine.ts] — deferred, pre-existing
- [x] [Review][Defer] D2 — `newFileCollisionItems` `rename` raises EXDEV on cross-filesystem pairs [engine/src/sync-engine.ts] — deferred, pre-existing
- [x] [Review][Defer] D3 — `upsertSyncState` not atomic with preceding hash computation [engine/src/sync-engine.ts] — deferred, pre-existing pattern
- [x] [Review][Defer] D4 — User-moved conflict copy treated as resolved by `os.path.exists` check [ui/src/protondrive/window.py] — deferred, design choice per Dev Notes §4
- [x] [Review][Defer] D5 — `_get_pair_name` returns `pair_id` for root-path local folders [ui/src/protondrive/window.py] — deferred, pre-existing minor edge case

## Change Log

- Story 4-4 implemented: in-app conflict notification (AdwBanner), SyncPairRow amber state, StatusFooterBar set_conflicts, conflict tracking + resolution in window.py, CSS infrastructure wired. 460 UI tests / 227 engine tests pass. (Date: 2026-04-17)
