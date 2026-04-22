# Story 6.4: Local Folder Missing Detection & Recovery

Status: ready-for-dev

## Story

As a user,
I want the app to detect when my synced local folder has been moved or deleted,
so that I can fix the issue instead of the pair silently failing.

## Acceptance Criteria

1. **Given** a sync pair's local folder path no longer exists on the filesystem **When** the engine detects this (at startup or during a sync cycle) **Then** the affected pair shows a dedicated error state in the sidebar — not a global error (FR45) **And** the `local_folder_missing` push event is emitted with `{pair_id, local_path}`.

2. **Given** the missing folder error state **When** the detail panel renders for the affected pair **Then** the "folder-missing" stack page is shown with: icon, title "Local Folder Not Found", description `"Local folder not found at \"[path]\". Was it moved?"`, and two action buttons: "Update path" and "Remove pair".

3. **Given** the user clicks "Update path" **When** the action is triggered **Then** the XDG File Chooser portal opens for the user to select a new local folder **And** on selection, the pair's `local_path` is updated in both SQLite and `config.yaml` **And** the FileWatcher restarts watching the new path **And** sync resumes via `startSyncAll`.

4. **Given** the user clicks "Remove pair" in the folder-missing detail panel **When** the action is triggered **Then** the standard removal confirmation dialog from Story 6.3 is shown (requires 6.3 to be implemented — see Precondition).

5. **Given** a missing folder **When** the pair is displayed in the sidebar **Then** the `SyncPairRow` shows a "folder_missing" state: red dot + "Folder missing" text (distinct from "Sync error"). **And** the pair is never silently dropped from the list.

6. **Given** multiple sync pairs configured **When** one pair's local folder goes missing **Then** only that pair enters folder-missing state — other pairs continue syncing normally (per-pair isolation in `reconcileAndEnqueue`).

## Precondition

**Soft dependency on Story 6-3.** The "Remove pair" button in the folder-missing panel emits the existing `"remove-pair-requested"` signal (added in 6-3). If 6-3 is not yet implemented:
- Add the signal and window.py handler here (follow 6-3 task 4.1 and 5.4/5.5).
- If 6-3 IS done, the signal and handler already exist — the folder-missing "Remove pair" button simply uses them.

The rest of 6-4 is fully independent.

## Tasks / Subtasks

- [ ] Task 1 — Engine: `isLocalFolderMissing` helper + detection in `reconcileAndEnqueue` (AC: 1, 6)
  - [ ] 1.1 — In `engine/src/sync-engine.ts`, add the following helper alongside the existing `isDiskFull`, `isPermissionDenied`, `isFileLocked` helpers (after `isFileLocked`, before `// ── Internal types`):
    ```typescript
    function isLocalFolderMissing(err: unknown): boolean {
      return (
        err != null &&
        typeof err === "object" &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      );
    }
    ```
  - [ ] 1.2 — In `reconcileAndEnqueue`'s per-pair catch block (lines ~205-222), insert the `LOCAL_FOLDER_MISSING` check **after** the `isFetchFailure` guard and **before** the generic `sync_cycle_error` emit:
    ```typescript
    if (isLocalFolderMissing(err)) {
      process.stderr.write(
        `[ENGINE] local_folder_missing pair=${pairObj.pair_id.slice(-8)} path=${pairObj.local_path}\n`
      );
      this.emitEvent({
        type: "local_folder_missing",
        payload: { pair_id: pairObj.pair_id, local_path: pairObj.local_path },
      });
      continue; // non-fatal — skip this pair, continue with others
    }
    ```
  - [ ] 1.3 — Why `continue` not `return true`: `isLocalFolderMissing` must NOT break out of the pair loop — other pairs are unaffected and must keep syncing. Only auth and network failures return early. The existing `DISK_FULL` handling (`break`) is an intentional exception (no space = all pairs blocked). Missing folder = pair-specific.
  - [ ] 1.4 — Why ENOENT only: `walkLocalTree` throws the root `readdir` error only when `isRoot = true`. Sub-directory ENOENT errors are swallowed inline. The only uncaught ENOENT that reaches `reconcileAndEnqueue`'s catch is the root directory being absent. Other ENOENT errors (e.g., `stat` on a file deleted between readdir and stat) are handled safely inside `walkLocalTree`.

- [ ] Task 2 — Engine: `updatePairPath` in `state-db.ts` (AC: 3)
  - [ ] 2.1 — In `engine/src/state-db.ts`, add `updatePairPath` method to the `StateDb` class immediately after `deletePair`:
    ```typescript
    updatePairPath(pair_id: string, new_local_path: string): void {
      this.db
        .prepare("UPDATE sync_pair SET local_path = ? WHERE pair_id = ?")
        .run(new_local_path, pair_id);
    }
    ```
  - [ ] 2.2 — No migration needed — this is a plain UPDATE on the existing `sync_pair` table. No new columns.
  - [ ] 2.3 — Do NOT clear `sync_state` on path update. If the user moves the folder (same files, same mtime), the reconciler compares the existing `sync_state` against the new path — no unnecessary re-upload. If the user picks a completely different folder, the reconciler detects new/modified files and enqueues them normally. Either way, clearing `sync_state` would force a full re-sync on every path update.

- [ ] Task 3 — Engine: `updatePairPathInConfigYaml` in `config.ts` (AC: 3)
  - [ ] 3.1 — In `engine/src/config.ts`, add the following export immediately after `removeFromConfigYaml` (from Story 6-3) or after `writeConfigYaml` if 6-3 is not yet merged:
    ```typescript
    export function updatePairPathInConfigYaml(
      pair_id: string,
      new_local_path: string,
    ): void {
      const configPath = getConfigPath();
      const existing = readConfigYaml();
      existing.pairs = existing.pairs.map((p) =>
        p.pair_id === pair_id ? { ...p, local_path: new_local_path } : p,
      );
      const tmpPath = configPath + ".tmp";
      writeFileSync(tmpPath, yaml.dump(existing), "utf8");
      renameSync(tmpPath, configPath);
    }
    ```
  - [ ] 3.2 — Uses `map` (not indexed access) to avoid `noUncheckedIndexedAccess` TS error. If `pair_id` is not found, the map is a no-op — safe on any input.
  - [ ] 3.3 — Same atomic write pattern as `writeConfigYaml` and `removeFromConfigYaml`: write-to-tmp then `rename()`. No new imports needed.

