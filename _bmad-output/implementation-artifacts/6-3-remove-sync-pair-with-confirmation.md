# Story 6.3: Remove Sync Pair with Confirmation

Status: ready-for-dev

## Story

As a user,
I want to remove a sync pair with a clear confirmation that no files will be deleted,
so that I can reorganize my sync setup without fear of data loss.

## Acceptance Criteria

1. **Given** the user clicks "Remove pair" in the detail panel **When** the confirmation dialog appears **Then** it is an `AdwAlertDialog` with heading "Stop syncing this folder pair?" and body: "Local files in `[local path]` will not be affected. Remote files in `ProtonDrive/[remote path]` will not be affected. Sync will simply stop." **And** two buttons: "Cancel" (default/escape, suggested-action style) and "Remove" (destructive-action style)

2. **Given** the user confirms removal **When** the removal is processed **Then** the `remove_pair` IPC command is sent with `{pair_id}` **And** the pair is removed from SQLite and `config.yaml` **And** local files remain untouched (FR11) **And** remote files remain untouched **And** the pair disappears from the sidebar

3. **Given** the "Remove pair" button **When** inspecting its position relative to other buttons **Then** it is never adjacent to a primary (suggested-action) button — always separated by distance or a divider (UX-DR17)

4. **Given** only one pair exists and is removed **When** the sidebar is empty **Then** the detail area shows the `AdwStatusPage` empty state: "Add your first sync pair to start syncing" (already implemented in `show_no_pairs()` — no new code needed)

## Precondition

**No dependency on 6-1 or 6-2.** The "Remove pair" button lives in the `PairDetailPanel` (detail area), which is fully functional before 6-1 adds the sidebar `add_pair_button`. The two features modify different files and can be implemented independently.

## Tasks / Subtasks

- [ ] Task 1 — Engine: add `removeFromConfigYaml` to config.ts (AC: 2)
  - [ ] 1.1 — In `engine/src/config.ts`, add the following export immediately after `writeConfigYaml`:
    ```typescript
    export function removeFromConfigYaml(pairId: string): void {
      const configPath = getConfigPath();
      const existing = readConfigYaml();
      existing.pairs = existing.pairs.filter((p) => p.pair_id !== pairId);
      const tmpPath = configPath + ".tmp";
      writeFileSync(tmpPath, yaml.dump(existing), "utf8");
      renameSync(tmpPath, configPath);
    }
    ```
  - [ ] 1.2 — Uses the same atomic write pattern as `writeConfigYaml` (write-to-tmp then rename). No new imports needed — `writeFileSync`, `renameSync`, `getConfigPath`, `readConfigYaml`, and `yaml` are already in scope.

- [ ] Task 2 — Engine: add `remove_pair` import and handler (AC: 2)
  - [ ] 2.1 — In `engine/src/main.ts`, add `removeFromConfigYaml` to the existing import from `"./config.js"` (line ~131):
    ```typescript
    import { writeConfigYaml, removeFromConfigYaml } from "./config.js";
    ```
  - [ ] 2.2 — In `engine/src/main.ts`, add the `remove_pair` handler block immediately after the closing `}` of the `add_pair` block (currently ending near line 577), before the `get_status` block. Insert:
    ```typescript
    if (command.type === "remove_pair") {
      if (!stateDb) {
        return {
          type: "remove_pair_result",
          id: command.id,
          payload: { error: "engine_not_ready" },
        };
      }

      const pairId = command.payload?.["pair_id"] as string | undefined;
      if (!pairId) {
        return {
          type: "remove_pair_result",
          id: command.id,
          payload: { error: "invalid_payload" },
        };
      }

      const existingPairs = stateDb.listPairs();
      if (!existingPairs.some((p) => p.pair_id === pairId)) {
        return {
          type: "remove_pair_result",
          id: command.id,
          payload: { error: "pair_not_found" },
        };
      }

      try {
        stateDb.deletePair(pairId);
      } catch {
        return {
          type: "remove_pair_result",
          id: command.id,
          payload: { error: "db_write_failed" },
        };
      }

      try {
        removeFromConfigYaml(pairId);
      } catch {
        return {
          type: "remove_pair_result",
          id: command.id,
          payload: { error: "config_write_failed" },
        };
      }

      // Restart FileWatcher with remaining pairs (stops watching the removed dir).
      if (driveClient) {
        fileWatcher?.stop();
        fileWatcher = new FileWatcher(
          stateDb.listPairs(),
          async (_pId) => {
            void syncEngine?.drainQueue();
          },
          (e) => server.emitEvent(e),
          undefined,
          undefined,
          () => networkMonitor?.isCurrentlyOnline ?? true,
          (e) => stateDb!.enqueue(e),
        );
        void fileWatcher.initialize();
      }

      return {
        type: "remove_pair_result",
        id: command.id,
        payload: {},
      };
    }
    ```
  - [ ] 2.3 — Note: `stateDb.deletePair(pairId)` cascades to `sync_state` and `change_queue` via `ON DELETE CASCADE` (schema migration v1, v2). No manual cleanup of those tables needed.
  - [ ] 2.4 — Note: if config_write_failed, the pair is already deleted from DB. This is acceptable — on next launch, the engine rebuilds from config.yaml (cold-start: pair absent from YAML = not synced). The UI will show zero pairs on the next `get_status`. This trade-off is consistent with the engine's existing `add_pair` rollback approach (best-effort).

