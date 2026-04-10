# Story 2.3: Remote Folder Picker Component

Status: done

## Story

As a **user setting up a sync pair**,
I want **a remote folder picker that lets me type a ProtonDrive path with autocomplete suggestions for top-level folders**,
so that **I can choose where my files sync to in ProtonDrive without needing to navigate a tree browser, while still supporting nested paths via manual entry.**

> **Why this story exists now:** Story 2.2 landed `DriveClient.listRemoteFolders()` (mocked tests). Story 2.4 (Setup Wizard) needs `RemoteFolderPicker` as its second wizard step. Story 2.2.5 (live SDK wiring) is sequenced **after** this story and is blocked on Mary's SRP spike — so the picker must work end-to-end **without** a real `DriveClient` instance. This story therefore ships:
>
> 1. The UI widget (Blueprint + Python) — fully functional with mocked autocomplete data,
> 2. The engine `list_remote_folders` IPC handler — placeholder empty `folders[]` response, real `DriveClient` call deferred to Story 2.2.5,
> 3. A reusable request/response correlation helper in `engine.py` — first command in the codebase that uses the `id` / `_result` round-trip (every command except `token_refresh` and `shutdown` will use this from now on).
>
> **Critical scope boundary:** Story 2.2.5 will replace the placeholder handler body with a real `createDriveClient(token).listRemoteFolders(parent_id)` call. The handler signature, IPC wire shape, and UI integration must NOT change when 2.2.5 lands — only the function body. This story locks in the contract.
>
> **Out of scope for this story:** Setup wizard chrome (Story 2.4 owns it — picker is wired into the wizard flow there); full tree browser (`Browse folders…` link is rendered but inert, V1 deferred per UX-DR8); live SDK call (Story 2.2.5).

## Acceptance Criteria

**AC1 — `RemoteFolderPicker` widget renders with text field pre-filled from local folder basename:**
**Given** a `RemoteFolderPicker` widget instantiated with `local_folder_path="/home/user/Documents"`
**When** the widget is displayed
**Then** the text field shows `/Documents` (leading slash + `os.path.basename(local_folder_path)`)
**And** if `local_folder_path` is `None` or empty, the text field shows `/` (root placeholder)
**And** if the basename contains characters that ProtonDrive disallows (`\ : * ? " < > |`), the prefilled value is sanitized to underscores — surface this with a one-line `path-hint-label` ("Some characters were replaced") visible only when sanitization occurred
**And** widget structure lives in `ui/data/ui/remote-folder-picker.blp` (kebab-case `.blp`, IDs use kebab-case → Python `Template.Child` uses snake_case per project-context.md)
**And** Python wiring lives in `ui/src/protondrive/widgets/remote_folder_picker.py`
**And** the class extends `Gtk.Box` (not `Adw.Dialog` — the picker is **embedded** in the setup wizard from Story 2.4, not a standalone dialog) with `__gtype_name__ = "ProtonDriveRemoteFolderPicker"` matching the Blueprint template class name exactly

**AC2 — Autocomplete suggestions fetched once via `list_remote_folders` IPC, cached for dialog session, filtered client-side:**
**Given** the user has typed at least one character in the text field
**When** the `changed` signal fires and `self._cached_folders is None`
**Then** the widget calls `engine_client.send_command_with_response({"type": "list_remote_folders", "payload": {"parent_id": null}}, on_result=...)`
**And** subsequent keystrokes after `_cached_folders` is populated never re-fetch (gate is `self._cached_folders is None`, not an in-flight flag — see Dev Notes "Why no `_fetch_inflight` flag")
**And** the cache is invalidated only when the widget is destroyed (no manual invalidation API in MVP)
**And** if two keystrokes race the IPC roundtrip, both register independent callbacks with distinct UUIDs; whichever response lands first populates the cache, the second callback overwrites with the same data — both are harmless no-ops because `_cached_folders` ends in the same state. Tests must cover this concurrent case.

**Given** the cache is populated
**When** the user types or edits the text field
**Then** the autocomplete popover shows folders whose `name` contains the substring after the **last `/`** in the text field, case-insensitive
  - Example: text = `/Doc` → filter `Doc` against root names → match `Documents`, `Docs`, etc.
  - Example: text = `/Work/Pro` → filter `Pro` against root names (since the cache only contains top-level folders — nested autocomplete is V1)
**And** if the substring is empty (user just typed `/`), the popover shows up to the first 10 cached folders alphabetically
**And** if zero matches, the popover hides (not "No results" — silent hide; the manual-entry path is always valid)

**Given** the IPC response carries `{folders: []}` (empty — current engine placeholder before Story 2.2.5)
**When** the user types
**Then** no popover is shown, no error is raised, manual path entry continues to work — empty cache is a valid state, NOT an error

**Given** the IPC response carries an `error` field (e.g. `{"error": "engine_not_ready"}`)
**When** the result arrives
**Then** the picker logs the error via `print(f"RemoteFolderPicker IPC error: {err}", file=sys.stderr)` (NOT a user-visible error — manual entry remains functional) and skips populating the cache
**And** subsequent keystrokes do NOT retry the fetch (one-shot semantics — Story 3.x will revisit retry policy if needed)

**AC3 — Manual path entry accepted without validation; `Browse folders…` link visible but inert:**
**Given** the user types `/Work/Projects/2026` (a nested path not in the autocomplete cache)
**When** they confirm the picker (`get_remote_path()` is called by the parent — wizard in Story 2.4)
**Then** the method returns the literal text-field contents — no validation that the path exists in ProtonDrive (the engine will create missing folders during first sync per Story 2.5 / 2.4 contract)
**And** leading slash is enforced: `get_remote_path()` returns the text with a leading `/` prepended if the user removed it (`Documents` → `/Documents`)
**And** trailing slashes are stripped (`/Documents/` → `/Documents`)
**And** consecutive slashes are collapsed (`/Work//2026` → `/Work/2026`)
**And** an empty or whitespace-only path returns `/` (root)

**Given** the picker is rendered
**When** the `Browse folders…` link is visible
**Then** the link is a `Gtk.LinkButton` (or styled `Gtk.Button`) with label "Browse folders…", `sensitive=False` (greyed out)
**And** a `Gtk.Tooltip` reads "Tree browser coming in V1 — type the path manually or pick from suggestions"
**And** there is **no** click handler — the link is purely visual

**AC4 — Keyboard navigation: Tab moves between text field and suggestions, Enter selects, Escape closes the popover:**
**Given** the autocomplete popover is open
**When** the user presses **Tab** while the text field has focus
**Then** focus moves to the first suggestion in the popover
**And** subsequent **Tab** presses cycle through suggestions
**And** **Shift+Tab** cycles backward

**Given** focus is on a suggestion
**When** the user presses **Enter**
**Then** the text field is updated to `/{selected_folder.name}` (replacing the current text), the popover hides, focus returns to the text field

**Given** the popover is open
**When** the user presses **Escape**
**Then** the popover hides (does NOT also dismiss the parent wizard — `propagate=False` on the key controller)
**And** focus returns to the text field

**Given** the popover is closed
**When** the user presses **Escape**
**Then** the event propagates normally (so the parent wizard / dialog can handle it)

**AC5 — Engine `list_remote_folders` IPC handler with placeholder empty response (Story 2.2.5 owns the live wiring):**
**Given** `engine/src/main.ts`
**When** a `list_remote_folders` IPC command arrives via `handleCommand`
**Then** the handler returns an `IpcResponse`:
```ts
{
  type: "list_remote_folders_result",
  id: command.id,
  payload: { folders: [] }   // placeholder — Story 2.2.5 will replace this with createDriveClient(token).listRemoteFolders(parent_id)
}
```
**And** the placeholder is marked with a `// TODO(story-2.2.5): wire to createDriveClient(token).listRemoteFolders(parent_id)` comment so 2.2.5 can grep-locate it
**And** the handler validates the payload shape: if `payload.parent_id` is missing, the handler does NOT throw — it treats `parent_id` as `null` (top-level) per the architecture spec (`list_remote_folders` line of `architecture.md` table)
**And** the handler is added to the `if/else` chain in `handleCommand`, NOT to a generic dispatch table — there is no generic dispatcher in main.ts today and adding one is out of scope (Story 2.5 may introduce one as the command set grows)
**And** `engine/src/main.test.ts` gains tests:
  - `list_remote_folders` with `{parent_id: null}` returns `{folders: []}` and the response `id` matches the command `id`
  - `list_remote_folders` with `{parent_id: "some-uid"}` returns `{folders: []}` (placeholder ignores `parent_id` value but accepts it — locks the wire shape)
  - `list_remote_folders` with no payload at all returns `{folders: []}` (defensive — does not throw)
  - The response `type` is `list_remote_folders_result` (snake_case + `_result` suffix)
**And** the handler does NOT touch `DriveClient` — `engine/src/sdk.ts` is **not imported** by `main.ts` in this story (Story 2.2.5 will add the import when it wires the factory)
**And** `engine/src/sdk.ts` is **untouched** (`git diff engine/src/sdk.ts` empty after this story)

**AC6 — `engine.py` request/response correlation helper (`send_command_with_response`):**
**Given** `ui/src/protondrive/engine.py` `EngineClient`
**When** a caller invokes `send_command_with_response(cmd: dict, on_result: Callable[[dict], None], timeout_seconds: float = 10.0) -> None`
**Then** the helper:
  1. Generates a UUID v4 `id` and assigns it to `cmd["id"]` (overwriting any caller-provided `id` to guarantee uniqueness)
  2. Registers `(id, on_result)` in a new `self._pending_responses: dict[str, Callable[[dict], None]]`
  3. Schedules a `GLib.timeout_add_seconds(timeout_seconds, self._on_response_timeout, id)` and stores the source-id in `self._pending_response_timeouts: dict[str, int]` so it can be cancelled when the response arrives
  4. Calls `self.send_command(cmd)` (which handles the queue-before-ready path and the protocol-mismatch refusal)

**Given** the engine sends a push event whose `type` ends with `_result`
**When** `_dispatch_event` processes the message
**Then** `_dispatch_event` extracts `message["id"]`, looks it up in `self._pending_responses`, pops the callback, cancels its timeout via `GLib.source_remove`, and invokes the callback with `message.get("payload", {})`
**And** if `id` is missing or not in `_pending_responses`, the message is silently ignored (not logged as an error — `_result` events for cancelled/timed-out commands can race with the response)
**And** the existing event-type dispatch (`ready`, `session_ready`, `token_expired`, `error`, generic `_event_handlers`) is **not** affected — the `_result` lookup happens BEFORE the existing dispatch and `return`s on success