- [ ] Task 4 — Engine: `update_pair_path` IPC handler in `main.ts` (AC: 3)
  - [ ] 4.1 — In `engine/src/main.ts`, add `updatePairPathInConfigYaml` to the existing import from `"./config.js"`.
    **Story 6-3 is not yet merged** — `removeFromConfigYaml` does not exist in `config.ts`. Use:
    ```typescript
    import { writeConfigYaml, updatePairPathInConfigYaml } from "./config.js";
    ```
    When Story 6-3 merges, update to:
    ```typescript
    import { writeConfigYaml, removeFromConfigYaml, updatePairPathInConfigYaml } from "./config.js";
    ```
  - [ ] 4.2 — Add the `update_pair_path` handler block immediately after the `remove_pair` block (or after `add_pair` if 6-3 not merged), before the `get_status` block:
    ```typescript
    if (command.type === "update_pair_path") {
      if (!stateDb) {
        return {
          type: "update_pair_path_result",
          id: command.id,
          payload: { error: "engine_not_ready" },
        };
      }

      const pairId = command.payload?.["pair_id"] as string | undefined;
      const newLocalPath = command.payload?.["new_local_path"] as string | undefined;
      if (!pairId || !newLocalPath) {
        return {
          type: "update_pair_path_result",
          id: command.id,
          payload: { error: "invalid_payload" },
        };
      }

      const exists = stateDb.listPairs().some((p) => p.pair_id === pairId);
      if (!exists) {
        return {
          type: "update_pair_path_result",
          id: command.id,
          payload: { error: "pair_not_found" },
        };
      }

      try {
        stateDb.updatePairPath(pairId, newLocalPath);
      } catch {
        return {
          type: "update_pair_path_result",
          id: command.id,
          payload: { error: "db_write_failed" },
        };
      }

      try {
        updatePairPathInConfigYaml(pairId, newLocalPath);
      } catch {
        return {
          type: "update_pair_path_result",
          id: command.id,
          payload: { error: "config_write_failed" },
        };
      }

      // Restart FileWatcher so it watches the new path instead of the old one.
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
        void syncEngine?.startSyncAll();
      }

      return {
        type: "update_pair_path_result",
        id: command.id,
        payload: {},
      };
    }
    ```
  - [ ] 4.3 — FileWatcher restart pattern is identical to `add_pair` and `remove_pair`. `stateDb.listPairs()` now returns the updated `local_path` because `updatePairPath` ran first.
  - [ ] 4.4 — `syncEngine?.startSyncAll()` triggers a fresh reconcile at the new path. If the new path has the same files as before (folder moved), the reconciler finds everything in sync and does minimal work. If the new path has new files, they get uploaded.

- [ ] Task 5 — Blueprint: add "folder-missing" StackPage to `pair-detail-panel.blp` (AC: 2, 5)
  - [ ] 5.1 — In `ui/data/ui/pair-detail-panel.blp`, add the following new `Gtk.StackPage` block inside `detail_stack` immediately **before** the `"conflict-log"` StackPage (i.e., after the `"detail"` StackPage closing `};`):
    ```
    Gtk.StackPage {
      name: "folder-missing";
      child: Adw.StatusPage folder_missing_status {
        icon-name: "dialog-warning-symbolic";
        title: _("Local Folder Not Found");
        description: "";

        child: Gtk.Box {
          orientation: horizontal;
          halign: center;
          spacing: 8;

          Gtk.Button folder_missing_update_btn {
            label: _("Update path");
            styles ["suggested-action"]
          }

          Gtk.Button folder_missing_remove_btn {
            label: _("Remove pair");
            styles ["destructive-action"]
          }
        };
      };
    }
    ```
  - [ ] 5.2 — `folder_missing_status` is the `AdwStatusPage` widget ID; its `description` is set dynamically at runtime by `show_folder_missing()`. Leave it empty string in Blueprint.
  - [ ] 5.3 — `folder_missing_update_btn` and `folder_missing_remove_btn` are the Python Template.Child IDs. Blueprint kebab IDs (`folder-missing-update-btn`) would auto-convert, but using snake_case directly avoids ambiguity — match the style of `remove_pair_button` from Story 6-3.
  - [ ] 5.4 — No new Blueprint file, no new Meson target, no new GResource entry — this is an addition to an existing `.blp` file only.

- [ ] Task 6 — Python: `SyncPairRow` — add "folder_missing" state (AC: 5)
  - [ ] 6.1 — In `ui/src/protondrive/widgets/sync_pair_row.py`, in `set_state()`, add an `elif state == "folder_missing":` branch immediately after `elif state == "error":` (before the final `else:` branch):
    ```python
    elif state == "folder_missing":
        self.status_label.set_text("Folder missing")
        self.status_dot.remove_css_class("sync-dot-syncing")
        self.status_dot.remove_css_class("sync-dot-offline")
        self.status_dot.remove_css_class("sync-dot-conflict")
        self.status_dot.queue_draw()
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [f"{self._pair_name} — folder missing"],
        )
        return  # early return: skip generic _set_accessible_label
    ```
  - [ ] 6.2 — In `_draw_dot()`, add `elif self._state == "folder_missing":` immediately after `elif self._state == "error":`, using the same red colour:
    ```python
    elif self._state == "folder_missing":
        cr.set_source_rgb(0.87, 0.19, 0.19)  # red — same as error
    ```
  - [ ] 6.3 — The distinction from "Sync error" is via the text label "Folder missing" (vs "Sync error"), satisfying the "dedicated error indicator (distinct from sync errors)" AC. Same red dot is intentional — both represent a pair that has stopped syncing.
  - [ ] 6.4 — `self._state` must also be set by `set_state("folder_missing")`. Looking at the method: `self._state = state` runs at the top for all branches EXCEPT for early-return branches. Since "folder_missing" early-returns, add `self._state = state` at the top of the branch body OR confirm the existing `self._state = state` line is above the if/elif chain (it is, at line 59). ✅ No extra assignment needed.