- [ ] Task 3 — Blueprint: add "Remove pair" button to `pair-detail-panel.blp` (AC: 1, 3)
  - [ ] 3.1 — In `ui/data/ui/pair-detail-panel.blp`, inside the `detail` StackPage's `detail_box` Gtk.Box, add the following **after** the `progress_slot` Gtk.Box (at the very end of `detail_box`'s children):
    ```
    Gtk.Box remove_pair_row {
      orientation: horizontal;
      halign: end;
      margin-top: 24;
      margin-bottom: 8;

      Gtk.Button remove_pair_button {
        label: _("Remove pair");
        styles ["destructive-action"]
      }
    }
    ```
  - [ ] 3.2 — `margin-top: 24` provides the visual separation from sync stats required by UX-DR17 (no suggested-action buttons in the detail panel to be adjacent to, but separation ensures the destructive action reads as distinct from the informational content above it).
  - [ ] 3.3 — `halign: end` on the outer `Gtk.Box` keeps the button right-aligned to match the UX wireframe (`[Remove pair]` bottom-right of detail panel).
  - [ ] 3.4 — Blueprint IDs for Template.Child: `remove_pair_button` (Python auto-converts kebab `remove-pair-button` but the id is already snake_case — use `remove_pair_button` directly as the Blueprint id).

- [ ] Task 4 — Python: update `PairDetailPanel` widget (AC: 1, 2)
  - [ ] 4.1 — In `ui/src/protondrive/widgets/pair_detail_panel.py`, add to `__gsignals__`:
    ```python
    __gsignals__ = {
        "setup-requested": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "view-conflict-log": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "remove-pair-requested": (GObject.SignalFlags.RUN_FIRST, None, (str,)),  # emits pair_id
    }
    ```
  - [ ] 4.2 — Add Template.Child declarations for new widget (alongside existing declarations):
    ```python
    remove_pair_button: Gtk.Button = Gtk.Template.Child()
    ```
  - [ ] 4.3 — In `__init__`, wire the button signal (no lambda — explicit method reference):
    ```python
    self.remove_pair_button.connect("clicked", self._on_remove_pair_clicked)
    ```
  - [ ] 4.4 — Add method (after `_on_conflict_log_back`):
    ```python
    def _on_remove_pair_clicked(self, _button: Gtk.Button) -> None:
        if self._current_pair_id is not None:
            self.emit("remove-pair-requested", self._current_pair_id)
    ```
  - [ ] 4.5 — Type hints on `_on_remove_pair_clicked` required (`_button: Gtk.Button`) — matches project style from `project-context.md`.
  - [ ] 4.6 — The `_current_pair_id` guard prevents emitting a signal with `None` if somehow the button is clicked before a pair is shown (defensive; in practice the button is only visible when the "detail" stack page is active, which requires `show_pair()` to have been called).

