# Story 4.5: Desktop Notification for Conflicts

Status: done

## Story

As a user,
I want a desktop notification when a conflict is detected while the app is open,
so that I notice conflicts even if the app window isn't in focus.

## Acceptance Criteria

### AC1 — Desktop notification sent on conflict_detected

**Given** a `conflict_detected` event is received  
**When** the application window is open (foreground notification — no background daemon required)  
**Then** a desktop notification is sent via the GNOME notification API (`Gio.Notification` via `Gio.Application.send_notification`)  
**And** the notification body includes the filename and pair name  
**And** the notification title is `"Sync Conflict Detected"`  
**And** the notification body is `"Conflict in [pair name]: [filename]"` where `filename` is the basename of `local_path` from the payload

### AC2 — Clicking notification brings app to focus with affected pair selected

**Given** the desktop notification from AC1  
**When** the user clicks it  
**Then** the app window is brought to focus (`present()`)  
**And** the affected pair is selected in the sidebar  
**And** the pair detail panel shows for that pair (same effect as clicking the row manually)

### AC3 — Notification uses stable ID per pair to prevent stacking

**Given** multiple conflicts detected on the same pair in quick succession  
**When** notifications are sent  
**Then** each notification for the same pair replaces the previous one (using `notification_id = f"conflict-{pair_id}"`)  
**And** conflicts on different pairs each get their own notification slot

### AC4 — Unit tests

**When** running `meson test -C builddir`  
**Then** tests cover:
- `Application._on_conflict_detected` calls `_send_conflict_notification` with correct payload
- `_send_conflict_notification` calls `self.send_notification` with stable ID, correct title, correct body
- `_send_conflict_notification` with missing `local_path` in payload uses fallback body `"Conflict in [pair name]"`
- `_send_conflict_notification` with missing `pair_id` in payload returns early (no notification sent)

---

## Tasks / Subtasks

- [x] **Task 1: Add `_send_conflict_notification` to `Application` in `main.py`** (AC: 1, 2, 3)
  - [x] 1.1 In `main.py`, add a new private method `_send_conflict_notification` after `_on_conflict_detected`:
    ```python
    def _send_conflict_notification(self, payload: dict[str, Any]) -> None:
        """Send a desktop notification for a detected conflict (Story 4-5).

        Uses Gio.Notification via send_notification() — the GApplication
        integration routes through the GNOME notification system automatically.
        Notification ID is stable per pair so repeated conflicts replace the
        previous notification rather than stacking.
        """
        pair_id = payload.get("pair_id", "")
        if not pair_id:
            return

        local_path = payload.get("local_path", "")
        pair_name = self._get_pair_name_for_notification(pair_id)
        filename = os.path.basename(local_path) if local_path else ""

        notification = Gio.Notification.new("Sync Conflict Detected")
        if filename:
            body = f"Conflict in {pair_name}: {filename}"
        else:
            body = f"Conflict in {pair_name}"
        notification.set_body(body)

        # Default action: activate the app and select the affected pair.
        # "app.show-conflict-pair" action is registered in do_startup (Task 2).
        notification.set_default_action_and_target(
            "app.show-conflict-pair", GLib.Variant("s", pair_id)
        )

        # Stable ID per pair: replaces previous conflict notification for same pair.
        self.send_notification(f"conflict-{pair_id}", notification)
    ```
  - [x] 1.2 Add helper `_get_pair_name_for_notification` after `_send_conflict_notification`:
    ```python
    def _get_pair_name_for_notification(self, pair_id: str) -> str:
        """Return display name for pair_id from window state, falling back to pair_id.

        Used only for notification body text — window may not yet exist on
        startup edge cases, so always falls back gracefully.
        """
        if self._window is not None:
            row = self._window._sync_pair_rows.get(pair_id)
            if row is not None:
                return row.pair_name
            data = self._window._pairs_data.get(pair_id, {})
            local_path = data.get("local_path", "")
            if local_path:
                return os.path.basename(local_path.rstrip("/")) or pair_id
        return pair_id
    ```
    Note: `os` is already imported in `main.py`.