- [ ] Task 7 — Python: `PairDetailPanel` — add widget children and `show_folder_missing` (AC: 2, 3, 4)
  - [ ] 7.1 — In `ui/src/protondrive/widgets/pair_detail_panel.py`, add the following `Gtk.Template.Child()` declarations alongside the existing ones (after `conflict_log_back_btn`):
    ```python
    # Story 6-4:
    folder_missing_status: Adw.StatusPage = Gtk.Template.Child()
    folder_missing_update_btn: Gtk.Button = Gtk.Template.Child()
    folder_missing_remove_btn: Gtk.Button = Gtk.Template.Child()
    ```
  - [ ] 7.2 — In `__init__`, wire the two new button signals (no lambda):
    ```python
    self.folder_missing_update_btn.connect(
        "clicked", self._on_folder_missing_update_clicked
    )
    self.folder_missing_remove_btn.connect(
        "clicked", self._on_folder_missing_remove_clicked
    )
    ```
  - [ ] 7.3 — Add `"update-path-requested"` to `__gsignals__`:
    ```python
    __gsignals__ = {
        "setup-requested": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "view-conflict-log": (GObject.SignalFlags.RUN_FIRST, None, ()),
        "remove-pair-requested": (GObject.SignalFlags.RUN_FIRST, None, (str,)),  # Story 6-3
        "update-path-requested": (GObject.SignalFlags.RUN_FIRST, None, (str,)),  # Story 6-4: emits pair_id
    }
    ```
    If Story 6-3 is not yet merged, `"remove-pair-requested"` is new here too. If 6-3 IS merged, it's already present — only add `"update-path-requested"`.
  - [ ] 7.4 — Add signal handlers:
    ```python
    def _on_folder_missing_update_clicked(self, _button: Gtk.Button) -> None:
        if self._current_pair_id is not None:
            self.emit("update-path-requested", self._current_pair_id)

    def _on_folder_missing_remove_clicked(self, _button: Gtk.Button) -> None:
        if self._current_pair_id is not None:
            self.emit("remove-pair-requested", self._current_pair_id)
    ```
  - [ ] 7.5 — Add `show_folder_missing` method (place after `show_pair`, before `on_sync_progress`):
    ```python
    def show_folder_missing(self, pair_id: str, local_path: str) -> None:
        """Show the folder-missing error state for the given pair.

        Has an internal pair_id guard (like set_error_state / set_conflict_state)
        so callers such as on_pair_folder_missing can call it unconditionally
        without worrying about whether this pair is currently selected.
        Exception: _on_row_activated and select_pair call show_pair() first,
        which sets _current_pair_id = pair_id, so the guard always passes there.
        """
        if self._current_pair_id != pair_id:
            return
        self._cancel_sync_timer()
        self._hide_progress_card()
        self.folder_missing_status.set_description(
            f'Local folder not found at "{local_path}". Was it moved?'
        )
        self.conflict_banner.set_revealed(False)
        self.error_banner.set_revealed(False)
        self.detail_stack.set_visible_child_name("folder-missing")
    ```
  - [ ] 7.5a — **Why the guard is here, not in `on_pair_folder_missing`**: consistent with
    `set_error_state` and `set_conflict_state`, both of which guard internally. The caller
    (`on_pair_folder_missing`) can call unconditionally. The one subtlety: `_on_row_activated`
    and `select_pair` call `show_pair()` first — `show_pair` sets `_current_pair_id = pair_id` —
    so by the time `show_folder_missing` is called from those handlers, the guard passes.
    Do NOT set `self._current_pair_id = pair_id` inside `show_folder_missing`; the pair is
    already current (set by `show_pair`) and setting it again here would be redundant but
    would also mask the guard check on the wrong-pair path.
  - [ ] 7.6 — Type hints on all new methods. `from __future__ import annotations` already present.
  - [ ] 7.7 — `show_pair()` is unchanged. It already calls `self.detail_stack.set_visible_child_name("detail")` — switching away from "folder-missing" naturally. No extra logic needed.