- [ ] Task 5 — Python: update `window.py` — confirmation dialog and IPC wiring (AC: 1, 2, 4)
  - [ ] 5.1 — In `window.py`, add `_pending_remove_pair_id: str | None = None` to `__init__` (after existing `_row_activated_connected`):
    ```python
    self._pending_remove_pair_id: str | None = None
    ```
  - [ ] 5.2 — In `window.py.__init__`, connect the new signal from `pair_detail_panel` (after the existing signal connections):
    ```python
    self.pair_detail_panel.connect(
        "remove-pair-requested", self._on_remove_pair_requested
    )
    ```
  - [ ] 5.3 — In `window.py.clear_session()`, reset pending state (after existing resets):
    ```python
    self._pending_remove_pair_id = None
    ```
  - [ ] 5.4 — Add `_on_remove_pair_requested` method to `window.py` (place after `_on_view_conflict_log`). Use plain string literals for dialog button labels — window.py has no `_()` i18n function; Blueprint handles all translatable strings:
    ```python
    def _on_remove_pair_requested(self, _panel: object, pair_id: str) -> None:
        pair_data = self._pairs_data.get(pair_id, {})
        local_path = pair_data.get("local_path", pair_id)
        remote_path = pair_data.get("remote_path", "").lstrip("/")
        body = (
            f"Local files in {local_path} will not be affected. "
            f"Remote files in ProtonDrive/{remote_path} will not be affected. "
            "Sync will simply stop."
        )
        self._pending_remove_pair_id = pair_id
        dialog = Adw.AlertDialog(
            heading="Stop syncing this folder pair?",
            body=body,
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("remove", "Remove")
        dialog.set_response_appearance("cancel", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_response_appearance("remove", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        dialog.connect("response", self._on_remove_pair_response)
        dialog.present(self)
    ```
  - [ ] 5.5 — Add `_on_remove_pair_response` method to `window.py` (place immediately after `_on_remove_pair_requested`):
    ```python
    def _on_remove_pair_response(self, _dialog: Adw.AlertDialog, response: str) -> None:
        pair_id = self._pending_remove_pair_id
        self._pending_remove_pair_id = None
        if response != "remove" or pair_id is None:
            return
        app = self.get_application()
        if app is not None and hasattr(app, "_on_remove_pair_confirmed"):
            app._on_remove_pair_confirmed(pair_id)
    ```
  - [ ] 5.6 — Add `on_pair_removed` method to `window.py` — cleans up per-pair tracking before `populate_pairs` runs (place after `select_pair`):
    ```python
    def on_pair_removed(self, pair_id: str) -> None:
        self._error_pair_ids.discard(pair_id)
        self._error_pending_cycle.discard(pair_id)
        self._error_messages.pop(pair_id, None)
        self._conflict_copies_by_pair.pop(pair_id, None)
    ```

- [ ] Task 6 — Python: update `main.py` — IPC handler for `remove_pair` (AC: 2, 4)
  - [ ] 6.1 — In `ui/src/protondrive/main.py`, add `_on_remove_pair_confirmed` immediately after `_on_wizard_complete` (line ~425):
    ```python
    def _on_remove_pair_confirmed(self, pair_id: str) -> None:
        if self._engine is not None:
            self._engine.send_command_with_response(
                {"type": "remove_pair", "payload": {"pair_id": pair_id}},
                lambda payload: self._on_remove_pair_result(payload, pair_id),
            )
    ```
  - [ ] 6.2 — Add `_on_remove_pair_result` immediately after `_on_remove_pair_confirmed`:
    ```python
    def _on_remove_pair_result(self, payload: dict[str, Any], pair_id: str) -> None:
        if payload.get("error"):
            if self._window is not None:
                toast = Adw.Toast.new("Failed to remove sync pair")
                toast.set_timeout(3)
                self._window.toast_overlay.add_toast(toast)
            return
        if self._window is not None:
            self._window.on_pair_removed(pair_id)
        if self._engine is not None:
            self._engine.send_command_with_response(
                {"type": "get_status"}, self._on_get_status_result
            )
    ```
  - [ ] 6.3 — `Adw` is already imported in main.py (check line 1 imports). If not, add `from gi.repository import Adw` to the import block.
  - [ ] 6.4 — The lambda `lambda payload: self._on_remove_pair_result(payload, pair_id)` captures `pair_id`. This is an IPC response callback (not a GTK signal connection), so the lambda rule does NOT apply — this matches the existing `_on_add_pair_complete` lambda pattern in Story 6-1.
  - [ ] 6.5 — `_on_get_status_result` is called as a direct method reference (no pair_id needed) — after removal we just want sidebar refresh, no auto-selection. This is the same as the `_on_wizard_complete` `get_status` call pattern.