- [x] **Task 2: Register `show-conflict-pair` GAction in `do_startup`** (AC: 2)
  - [x] 2.1 In `do_startup`, after the CSS loading block and before the `style_manager` lines, register the action:
    ```python
    # Action invoked when user clicks the desktop conflict notification (Story 4-5).
    show_conflict_pair_action = Gio.SimpleAction.new(
        "show-conflict-pair", GLib.VariantType.new("s")
    )
    show_conflict_pair_action.connect(
        "activate", self._on_show_conflict_pair
    )
    self.add_action(show_conflict_pair_action)
    ```
  - [x] 2.2 Add the `GLib` import if not already present (it is already imported in `main.py` via `from gi.repository import Adw, Gdk, Gio, GLib, Gtk`). No change needed.

- [x] **Task 3: Add `_on_show_conflict_pair` handler to `Application`** (AC: 2)
  - [x] 3.1 Add handler after `_on_show_conflict_pair` registration area (near `_send_conflict_notification`):
    ```python
    def _on_show_conflict_pair(
        self, _action: Gio.SimpleAction, parameter: GLib.Variant
    ) -> None:
        """Bring window to focus and select the affected pair (Story 4-5 AC2).

        Called when user clicks the desktop conflict notification.
        parameter is a GLib.Variant("s", pair_id).
        """
        pair_id = parameter.get_string()

        # Ensure window exists and is visible.
        if self._window is None:
            self.activate()
        if self._window is not None:
            self._window.present()
            self._window.select_pair(pair_id)
    ```

- [x] **Task 4: Add `select_pair(pair_id)` to `MainWindow` in `window.py`** (AC: 2)
  - [x] 4.1 Add `select_pair` method to `MainWindow` (near `_on_row_activated`):
    ```python
    def select_pair(self, pair_id: str) -> None:
        """Programmatically select a pair row in the sidebar and show its detail panel.

        Called from Application._on_show_conflict_pair when the user clicks
        the desktop notification. Mirrors the effect of the user clicking the row.
        """
        row = self._sync_pair_rows.get(pair_id)
        if row is None:
            return
        self.pairs_list.select_row(row)
        pair_data = self._pairs_data.get(pair_id, {})
        self.pair_detail_panel.show_pair(pair_data)
        conflict_count = len(self._conflict_copies_by_pair.get(pair_id, []))
        self.pair_detail_panel.set_conflict_state(pair_id, conflict_count, row.pair_name)
        self.nav_split_view.set_show_content(True)
    ```
    Note: `Gtk.ListBox.select_row()` programmatically selects the row without firing `row-activated`; we handle the detail panel update here directly — same sequence as `_on_row_activated` but driven by the notification click.

- [x] **Task 5: Wire notification call into `_on_conflict_detected` in `main.py`** (AC: 1)
  - [x] 5.1 The `on_event("conflict_detected", self._on_conflict_detected)` registration was added in Story 4-4 — do NOT add it again. Update only the handler body to call `_send_conflict_notification` after routing to the window:
    ```python
    def _on_conflict_detected(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        if self._window is not None:
            self._window.on_conflict_detected(payload)
        self._send_conflict_notification(payload)
    ```
    Note: The notification is sent regardless of window focus state — `Gio.Application.send_notification` handles desktop routing.