- [ ] Task 8 — Python: `window.py` — event wiring, tracking, row/panel routing (AC: 1, 3, 5, 6)
  - [ ] 8.1 — Add `GLib` to `window.py` imports:
    ```python
    from gi.repository import Adw, Gio, GLib, Gtk
    ```
  - [ ] 8.2 — In `MainWindow.__init__`, add `_folder_missing_pair_ids` tracking alongside the existing error tracking (after `self._error_messages`):
    ```python
    self._folder_missing_pair_ids: set[str] = set()  # Story 6-4
    self._pending_update_pair_id: str | None = None  # Story 6-4
    ```
  - [ ] 8.3 — In `MainWindow.__init__`, connect new signals from `pair_detail_panel` (after the `"view-conflict-log"` connection):
    ```python
    self.pair_detail_panel.connect(
        "remove-pair-requested", self._on_remove_pair_requested  # may already exist from 6-3
    )
    self.pair_detail_panel.connect(
        "update-path-requested", self._on_update_path_requested
    )
    ```
    If 6-3 is merged, the `remove-pair-requested` connection already exists in `__init__` — do NOT add it again; only add `update-path-requested`.
  - [ ] 8.4 — In `clear_session()`, reset new state (after `self._error_messages = {}`):
    ```python
    self._folder_missing_pair_ids = set()  # Story 6-4
    self._pending_update_pair_id = None    # Story 6-4
    ```
  - [ ] 8.5 — Add `on_pair_folder_missing` method to `window.py` (place after `on_pair_error`):
    ```python
    def on_pair_folder_missing(self, pair_id: str, local_path: str) -> None:
        """Handle engine local_folder_missing event (Story 6-4 AC1, AC5)."""
        row = self._sync_pair_rows.get(pair_id)
        if row is None:
            return
        row.set_state("folder_missing")
        self._folder_missing_pair_ids.add(pair_id)
        self._error_pair_ids.add(pair_id)         # drives footer error display
        self._error_messages[pair_id] = "Folder missing"
        # show_folder_missing has an internal pair_id guard — safe to call
        # unconditionally; it's a no-op if a different pair is currently shown.
        self.pair_detail_panel.show_folder_missing(pair_id, local_path)
        self._update_footer_error_state()
    ```
  - [ ] 8.6 — Add `_on_update_path_requested` method to `window.py` (place after `_on_remove_pair_response` or after `_on_remove_pair_requested` if 6-3 is merged; or after `_on_view_conflict_log` if 6-3 is not):
    ```python
    def _on_update_path_requested(self, _panel: object, pair_id: str) -> None:
        self._pending_update_pair_id = pair_id
        dialog = Gtk.FileDialog()
        dialog.select_folder(
            parent=self,
            cancellable=None,
            callback=self._on_new_path_chosen,
        )

    def _on_new_path_chosen(
        self, dialog: Gtk.FileDialog, result: Gio.AsyncResult
    ) -> None:
        pair_id = self._pending_update_pair_id
        self._pending_update_pair_id = None
        if pair_id is None:
            return
        try:
            gio_file = dialog.select_folder_finish(result)
        except GLib.Error:
            return  # user cancelled — silently ignore
        if gio_file is None:
            return
        new_path = gio_file.get_path()
        if not new_path:
            return
        app = self.get_application()
        if app is not None and hasattr(app, "_on_update_pair_path"):
            app._on_update_pair_path(pair_id, new_path)
    ```
  - [ ] 8.7 — In `_on_row_activated`, add folder-missing detection after the existing error banner restore (after the `_error_pair_ids` check block):
    ```python
    if pair_id in self._folder_missing_pair_ids:
        pair_data = self._pairs_data.get(pair_id, {})
        local_path = pair_data.get("local_path", pair_id)
        self.pair_detail_panel.show_folder_missing(pair_id, local_path)
    elif pair_id in self._error_pair_ids:
        self.pair_detail_panel.set_error_state(
            pair_id, True, self._error_messages.get(pair_id, "")
        )
    ```
    Note: replace the existing `if pair_id in self._error_pair_ids:` block with the above `elif` so folder-missing takes priority and the detail panel shows "folder-missing" page instead of the error banner. The full replacement in `_on_row_activated` (after `show_pair` and `set_conflict_state`):
    ```python
    if pair_id in self._folder_missing_pair_ids:      # Story 6-4 — before error check
        pair_data = self._pairs_data.get(pair_id, {})
        local_path = pair_data.get("local_path", pair_id)
        self.pair_detail_panel.show_folder_missing(pair_id, local_path)
    elif pair_id in self._error_pair_ids:              # Story 6-0d — only when not folder-missing
        self.pair_detail_panel.set_error_state(
            pair_id, True, self._error_messages.get(pair_id, "")
        )
    self.nav_split_view.set_show_content(True)
    ```
  - [ ] 8.8 — Apply the same `folder_missing` priority check to `select_pair` (mirrors `_on_row_activated`). Replace:
    ```python
    if pair_id in self._error_pair_ids:
        self.pair_detail_panel.set_error_state(
            pair_id, True, self._error_messages.get(pair_id, "")
        )
    ```
    With:
    ```python
    if pair_id in self._folder_missing_pair_ids:      # Story 6-4
        pair_data = self._pairs_data.get(pair_id, {})
        local_path = pair_data.get("local_path", pair_id)
        self.pair_detail_panel.show_folder_missing(pair_id, local_path)
    elif pair_id in self._error_pair_ids:
        self.pair_detail_panel.set_error_state(
            pair_id, True, self._error_messages.get(pair_id, "")
        )
    ```
  - [ ] 8.9 — In `on_pair_removed`, add `_folder_missing_pair_ids` cleanup (after the existing `discard`/`pop` calls):
    ```python
    self._folder_missing_pair_ids.discard(pair_id)  # Story 6-4
    ```
    If 6-3 is not merged, `on_pair_removed` does not exist yet — create it with all the required cleanup including this line.

- [ ] Task 9 — Python: `main.py` — register event, handle IPC (AC: 1, 3)
  - [ ] 9.1 — In `Application.do_startup`, register the new event handler after `"crash_recovery_complete"`:
    ```python
    self._engine.on_event("local_folder_missing", self._on_local_folder_missing)
    ```
  - [ ] 9.2 — Add `_on_local_folder_missing` handler (place after `_on_crash_recovery_complete`):
    ```python
    def _on_local_folder_missing(self, message: dict[str, Any]) -> None:
        payload = message.get("payload", {})
        if not isinstance(payload, dict):
            return
        pair_id = payload.get("pair_id", "")
        local_path = payload.get("local_path", "")
        if pair_id and self._window is not None:
            self._window.on_pair_folder_missing(pair_id, local_path)
    ```
  - [ ] 9.3 — Add `_on_update_pair_path` (place after `_on_remove_pair_confirmed` from 6-3, or after `_on_wizard_complete` if 6-3 is not merged):
    ```python
    def _on_update_pair_path(self, pair_id: str, new_local_path: str) -> None:
        if self._engine is not None:
            self._engine.send_command_with_response(
                {"type": "update_pair_path", "payload": {"pair_id": pair_id, "new_local_path": new_local_path}},
                lambda payload: self._on_update_pair_path_result(payload, pair_id),
            )
    ```
  - [ ] 9.4 — Add `_on_update_pair_path_result` immediately after:
    ```python
    def _on_update_pair_path_result(
        self, payload: dict[str, Any], pair_id: str
    ) -> None:
        if payload.get("error"):
            if self._window is not None:
                toast = Adw.Toast.new("Failed to update folder path")
                toast.set_timeout(3)
                self._window.toast_overlay.add_toast(toast)
            return
        # Clear folder-missing state before refreshing sidebar rows.
        if self._window is not None:
            self._window._folder_missing_pair_ids.discard(pair_id)
            self._window._error_pair_ids.discard(pair_id)
            self._window._error_messages.pop(pair_id, None)
        if self._engine is not None:
            self._engine.send_command_with_response(
                {"type": "get_status"}, self._on_get_status_result
            )
    ```
  - [ ] 9.5 — The `lambda payload: self._on_update_pair_path_result(payload, pair_id)` captures `pair_id`. This is an IPC response callback (not a GTK signal connection) — the lambda rule does NOT apply. Same pattern as `_on_remove_pair_confirmed` (Story 6-3) and `_on_add_pair_complete` (Story 6-1).
  - [ ] 9.6 — Clearing folder-missing state in `_on_update_pair_path_result` BEFORE sending `get_status` ensures that when `populate_pairs` rebuilds the sidebar rows, they start clean with no error/folder-missing flags.