- [ ] Task 7 — Engine tests: `remove_pair` command (AC: 2)
  - [ ] 7.1 — In `engine/src/main.test.ts`, add a new `describe("remove_pair command", ...)` block **after** the closing `});` of the `describe("add_pair command")` block (line ~371), **before** the `describe("unlock_keys command")` block. Use the same `tmpDir`/`XDG_CONFIG_HOME` pattern as `add_pair`:

    ```typescript
    // ---------------------------------------------------------------------------
    // remove_pair command (Story 6.3)
    // ---------------------------------------------------------------------------
    describe("remove_pair command", () => {
      let tmpDir: string;
      let origXdg: string | undefined;
      let removePairServer: IpcServer;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remove-pair-test-"));
        origXdg = process.env["XDG_CONFIG_HOME"];
        process.env["XDG_CONFIG_HOME"] = tmpDir;
        _setStateDbForTests(new StateDb(":memory:"));
        removePairServer = new IpcServer(tmpSocketPath(), handleCommand);
        removePairServer.emitEvent = () => {};
        _setServerForTests(removePairServer);
      });

      afterEach(() => {
        _setDriveClientForTests(null);
        _setStateDbForTests(undefined);
        if (origXdg === undefined) {
          delete process.env["XDG_CONFIG_HOME"];
        } else {
          process.env["XDG_CONFIG_HOME"] = origXdg;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it("success: existing pair → removed from DB and config, returns {}", async () => {
        const db = new StateDb(":memory:");
        _setStateDbForTests(db);
        db.insertPair({
          pair_id: "pair-to-remove",
          local_path: "/home/user/Docs",
          remote_path: "/Documents",
          remote_id: "",
          created_at: new Date().toISOString(),
          last_synced_at: null,
        });
        // Pre-populate config.yaml so removeFromConfigYaml has something to remove.
        writeConfigYaml("pair-to-remove", "/home/user/Docs", "/Documents");

        const response = await handleCommand({
          type: "remove_pair",
          id: "rp-1",
          payload: { pair_id: "pair-to-remove" },
        });

        expect(response!.type).toBe("remove_pair_result");
        expect(response!.id).toBe("rp-1");
        expect(response!.payload).toEqual({});
        // Verify pair is gone from DB.
        expect(db.listPairs().some((p) => p.pair_id === "pair-to-remove")).toBe(false);
        // Verify config.yaml was also updated (AC2 — removeFromConfigYaml ran).
        const remaining = readConfigYaml();
        expect(remaining.pairs.some((p) => p.pair_id === "pair-to-remove")).toBe(false);
      });

      it("stateDb undefined → engine_not_ready", async () => {
        _setStateDbForTests(undefined);
        const response = await handleCommand({
          type: "remove_pair",
          id: "rp-2",
          payload: { pair_id: "any-id" },
        });
        expect(response!.payload).toEqual({ error: "engine_not_ready" });
      });

      it("missing pair_id payload → invalid_payload", async () => {
        const response = await handleCommand({
          type: "remove_pair",
          id: "rp-3",
          payload: {},
        });
        expect(response!.type).toBe("remove_pair_result");
        expect(response!.payload).toEqual({ error: "invalid_payload" });
      });

      it("non-existent pair_id → pair_not_found", async () => {
        const response = await handleCommand({
          type: "remove_pair",
          id: "rp-4",
          payload: { pair_id: "does-not-exist" },
        });
        expect(response!.type).toBe("remove_pair_result");
        expect(response!.payload).toEqual({ error: "pair_not_found" });
      });

      it("FileWatcher restarted with remaining pairs after removal", async () => {
        const db = new StateDb(":memory:");
        _setStateDbForTests(db);
        // Insert two pairs; remove one; watcher should restart with remaining one.
        db.insertPair({
          pair_id: "pair-keep",
          local_path: "/home/user/Keep",
          remote_path: "/Keep",
          remote_id: "",
          created_at: new Date().toISOString(),
          last_synced_at: null,
        });
        db.insertPair({
          pair_id: "pair-remove",
          local_path: "/home/user/Remove",
          remote_path: "/Remove",
          remote_id: "",
          created_at: new Date().toISOString(),
          last_synced_at: null,
        });
        writeConfigYaml("pair-keep", "/home/user/Keep", "/Keep");
        writeConfigYaml("pair-remove", "/home/user/Remove", "/Remove");

        const mockClient = {} as unknown as DriveClient;
        _setDriveClientForTests(mockClient);

        const fwStops: string[] = [];
        const mockFw = { stop: () => { fwStops.push("stopped"); }, initialize: async () => {} } as unknown as FileWatcher;
        _setFileWatcherForTests(mockFw);

        await handleCommand({
          type: "remove_pair",
          id: "rp-5",
          payload: { pair_id: "pair-remove" },
        });

        // FileWatcher was stopped and re-created (we can verify the stop was called).
        expect(fwStops.length).toBe(1);
        // Only the kept pair remains in DB.
        expect(db.listPairs().length).toBe(1);
        expect(db.listPairs()[0]!.pair_id).toBe("pair-keep");
      });
    });
    ```

  - [ ] 7.2 — `writeConfigYaml` and `readConfigYaml` are NOT yet imported in `main.test.ts`. Add a new import line after the existing `"./main.js"` import block:
    ```typescript
    import { writeConfigYaml, readConfigYaml } from "./config.js";
    ```
  - [ ] 7.3 — `_setFileWatcherForTests` is NOT imported in `main.test.ts` (confirmed: current imports at line 15-23 only include `handleCommand`, `_setDriveClientForTests`, `_setStateDbForTests`, `_setServerForTests`, `createNetworkMonitorCallback`, `cleanTmpFilesInDir`, `runCrashRecovery`). Add it to the existing import from `"./main.js"`:
    ```typescript
    import {
      handleCommand,
      _setDriveClientForTests,
      _setStateDbForTests,
      _setServerForTests,
      _setFileWatcherForTests,
      createNetworkMonitorCallback,
      cleanTmpFilesInDir,
      runCrashRecovery,
    } from "./main.js";
    ```
  - [ ] 7.4 — Test rp-5 uses `as unknown as FileWatcher` type cast. Add `FileWatcher` to imports from `"./watcher.js"`:
    ```typescript
    import { FileWatcher } from "./watcher.js";
    ```
    (Add alongside existing test file imports at the top of `main.test.ts`.)