- [x] **Task 6: Tests — `Application._send_conflict_notification`** (AC: 4)
  - [x] 6.1 In `ui/tests/test_main.py`, add a new test class. The class defines its own `_make_app` method (minimal — only `_window` and `send_notification`) alongside the existing module-level `_make_app()`. Do NOT replace the module-level function — both coexist:
    ```python
    class TestSendConflictNotification:
        def _make_app(self) -> Application:
            app = object.__new__(Application)
            app._window = None
            app.send_notification = MagicMock()
            return app

        def test_sends_notification_with_stable_id(self):
            app = self._make_app()
            app._get_pair_name_for_notification = MagicMock(return_value="Docs")
            app._send_conflict_notification({
                "pair_id": "p1",
                "local_path": "/home/user/Docs/notes.md",
            })
            call_args = app.send_notification.call_args
            assert call_args[0][0] == "conflict-p1"

        def test_notification_title_is_sync_conflict_detected(self):
            app = self._make_app()
            app._get_pair_name_for_notification = MagicMock(return_value="Docs")
            with patch("protondrive.main.Gio.Notification") as mock_notif_cls:
                mock_notif = MagicMock()
                mock_notif_cls.new.return_value = mock_notif
                app._send_conflict_notification({
                    "pair_id": "p1",
                    "local_path": "/home/user/Docs/notes.md",
                })
                mock_notif_cls.new.assert_called_once_with("Sync Conflict Detected")

        def test_body_includes_filename_and_pair_name(self):
            app = self._make_app()
            app._get_pair_name_for_notification = MagicMock(return_value="Docs")
            with patch("protondrive.main.Gio.Notification") as mock_notif_cls:
                mock_notif = MagicMock()
                mock_notif_cls.new.return_value = mock_notif
                app._send_conflict_notification({
                    "pair_id": "p1",
                    "local_path": "/home/user/Docs/notes.md",
                })
                mock_notif.set_body.assert_called_once_with("Conflict in Docs: notes.md")

        def test_body_fallback_when_no_local_path(self):
            app = self._make_app()
            app._get_pair_name_for_notification = MagicMock(return_value="Photos")
            with patch("protondrive.main.Gio.Notification") as mock_notif_cls:
                mock_notif = MagicMock()
                mock_notif_cls.new.return_value = mock_notif
                app._send_conflict_notification({"pair_id": "p1"})
                mock_notif.set_body.assert_called_once_with("Conflict in Photos")

        def test_returns_early_when_no_pair_id(self):
            app = self._make_app()
            app._send_conflict_notification({})
            app.send_notification.assert_not_called()

        def test_on_conflict_detected_calls_send_conflict_notification(self):
            app = self._make_app()
            app._window = None
            app._send_conflict_notification = MagicMock()
            app._on_conflict_detected({"payload": {"pair_id": "p1", "local_path": "/tmp/f.md"}})
            app._send_conflict_notification.assert_called_once_with(
                {"pair_id": "p1", "local_path": "/tmp/f.md"}
            )
    ```

- [x] **Task 7: Tests — `MainWindow.select_pair`** (AC: 4)
  - [x] 7.1 In `ui/tests/test_window_routing.py`, add a test class. No changes to `_make_window()` or `_make_row()` are needed — they already provide all required attributes (`_sync_pair_rows`, `_pairs_data`, `_conflict_copies_by_pair`, `pairs_list`, `pair_detail_panel`, `nav_split_view`) from Story 4-4:
    ```python
    class TestSelectPair:
        def test_select_pair_selects_row_in_listbox(self):
            win = _make_window()
            row = _make_row(pair_name="Docs")
            win._sync_pair_rows["p1"] = row
            win._pairs_data["p1"] = {"pair_id": "p1", "local_path": "/home/user/Docs"}
            win.select_pair("p1")
            win.pairs_list.select_row.assert_called_once_with(row)

        def test_select_pair_shows_pair_in_detail_panel(self):
            win = _make_window()
            row = _make_row(pair_name="Docs")
            win._sync_pair_rows["p1"] = row
            win._pairs_data["p1"] = {"pair_id": "p1"}
            win.select_pair("p1")
            win.pair_detail_panel.show_pair.assert_called_once_with({"pair_id": "p1"})

        def test_select_pair_shows_content_pane(self):
            win = _make_window()
            row = _make_row()
            win._sync_pair_rows["p1"] = row
            win.select_pair("p1")
            win.nav_split_view.set_show_content.assert_called_once_with(True)

        def test_select_pair_restores_conflict_banner(self):
            win = _make_window()
            row = _make_row(pair_name="Docs")
            win._sync_pair_rows["p1"] = row
            win._conflict_copies_by_pair["p1"] = ["/tmp/notes.md.conflict-2026-04-17"]
            win.select_pair("p1")
            win.pair_detail_panel.set_conflict_state.assert_called_once_with("p1", 1, "Docs")

        def test_select_pair_unknown_pair_id_does_nothing(self):
            win = _make_window()
            win.select_pair("unknown")
            win.pairs_list.select_row.assert_not_called()
    ```