- [ ] Task 10 — Engine tests: `update_pair_path` command (AC: 3)
  - [ ] 10.1 — In `engine/src/main.test.ts`, add a new `describe("update_pair_path command", ...)` block after the `describe("remove_pair command")` block (or after `describe("add_pair command")` if 6-3 not merged), before `describe("unlock_keys command")`. Use the same `tmpDir`/`XDG_CONFIG_HOME` pattern:

    ```typescript
    // ---------------------------------------------------------------------------
    // update_pair_path command (Story 6.4)
    // ---------------------------------------------------------------------------
    describe("update_pair_path command", () => {
      let tmpDir: string;
      let origXdg: string | undefined;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-path-test-"));
        origXdg = process.env["XDG_CONFIG_HOME"];
        process.env["XDG_CONFIG_HOME"] = tmpDir;
        _setStateDbForTests(new StateDb(":memory:"));
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

      it("success: updates local_path in DB and config.yaml, returns {}", async () => {
        const db = new StateDb(":memory:");
        _setStateDbForTests(db);
        db.insertPair({
          pair_id: "pair-abc",
          local_path: "/old/path",
          remote_path: "/Documents",
          remote_id: "",
          created_at: new Date().toISOString(),
          last_synced_at: null,
        });
        writeConfigYaml("pair-abc", "/old/path", "/Documents");

        const response = await handleCommand({
          type: "update_pair_path",
          id: "up-1",
          payload: { pair_id: "pair-abc", new_local_path: "/new/path" },
        });

        expect(response!.type).toBe("update_pair_path_result");
        expect(response!.id).toBe("up-1");
        expect(response!.payload).toEqual({});
        // Verify DB update.
        const pairs = db.listPairs();
        expect(pairs.length).toBe(1);
        expect(pairs[0]!.local_path).toBe("/new/path");
        // Verify config.yaml update.
        const cfg = readConfigYaml();
        expect(cfg.pairs[0]!.local_path).toBe("/new/path");
      });

      it("stateDb undefined → engine_not_ready", async () => {
        _setStateDbForTests(undefined);
        const response = await handleCommand({
          type: "update_pair_path",
          id: "up-2",
          payload: { pair_id: "pair-abc", new_local_path: "/new/path" },
        });
        expect(response!.payload).toEqual({ error: "engine_not_ready" });
      });

      it("missing pair_id → invalid_payload", async () => {
        const response = await handleCommand({
          type: "update_pair_path",
          id: "up-3",
          payload: { new_local_path: "/new/path" },
        });
        expect(response!.payload).toEqual({ error: "invalid_payload" });
      });

      it("non-existent pair_id → pair_not_found", async () => {
        const response = await handleCommand({
          type: "update_pair_path",
          id: "up-4",
          payload: { pair_id: "ghost-id", new_local_path: "/new/path" },
        });
        expect(response!.payload).toEqual({ error: "pair_not_found" });
      });

      it("FileWatcher restarted and startSyncAll called after success", async () => {
        const db = new StateDb(":memory:");
        _setStateDbForTests(db);
        db.insertPair({
          pair_id: "pair-xyz",
          local_path: "/old/path",
          remote_path: "/Docs",
          remote_id: "",
          created_at: new Date().toISOString(),
          last_synced_at: null,
        });
        writeConfigYaml("pair-xyz", "/old/path", "/Docs");

        const mockClient = {} as unknown as DriveClient;
        _setDriveClientForTests(mockClient);
        const fwStops: string[] = [];
        const mockFw = {
          stop: () => { fwStops.push("stopped"); },
          initialize: async () => {},
        } as unknown as FileWatcher;
        _setFileWatcherForTests(mockFw);

        const syncAllCalls: string[] = [];
        const mockEngine = {
          startSyncAll: async () => { syncAllCalls.push("called"); },
          drainQueue: async () => {},
          setDriveClient: () => {},
        } as unknown as SyncEngine;
        _setSyncEngineForTests(mockEngine);

        await handleCommand({
          type: "update_pair_path",
          id: "up-5",
          payload: { pair_id: "pair-xyz", new_local_path: "/new/path" },
        });

        expect(fwStops.length).toBe(1);
        expect(syncAllCalls.length).toBe(1);
      });
    });
    ```

  - [ ] 10.2 — Add imports needed for test block. `writeConfigYaml` and `readConfigYaml` should already be imported if 6-3 is merged. If not, add:
    ```typescript
    import { writeConfigYaml, readConfigYaml } from "./config.js";
    ```
  - [ ] 10.3 — `_setSyncEngineForTests` is needed for test up-5. Add to imports from `"./main.js"` if not already present:
    ```typescript
    import {
      handleCommand,
      _setDriveClientForTests,
      _setStateDbForTests,
      _setServerForTests,
      _setFileWatcherForTests,
      _setSyncEngineForTests,   // ← add this if not present
      createNetworkMonitorCallback,
      cleanTmpFilesInDir,
      runCrashRecovery,
    } from "./main.js";
    ```
  - [ ] 10.4 — `SyncEngine` type needed for `as unknown as SyncEngine`. Add to imports if not present:
    ```typescript
    import { SyncEngine } from "./sync-engine.js";
    ```