- [ ] Task 8 — UI tests: `PairDetailPanel` remove button (AC: 1)
  - [ ] 8.1 — In `ui/tests/test_pair_detail_panel.py`, add `remove_pair_button = MagicMock()` to `_make_panel()`:
    ```python
    panel.remove_pair_button = MagicMock()
    ```
  - [ ] 8.2 — Add the following tests after the existing `TestShowPair` or `TestSetConflictState` class:

    ```python
    class TestRemovePairButton:
        def test_clicked_emits_remove_pair_requested_with_current_pair_id(self):
            panel = _make_panel()
            panel._current_pair_id = "pair-abc"
            emitted = []
            panel.emit = lambda signal, *args: emitted.append((signal, args))
            from gi.repository import Gtk
            panel._on_remove_pair_clicked(MagicMock(spec=Gtk.Button))
            assert len(emitted) == 1
            assert emitted[0][0] == "remove-pair-requested"
            assert emitted[0][1] == ("pair-abc",)

        def test_clicked_with_no_current_pair_does_not_emit(self):
            panel = _make_panel()
            panel._current_pair_id = None
            emitted = []
            panel.emit = lambda signal, *args: emitted.append((signal, args))
            from gi.repository import Gtk
            panel._on_remove_pair_clicked(MagicMock(spec=Gtk.Button))
            assert len(emitted) == 0
    ```

  - [ ] 8.3 — Note: `panel.emit` is overridden to a plain lambda that captures calls. This avoids triggering real GObject signal infrastructure. Pattern matches existing tests in `test_pair_detail_panel.py`.