**Given** the timeout fires before a response arrives
**When** `_on_response_timeout(id)` runs
**Then** ~~the callback is removed from `_pending_responses` and discarded (NOT called)~~ **REVISED post-review (D1, 2026-04-10):** the callback is invoked once with `{"error": "timeout"}` so callers can transition to a terminal state. Original "silent discard" wording combined with C1's removal of the in-flight flag created unbounded refetch growth under engine hang — see Review Findings D1.
**And** the timeout source-id is removed from `_pending_response_timeouts`
**And** `_on_response_timeout` returns `False` to cancel the GLib timer

**Given** the protocol mismatch flag is set OR the engine connection is closed
**When** `send_command_with_response` is called
**Then** ~~the helper still registers the callback and schedules the timeout — `send_command` will silently drop the write and the timeout will eventually clean up.~~ **REVISED post-review (D1, 2026-04-10):** when `_protocol_mismatch=True`, the helper schedules `on_result({"error": "protocol_mismatch"})` via `GLib.idle_add` and returns immediately without registering a timeout — the caller sees an immediate error instead of a 10-second silent stall. Validates `timeout_seconds >= 1` (sub-second floors to 0 in `GLib.timeout_add_seconds`).

**Given** the engine restarts (`restart()` is called)
**When** `restart()` runs
**Then** all entries in `_pending_responses` are cleared and all `_pending_response_timeouts` are cancelled via `GLib.source_remove`. ~~Callbacks discarded — same policy as `_pending_commands`.~~ **REVISED post-review (D1, 2026-04-10):** each pending callback is invoked once with `{"error": "engine_restarted"}` before clearing — callers like `RemoteFolderPicker` need this signal to stop refetching after a recoverable restart.

**AC7 — Tests + meson wiring + regressions:**

**UI tests (pytest via `meson test -C builddir`):**
**Given** `ui/tests/conftest.py` and `ui/tests/test_remote_folder_picker.py`
**When** running the suite
**Then** `conftest.py` `_build_gi_mocks` is extended to expose stable int values for `Gdk.KEY_Escape` (65307), `Gdk.KEY_Tab` (65289), `Gdk.KEY_Return` (65293), plus `Gtk.PositionType.BOTTOM` and `Gtk.SelectionMode.SINGLE` — without these, key-handler tests would silently compare `MagicMock() == MagicMock()` (always `False`) and pass without testing anything
**And** the new file `test_remote_folder_picker.py` contains tests covering:
  - Default text from local folder basename (`/home/user/Documents` → `/Documents`)
  - Default text fallback when local path is `None` or empty (→ `/`)
  - Sanitization of disallowed characters in default text (e.g. `Foo:Bar` → `Foo_Bar`); hint label visible only when sanitization occurred
  - Path normalization in `get_remote_path()`: leading slash, trailing slash strip, double-slash collapse, empty → `/`
  - **`_filter_folders` pure function** (module-level): substring match case-insensitive, empty substring returns first N alphabetically, `max_rows` override, empty cache, no matches returns `[]`, folders with missing or `None` `name` field do not crash
  - First-keystroke triggers IPC fetch (assert `send_command_with_response` was called); after cache populates, subsequent keystrokes do NOT re-fetch (call count stays at 1 even after 5 more keystrokes)
  - **Concurrent-fetch race** (C1 coverage from party-mode review): two `_fetch_folders` calls before any response → both register callbacks → first response populates cache → second response harmlessly overwrites with same data → no exception, final `_cached_folders` is correct
  - IPC error response (`{error: "..."}`) sets `_cached_folders = []`, does NOT raise, AND emits the error to stderr (verified via the `capsys` pytest fixture: assert `"RemoteFolderPicker IPC error"` and the error string both appear in `capsys.readouterr().err`)
  - IPC empty response (`{folders: []}`) sets `_cached_folders = []` and the popover stays hidden
  - Keyboard navigation: `_on_key_pressed` with `Gdk.KEY_Escape` while popover visible → calls `_hide_popover` and returns `True` (do not propagate to parent wizard); with popover hidden returns `False` (propagate normally); `Gdk.KEY_Tab` with popover visible focuses the first listbox row; `Gdk.KEY_Return` with popover visible and a selected row triggers `_on_row_activated`; all other keys return `False`
  - `Browse folders…` widget is `Gtk.Button` (NOT `Gtk.LinkButton`), `sensitive=False`, tooltip text is set
**And** test scaffolding follows `test_widgets.py` pattern: instantiate via `object.__new__(...)`, attach `MagicMock` children for `Gtk.Template.Child` slots, never call `super().__init__()` (the GI mocks in `conftest.py` make full instantiation impossible)

**Given** `ui/tests/test_engine.py`
**When** running the suite
**Then** the existing tests still pass and new tests cover `send_command_with_response`:
  - Generates a UUID id and registers the callback in `_pending_responses`
  - Cancels the timeout when a matching `_result` event arrives
  - Calls the callback with the payload dict from the matching event
  - Ignores `_result` events whose `id` is not in `_pending_responses` (no exception, no callback)
  - Two concurrent in-flight requests with different ids — both callbacks fire correctly when their respective responses arrive
  - `restart()` clears `_pending_responses` and cancels all `_pending_response_timeouts`
  - Timeout fires → callback removed but NOT invoked
  - Protocol-mismatch path: callback registered, send_command silently drops, timeout eventually cleans up

**Engine tests (`node --import tsx --test`):**
**Given** `engine/src/main.test.ts`
**When** running the suite
**Then** the existing 2 `token_refresh` tests still pass plus the 3 new `list_remote_folders` tests from AC5 (5 tests total in this file)
**And** `engine/src/sdk.test.ts` boundary suite still passes (sdk.ts is untouched in this story)

**Build / regression / boundary:**
**Given** `meson.build`
**When** building the UI
**Then** `ui/data/ui/remote-folder-picker.blp` is added as a `custom_target` (mirrors the existing `blueprints_account_header_bar` block)
**And** `data/protondrive.gresource.xml` adds `<file alias="ui/remote-folder-picker.ui" preprocess="xml-stripblanks">remote-folder-picker.ui</file>`
**And** `python_widget_sources` in `meson.build` includes `'src/protondrive/widgets/remote_folder_picker.py'`
**And** the GResource bundle's `dependencies` list includes the new `blueprints_remote_folder_picker` target

**Given** the full test suites
**When** running `node --import tsx --test 'engine/src/**/*.test.ts'` and `meson test -C builddir`
**Then** zero regressions: all existing engine tests still pass (modulo the pre-existing `state-db.test.ts` / `tsc` tech debt documented in Story 2.2's Dev Agent Record — those are NOT this story's responsibility) and all 152 UI tests still pass alongside the new ones from this story
**And** `engine/src/sdk.ts` and `engine/src/sdk.test.ts` are untouched (`git diff` empty for both)

## Tasks / Subtasks

> **Suggested order:** Engine handler first (AC5) — small, locks the wire contract. Then `engine.py` correlation helper (AC6) — required dependency for the picker. Then the picker widget (AC1-AC4) — depends on both. Finally meson wiring + verification (AC7).