- [x] **Task 7b: Tests — `Application._on_show_conflict_pair`** (AC: 2)
  - [x] 7b.1 In `ui/tests/test_main.py`, add a new test class using the module-level `_make_app()`:
    ```python
    class TestOnShowConflictPair:
        def test_presents_window_and_selects_pair(self):
            app = _make_app()
            app._on_show_conflict_pair(MagicMock(), GLib.Variant("s", "p1"))
            app._window.present.assert_called_once()
            app._window.select_pair.assert_called_once_with("p1")

        def test_calls_activate_when_window_is_none(self):
            app = _make_app()
            app._window = None
            app.activate = MagicMock()
            # After activate(), _window remains None in unit context — no crash expected.
            app._on_show_conflict_pair(MagicMock(), GLib.Variant("s", "p1"))
            app.activate.assert_called_once()
    ```
    Note: `GLib` is already imported in `conftest.py` GI mocks — if `GLib.Variant` is a `MagicMock`, pass a plain `MagicMock` with `.get_string.return_value = "p1"` instead:
    ```python
    param = MagicMock()
    param.get_string.return_value = "p1"
    app._on_show_conflict_pair(MagicMock(), param)
    app._window.select_pair.assert_called_once_with("p1")
    ```
    Use whichever form works with the project's conftest mock setup (check `ui/tests/conftest.py`).

- [x] **Task 8: Validate** (AC: 4)
  - [x] 8.1 `meson test -C builddir` — all UI tests pass (no regressions)
  - [x] 8.2 `bun test engine/src` — engine test suite passes (227 tests, no engine changes)
  - [ ] 8.3 Manual smoke test: trigger a conflict and verify the desktop notification appears with correct title/body. Click it and confirm the window comes to focus with the correct pair selected.

---

## Dev Notes

### §1 — `Gio.Notification` + `send_notification` — The GNOME Pattern

`Gio.Application.send_notification(id, notification)` is the standard GNOME API for desktop notifications. It routes through the `org.freedesktop.Notifications` D-Bus interface (or its portal equivalent in Flatpak). No additional imports are needed beyond `Gio` and `GLib` — both already present in `main.py`.

```python
notification = Gio.Notification.new("Title")
notification.set_body("Body text")
notification.set_default_action_and_target("app.action-name", GLib.Variant("s", "param"))
self.send_notification("stable-id", notification)
```

- **`send_notification` is a method on `Gio.Application`** (which `Adw.Application` inherits) — call as `self.send_notification(...)` from within `Application`.
- **Stable ID** (`f"conflict-{pair_id}"`) ensures that a second conflict on the same pair replaces the first notification in the notification center rather than stacking. Different pairs each get their own slot.
- **In Flatpak**, `send_notification` works via the Background Portal — `--share=network` is already declared; no additional Flatpak `finish-args` needed for notifications (notifications use `org.freedesktop.portal.Notification` which is granted by default).

### §2 — GAction for Notification Click (AC2)

The `set_default_action_and_target("app.show-conflict-pair", GLib.Variant("s", pair_id))` call registers what happens when the user clicks the notification body. GNOME activates the `"app"` action namespace, which maps to actions registered on the `Gio.Application` instance via `add_action`.