- [ ] Task 9 — UI tests: `window.py` remove pair flow (AC: 1, 2)
  - [ ] 9.1 — In `ui/tests/test_window_routing.py`, add `_pending_remove_pair_id = None` to `_make_window()`:
    ```python
    win._pending_remove_pair_id = None
    ```
  - [ ] 9.2 — Add the following test class to `test_window_routing.py`:

    ```python
    class TestRemovePairFlow:
        def test_on_remove_pair_requested_stores_pending_id_and_shows_dialog(self):
            win = _make_window()
            win._pairs_data = {
                "pair-x": {"local_path": "/home/user/Docs", "remote_path": "/Documents"},
            }
            with patch("protondrive.window.Adw") as mock_adw:
                mock_dialog = MagicMock()
                mock_adw.AlertDialog.return_value = mock_dialog
                win._on_remove_pair_requested(MagicMock(), "pair-x")
            assert win._pending_remove_pair_id == "pair-x"
            mock_dialog.present.assert_called_once_with(win)

        def test_on_remove_pair_response_cancel_does_not_call_app(self):
            win = _make_window()
            win._pending_remove_pair_id = "pair-x"
            app = MagicMock()
            win.get_application = MagicMock(return_value=app)
            win._on_remove_pair_response(MagicMock(), "cancel")
            assert win._pending_remove_pair_id is None
            app._on_remove_pair_confirmed.assert_not_called()

        def test_on_remove_pair_response_remove_calls_app_confirmed(self):
            win = _make_window()
            win._pending_remove_pair_id = "pair-x"
            app = MagicMock()
            app._on_remove_pair_confirmed = MagicMock()
            win.get_application = MagicMock(return_value=app)
            win._on_remove_pair_response(MagicMock(), "remove")
            assert win._pending_remove_pair_id is None
            app._on_remove_pair_confirmed.assert_called_once_with("pair-x")

        def test_on_pair_removed_clears_tracking_state(self):
            win = _make_window()
            win._error_pair_ids = {"pair-x", "pair-y"}
            win._error_pending_cycle = {"pair-x"}
            win._error_messages = {"pair-x": "DISK_FULL", "pair-y": "PERMISSION_DENIED"}
            win._conflict_copies_by_pair = {"pair-x": ["/tmp/a.conflict-2026-01-01"]}
            win.on_pair_removed("pair-x")
            assert "pair-x" not in win._error_pair_ids
            assert "pair-y" in win._error_pair_ids  # other pair unaffected
            assert "pair-x" not in win._error_messages
            assert "pair-x" not in win._conflict_copies_by_pair
    ```

- [ ] Task 10 — Full test suite validation (AC: all)
  - [ ] 10.1 — `cd engine && bun test` — all tests green, exit 0
  - [ ] 10.2 — `distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"` — must exit 0 (Blueprint compiles successfully with new `remove_pair_button` ID)
  - [ ] 10.3 — `.venv/bin/pytest ui/tests/ -v` from project root — all tests green, exit 0

## Dev Notes

### Engine: `remove_pair` Command Position in main.ts

Insert the new `remove_pair` block **between** the `add_pair` block (ends ~line 577) and the `get_status` block (starts ~line 579). The `handleCommand` function is a chain of `if` blocks — order matters only for readability, not correctness. Grouping related pair-management commands (add / remove) together before the status query is the natural order.

### `removeFromConfigYaml` Atomicity

Identical atomic write pattern to `writeConfigYaml`: write YAML to `.tmp` then `rename()` (POSIX atomic on same filesystem). If the process crashes between write and rename, `.tmp` is an orphan — harmless on next run. `readConfigYaml` ignores missing files gracefully.

No `mkdirSync` needed in `removeFromConfigYaml` — if the config file doesn't exist, `readConfigYaml()` returns `{ pairs: [] }` and `filter()` on an empty array is a no-op. The write creates the file. In practice, `removeFromConfigYaml` is only called after a successful `add_pair`, so the directory always exists.

### Engine: DB Cascade on `deletePair`

`stateDb.deletePair(pairId)` executes `DELETE FROM sync_pair WHERE pair_id = ?`. The schema has `sync_state` with `ON DELETE CASCADE` and `change_queue` with `ON DELETE CASCADE` (added in migration v2). All related rows in `sync_state`, `change_queue`, and the dead-letter-like structures are automatically removed. No manual cleanup needed.

### FileWatcher Restart Pattern

Identical pattern to `add_pair` — stop current watcher, construct a new one with `stateDb.listPairs()` (which no longer includes the removed pair), and call `fileWatcher.initialize()`. This is the canonical way to update which directories are watched. The `syncEngine` does not need explicit notification — its next `startSyncAll()` or `drainQueue()` call will only process pairs present in `stateDb`.

The FileWatcher restart only runs when `driveClient !== null` (same guard as `add_pair`). If the engine is in an unauthenticated state (driveClient null), the watcher is not running anyway.

### `AdwAlertDialog` — Python API

`Adw.AlertDialog` (Libadwaita 1.5+, available in 1.8 GNOME 50 runtime). Created programmatically in Python because the body text is dynamic (contains local_path and remote_path):

```python
dialog = Adw.AlertDialog(
    heading="Stop syncing this folder pair?",
    body=body,  # dynamic string with paths
)
dialog.add_response("cancel", "Cancel")
dialog.add_response("remove", "Remove")
dialog.set_response_appearance("cancel", Adw.ResponseAppearance.SUGGESTED)
dialog.set_response_appearance("remove", Adw.ResponseAppearance.DESTRUCTIVE)
dialog.set_default_response("cancel")
dialog.set_close_response("cancel")
```