- [ ] Task 11 — Engine tests: `local_folder_missing` emission in SyncEngine (AC: 1, 6)
  - [ ] 11.1 — In `engine/src/sync-engine.test.ts`, add a new test within the existing `reconcileAndEnqueue` describe block (or in a new `describe("local folder missing detection")` block):

    ```typescript
    it("emits local_folder_missing and continues when local_path does not exist", async () => {
      const emitted: IpcPushEvent[] = [];
      const db = new StateDb(":memory:");
      db.insertPair({
        pair_id: "missing-pair",
        local_path: "/does/not/exist/at/all",
        remote_path: "/Docs",
        remote_id: "root-id",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      db.insertPair({
        pair_id: "good-pair",
        local_path: os.tmpdir(),  // always exists
        remote_path: "/Docs",
        remote_id: "root-id",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });

      const mockClient = {
        listRemoteFolders: async () => [],
        walkRemoteTree: async () => ({ files: new Map(), folders: new Map() }),
      } as unknown as DriveClient;

      const engine = new SyncEngine(db, (e) => emitted.push(e));
      engine.setDriveClient(mockClient);
      await engine.reconcileAndEnqueue();

      const missingEvent = emitted.find(
        (e) => e.type === "local_folder_missing" &&
               (e.payload as Record<string, string>)["pair_id"] === "missing-pair"
      );
      expect(missingEvent).toBeDefined();
      expect((missingEvent!.payload as Record<string, string>)["local_path"]).toBe(
        "/does/not/exist/at/all"
      );
      // Verify loop continued: no folder_missing for good-pair.
      const badEvent = emitted.find(
        (e) => e.type === "local_folder_missing" &&
               (e.payload as Record<string, string>)["pair_id"] === "good-pair"
      );
      expect(badEvent).toBeUndefined();
    });
    ```

  - [ ] 11.2 — The test uses `os.tmpdir()` for the "good-pair" local_path (always exists).
    `walkLocalTree(os.tmpdir())` will return whatever files happen to be in `/tmp`. The mock
    `walkRemoteTree` returns empty maps, so the reconciler computes "upload" work items for those
    files and enqueues them in the in-memory StateDb. It does NOT attempt actual uploads in
    `reconcileAndEnqueue` — that happens in `drainQueue`, which is not called by this test.
    The test only asserts that `local_folder_missing` is NOT emitted for `good-pair`; any
    `sync_cycle_error` from unexpected conditions during the walk is irrelevant to the assertion.
  - [ ] 11.3 — Import `os` at the top of the test file if not already present: `import os from "node:os";`

- [ ] Task 12 — UI tests (AC: 1, 2, 3, 5)
  - [ ] 12.1 — In `ui/tests/test_sync_pair_row.py` (or wherever SyncPairRow tests live), add tests for the new "folder_missing" state:
    ```python
    class TestFolderMissingState:
        def test_set_state_folder_missing_sets_label(self):
            row = _make_row()
            row.set_state("folder_missing")
            assert row.status_label.get_text() == "Folder missing"
            assert row.state == "folder_missing"

        def test_set_state_folder_missing_removes_other_css(self):
            row = _make_row()
            row.set_state("syncing")  # add a CSS class first
            row.set_state("folder_missing")
            assert not row.status_dot.has_css_class("sync-dot-syncing")
            assert not row.status_dot.has_css_class("sync-dot-offline")
            assert not row.status_dot.has_css_class("sync-dot-conflict")
    ```
  - [ ] 12.2 — In `ui/tests/test_pair_detail_panel.py`, add to `_make_panel()` fixture:
    ```python
    panel.folder_missing_status = MagicMock()
    panel.folder_missing_update_btn = MagicMock()
    panel.folder_missing_remove_btn = MagicMock()
    ```
  - [ ] 12.3 — Add test class in `test_pair_detail_panel.py`:
    ```python
    class TestShowFolderMissing:
        def test_show_folder_missing_sets_stack_page(self):
            panel = _make_panel()
            panel._current_pair_id = "pair-abc"  # must match for guard to pass
            panel.show_folder_missing("pair-abc", "/home/user/Docs")
            panel.detail_stack.set_visible_child_name.assert_called_with("folder-missing")

        def test_show_folder_missing_sets_description_with_path(self):
            panel = _make_panel()
            panel._current_pair_id = "pair-abc"
            panel.show_folder_missing("pair-abc", "/home/user/Docs")
            panel.folder_missing_status.set_description.assert_called_once()
            call_arg = panel.folder_missing_status.set_description.call_args[0][0]
            assert "/home/user/Docs" in call_arg

        def test_show_folder_missing_noop_when_different_pair_selected(self):
            """Guard: show_folder_missing is a no-op when a different pair is shown."""
            panel = _make_panel()
            panel._current_pair_id = "pair-other"  # different pair is selected
            panel.show_folder_missing("pair-abc", "/home/user/Docs")
            # stack page must NOT be switched
            panel.detail_stack.set_visible_child_name.assert_not_called()
            panel.folder_missing_status.set_description.assert_not_called()

        def test_update_clicked_emits_update_path_requested(self):
            panel = _make_panel()
            panel._current_pair_id = "pair-abc"
            emitted = []
            panel.emit = lambda signal, *args: emitted.append((signal, args))
            from gi.repository import Gtk
            panel._on_folder_missing_update_clicked(MagicMock(spec=Gtk.Button))
            assert len(emitted) == 1
            assert emitted[0][0] == "update-path-requested"
            assert emitted[0][1] == ("pair-abc",)

        def test_remove_clicked_emits_remove_pair_requested(self):
            panel = _make_panel()
            panel._current_pair_id = "pair-abc"
            emitted = []
            panel.emit = lambda signal, *args: emitted.append((signal, args))
            from gi.repository import Gtk
            panel._on_folder_missing_remove_clicked(MagicMock(spec=Gtk.Button))
            assert len(emitted) == 1
            assert emitted[0][0] == "remove-pair-requested"
            assert emitted[0][1] == ("pair-abc",)
    ```

- [ ] Task 13 — Full test suite validation (AC: all)
  - [ ] 13.1 — `cd engine && bun test` — all tests green, exit 0 (includes new `update_pair_path` and `local_folder_missing` tests)
  - [ ] 13.2 — `distrobox-enter -n LinuxProtonDrive -- bash -c "/usr/bin/meson compile -C builddir 2>&1"` — must exit 0 (Blueprint compiles with new "folder-missing" StackPage and new widget IDs)
  - [ ] 13.3 — `.venv/bin/pytest ui/tests/ -v` from project root — all tests green, exit 0

## Dev Notes

### Engine: Detection Point — `walkLocalTree` Root Failure

`walkLocalTree(localPath)` calls `readdir(dirPath, {withFileTypes: true})` inside `walkDir`. When `isRoot = true` and `readdir` throws (e.g., ENOENT — directory does not exist), the error propagates out of `walkLocalTree` and into `reconcilePair`, then into `reconcileAndEnqueue`'s catch block.