The pattern is:
1. Register `Gio.SimpleAction("show-conflict-pair", GLib.VariantType("s"))` in `do_startup`
2. Connect its `"activate"` signal to `_on_show_conflict_pair`
3. In `_on_show_conflict_pair`, call `window.present()` + `window.select_pair(pair_id)`

This is the canonical GNOME pattern for actionable notifications. The `parameter` in the handler is a `GLib.Variant("s", ...)` — extract with `parameter.get_string()`.

### §3 — `select_pair` vs `_on_row_activated`

`select_pair` in `window.py` mirrors `_on_row_activated` but is driven programmatically. It must:
1. Call `pairs_list.select_row(row)` — updates the GTK selection highlight in the sidebar
2. Call `pair_detail_panel.show_pair(pair_data)` — resets detail pane (clears banner, loads pair info)
3. Call `pair_detail_panel.set_conflict_state(pair_id, count, name)` — re-shows banner if pair has active conflicts
4. Call `nav_split_view.set_show_content(True)` — ensures detail pane is visible on narrow screens

`pairs_list.select_row(row)` does NOT fire `row-activated` signal — it just highlights the row. We handle the detail panel update inline in `select_pair`. This is correct GTK4 behavior.

### §4 — `_get_pair_name_for_notification` lives in `Application`, not `MainWindow`

The notification is sent at the `Application` level (before or independently of the window). `Application` already has `_window` reference and can access `_window._sync_pair_rows`. The `_get_pair_name` helper in `window.py` (Story 4-4) serves window-internal routing; the one in `Application` serves notification text. They share the same logic but are separate methods — no cross-import needed.

### §5 — No New IPC Events Needed

Story 4-3 already emits `conflict_detected` with `{pair_id, local_path, conflict_copy_path}`. `local_path` is the absolute path of the conflicting local file — `os.path.basename(local_path)` gives the filename. No engine changes required.

### §6 — Story is Pure UI Work

**Files to modify:** `ui/src/protondrive/main.py`, `ui/src/protondrive/window.py`  
**Files to modify (tests):** `ui/tests/test_main.py`, `ui/tests/test_window_routing.py`  
**Files created:** none  
**Engine files:** none

### §7 — No Background Daemon / Portal Concerns

Epic definition states "foreground notification — no background daemon required." `Gio.Application.send_notification` works even when the window is open — the notification goes to the GNOME notification center regardless. This story does NOT implement any background autostart or persistent background process.

### §8 — Test Pattern for `Gio.Notification.new`

Since `Gio.Notification` is a GObject type, testing its interactions requires patching at the import level in `main.py`. The correct patch target is `"protondrive.main.Gio.Notification"`. Use `MagicMock()` for the returned instance and check method calls (`set_body`, `set_default_action_and_target`).

For `send_notification` itself — it's a method on `Gio.Application`, called as `self.send_notification(id, notif)`. In tests using `object.__new__`, mock it directly: `app.send_notification = MagicMock()`.

### §9 — Import Requirements

`main.py` already imports: `os`, `Gio`, `GLib`. No new imports needed.

### §10 — Story 4-4 Dev Notes Still Apply

The `_conflict_copies_by_pair` dict and `on_conflict_detected` routing established in Story 4-4 remain unchanged. This story adds a side effect (notification) to the existing `_on_conflict_detected` handler in `main.py` — it calls both `window.on_conflict_detected(payload)` (existing) and `_send_conflict_notification(payload)` (new).

### Project Structure Notes

- `Application` in `main.py` owns notification sending — it has the `Gio.Application` base class required for `send_notification`.
- `MainWindow.select_pair` is new — add it near `_on_row_activated` (line ~324) to keep pair-navigation methods together.
- All widget structure rules apply: no new `.blp` files needed for this story (notifications are non-widget OS-level UI).
- No Blueprint changes — this story adds no new GTK widget structure.

### References