`Adw.ResponseAppearance.SUGGESTED` = blue "safe" button. `Adw.ResponseAppearance.DESTRUCTIVE` = red "dangerous" button. `set_default_response("cancel")` means Enter key activates Cancel. `set_close_response("cancel")` means Escape dismisses as Cancel.

This is the same approach used for `Adw.AboutDialog` in `window.py.show_about()` — programmatic creation is appropriate when dialog content is dynamic.

**Blueprint rule compliance:** `AdwAlertDialog` is an atomic dialog helper API, not a widget tree. Creating it in Python does not violate the "no widget tree construction in Python" rule. The rule targets `Gtk.Box()`, `Gtk.Label()` etc. — building composite layouts in Python instead of Blueprint. A simple dialog created with constructor + response methods is not a widget tree.

### `_pending_remove_pair_id` Pattern in window.py

Stores the pair_id of the pair being removed while the confirmation dialog is on screen. Set to `None` immediately in `_on_remove_pair_response` (regardless of Cancel or Remove) to prevent reuse. The GTK main loop is single-threaded, so there's no race condition: only one `AdwAlertDialog` can be pending at a time for this action.

If the user opens two remove dialogs simultaneously (impossible in practice — you can't click "Remove pair" while a dialog is blocking the window), the second would overwrite `_pending_remove_pair_id`. This edge case is not worth defending against.

### Remote Path Display in Dialog Body

The body text: `f"Remote files in ProtonDrive/{remote_path} will not be affected."`

`remote_path` from `_pairs_data` is the raw path stored by the engine (e.g., `/Documents` or `Documents`). We call `.lstrip("/")` to normalize (strip leading slash), then prepend `ProtonDrive/`. So:
- `/Documents` → `ProtonDrive/Documents`
- `Documents` → `ProtonDrive/Documents`
- `/` → `ProtonDrive/` (edge case: root remote path)

### No Blueprint Change for Dialog

The `AdwAlertDialog` lives only during the `_on_remove_pair_requested` call — it's presented and then GC'd when the user responds. No new Blueprint file, no new GResource entry, no new Meson build target.

### empty State (AC 4)

The empty state is **already implemented**. After successful removal:
1. `_on_remove_pair_result` calls `window.on_pair_removed(pair_id)` (cleanup)
2. Then sends `get_status` → `_on_get_status_result` → `populate_pairs([])`
3. `populate_pairs([])` calls `pair_detail_panel.show_no_pairs()` (line ~412 in window.py)
4. `show_no_pairs()` sets the stack page to "no-pairs"
5. The "no-pairs" Blueprint page already has `AdwStatusPage` with description "Add your first sync pair to start syncing"

Zero new code needed for AC 4.

### `on_pair_removed` vs `clear_session` 

`clear_session` clears ALL pairs' state (e.g., on logout). `on_pair_removed` clears only the removed pair's state. Both call `discard`/`pop` which are no-ops if the pair_id isn't in the dict — safe to call for any pair_id.

`_conflict_log_entries` is intentionally NOT cleared in `on_pair_removed`. Conflict entries are historical records; clearing them on removal would make the log dishonest. If the user removes a pair and re-adds it, they should still see past conflicts.

### `Adw` Import in main.py

Check current imports in `main.py`. If `Adw` is not imported, add `from gi.repository import Adw, GLib, Gio` (or extend existing import). Looking at main.py imports (from the code), it likely already imports `Adw` for the `ReauthDialog` usage — verify before adding.

### TypeScript `noUncheckedIndexedAccess` Compliance

In the test `rp-5` (FileWatcher restart), `db.listPairs()[0]!.pair_id` uses `!` after the indexed access — required because `noUncheckedIndexedAccess` makes `db.listPairs()[0]` return `SyncPair | undefined`. The `!` is appropriate here since we've already asserted `length === 1` on the line above.

### Blueprint `remove_pair_button` ID Convention

Blueprint uses `remove_pair_button` as the widget ID (snake_case, not kebab-case). GTK's Blueprint-to-Python binding converts kebab IDs to snake_case automatically, but since the ID itself is already snake_case it maps 1:1. `Gtk.Template.Child()` attribute name `remove_pair_button` matches exactly.

### File Locations

Modified files:
- `engine/src/config.ts` — add `removeFromConfigYaml` export
- `engine/src/main.ts` — add `removeFromConfigYaml` import and `remove_pair` command handler
- `engine/src/main.test.ts` — new `describe("remove_pair command")` block + `writeConfigYaml` import
- `ui/data/ui/pair-detail-panel.blp` — add `remove_pair_button` to `detail_box`
- `ui/src/protondrive/widgets/pair_detail_panel.py` — `remove_pair_button` Template.Child, `remove-pair-requested` signal, `_on_remove_pair_clicked` method
- `ui/src/protondrive/window.py` — `_pending_remove_pair_id` state, connect signal, `_on_remove_pair_requested`, `_on_remove_pair_response`, `on_pair_removed`
- `ui/src/protondrive/main.py` — `_on_remove_pair_confirmed`, `_on_remove_pair_result`
- `ui/tests/test_pair_detail_panel.py` — `remove_pair_button` in `_make_panel()`, `TestRemovePairButton` class
- `ui/tests/test_window_routing.py` — `_pending_remove_pair_id` in `_make_window()`, `TestRemovePairFlow` class

No new files. No Blueprint registration needed (no new `.blp` file). No Meson build changes.

### References

- [Source: engine/src/config.ts] — `writeConfigYaml` pattern; `removeFromConfigYaml` follows it exactly
- [Source: engine/src/main.ts:482–577] — `add_pair` handler; `remove_pair` mirrors error codes and FileWatcher restart pattern
- [Source: engine/src/main.ts:168–194] — `_setStateDbForTests`, `_setFileWatcherForTests` test injection
- [Source: engine/src/main.test.ts:254–371] — `add_pair` test block; `remove_pair` tests follow same `tmpDir`/`XDG_CONFIG_HOME` setup
- [Source: engine/src/state-db.ts:186–190] — `deletePair(pairId)` method
- [Source: ui/data/ui/pair-detail-panel.blp] — `detail_box` Gtk.Box where `remove_pair_button` is appended
- [Source: ui/src/protondrive/widgets/pair_detail_panel.py] — `__gsignals__`, `Gtk.Template.Child()` declarations, `__init__` signal wiring pattern
- [Source: ui/src/protondrive/window.py:82–86] — existing signal connections pattern; `_on_remove_pair_requested` connects here
- [Source: ui/src/protondrive/window.py:161–174] — `clear_session`; add `_pending_remove_pair_id = None`
- [Source: ui/src/protondrive/window.py:380–414] — `populate_pairs`; this is called by `_on_get_status_result` after removal
- [Source: ui/src/protondrive/main.py:416–424] — `_on_wizard_complete`; `_on_remove_pair_confirmed` follows this lambda-for-IPC pattern
- [Source: ui/src/protondrive/main.py:404–414] — `_on_get_status_result`; called directly from `_on_remove_pair_result`
- [Source: ui/tests/test_pair_detail_panel.py:15–36] — `_make_panel()` factory; extend with `remove_pair_button = MagicMock()`
- [Source: ui/tests/test_window_routing.py:16–33] — `_make_window()` factory; extend with `_pending_remove_pair_id = None`
- [Source: _bmad-output/planning-artifacts/epics/epic-6-multi-pair-management-validation.md#story-63] — canonical ACs
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md:658, 719] — destructive button styling, `[Remove pair]` wireframe position
- [Source: _bmad-output/project-context.md#blueprint-rule] — widget structure in .blp only
- [Source: _bmad-output/project-context.md#meson-invocation] — use `distrobox-enter` for meson

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

**Party Mode Validation — 2026-04-22** (agents: Bob/SM, Winston/Architect, Quinn/QA, Amelia/Dev)

Findings and resolutions:

- [x] **CRITICAL — Task 5.4 `_()` wrapper trap**: Code block showed `_("Cancel")`/`_("Remove")` but Tasks 5.7/5.8 then corrected this inline. Developer reading top-to-bottom would implement the wrong code, then have to scroll back to apply a correction. **Fixed**: Updated 5.4 code block to use plain `"Cancel"` / `"Remove"` directly; added a single inline note about why (`_()` is unavailable in window.py; Blueprint handles i18n). Removed the now-redundant corrective Tasks 5.7 and 5.8.

- [x] **ENHANCEMENT — Test rp-1 missing config.yaml verification**: Success test verified DB removal but not that `removeFromConfigYaml` ran (a separate code path that could silently fail). **Fixed**: Added `readConfigYaml()` assertion after the DB check in rp-1 to verify the pair is absent from YAML. Updated Task 7.2 import to include both `writeConfigYaml` and `readConfigYaml` from `"./config.js"`.

### File List