The catch block already handles:
- `isAuthExpired` → early return, halts all pairs
- `isFetchFailure` → early return, halts all pairs
- (new) `isLocalFolderMissing` → emit event, `continue` to next pair
- generic → emit `sync_cycle_error`, `continue` to next pair

`isLocalFolderMissing` detects `.code === "ENOENT"`. This is the only ENOENT that reaches this catch block — all other ENOENT scenarios inside the tree walk are handled internally.

### Engine: Push Event `local_folder_missing` vs `error`

Story uses a new **dedicated push event type** (`local_folder_missing`) rather than routing through the existing generic `error` event. Rationale:
- The generic `error` event dispatch in `engine.py` passes only `(message, fatal, pair_id)` — the `code` field is dropped.
- A dedicated event type lets UI register a named handler without modifying `engine.py`'s error dispatch. Zero changes to `EngineClient`.
- Consistent with `conflict_detected` (another pair-specific event that has its own type rather than being routed through `error`).

### Engine: `update_pair_path` vs IPC `_result` Convention

`update_pair_path_result` uses the `_result` suffix — it is a command response, not a push event. The `engine.py._dispatch_event` routes `_result` messages via `_pending_responses` (request/response correlation). This is correct.

Do NOT emit a `local_folder_missing` push event AFTER a successful `update_pair_path` — the UI handles path recovery locally after seeing `update_pair_path_result: {}`.

### UI: `_folder_missing_pair_ids` vs `_error_pair_ids`

`_folder_missing_pair_ids` is a **subset** of `_error_pair_ids`. A folder-missing pair is added to BOTH sets:
- `_folder_missing_pair_ids`: drives the detail panel "folder-missing" stack page
- `_error_pair_ids`: drives the footer "Sync error" state and the row's red dot

When path is updated successfully, BOTH are cleared in `_on_update_pair_path_result`.

`_error_pair_ids` without `_folder_missing_pair_ids` = standard sync error (error banner in detail panel).
`_folder_missing_pair_ids` ∩ `_error_pair_ids` = folder-missing state (folder-missing page in detail panel).

The pair detail routing check must check `_folder_missing_pair_ids` FIRST (it takes priority over the error banner).

### UI: `show_folder_missing` vs `show_pair` + error banner

Story 6-0d added an `error_banner` inside the "detail" stack page. For a standard sync error, the flow is:
1. `show_pair(pair_data)` → stack shows "detail" page
2. `set_error_state(pair_id, True, msg)` → `error_banner` revealed on "detail" page

For folder-missing, the entire detail page is replaced:
1. `show_folder_missing(pair_id, local_path)` → stack shows "folder-missing" page

This is intentional — the folder-missing state has distinct action buttons that don't fit in the error banner model. The `error_banner` is hidden in `show_folder_missing` (defensive cleanup).

### UI: File Chooser Pattern in window.py

`Gtk.FileDialog.select_folder()` is async. The cancellation guard:
```python
try:
    gio_file = dialog.select_folder_finish(result)
except GLib.Error:
    return  # user clicked Cancel — GLib.Error (Gio.IOErrorEnum.CANCELLED)
```

`GLib.Error` is the Python exception class for all GLib/Gio errors. `GLib` must be imported in `window.py` (currently missing — add it).

`_pending_update_pair_id` is a single-element store (same as `_pending_remove_pair_id` from 6-3). GTK is single-threaded — only one file chooser can be open at a time.

### UI: No Blueprint Registration Needed

No new `.blp` file created. The "folder-missing" StackPage is added to the existing `pair-detail-panel.blp`. No new `custom_target`, no new `gnome.compile_resources` dependency, no new `gresource.xml` entry.

The Meson build will recompile `pair-detail-panel.blp` automatically because the file changed.

### Story 6-3 Dependency Detail

**If Story 6-3 is already merged**, these exist in the codebase:
- `"remove-pair-requested"` signal in `PairDetailPanel.__gsignals__`
- `remove_pair_button: Gtk.Template.Child()` in `pair_detail_panel.py` (on the "detail" page — separate from `folder_missing_remove_btn` on the "folder-missing" page)
- `_on_remove_pair_requested` method in `window.py`
- `_pending_remove_pair_id`, `_on_remove_pair_response`, `on_pair_removed` in `window.py`
- `_on_remove_pair_confirmed`, `_on_remove_pair_result` in `main.py`
- `remove_pair` IPC handler in engine

Tasks 7.3 (`"remove-pair-requested"` signal), 8.3 (signal connection), 8.9 (`on_pair_removed` update), and Task 4 (`remove_pair` engine handler) need conditional handling:
- If 6-3 merged: only ADD what's new, do NOT duplicate.
- If 6-3 not merged: implement the full set from scratch (following 6-3 story).

**If Story 6-3 is NOT merged**, implement the following from 6-3:
1. Add `remove_pair` engine handler (6-3 Task 2)
2. Add `remove_pair_button` to `pair-detail-panel.blp` "detail" page (6-3 Task 3) — separate from `folder_missing_remove_btn`
3. Add `"remove-pair-requested"` signal + `remove_pair_button` Template.Child to `pair_detail_panel.py` (6-3 Task 4)
4. Add `_on_remove_pair_requested`, `_on_remove_pair_response`, `on_pair_removed`, `_pending_remove_pair_id` to `window.py` (6-3 Task 5)
5. Add `_on_remove_pair_confirmed`, `_on_remove_pair_result` to `main.py` (6-3 Task 6)

### File Locations

Modified files:
- `engine/src/sync-engine.ts` — `isLocalFolderMissing` helper + detection in `reconcileAndEnqueue`
- `engine/src/state-db.ts` — `updatePairPath` method
- `engine/src/config.ts` — `updatePairPathInConfigYaml` export
- `engine/src/main.ts` — `update_pair_path` handler + import
- `engine/src/main.test.ts` — `update_pair_path` test block + imports
- `engine/src/sync-engine.test.ts` — `local_folder_missing` emission test
- `ui/data/ui/pair-detail-panel.blp` — "folder-missing" StackPage
- `ui/src/protondrive/widgets/sync_pair_row.py` — "folder_missing" state
- `ui/src/protondrive/widgets/pair_detail_panel.py` — new Template.Child, signal, `show_folder_missing`, button handlers
- `ui/src/protondrive/window.py` — `GLib` import, `_folder_missing_pair_ids`, `on_pair_folder_missing`, file chooser flow, `_on_row_activated`/`select_pair` update, `on_pair_removed` update, `clear_session` update
- `ui/src/protondrive/main.py` — `local_folder_missing` event handler, `_on_update_pair_path`, `_on_update_pair_path_result`
- `ui/tests/test_pair_detail_panel.py` — fixture update, `TestShowFolderMissing` tests
- `ui/tests/test_sync_pair_row.py` — `TestFolderMissingState` tests