- Epic 4 story definition: `_bmad-output/planning-artifacts/epics/epic-4-conflict-detection-resolution.md#story-45`
- `Gio.Notification` + `send_notification` GNOME pattern: GNOME Developer Docs (Gio.Application)
- `conflict_detected` payload `{pair_id, local_path, conflict_copy_path}`: Story 4-3 impl
- `_on_conflict_detected` in `main.py` (existing): `ui/src/protondrive/main.py:211`
- Story 4-4 `_conflict_copies_by_pair` dict: `ui/src/protondrive/window.py:58-60`
- Story 4-4 `_get_pair_name` helper (window-internal): `ui/src/protondrive/window.py`
- `_on_row_activated` (pair selection pattern to mirror): `ui/src/protondrive/window.py:324`
- `pairs_list.select_row` (GTK4 ListBox programmatic selection): standard GTK4 API
- `GLib.Variant("s", ...)` for GAction parameter: standard GLib pattern
- `test_main.py` test structure (existing): `ui/tests/test_main.py`
- `test_window_routing.py` `_make_window` helper: `ui/tests/test_window_routing.py:15`
- Flatpak notification portal: `org.freedesktop.portal.Notification` (granted by default — no new `finish-args`)

---

## Review Findings

- [x] [Review][Defer] Post-activation pair selection lost if window destroyed before notification click [main.py] — deferred, GTK activation is async; if window is None and `activate()` is called, the subsequent `if self._window is not None` guard fires before the new window is ready, so `select_pair` is skipped. Edge case: user closes window, then clicks an already-queued desktop notification. Window re-opens but pair is not pre-selected. Mirrors canonical GTK two-check pattern; no fix in this story's scope.
- [x] [Review][Defer] Silent early return on missing pair_id in `_send_conflict_notification` [main.py] — deferred, pre-existing; matches existing codebase style (no debug logging throughout); complicates silent notification failures in production but not a bug.
- [x] [Review][Defer] `set_conflict_state(pair_id, 0, name)` called in `select_pair` when pair has no active conflicts [window.py] — deferred, mirrors `_on_row_activated` identical code path; relied on by Story 4-4 tests; zero-conflict banner hide behavior not explicitly tested for the notification-click flow specifically.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

(none)

### Completion Notes List

- **Task 1–3, 5**: Added `_send_conflict_notification`, `_get_pair_name_for_notification`, and `_on_show_conflict_pair` to `Application` in `main.py`. `_on_conflict_detected` now calls `_send_conflict_notification(payload)` after forwarding to window. GAction `show-conflict-pair` registered in `do_startup`.
- **Task 4**: Added `select_pair(pair_id)` to `MainWindow` in `window.py` — mirrors `_on_row_activated` but driven programmatically; calls `pairs_list.select_row`, `show_pair`, `set_conflict_state`, `set_show_content`.
- **Task 6**: `TestSendConflictNotification` (6 tests) added to `test_main.py` — covers stable ID, title, body with filename, body fallback, early-return on missing pair_id, and `_on_conflict_detected` delegation.
- **Task 7**: `TestSelectPair` (5 tests) added to `test_window_routing.py` — covers listbox selection, detail panel, content pane, conflict banner restore, unknown pair noop.
- **Task 7b**: `TestOnShowConflictPair` (2 tests) added to `test_main.py` — covers present+select flow and activate-when-window-is-None.
- **Task 8**: 503 UI tests pass, 227 engine tests pass, 0 regressions. Manual smoke test deferred to user (requires live Proton session).

### File List

- `ui/src/protondrive/main.py`
- `ui/src/protondrive/window.py`
- `ui/tests/test_main.py`
- `ui/tests/test_window_routing.py`
- `_bmad-output/implementation-artifacts/4-5-desktop-notification-for-conflicts.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Change Log

- 2026-04-18: Story 4-5 implemented — desktop notification for conflicts via `Gio.Notification`, `show-conflict-pair` GAction, `MainWindow.select_pair`. 13 new tests added. 503 UI + 227 engine tests pass.