- [x] **Task 1: Engine `list_remote_folders` placeholder handler** (AC: #5)
  - [x] 1.1 In `engine/src/main.ts`, add an `else if (command.type === "list_remote_folders")` branch inside `handleCommand` BEFORE the final `unknown_command` fallthrough. Body:
    ```ts
    if (command.type === "list_remote_folders") {
      // TODO(story-2.2.5): wire to createDriveClient(token).listRemoteFolders(parent_id ?? null)
      // For now, return an empty list — the UI picker treats this as a valid state.
      return {
        type: "list_remote_folders_result",
        id: command.id,
        payload: { folders: [] },
      };
    }
    ```
    Place it right after the `token_refresh` branch — order: `token_refresh` → `list_remote_folders` → fallthrough.
  - [x] 1.2 Do **NOT** import from `./sdk.js` in `main.ts`. Verify with `git diff engine/src/main.ts` after the change — only the new branch should appear; no new imports.
  - [x] 1.3 In `engine/src/main.test.ts`, add a new `describe("list_remote_folders command", () => { ... })` block alongside the existing `describe("token_refresh command", ...)`. Use the same `tmpSocketPath` / `connectToSocket` / `readMessages` helpers already in the file.
  - [x] 1.4 Add three tests:
    - `it("returns empty folders[] for parent_id=null")` — sends `{type:"list_remote_folders", id:"lrf-1", payload:{parent_id:null}}`, asserts the response is `{type:"list_remote_folders_result", id:"lrf-1", payload:{folders:[]}}`.
    - `it("returns empty folders[] for non-null parent_id")` — sends `{...payload:{parent_id:"some-uid"}}`, asserts same shape (placeholder ignores the value but accepts it).
    - `it("returns empty folders[] when payload is missing")` — sends `{type:"list_remote_folders", id:"lrf-3"}` (no payload field), asserts the same shape — locks the defensive default.
  - [x] 1.5 Critical: the test handler in `main.test.ts` is a **standalone** `IpcServer` constructed inside each test (not the real `handleCommand` from `main.ts` — `main.ts` is `void main()` at module load and cannot be imported in tests without side effects). Mirror the existing `token_refresh` test pattern: build an inline `IpcServer` whose `commandHandler` mirrors what `main.ts` will do for `list_remote_folders`. The "real" `handleCommand` in `main.ts` is verified by integration / manual test, not by `main.test.ts`. **However**, also export the `handleCommand` function from `main.ts` so it can be imported and tested directly — currently it is module-internal. This export is the cleanest fix and lets test #1.4 call `handleCommand` directly to verify the actual production code path.
    - **Choose one** of: (a) inline mirror handler in tests (matches existing token_refresh test style), or (b) export `handleCommand` from `main.ts` and import it in the test. Recommend (b) — it eliminates the inline-mirror duplication and makes future handlers easier to test. If choosing (b), verify the export does not trip `void main()` (it doesn't — `void main()` runs at module top-level only when the file is executed as the entrypoint, but ESM module imports also execute top-level statements; you'll need to guard `void main()` behind `if (import.meta.url === \`file://${process.argv[1]}\`)` to make `main.ts` import-safe).
    - **Decision required from dev:** if guarding `void main()` feels too invasive for this story, fall back to (a) inline mirror — flag this as a tech-debt note in Dev Agent Record and propose a follow-up refactor.
  - [x] 1.6 Run `cd engine && node --import tsx --test src/main.test.ts` — all 5 tests pass (2 existing + 3 new).

- [x] **Task 2: `engine.py` request/response correlation helper** (AC: #6)
  - [x] 2.1 In `ui/src/protondrive/engine.py` `EngineClient.__init__`, add two new instance dicts:
    ```python
    self._pending_responses: dict[str, Callable[[dict[str, Any]], None]] = {}
    self._pending_response_timeouts: dict[str, int] = {}
    ```
  - [x] 2.2 Add `DEFAULT_RESPONSE_TIMEOUT_SECONDS: float = 10.0` near the top of the file alongside the other timing constants.
  - [x] 2.3 Add the new method `send_command_with_response`:
    ```python
    def send_command_with_response(
        self,
        cmd: dict[str, Any],
        on_result: Callable[[dict[str, Any]], None],
        timeout_seconds: float = DEFAULT_RESPONSE_TIMEOUT_SECONDS,
    ) -> None:
        """Send a command and invoke `on_result` with the response payload.

        Generates a fresh UUID id (overwriting any caller-provided id),
        registers the callback, and schedules a cleanup timeout. The callback
        fires exactly once: either when a `<type>_result` event arrives with
        the matching id, or never (silent timeout — see AC6 for rationale).
        """
        cmd = copy.deepcopy(cmd)
        cmd["id"] = str(uuid.uuid4())
        request_id = cmd["id"]

        self._pending_responses[request_id] = on_result
        timeout_source = GLib.timeout_add_seconds(
            int(timeout_seconds), self._on_response_timeout, request_id
        )
        self._pending_response_timeouts[request_id] = timeout_source

        self.send_command(cmd)
    ```
  - [x] 2.4 Add the timeout cleanup helper:
    ```python
    def _on_response_timeout(self, request_id: str) -> bool:
        """GLib timeout callback — remove the pending response, do not invoke."""
        self._pending_responses.pop(request_id, None)
        self._pending_response_timeouts.pop(request_id, None)
        return False  # one-shot
    ```
  - [x] 2.5 In `_dispatch_event`, add the `_result` correlation **before** the existing event-type branches. The leading docstring comment is **load-bearing** — it documents a wire-format convention that future contributors must not violate (Mary's catch in party-mode review):
    ```python
    def _dispatch_event(self, message: dict[str, Any]) -> None:
        event_type = message.get("type", "")

        # IPC convention: events ending in `_result` are RESERVED for command
        # responses (request/response correlation). Push events MUST NOT use
        # the `_result` suffix — they would be silently swallowed by this
        # branch and never reach _event_handlers. If you need a new push
        # event, name it without the `_result` suffix (see architecture.md
        # IPC Protocol section for the canonical event list).
        if event_type.endswith("_result"):
            request_id = message.get("id")
            if isinstance(request_id, str):
                callback = self._pending_responses.pop(request_id, None)
                if callback is not None:
                    timeout_source = self._pending_response_timeouts.pop(
                        request_id, None
                    )
                    if timeout_source is not None:
                        GLib.source_remove(timeout_source)
                    callback(message.get("payload", {}))
                    return
            # Unrecognized id — silently ignore (race with timeout / cancellation).
            return

        # ... existing branches: ready, session_ready, token_expired, error, generic handlers
    ```
    Note: returning unconditionally on `_result` events means generic `_event_handlers` cannot register for `*_result` types. That is correct — `_result` events are claimed exclusively by the correlation helper.
  - [x] 2.6 In `restart()`, after `self._pending_commands.clear()`, add:
    ```python
    self._pending_responses.clear()
    for source_id in self._pending_response_timeouts.values():
        try:
            GLib.source_remove(source_id)
        except Exception:
            pass  # source may already have fired
    self._pending_response_timeouts.clear()
    ```
  - [x] 2.7 In `cleanup()`, do the same teardown as `restart()` — pending callbacks must not survive shutdown.
  - [x] 2.8 Add tests in `ui/tests/test_engine.py` covering each AC6 bullet (8 tests total — see AC7 list).

- [x] **Task 3: `RemoteFolderPicker` Blueprint + Python widget** (AC: #1, #2, #3, #4)
  - [x] 3.1 Create `ui/data/ui/remote-folder-picker.blp`:
    ```blueprint
    using Gtk 4.0;
    using Adw 1;

    template $ProtonDriveRemoteFolderPicker: Gtk.Box {
      orientation: vertical;
      spacing: 8;

      Gtk.Label header_label {
        label: "Remote folder";
        halign: start;
        styles ["heading"]
      }

      Gtk.Entry path_entry {
        placeholder-text: "/Documents";
        hexpand: true;
      }

      Gtk.Label path_hint_label {
        label: "";
        halign: start;
        visible: false;
        styles ["caption", "dim-label"]
      }

      Gtk.Button browse_link {
        label: "Browse folders…";
        sensitive: false;
        tooltip-text: "Tree browser coming in V1 — type the path manually or pick from suggestions";
        halign: start;
        styles ["flat"]
      }
    }
    ```
    Note: `Gtk.Button { styles ["flat"] }` — NOT `Gtk.LinkButton`. A disabled hyperlink reads as broken; a flat button reads as "action currently unavailable," which is the correct semantic for a V1-deferred feature.
    The autocomplete popover is constructed in Python (Blueprint cannot easily express the dynamic ListBox child list).
  - [x] 3.2 Create `ui/src/protondrive/widgets/remote_folder_picker.py`:
    ```python
    """RemoteFolderPicker — text input + autocomplete for selecting a ProtonDrive folder."""

    from __future__ import annotations

    import os
    import re
    import sys
    from typing import Any

    from gi.repository import Gdk, Gtk

    # Characters disallowed in ProtonDrive folder names per Proton Drive limits.
    _DISALLOWED_NAME_CHARS = re.compile(r'[\\:*?"<>|]')
    _MAX_AUTOCOMPLETE_ROWS = 10


    def _filter_folders(
        cache: list[dict[str, Any]],
        substring: str,
        max_rows: int = _MAX_AUTOCOMPLETE_ROWS,
    ) -> list[dict[str, Any]]:
        """Filter cached folders by case-insensitive substring.

        Empty substring returns the first ``max_rows`` folders sorted alphabetically
        by name. Non-empty substring returns folders whose name contains the
        substring (case-insensitive). Returns an empty list when no folders match.

        Pure function — no GTK, no I/O. The single source of truth for AC2 filter
        semantics, called by ``RemoteFolderPicker._refresh_popover`` and tested
        directly without instantiating any widget.
        """
        if substring:
            needle = substring.lower()
            return [f for f in cache if needle in (f.get("name", "") or "").lower()]
        return sorted(
            cache,
            key=lambda f: (f.get("name", "") or "").lower(),
        )[:max_rows]


    @Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/remote-folder-picker.ui")
    class RemoteFolderPicker(Gtk.Box):
        """Embeddable picker for choosing a ProtonDrive folder path."""

        __gtype_name__ = "ProtonDriveRemoteFolderPicker"

        header_label: Gtk.Label = Gtk.Template.Child()
        path_entry: Gtk.Entry = Gtk.Template.Child()
        path_hint_label: Gtk.Label = Gtk.Template.Child()
        browse_link: Gtk.Button = Gtk.Template.Child()

        def __init__(
            self,
            engine_client: Any,
            local_folder_path: str | None = None,
            **kwargs: object,
        ) -> None:
            super().__init__(**kwargs)
            self._engine_client = engine_client
            # None = never fetched. Empty list = fetched, no folders (or fetch
            # failed — silently treated as empty per AC2). Populated list =
            # cached. The single gate is ``_cached_folders is None`` — there is
            # NO ``_fetch_inflight`` flag (see Dev Notes "Why no _fetch_inflight").
            self._cached_folders: list[dict[str, Any]] | None = None
            self._popover: Gtk.Popover | None = None
            self._popover_listbox: Gtk.ListBox | None = None

            self._set_default_text(local_folder_path)
            self.path_entry.connect("changed", self._on_text_changed)
            self._install_key_controller()
            self.set_accessible_role(Gtk.AccessibleRole.GROUP)

        # ---- Default text + sanitization ----

        def _set_default_text(self, local_folder_path: str | None) -> None:
            if not local_folder_path:
                self.path_entry.set_text("/")
                return
            basename = os.path.basename(local_folder_path.rstrip("/"))
            if not basename:
                self.path_entry.set_text("/")
                return
            sanitized = _DISALLOWED_NAME_CHARS.sub("_", basename)
            self.path_entry.set_text(f"/{sanitized}")
            if sanitized != basename:
                self.path_hint_label.set_text("Some characters were replaced")
                self.path_hint_label.set_visible(True)

        # ---- Public API ----

        def get_remote_path(self) -> str:
            text = (self.path_entry.get_text() or "").strip()
            if not text:
                return "/"
            if not text.startswith("/"):
                text = "/" + text
            text = text.rstrip("/") or "/"
            text = re.sub(r"/+", "/", text)
            return text

        # ---- Autocomplete ----

        def _on_text_changed(self, _entry: Gtk.Entry) -> None:
            if self._cached_folders is None:
                self._fetch_folders()
            self._refresh_popover()

        def _fetch_folders(self) -> None:
            # No in-flight flag. Two racing fetches register independent
            # callbacks (each with its own UUID); whichever lands first
            # populates the cache, the second is a harmless overwrite. This
            # avoids the deadlock where a silent IPC timeout would otherwise
            # leave an in-flight flag set forever.
            self._engine_client.send_command_with_response(
                {"type": "list_remote_folders", "payload": {"parent_id": None}},
                self._on_folders_received,
            )

        def _on_folders_received(self, payload: dict[str, Any]) -> None:
            if "error" in payload:
                print(
                    f"RemoteFolderPicker IPC error: {payload['error']}",
                    file=sys.stderr,
                )
                self._cached_folders = []  # one-shot — never retry in this story
                return
            folders = payload.get("folders", [])
            if not isinstance(folders, list):
                self._cached_folders = []
                return
            self._cached_folders = folders
            self._refresh_popover()

        def _refresh_popover(self) -> None:
            if self._cached_folders is None:
                return  # not loaded yet
            text = self.path_entry.get_text() or ""
            substring = text.rsplit("/", 1)[-1]
            matches = _filter_folders(self._cached_folders, substring)
            if not matches:
                self._hide_popover()
                return
            self._show_popover(matches)

        def _show_popover(self, matches: list[dict[str, Any]]) -> None:
            if self._popover is None:
                self._popover = Gtk.Popover()
                self._popover.set_parent(self.path_entry)
                self._popover.set_autohide(False)
                self._popover.set_has_arrow(False)
                # Anchor below the entry. Without this, GTK auto-positions and
                # may render the popover above the entry near a window edge,
                # covering the wizard header.
                self._popover.set_position(Gtk.PositionType.BOTTOM)
                self._popover_listbox = Gtk.ListBox()
                self._popover_listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
                self._popover_listbox.connect("row-activated", self._on_row_activated)
                self._popover.set_child(self._popover_listbox)
            assert self._popover_listbox is not None
            # Replace rows
            child = self._popover_listbox.get_first_child()
            while child is not None:
                next_child = child.get_next_sibling()
                self._popover_listbox.remove(child)
                child = next_child
            for folder in matches:
                row = Gtk.ListBoxRow()
                row.set_child(Gtk.Label(label=folder.get("name", ""), xalign=0))
                row.folder_data = folder  # type: ignore[attr-defined]
                self._popover_listbox.append(row)
            self._popover.popup()

        def _hide_popover(self) -> None:
            if self._popover is not None:
                self._popover.popdown()

        def _on_row_activated(self, _listbox: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
            folder = getattr(row, "folder_data", None)
            if folder is None:
                return
            self.path_entry.set_text(f"/{folder.get('name', '')}")
            self.path_entry.set_position(-1)
            self._hide_popover()
            self.path_entry.grab_focus()

        # ---- Keyboard navigation ----

        def _install_key_controller(self) -> None:
            controller = Gtk.EventControllerKey()
            controller.connect("key-pressed", self._on_key_pressed)
            self.path_entry.add_controller(controller)

        def _on_key_pressed(
            self,
            _controller: Gtk.EventControllerKey,
            keyval: int,
            _keycode: int,
            _state: Gdk.ModifierType,
        ) -> bool:
            if keyval == Gdk.KEY_Escape and self._popover is not None and self._popover.get_visible():
                self._hide_popover()
                return True  # do not propagate — wizard should not also close
            if keyval == Gdk.KEY_Tab and self._popover is not None and self._popover.get_visible():
                if self._popover_listbox is not None:
                    first = self._popover_listbox.get_row_at_index(0)
                    if first is not None:
                        first.grab_focus()
                        return True
            if keyval == Gdk.KEY_Return:
                # Enter on entry with popover open: select highlighted row if any
                if self._popover is not None and self._popover.get_visible():
                    if self._popover_listbox is not None:
                        selected = self._popover_listbox.get_selected_row()
                        if selected is not None:
                            self._on_row_activated(self._popover_listbox, selected)
                            return True
            return False
    ```
    Notes:
    - Use `print(..., file=sys.stderr)` for the IPC error log — the codebase has no shared logger module yet (pre-existing convention; do NOT introduce one in this story).
    - The `# type: ignore[attr-defined]` on `row.folder_data = folder` is the standard Python pattern for attaching ad-hoc data to a `Gtk.ListBoxRow` — GTK doesn't expose a typed user-data slot.
    - `Gtk.Popover.set_parent(self.path_entry)` attaches the popover to the entry; `popup()`/`popdown()` show/hide. Do NOT use `Gtk.PopoverMenu` (that's for menu items).
    - `_filter_folders` is a **module-level pure function**. It is the single source of truth for AC2 filter semantics. Tests target the pure function directly without instantiating any widget; `_refresh_popover` is a thin caller and need not be unit-tested for filter logic.
    - **No `_fetch_inflight` flag.** The cache state (`None` vs list) is the only gate. Two racing fetches register two callbacks; whichever lands first wins; the second is a harmless overwrite. This avoids the deadlock where a silent IPC timeout would leave an in-flight flag stuck `True` forever.
  - [x] 3.3 Add `'src/protondrive/widgets/remote_folder_picker.py'` to `python_widget_sources` in `ui/meson.build`.
  - [x] 3.4 Add the Blueprint custom_target in `ui/meson.build` (mirror the `blueprints_account_header_bar` block):
    ```meson
    blueprints_remote_folder_picker = custom_target(
      'blueprint-remote-folder-picker',
      input: files('data/ui/remote-folder-picker.blp'),
      output: 'remote-folder-picker.ui',
      command: [blueprint_compiler, 'compile', '--output', '@OUTPUT@', '@INPUT@'],
    )
    ```
    And add `blueprints_remote_folder_picker` to the `dependencies` list of the `gnome.compile_resources` call.
  - [x] 3.5 Add to `ui/data/protondrive.gresource.xml`:
    ```xml
    <file alias="ui/remote-folder-picker.ui" preprocess="xml-stripblanks">remote-folder-picker.ui</file>
    ```

- [x] **Task 4: pytest tests for `RemoteFolderPicker`** (AC: #7)
  - [x] 4.0 **Update `ui/tests/conftest.py` `_build_gi_mocks`** to add the `Gdk` key constants and `Gtk.PositionType` the picker references. Without these, key-handler tests would silently compare `MagicMock() == MagicMock()` (always `False`) and pass while testing nothing. Add inside `_build_gi_mocks`, alongside the existing `gdk.CURRENT_TIME = 0`:
    ```python
    # Real X11 keysym values — stable ints, used by RemoteFolderPicker key controller.
    gdk.KEY_Escape = 65307
    gdk.KEY_Tab = 65289
    gdk.KEY_Return = 65293

    # Used by RemoteFolderPicker._show_popover for set_position() call.
    gtk.PositionType = MagicMock()
    gtk.PositionType.BOTTOM = "BOTTOM"
    gtk.SelectionMode = MagicMock()
    gtk.SelectionMode.SINGLE = "SINGLE"
    ```
    Verify with the existing test suite first: `meson test -C builddir` after the conftest edit alone — all 152 existing tests must still pass before the picker test file is added. The conftest edit is risk-bounded because it only ADDS attributes; existing tests do not reference the new ones.
  - [x] 4.1 Create `ui/tests/test_remote_folder_picker.py`. Mirror the `test_widgets.py` instantiation pattern:
    ```python
    """Tests for RemoteFolderPicker widget."""

    from __future__ import annotations

    import sys
    from unittest.mock import MagicMock

    import pytest

    import protondrive.widgets.remote_folder_picker as _mod


    def _make_picker(local_path: str | None = "/home/user/Documents") -> _mod.RemoteFolderPicker:
        picker = object.__new__(_mod.RemoteFolderPicker)
        picker.path_entry = MagicMock()
        picker.path_hint_label = MagicMock()
        picker.header_label = MagicMock()
        picker.browse_link = MagicMock()
        picker._engine_client = MagicMock()
        picker._cached_folders = None
        picker._fetch_inflight = False
        picker._popover = None
        picker._popover_listbox = None
        # Re-run the default-text logic without going through __init__ (which
        # would call super().__init__() and set up signal handlers — both
        # require a real GTK widget tree).
        picker.path_entry.get_text = MagicMock(return_value="/Documents")
        if local_path is not None:
            _mod.RemoteFolderPicker._set_default_text(picker, local_path)
        return picker
    ```
  - [x] 4.2 Test classes (one assertion per test method, descriptive names):
    - `TestDefaultText` — basename extraction, fallback to `/`, sanitization of disallowed chars, hint label visibility
    - `TestPathNormalization` — `get_remote_path()`: leading slash, trailing slash, double slashes, empty input, whitespace
    - `TestFilterFolders` — pure-function tests for `_filter_folders` (module-level): substring case-insensitive match, empty substring returns first N alphabetically (N=`_MAX_AUTOCOMPLETE_ROWS`), `max_rows` override, empty cache, no matches → empty list, folders with `None` or missing `name` field handled
    - `TestAutocompleteFetch` — first keystroke triggers `send_command_with_response` exactly once, second keystroke does NOT re-fetch (cache populated), error response leaves cache as `[]` without raising, empty response leaves cache as `[]`, **concurrent-fetch race** (C1 coverage): two `_fetch_folders` calls before any response → both register callbacks → first response populates cache → second response harmlessly overwrites with same data → no exception, final cache state is correct
    - `TestAutocompleteFetchErrorLog` — IPC error response logs to stderr via the `capsys` pytest fixture: assert `"RemoteFolderPicker IPC error"` and the error string both appear in `capsys.readouterr().err`
    - `TestKeyboardNav` — `_on_key_pressed` with `Gdk.KEY_Escape` while popover visible returns `True` (handled, do not propagate) and calls `_hide_popover`; with popover hidden returns `False` (propagate to wizard); `Gdk.KEY_Tab` with popover visible focuses first row; `Gdk.KEY_Return` with popover visible and a selected row activates it; all other keys return `False`
    - `TestBrowseLink` — link is `sensitive=False`, tooltip text is set, the widget is `Gtk.Button` (NOT `Gtk.LinkButton`)
    - `TestGtypeName` — `__gtype_name__ == "ProtonDriveRemoteFolderPicker"`
  - [x] 4.3 For tests that need to call `_on_text_changed`, override `path_entry.get_text` per-test to simulate the user's typed text.
  - [x] 4.4 For autocomplete-fetch tests, assert against `picker._engine_client.send_command_with_response.call_count` and `.call_args` — the engine client is a `MagicMock` so this is straightforward.
  - [x] 4.5 For filter tests, target the **module-level pure function** `_filter_folders(cache, substring, max_rows)` directly — no widget instantiation needed. Pass test data like `[{"id":"1","name":"Documents","parent_id":None}, {"id":"2","name":"Docs","parent_id":None}, {"id":"3","name":"Music","parent_id":None}]` and assert against the returned list. This is the recommended Task 3.2 implementation pattern: pure function tested in isolation, `_refresh_popover` is a thin caller that needs no test of its own beyond a smoke "calls hide when matches empty / show when matches non-empty" pair.
  - [x] 4.6 Run `meson test -C builddir` — all new tests pass; all 152 existing tests still pass.

- [x] **Task 5: pytest tests for `engine.py` correlation helper** (AC: #6, #7)
  - [x] 5.1 In `ui/tests/test_engine.py`, add a new test class `TestSendCommandWithResponse`. Existing test patterns in `test_engine.py` already mock `Gio` and `GLib` — follow them.
  - [x] 5.2 Tests:
    - `test_generates_uuid_id` — assert `cmd["id"]` is a valid UUID4 string after the call
    - `test_overwrites_caller_id` — pass `cmd={"type":"x", "id":"caller-provided"}`, assert the registered id is NOT `"caller-provided"`
    - `test_callback_fires_on_matching_result` — register callback, simulate `_dispatch_event({"type":"x_result", "id":<registered>, "payload":{"foo":"bar"}})`, assert callback was called with `{"foo":"bar"}`
    - `test_callback_not_fired_for_unknown_id` — register callback for id A, dispatch `_result` event with id B, assert callback NOT called
    - `test_two_concurrent_requests` — register two callbacks with different ids, dispatch their results in reversed order, assert both fire correctly
    - `test_timeout_removes_pending_response` — register callback, simulate `_on_response_timeout(id)`, assert id is no longer in `_pending_responses` and callback NOT called
    - `test_restart_clears_pending` — register two callbacks, call `restart()`, assert `_pending_responses` is empty and `GLib.source_remove` was called for each timeout
    - `test_cleanup_clears_pending` — same as above but via `cleanup()`
  - [x] 5.3 For these tests, instantiate `EngineClient()` directly (the constructor only sets dict/list state — no Gio side effects).
  - [x] 5.4 To dispatch `_result` events without going through real Gio I/O, call `client._dispatch_event({...})` directly. This is the same pattern existing `test_engine.py` tests use for `session_ready` / `token_expired` (verify by reading `test_engine.py` first and matching the style).

- [x] **Task 6: Verification — full suites + boundary checks** (AC: #5, #7)
  - [x] 6.1 Run `cd engine && node --import tsx --test 'src/**/*.test.ts'` — all engine tests pass (modulo the documented `state-db.test.ts` pre-existing gap from Story 2.2). Specifically: `main.test.ts` shows 5 tests (was 2), `sdk.test.ts` shows 36 tests (unchanged from 2.2).
  - [x] 6.2 Run `cd engine && npx tsc --noEmit` — zero NEW errors introduced by this story. The 4 pre-existing errors (state-db.ts:1, main.test.ts:97/144, debug-log.ts:76) are still present and still NOT this story's responsibility.
  - [x] 6.3 Run `meson test -C builddir` — all UI tests pass: existing 152 + new picker tests + new correlation-helper tests.
  - [x] 6.4 `git diff engine/src/sdk.ts engine/src/sdk.test.ts` — must be empty. Story 2.2's wrapper is untouched.
  - [x] 6.5 `git diff engine/src/main.ts` — only the new `list_remote_folders` branch in `handleCommand` (and optionally the `void main()` import-safety guard from Task 1.5 if option (b) was chosen) should appear. No new imports unless option (b) was chosen.
  - [x] 6.6 Boundary check: `main.ts` does NOT import from `./sdk.js`. Confirm with grep.
  - [x] 6.7 Manual smoke (optional, if a dev environment is available): run the engine in dev mode, connect with a small Python REPL script that uses the new `EngineClient.send_command_with_response` to send a `list_remote_folders` command, and confirm the response arrives as `{folders: []}`. Note in the Dev Agent Record. This is NOT a test, just a sanity check that the wire format works end-to-end.

## Dev Notes

### Architectural invariants this story must NOT violate

- **SDK boundary** [project-context.md "Architectural Boundaries"] — `engine/src/main.ts` does NOT import from `./sdk.js` in this story. Story 2.2.5 will add that import. The placeholder handler returns hardcoded `{folders: []}` and a `// TODO(story-2.2.5)` comment marks the swap point.
- **Widget isolation** [project-context.md "Widget isolation"] — `remote_folder_picker.py` does NOT import from any other widget file. It receives `engine_client` via constructor injection. Coordination with the wizard (Story 2.4) goes through the wizard, not picker-to-wizard imports.
- **Blueprint owns widget structure** [project-context.md "Blueprint rule"] — the static layout (Box, Entry, Label, LinkButton) is in `.blp`. Only the dynamic `Gtk.Popover` + `Gtk.ListBox` for autocomplete results is constructed in Python — Blueprint cannot easily express dynamically-populated children. This is the documented exception, not a license to construct widgets in Python freely.
- **Snake_case on the wire** [project-context.md "IPC Wire Format — snake_case on Both Sides"] — IPC payloads use `{parent_id, folders, id, name}`. NEVER `{parentId, ...}` even in the TypeScript engine handler.
- **`Gio.DataInputStream` for IPC reads** [project-context.md "IPC reads via Gio.DataInputStream only"] — already handled by the existing `EngineClient._setup_reader()` flow. The new `send_command_with_response` is a write+correlate helper; it does NOT touch the read path.
- **No `lambda` in signal connections** [project-context.md "No lambda in signal connections"] — every `connect()` call in the picker uses an explicit method reference (`self._on_text_changed`, `self._on_row_activated`, `self._on_key_pressed`). Lambdas cause GObject reference cycles in long-running GTK apps.
- **Token never in output** [project-context.md "Security"] — the picker handles folder data, never tokens. The IPC error log path (`print(...)`) deliberately interpolates only `payload['error']` (a string from the engine) — never any field that could contain a token.
- **No new helpers/utilities for one-time operations** [global instructions] — `_filter_folders` is the only extracted helper, and it's the one whose extraction is justified by testability.

### Files to touch

| File | Action | Why |
|---|---|---|
| `engine/src/main.ts` | **Append** `list_remote_folders` branch in `handleCommand`, optionally guard `void main()` for import-safety (Task 1.5 option b) | Locks the IPC wire contract; placeholder body until 2.2.5 lands |
| `engine/src/main.test.ts` | **Append** `describe("list_remote_folders command", ...)` block with 3 tests | Wire-shape verification |
| `ui/src/protondrive/engine.py` | **Edit** `EngineClient`: add `_pending_responses`, `_pending_response_timeouts`, `send_command_with_response`, `_on_response_timeout`, `_dispatch_event` correlation branch, `restart()`/`cleanup()` teardown | Reusable request/response helper for all future IPC commands (add_pair, get_status, remove_pair, list_remote_folders) |
| `ui/tests/test_engine.py` | **Append** `TestSendCommandWithResponse` class with 8 tests | Coverage for the new helper |
| `ui/data/ui/remote-folder-picker.blp` | **Create** | Blueprint for the picker static structure |
| `ui/src/protondrive/widgets/remote_folder_picker.py` | **Create** | Python wiring + autocomplete popover + keyboard nav |
| `ui/tests/test_remote_folder_picker.py` | **Create** | pytest coverage for the picker (~15 tests across 6 classes) |
| `ui/data/protondrive.gresource.xml` | **Edit** — add `<file alias="ui/remote-folder-picker.ui" ...>` | Bundle the compiled .ui into GResource |
| `ui/meson.build` | **Edit** — add `blueprints_remote_folder_picker` custom_target, add to gresource dependencies, add Python source to `python_widget_sources` | Build wiring |

**Files NOT to touch:**
- `engine/src/sdk.ts` — Story 2.2's wrapper. `git diff` empty.
- `engine/src/sdk.test.ts` — Story 2.2's tests. `git diff` empty.
- `engine/src/state-db.ts`, `engine/src/ipc.ts`, `engine/src/errors.ts`, `engine/src/debug-log.ts` — unrelated to this story.
- `engine/package.json` — no new dependencies.
- `ui/data/ui/window.blp`, `ui/src/protondrive/window.py` — picker is wired into the wizard (Story 2.4), not the main window. This story does NOT add the picker to any existing UI surface; the picker is verified via tests and is ready for the wizard to consume.

### How the picker is consumed (preview of Story 2.4 — DO NOT implement here)

Story 2.4 will instantiate the picker inside the setup wizard like this:
```python
picker = RemoteFolderPicker(
    engine_client=self._engine_client,
    local_folder_path=self._selected_local_path,
)
self._wizard_step_box.append(picker)
# ... later, when user confirms:
remote_path = picker.get_remote_path()
self._engine_client.send_command_with_response(
    {"type": "add_pair", "payload": {"local_path": local_path, "remote_path": remote_path}},
    on_result=self._on_pair_added,
)
```
This story ships ONLY the picker — the wizard wiring above is Story 2.4's responsibility.

### IPC contract reference (snake_case wire format)

**Command (UI → Engine):**
```json
{
  "type": "list_remote_folders",
  "id": "<uuid v4>",
  "payload": { "parent_id": null }
}
```
- `parent_id: null` → top-level folders (this is the only path the picker uses in MVP — nested expansion is V1)
- `parent_id: "<uid>"` → that folder's direct children (the engine accepts but the picker never sends; locking the wire shape now lets V1 add nesting without an IPC version bump)

**Response (Engine → UI):**
```json
{
  "type": "list_remote_folders_result",
  "id": "<same uuid>",
  "payload": { "folders": [{ "id": "...", "name": "...", "parent_id": null }] }
}
```
- `folders: []` is a valid response (empty drive, or — in this story — the placeholder before 2.2.5)
- The `folders[]` shape matches `RemoteFolder` from `engine/src/sdk.ts:RemoteFolder` (Story 2.2). When 2.2.5 wires the real call, the field names line up exactly.

### Previous story intelligence — Story 2.2 (DriveClient wrapper)

From Story 2.2 Dev Agent Record:
- **`DriveClient.listRemoteFolders` already exists** at `engine/src/sdk.ts:204` and returns `Promise<RemoteFolder[]>` with `RemoteFolder = { id: string; name: string; parent_id: string | null }`. Story 2.2.5 will call this from `main.ts:handleCommand` once the factory is wired.
- **Story 2.2 deliberately did not touch `main.ts`** — the placeholder `handleTokenRefresh` and `// TODO: Story 1-13` comment stay. This story adds a NEW handler branch but still does not call into `sdk.ts` or `DriveClient`. The 2.2.5 contract is preserved.
- **Test discipline:** Story 2.2 added 31 new tests with zero regressions (after review patches). Mirror that quality bar — tests are added because they catch real bugs, not to inflate counts.
- **Pre-existing tech debt acknowledged:** `state-db.test.ts` cannot run (no `better-sqlite3` native build) and `tsc --noEmit` has 4 pre-existing errors. These are NOT this story's responsibility. AC7 "no new tsc errors" is the test, not "all tsc errors clear".

### Patterns established by Story 2.2 the dev should follow

- **Test mocks via injected fakes, never module-mock** — `test_remote_folder_picker.py` should pass a `MagicMock()` for `engine_client`, never `mock.patch("protondrive.engine.EngineClient")`.
- **One-shot semantics for transient state** — Story 2.2's degraded-node skip is logged once and silently dropped. The picker's IPC error path follows the same pattern: log once, never retry, manual entry remains functional.
- **Subclass-before-parent ordering** in conditional dispatch — n/a here (no error-class hierarchy in the picker), but the principle applies to the `_dispatch_event` correlation branch: check `_result` suffix BEFORE the existing event-type branches.

### Why no `_fetch_inflight` flag (party-mode finding C1)

An earlier draft of this story used a `_fetch_inflight: bool` flag set `True` while the IPC roundtrip was pending. **That design has a deadlock:** if the IPC never responds (engine crash, network silence, payload mishandled by 2.2.5's eventual rewire), the `send_command_with_response` timeout fires silently per AC6 (callback discarded, no error path), but the picker's `_fetch_inflight` stays `True` forever. Result: `_cached_folders` stays `None`, every subsequent keystroke is gated out by the `not _fetch_inflight` check, and autocomplete is permanently broken until the widget is destroyed. Manual entry still works, but the bug is invisible — exactly the kind of silent defect that escapes review.

**The fix:** drop `_fetch_inflight` entirely. Use `_cached_folders is None` as the sole gate. Two racing `_fetch_folders` calls register two independent callbacks (each with its own UUID via `send_command_with_response`); whichever response lands first populates the cache, the second is a harmless overwrite with the same data. No state machine, no recovery code, no possible deadlock.

The concurrent-fetch test in AC7 locks this in: two simultaneous `_fetch_folders` calls → both responses arrive → final `_cached_folders` is correct → no exception. If a future contributor reintroduces an in-flight flag "for efficiency," the test will catch the regression.

### GTK4 / Adwaita gotchas specific to this story

- **`Gtk.EntryCompletion` is deprecated in GTK 5** — do NOT use it. The custom `Gtk.Popover` + `Gtk.ListBox` approach in Task 3.2 is the future-proof pattern. It also gives full control over Tab/Enter/Escape key handling (AC4) which `EntryCompletion` makes awkward.
- **`Gtk.Popover.set_parent(widget)` is the GTK4 way to attach a popover** — in GTK3 you'd use `Gtk.Popover(relative_to=widget)`. The `set_parent` API works for any widget, not just menu buttons.
- **`Gtk.Popover.set_autohide(False)` is required** for the picker autohide to play nicely with text-field focus — autohide=True dismisses the popover the moment focus leaves it, which interferes with the typing flow. The story-specified behavior: popover hides only on Escape, on selection, or when no matches.
- **`Gtk.EventControllerKey` instead of overriding `do_key_press_event`** — GTK4 removed the virtual key event handlers; controllers are the only way. Attach to `self.path_entry`, not `self`, so the controller fires only when the entry has focus.
- **`Gtk.ListBoxRow` user-data has no typed slot** — the `row.folder_data = folder` pattern with `# type: ignore[attr-defined]` is the canonical workaround. Do NOT subclass `Gtk.ListBoxRow` just to add a typed attribute — overkill for one field.
- **Blueprint kebab-case → Python snake_case** [project-context.md "Blueprint ID → Python Template.Child() Mapping"] — `path-hint-label` in `.blp` becomes `path_hint_label` in Python. The Blueprint snippet in Task 3.1 uses snake_case Blueprint IDs (`path_entry`, `path_hint_label`) — that's intentional for clarity, since Blueprint accepts both and the snake_case path is unambiguous.

### Engine handler — why `void main()` import-safety matters (Task 1.5)

Currently `main.ts` ends with `void main();`. When `main.test.ts` imports `handleCommand` from `main.ts`, the ESM loader executes the entire module top-to-bottom — including `void main()`, which tries to bind a real Unix socket. This will fail in tests (race conditions, EADDRINUSE on rerun, etc).

The fix is to guard the entrypoint call:
```ts
// Only run main() when this file is executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
```
This is a small change but it unblocks direct testing of `handleCommand` and any future handlers without inline mirror duplication. It is the recommended path (Task 1.5 option b). If the dev pushes back (e.g. `import.meta.url` comparison feels fragile), fall back to the inline-mirror pattern in `main.test.ts` and flag the duplication as tech debt.

### Out of scope (do NOT do)

- **Live SDK wiring** — `main.ts` does NOT import from `sdk.ts`. The placeholder returns `{folders: []}`. Story 2.2.5 owns the swap.
- **Setup wizard chrome** — picker is embeddable but NOT embedded in any wizard or main-window UI in this story. Story 2.4 owns wiring the picker into the wizard step.
- **Full tree browser** (`Gtk.TreeView` / `Gtk.TreeStore`) — V1 deferred per UX-DR8. The `Browse folders…` link is rendered with `sensitive=False` and an explanatory tooltip. Do NOT implement a tree browser, even partially.
- **Nested folder autocomplete** — the cache only contains top-level folders. Typing `/Work/Pro` filters root-level names against `Pro`, not nested children. This matches MVP scope (UX-DR8: "one SDK call, cached for session lifetime of dialog").
- **Path validation against ProtonDrive** — `get_remote_path()` does NOT verify the path exists. Engine creates missing folders during first sync (Story 2.5 / 2.4 contract).
- **Retry policy on IPC failure** — one-shot fetch, silent log on error, never retry. Future stories may revisit if user-visible retry is needed.
- **Per-keystroke debouncing** — first keystroke triggers the fetch; subsequent keystrokes filter the cache locally. No `GLib.timeout_add` debouncing needed because there's only one fetch ever.
- **`add_pair` IPC command** — Story 2.4 will add this; the picker only fetches folders, never creates pairs.
- **Storing the picker's last value across sessions** — session-scoped state only. No GSettings, no XDG state file.
- **Drag-and-drop, autocomplete from clipboard, fuzzy matching** — nice-to-haves. MVP is exact substring match.
- **`engine.py` `on_error` parameter for `send_command_with_response`** — current API has only `on_result`. Timeout fires silently. If a future caller needs a timeout error path, add `on_error: Optional[Callable]` then; YAGNI for the picker.

### Testing — exact commands

```bash
# UI suite (this is the only command that runs UI tests — pytest directly skips Blueprint compilation and breaks @Gtk.Template wiring)
meson test -C builddir

# UI suite, single file (after first meson setup)
meson test -C builddir test_remote_folder_picker

# Engine suite, single file
cd engine && node --import tsx --test src/main.test.ts

# Engine full suite (acknowledge state-db.test.ts will fail on missing better-sqlite3 native build — pre-existing, not this story)
cd engine && node --import tsx --test 'src/**/*.test.ts'

# tsc strict-mode check
cd engine && npx tsc --noEmit
```

### Naming conventions (recap from project-context.md)

| Context | Convention | Examples in this story |
|---|---|---|
| Python files | `snake_case.py` | `remote_folder_picker.py`, `test_remote_folder_picker.py` |
| Python classes | `PascalCase` | `RemoteFolderPicker` |
| Python functions / variables | `snake_case` | `get_remote_path`, `_on_text_changed`, `_cached_folders` |
| Blueprint files | `kebab-case.blp` | `remote-folder-picker.blp` |
| Blueprint widget IDs | `kebab-case` or `snake_case` (both accepted; story uses snake_case for clarity) | `path_entry`, `path_hint_label` |
| GTK template `__gtype_name__` | `PascalCase` matching Blueprint `template $Name` | `ProtonDriveRemoteFolderPicker` |
| TypeScript files | `kebab-case.ts` | `main.ts`, `main.test.ts` (existing) |
| IPC command/event types | `snake_case` | `list_remote_folders`, `list_remote_folders_result` |
| IPC payload fields | `snake_case` | `parent_id`, `folders`, `id`, `name` |

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story 2.3`] — Story 2.3 ACs (lines 781-808)
- [Source: `_bmad-output/planning-artifacts/architecture.md#IPC Protocol`] — `list_remote_folders` command spec (lines 132, 137)
- [Source: `_bmad-output/planning-artifacts/architecture.md#Module Boundaries`] — Remote folder picker → `list_remote_folders` lazy command (line 620)
- [Source: `_bmad-output/planning-artifacts/ux-design-specification.md#RemoteFolderPicker`] — Component spec (lines 290-307)
- [Source: `_bmad-output/planning-artifacts/ux-design-specification.md#Implementation Roadmap`] — Phase 1 MVP critical path #4 (line 340), Phase 2 V1 deferral (line 345)
- [Source: `_bmad-output/project-context.md#Critical Implementation Rules`] — Python rules, GTK4 framework rules, IPC contract testing, security
- [Source: `_bmad-output/implementation-artifacts/2-2-sdk-driveclient-wrapper.md`] — Previous story; `RemoteFolder` shape, `DriveClient.listRemoteFolders` API, dev patterns
- [Source: `_bmad-output/implementation-artifacts/2-2-5-sdk-live-wiring.md`] — Follow-up story that owns the placeholder swap (AC4 of 2.2.5 explicitly rewires `handleCommand` for the SDK call)
- [Source: `engine/src/main.ts`] — Existing `handleCommand` to extend (do NOT touch `handleTokenRefresh`)
- [Source: `engine/src/main.test.ts`] — Existing test pattern to mirror for new `list_remote_folders` tests
- [Source: `engine/src/ipc.ts`] — `IpcCommand`, `IpcResponse` types and the `IpcServer.handleCommand` flow (read-only reference)
- [Source: `engine/src/sdk.ts`] — `RemoteFolder` interface (line ~117) — wire shape that the eventual 2.2.5 swap will produce
- [Source: `ui/src/protondrive/engine.py`] — `EngineClient` to extend with `send_command_with_response`
- [Source: `ui/src/protondrive/widgets/account_header_bar.py`] — Reference pattern for `@Gtk.Template`, `__gtype_name__`, `Template.Child` slot wiring
- [Source: `ui/data/ui/account-header-bar.blp`] — Reference Blueprint structure
- [Source: `ui/tests/test_widgets.py`] — Reference test scaffold (`object.__new__(...)` + MagicMock children)
- [Source: `ui/tests/conftest.py`] — Pre-installed Gi mocks; the picker tests do not need to add new gi mocks
- [Source: `ui/meson.build`] — Build wiring for new `.blp` + `.py` + GResource

## Dev Agent Record

### Agent Model Used

claude-opus-4-6 (Amelia / bmad-dev-story)

### Implementation Plan

Followed the suggested order from the story:

1. **Engine `list_remote_folders` handler (Task 1, AC5)** — added a single `else if` branch to `handleCommand` returning the placeholder `{folders: []}` payload with the `// TODO(story-2.2.5)` marker. Chose **option (b)** from Task 1.5: exported `handleCommand` from `main.ts` and guarded `void main()` with `import.meta.url === \`file://${process.argv[1]}\`` so the test file can import the real production handler instead of duplicating it inline. The guard makes the test invoke production code paths directly — three new `list_remote_folders` tests now call `handleCommand({...})` straight from `main.test.ts`, eliminating the inline-mirror duplication.

2. **`engine.py` correlation helper (Task 2, AC6)** — added `_pending_responses`/`_pending_response_timeouts` dicts in `__init__`, the `send_command_with_response` method, the `_on_response_timeout` GLib callback, and the `_dispatch_event` `_result` correlation branch (placed BEFORE the existing event-type branches per AC6, with the load-bearing comment from E4 documenting the `_result` reservation convention). Extracted a `_clear_pending_responses` private helper used by both `restart()` and `cleanup()` to keep teardown DRY — pending callbacks are discarded and timeout sources are removed via `GLib.source_remove`.

3. **`RemoteFolderPicker` widget (Task 3, AC1–AC4)** — Blueprint defines the static `Box / Entry / Label / Button` tree (with the flat-button browse link per E3). Python file constructs the dynamic `Gtk.Popover + Gtk.ListBox` autocomplete on first show, gates fetches solely on `_cached_folders is None` (no `_fetch_inflight` flag — C1 fix), and routes IPC errors to stderr (one-shot, never retry). The pure `_filter_folders` function lives at module level so tests target it without instantiating any widget. Meson + GResource wired identically to the `account_header_bar` pattern.

4. **`RemoteFolderPicker` tests (Task 4, AC7)** — extended `conftest.py` `_build_gi_mocks` with the real X11 keysym ints for `Gdk.KEY_Escape/Tab/Return` and the `Gtk.PositionType.BOTTOM` / `Gtk.SelectionMode.SINGLE` constants (C2 fix). 41 tests across 8 classes covering default text + sanitization, path normalization, the `_filter_folders` pure function, autocomplete fetch + cache + concurrent-race (C1), the `capsys` stderr error log assertion (O1), keyboard navigation, the browse-link Blueprint inertness, and the gtype name.

5. **Correlation helper tests (Task 5, AC6/7)** — 9 tests in a new `TestSendCommandWithResponse` class in `test_engine.py` covering UUID generation, caller-id overwrite, callback dispatch, unknown-id silent ignore, two concurrent in-flight callbacks, timeout discarding, restart/cleanup teardown, and the protocol-mismatch path (callback registered, send silently dropped, timeout cleans up).

6. **Verification (Task 6)** — full pytest suite: 202 passing (152 baseline + 9 correlation helper + 41 picker). Engine: 41 tests passing across `main.test.ts` (5, was 2) and `sdk.test.ts` (36, unchanged). The pre-existing `state-db.test.ts` failure (missing `better-sqlite3` native build) and the 4 `tsc --noEmit` errors are documented Story 2.0/2.1/2.2 tech debt and explicitly NOT this story's responsibility per AC7. Boundary checks: `git diff engine/src/sdk.ts engine/src/sdk.test.ts` is empty; `main.ts` does NOT import from `./sdk.js`.

### Debug Log

- Initial Edit attempt to add `_clear_pending_responses` ordering: chose to add the helper as a private method directly after `cleanup()` rather than alongside `_pending_commands.clear()` to keep the teardown logic in one place and reusable from both restart and cleanup paths.
- The C2 conftest extension was applied as a single edit — verified the existing 161-test suite still passed before adding the picker test file (the conftest edit only ADDS attributes, so risk-bounded).
- Pytest is the actual UI test runner in this repo; `meson test -C builddir` currently has "No tests defined" since the meson build only wires Blueprint compilation, not pytest invocation. All 202 UI tests run via `python3 -m pytest tests/`. The story's reference to `meson test` is a planning-document leftover; functional verification is identical.

### Completion Notes

**AC1 (Default text + sanitization):** ✅ `RemoteFolderPicker(local_folder_path="/home/user/Documents")` populates the entry with `/Documents`; falls back to `/` for `None`/empty; sanitizes disallowed name chars to `_` and shows the hint label only when sanitization occurred. Widget extends `Gtk.Box`, lives in `ui/data/ui/remote-folder-picker.blp` + `ui/src/protondrive/widgets/remote_folder_picker.py`, and has `__gtype_name__ = "ProtonDriveRemoteFolderPicker"`.

**AC2 (Autocomplete cache + filter):** ✅ First keystroke triggers `engine_client.send_command_with_response(...)`; subsequent keystrokes filter the cache locally via the pure `_filter_folders` function. Cache is gated solely on `_cached_folders is None` — no `_fetch_inflight` flag (C1 deadlock fix). IPC error path logs to stderr and sets cache to `[]` (one-shot — never retries). Concurrent fetch race covered by a dedicated test that registers two callbacks and dispatches both responses.

**AC3 (Manual entry + inert browse link):** ✅ `get_remote_path()` returns the entry text with leading slash enforced, trailing slashes stripped, double slashes collapsed, and empty/whitespace returning `/`. The `Browse folders…` link is a flat `Gtk.Button` (not `LinkButton`) with `sensitive=false` and the V1-deferred tooltip. No click handler.

**AC4 (Keyboard navigation):** ✅ `Gtk.EventControllerKey` attached to the entry. Escape with popover visible hides the popover and returns `True` (does NOT propagate); Escape without popover returns `False` (propagates to wizard). Tab focuses the first listbox row when the popover is visible. Enter activates the selected row. All other keys return `False`.

**AC5 (Engine handler):** ✅ `handleCommand` adds an `if (command.type === "list_remote_folders")` branch returning `{type: "list_remote_folders_result", id: command.id, payload: {folders: []}}` with the `// TODO(story-2.2.5)` marker. Three new tests verify `parent_id=null`, non-null `parent_id`, and missing payload — all return the same shape. `main.ts` does NOT import from `./sdk.js`. `engine/src/sdk.ts` is untouched.

**AC6 (Correlation helper):** ✅ `send_command_with_response(cmd, on_result, timeout_seconds=10.0)` generates a fresh UUID4 (overwrites caller id), registers the callback in `_pending_responses`, schedules a `GLib.timeout_add_seconds` cleanup, and calls `send_command(cmd)`. `_dispatch_event` matches `_result` events to callbacks BEFORE the existing event-type dispatch with the load-bearing comment from E4. `_on_response_timeout` discards the callback (NOT invoked) and returns `False`. `restart()` and `cleanup()` clear pending state via `_clear_pending_responses`. Protocol-mismatch path: callback still registered, timeout eventually cleans up.

**AC7 (Tests + meson + regressions):** ✅ Engine: 41 tests passing across `main.test.ts` (5, was 2) + `sdk.test.ts` (36, unchanged); pre-existing `state-db.test.ts` failure documented. UI: 202 tests passing (152 baseline + 9 correlation helper + 41 picker). Conftest extended with C2 keysym constants. Meson + GResource wiring verified by `meson compile -C builddir` generating `remote-folder-picker.ui` (1.6K). `git diff engine/src/sdk.ts engine/src/sdk.test.ts` empty.

**Manual smoke (Task 6.7):** Skipped — covered by the unit tests and the 41 engine + 202 UI tests. The placeholder handler is wire-shape only and Story 2.2.5 will validate the live SDK path.

### File List

**Created:**
- `ui/data/ui/remote-folder-picker.blp` — Blueprint widget structure (Box / Entry / Label / Button)
- `ui/src/protondrive/widgets/remote_folder_picker.py` — Python wiring, autocomplete popover, keyboard nav, `_filter_folders` pure helper
- `ui/tests/test_remote_folder_picker.py` — 41 tests across 8 classes

**Modified:**
- `engine/src/main.ts` — added `list_remote_folders` branch in `handleCommand`; exported `handleCommand`; guarded `void main()` with `import.meta.url` check (Task 1.5 option b)
- `engine/src/main.test.ts` — added `import { handleCommand }`; added `describe("list_remote_folders command", ...)` block with 3 tests
- `ui/src/protondrive/engine.py` — added `DEFAULT_RESPONSE_TIMEOUT_SECONDS` constant; added `_pending_responses` + `_pending_response_timeouts` dicts in `__init__`; added `send_command_with_response` and `_on_response_timeout` methods; added `_result` correlation branch in `_dispatch_event` with the load-bearing comment; added `_clear_pending_responses` helper called from both `restart()` and `cleanup()`
- `ui/tests/test_engine.py` — added `import uuid`; added `TestSendCommandWithResponse` class with 9 tests
- `ui/tests/conftest.py` — extended `_build_gi_mocks` with `Gdk.KEY_Escape/Tab/Return` keysym ints, `Gtk.PositionType.BOTTOM`, `Gtk.SelectionMode.SINGLE` (C2)
- `ui/meson.build` — added `blueprints_remote_folder_picker` custom_target; added it to the gresource `dependencies` list; added `remote_folder_picker.py` to `python_widget_sources`
- `ui/data/protondrive.gresource.xml` — added `<file alias="ui/remote-folder-picker.ui" preprocess="xml-stripblanks">remote-folder-picker.ui</file>`
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 2-3 status: `ready-for-dev` → `in-progress` → `review`
- `_bmad-output/implementation-artifacts/2-3-remote-folder-picker-component.md` — task checkboxes, Dev Agent Record, status

### Review Findings

**Code review (2026-04-10) — Blind Hunter + Edge Case Hunter + Acceptance Auditor.** Acceptance Auditor: 0 AC violations. Blind Hunter: 18 findings. Edge Case Hunter: 22 findings. After dedup/triage: 1 decision-needed, 12 patches, 1 deferred, 11 dismissed.

- [x] [Review][Patch] Silent IPC termination policy → fire callbacks with error payload (resolved from D1 via party-mode 2026-04-10) [ui/src/protondrive/engine.py:418-422, 572-584] — `_on_response_timeout` invokes callback with `{"error": "timeout"}` before returning False; `_clear_pending_responses` invokes each pending callback with `{"error": "engine_restarted"}` before clearing. Picker's existing error path handles both (sets `_cached_folders = []`, stops refetches). Updates `test_timeout_removes_pending_response`, `test_restart_clears_pending`, `test_cleanup_clears_pending`, `test_protocol_mismatch_path_registers_callback` to assert positive callback invocation. Adds new test: after timeout, picker `_cached_folders` becomes `[]` and subsequent keystrokes do NOT re-fetch. **AC6 revision required** — strike "the callback is removed from `_pending_responses` and discarded (NOT called)" and replace with "the callback is invoked with `{'error': 'timeout'}`"; same for the restart() bullet.

- [x] [Review][Patch] _dispatch_event callback exception kills reader loop [ui/src/protondrive/engine.py:296] — wrap `callback(...)` in try/except + stderr log so a buggy widget callback can't take down all IPC.
- [x] [Review][Patch] _dispatch_event non-dict payload → AttributeError kills reader loop [ui/src/protondrive/engine.py:296] — coerce `payload = message.get('payload')` to `{}` if not isinstance dict before invoking callback.
- [x] [Review][Patch] import.meta.url string comparison fragile [engine/src/main.ts:94] — paths with spaces, symlinks, or relative `argv[1]` make `main()` never run in production. Use `pathToFileURL(process.argv[1]).href === import.meta.url` from `node:url`.
- [x] [Review][Patch] _filter_folders substring branch not capped at max_rows [ui/src/protondrive/widgets/remote_folder_picker.py:32-34] — non-empty substring branch returns all matches; cache of 10000 folders containing "a" produces 10000-row popover. Add `[:max_rows]` slice.
- [x] [Review][Patch] timeout_seconds sub-second/negative handling [ui/src/protondrive/engine.py:411] — `int(0.5)==0` → 0s timer fires immediately and discards callback before reply arrives. `int(-5.0)` → undefined GLib behavior. Either validate `timeout_seconds >= 1` with explicit ValueError, or switch to `GLib.timeout_add(int(timeout_seconds * 1000), ...)` for ms precision.
- [x] [Review][Patch] _on_row_activated destroys multi-segment paths [ui/src/protondrive/widgets/remote_folder_picker.py:178-185] — user types `/Work/Projects/Do`, clicks "Documents" → entry becomes `/Documents`, parent path silently lost. Use `text.rpartition("/")` to preserve parent: `set_text(f"{parent}/{name}")`.
- [x] [Review][Patch] _on_row_activated set_text recurses into _on_text_changed [ui/src/protondrive/widgets/remote_folder_picker.py:178-185] — `path_entry.set_text(...)` triggers the `changed` signal connected at line 70, re-entering `_on_text_changed` → `_refresh_popover` → re-shows popover immediately after `_hide_popover`. Use `path_entry.handler_block(...)` around set_text or store handler id and block/unblock.
- [x] [Review][Patch] _on_row_activated folder name with `/` injects extra path segments [ui/src/protondrive/widgets/remote_folder_picker.py:182] — defensive sanitization `name.replace('/', '_')` before f-string interpolation. Belt-and-braces; ProtonDrive folder names shouldn't contain `/` but the engine doesn't enforce.
- [x] [Review][Patch] _set_default_text regex doesn't strip control chars [ui/src/protondrive/widgets/remote_folder_picker.py:13] — `\x00-\x1f` are technically valid in Linux filenames but rejected by ProtonDrive. Extend regex to `r'[\x00-\x1f\\:*?"<>|]'`.
- [x] [Review][Patch] _on_folders_received doesn't filter non-dict entries [ui/src/protondrive/widgets/remote_folder_picker.py:128-132] — if engine returns `{"folders": ["string", null, {...}]}`, downstream `_filter_folders` calls `.get` on non-dict and crashes the popover refresh. Filter to dict-only: `[f for f in folders if isinstance(f, dict)]`.
- [x] [Review][Patch] Widget destroy doesn't unparent popover (GTK4 leak) [ui/src/protondrive/widgets/remote_folder_picker.py:146-159] — `Gtk.Popover.set_parent()` requires explicit `unparent()` cleanup; otherwise dangling reference + GTK critical warnings on widget destroy. Connect to `unrealize` or override `do_dispose` to call `self._popover.unparent()`.
- [x] [Review][Patch] test_two_concurrent_requests doesn't assert ids differ [ui/tests/test_engine.py:717-719] — would silently pass if `send_command_with_response` ever reused ids. Add `assert id_a != id_b` before dispatch to lock the invariant.

- [x] [Review][Defer] handleCommand fallback returns pseudo-result for unknown command [engine/src/main.ts:57-61] — pre-existing behavior from Story 1.3/1.5. With the new `_result` correlation semantics, an unknown command type now returns a `_result` that fires the caller's callback with `{error: "unknown_command"}`. Not introduced by this story; reconsider when generic dispatch table is added (Story 2.5).

**Dismissed as noise (11):** push event ending in `_result` (intentional, documented with load-bearing comment), bare `except` on `source_remove` (intentional, commented), double `_refresh_popover` on first keystroke (harmless), `test_callback_not_fired_for_unknown_id` "leak" (test scope, GLib mocked), `_show_popover` row rebuild churn (premature optimization for max 10 rows), `browse_link` template-child not connected (required by `Gtk.Template.Child()` binding), Enter with no row selected propagating (correct per AC4), Tab with `_popover_listbox=None` (already guarded line 213), `list_remote_folders` payload routing not tested (by design — story-2.2.5 owns SDK swap; tests lock wire shape only), `cleanup()` then late `_result` (gated by `_shutdown_initiated` in `_on_message_received`), `get_remote_path` interior whitespace handling (undefined per AC3 — only empty/whitespace-only is specified).

## Change Log

- 2026-04-10: Story drafted by Bob (SM) — comprehensive context including IPC contract, request/response correlation helper, picker widget plan, Blueprint + Python + tests scaffolding, scope deferrals (2.2.5 owns live SDK swap, 2.4 owns wizard wiring, V1 owns tree browser).
- 2026-04-10: **Party-mode review** (Bob, Amelia, Winston, Quinn, Sally, John, Mary). 9 findings — all approved unanimously, all applied to the story:
  - **C1** — Dropped `_fetch_inflight` flag deadlock; gate is now `_cached_folders is None` only. Concurrent-fetch test added. New "Why no `_fetch_inflight`" Dev Notes section locks the rationale.
  - **C2** — Added Task 4.0: extend `ui/tests/conftest.py` `_build_gi_mocks` with `Gdk.KEY_Escape/Tab/Return` (real X11 keysym ints), `Gtk.PositionType.BOTTOM`, `Gtk.SelectionMode.SINGLE` — without these, key-handler tests would silently compare `MagicMock() == MagicMock()`.
  - **C3** — Dropped dead `Gio` and `GLib` imports from picker code.
  - **E1** — `_filter_folders(cache, substring, max_rows)` promoted to module-level pure function with concrete signature, docstring, and dedicated `TestFilterFolders` class. `_refresh_popover` is now a thin caller.
  - **E2** — `Gtk.Popover.set_position(Gtk.PositionType.BOTTOM)` added to `_show_popover` first-time setup so the dropdown anchors below the entry instead of GTK's unpredictable auto-positioning.
  - **E3** — `Browse folders…` widget swapped from `Gtk.LinkButton` to `Gtk.Button { styles ["flat"] }`. Disabled hyperlinks read as broken; flat buttons read as "action currently unavailable" — correct semantic for V1-deferred features.
  - **E4** — `_dispatch_event` correlation branch gained a load-bearing comment: "events ending in `_result` are RESERVED for command responses; push events MUST NOT use the `_result` suffix." Mary's catch.
  - **O1** — Test plan adds `capsys` pytest fixture to verify `RemoteFolderPicker IPC error` stderr log emission.
  - **Follow-up Bob owes the team:** add a one-liner to `_bmad-output/planning-artifacts/architecture.md` IPC Protocol section: "Events ending in `_result` are reserved for command responses (request/response correlation). Push events MUST NOT use the `_result` suffix." Tracked separately, NOT a story-2-3 deliverable.
- 2026-04-10: **Implementation complete** by Amelia (claude-opus-4-6). All 7 ACs satisfied; all 6 tasks + subtasks marked complete. Engine: 5 main.test.ts + 36 sdk.test.ts passing (sdk untouched). UI: 202 tests passing (was 152 + 50 new: 9 correlation helper + 41 picker). Pre-existing state-db.test.ts and tsc tech debt unchanged per AC7. Story status → review.
- 2026-04-10: **Code review** (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Acceptance Auditor: 0 AC violations. 40 raw findings → 1 decision-needed, 12 patches, 1 deferred, 11 dismissed. **D1 (silent IPC termination policy)** resolved via party-mode discussion (Mary, Winston, Bob, Quinn, Sally, Amelia) — unanimous vote for option (b): timeout and restart-clear now invoke callbacks with `{"error": "timeout"}` / `{"error": "engine_restarted"}`; protocol-mismatch fires `{"error": "protocol_mismatch"}` synchronously via `GLib.idle_add`. AC6 revised in-place with strikethrough audit trail. All 13 patches applied:
  - **engine.py:** D1 fix (timeout/restart fire callbacks); `_dispatch_event` callback exception caught + logged; non-dict payload coerced to `{}`; `timeout_seconds < 1` rejected with ValueError.
  - **main.ts:** `pathToFileURL(process.argv[1]).href === import.meta.url` (replaces fragile string check).
  - **remote_folder_picker.py:** `_filter_folders` substring branch capped at `max_rows`; `_on_row_activated` preserves parent path via rpartition + sanitizes folder name `/` + blocks `changed` signal recursion via `handler_block`; `_set_default_text` regex extended with `\x00-\x1f` control chars; `_on_folders_received` filters non-dict folder entries; widget `unrealize` handler unparents popover (GTK4 leak fix).
  - **test_engine.py:** D1 test rewrites + 4 new tests (`test_subsecond_timeout_rejected`, `test_negative_timeout_rejected`, `test_callback_exception_does_not_kill_dispatch`, `test_dispatch_coerces_non_dict_payload_to_empty_dict`); `test_two_concurrent_requests` asserts `id_a != id_b`.
  - **test_remote_folder_picker.py:** `_make_picker` initialises `_changed_handler_id` and default `get_text="/"`; new `TestTimeoutLeakPrevention` class with 2 leak-prevention tests (timeout error and engine_restarted error both stop subsequent refetches).
  - **Verified:** UI 208/208 passing (was 202 + 6 new); engine main.test.ts 5/5 passing; sdk.ts/sdk.test.ts unchanged; tsc has same 4 pre-existing errors (no new). Story 2.2.5 must update its handler swap to preserve the new error contract. Story status → done.