No new files. No Blueprint build registration changes.

### References

- [Source: engine/src/sync-engine.ts:200–225] — `reconcileAndEnqueue` catch block; `isLocalFolderMissing` inserts between `isFetchFailure` and generic error
- [Source: engine/src/sync-engine.ts:1095–1138] — `walkLocalTree`; `isRoot` guard at line 1108 propagates root ENOENT
- [Source: engine/src/sync-engine.ts:28–49] — `isDiskFull`, `isPermissionDenied`, `isFileLocked` helper pattern; `isLocalFolderMissing` follows this
- [Source: engine/src/state-db.ts:186–190] — `deletePair`; `updatePairPath` follows same `db.run()` pattern
- [Source: engine/src/config.ts:49–69] — `writeConfigYaml`; `updatePairPathInConfigYaml` follows same atomic-write pattern
- [Source: engine/src/main.ts:482–577] — `add_pair` handler; `update_pair_path` mirrors error codes and FileWatcher restart
- [Source: engine/src/main.ts:168–200] — `_setStateDbForTests`, `_setFileWatcherForTests`, `_setSyncEngineForTests` test exports
- [Source: engine/src/main.test.ts] — `add_pair` and `remove_pair` test block patterns
- [Source: ui/data/ui/pair-detail-panel.blp] — existing StackPage structure; "folder-missing" page inserts before "conflict-log"
- [Source: ui/src/protondrive/widgets/sync_pair_row.py:52–100] — `set_state()` pattern; "folder_missing" inserts after "error"
- [Source: ui/src/protondrive/widgets/pair_detail_panel.py:43–57] — `Gtk.Template.Child()` declarations; new ones append here
- [Source: ui/src/protondrive/widgets/pair_detail_panel.py:148–162] — `show_pair()`; `show_folder_missing` follows same pattern
- [Source: ui/src/protondrive/window.py:37–86] — `__init__` state declarations and signal connections
- [Source: ui/src/protondrive/window.py:161–174] — `clear_session()`; add new resets
- [Source: ui/src/protondrive/window.py:420–452] — `_on_row_activated`, `select_pair`; add folder-missing priority check
- [Source: ui/src/protondrive/window.py:540–550] — `on_pair_error`; `on_pair_folder_missing` follows same pattern
- [Source: ui/src/protondrive/main.py:89–102] — `do_startup` event registrations
- [Source: ui/src/protondrive/main.py:224–234] — `_on_crash_recovery_complete`; `_on_local_folder_missing` inserts after
- [Source: ui/src/protondrive/main.py:416–424] — `_on_wizard_complete`; `_on_update_pair_path` follows same IPC pattern
- [Source: _bmad-output/planning-artifacts/epics/epic-6-multi-pair-management-validation.md#story-64] — canonical ACs
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md:759] — UX copy: "Local folder not found at [path]. Was it moved?"
- [Source: _bmad-output/planning-artifacts/epics/requirements-inventory.md:147] — UX-DR19
- [Source: _bmad-output/project-context.md#blueprint-rule] — widget structure in .blp only; no widget tree construction in Python
- [Source: _bmad-output/project-context.md#meson-invocation] — use `distrobox-enter` for meson (never bare `meson`)

## Party-Mode Validation Record

**Validated:** 2026-04-22  
**Agents:** Winston (Architect), Amelia (Dev), Quinn (QA), Bob (SM)

### Findings

- [x] **[C1 — CRITICAL] `show_folder_missing` missing pair_id guard** — Without a guard, `on_pair_folder_missing` would switch the detail panel even when a different pair was selected, violating UX isolation. Fixed in Task 7.5: added `if self._current_pair_id != pair_id: return` at the top of `show_folder_missing`, consistent with the `set_error_state` / `set_conflict_state` pattern. Task 7.5a added a rationale note explaining why the guard is inside the method (not in the caller) and why `_current_pair_id` is NOT re-set inside this method.

- [x] **[E1 — ENHANCEMENT] `updatePairPath` used `this.db.run()` shorthand** — Inconsistent with every other `StateDb` method which uses `this.db.prepare(...).run(...)`. Fixed in Task 2.1: changed to `.prepare("UPDATE ...").run(new_local_path, pair_id)`.

- [x] **[E2 — ENHANCEMENT] Task 4.1 import included `removeFromConfigYaml` (Story 6-3 not merged)** — The 6-3-not-merged branch was buried in a parenthetical, risking a compile error. Fixed in Task 4.1: the primary code block now shows only `writeConfigYaml` and `updatePairPathInConfigYaml` (what exists today); the 6-3-merged form is shown as the future upgrade path.

- [x] **[E3 — ENHANCEMENT] Missing test for `show_folder_missing` guard behavior** — No test verified that `show_folder_missing` is a no-op when a different pair is shown. Fixed in Task 12.3: added `test_show_folder_missing_noop_when_different_pair_selected`. Also updated existing tests in 12.3 to pre-set `_current_pair_id` so the guard passes in the "happy path" tests.

- [x] **[E4 — ENHANCEMENT] Test note 11.2 inaccurate about `os.tmpdir()`** — Note claimed "reconciler finds nothing to upload/download" but `os.tmpdir()` typically has files; the reconciler enqueues them as uploads (no crash, but not "nothing to do"). Fixed in Task 11.2 note: clarified that files are enqueued (not uploaded) in `reconcileAndEnqueue`, and that the test assertion is unaffected by this.

### Rationale for Deferred Items

No scope-expanding items identified. All findings were in-scope fixes to the story spec itself.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List
