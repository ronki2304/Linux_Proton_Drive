# Story 6.2: Nesting & Overlap Validation

Status: ready-for-dev

## Story

As a user,
I want the app to prevent me from creating sync pairs that overlap or nest inside each other,
so that I don't accidentally cause duplicate syncing or file conflicts.

## Acceptance Criteria

1. **Given** the user attempts to add a new sync pair **When** the new local path is inside an existing pair's local path (or is the same path) **Then** `add_pair` is rejected with error code `local_nesting` and the conflicting pair's paths in the payload; AddPairDialog shows: "This folder is inside your '[pair name]' sync pair — syncing a subfolder separately would cause duplicate files"

2. **Given** the user attempts to add a new sync pair **When** an existing pair's local path is a strict subdirectory of the new local path **Then** `add_pair` is rejected with error code `local_overlap`; AddPairDialog shows: "Your '[pair name]' sync pair folder is inside this folder — this would cause duplicate files"

3. **Given** the user attempts to add a new sync pair **When** the new remote path is inside an existing pair's remote path **Then** `add_pair` is rejected with error code `remote_nesting`; AddPairDialog shows: "This remote folder is inside your '[pair name]' sync pair — syncing a subfolder separately would cause duplicate files"

4. **Given** the user attempts to add a new sync pair **When** the new remote path is the same as an existing pair's remote path **Then** `add_pair` is rejected with error code `remote_exact`; AddPairDialog shows: "Already in use by '[pair name]'"

5. **Given** any validation failure **When** the error is displayed **Then** it appears in the `error_label` (inline in the dialog), "Add Pair" is re-enabled for retry, the spinner stops, and no separate error dialog is shown

6. **Given** all four validation checks **When** they run **Then** they execute inside the `add_pair` handler before any database write, remote ID resolution, or filesystem access

7. **Given** a new pair with no local or remote path conflict with existing pairs **When** `add_pair` is called **Then** it succeeds normally (no false positives)

## Precondition

**Story 6-1 must be done before implementing 6-2.** This story assumes `AddPairDialog` exists at `ui/src/protondrive/widgets/add_pair_dialog.py` with the `error_label`, `add_pair_button`, and `spinner` wired as specified in Story 6-1. No engine changes were made in 6-1.

## Tasks / Subtasks

- [ ] Task 1 — Engine: add validation type and helper function (AC: 1–4, 6)
  - [ ] 1.1 — In `engine/src/main.ts`, add the following interface declaration just before the `if (command.type === "add_pair")` block (~line 482):
    ```typescript
    interface PairValidationError {
      error: "local_nesting" | "local_overlap" | "remote_nesting" | "remote_exact";
      conflicting_local_path: string;
      conflicting_remote_path: string;
    }
    ```
  - [ ] 1.2 — Add the following helper functions immediately after the interface (before the `add_pair` block):
    ```typescript
    function normLocal(p: string): string {
      return p.replace(/\/$/, "");
    }

    function normRemote(p: string): string {
      const s = (p.startsWith("/") ? p : "/" + p).replace(/\/$/, "");
      return s === "" ? "/" : s;
    }

    function isRemoteSubpath(newRemote: string, parentRemote: string): boolean {
      if (parentRemote === "/") return newRemote !== "/";
      return newRemote.startsWith(parentRemote + "/");
    }

    function validateNewPair(
      localPath: string,
      remotePath: string,
      existingPairs: SyncPair[],
    ): PairValidationError | null {
      const newLocal = normLocal(localPath);
      const newRemote = normRemote(remotePath);
      for (const pair of existingPairs) {
        const exLocal = normLocal(pair.local_path);
        const exRemote = normRemote(pair.remote_path);
        if (newLocal === exLocal || newLocal.startsWith(exLocal + "/")) {
          return { error: "local_nesting", conflicting_local_path: pair.local_path, conflicting_remote_path: pair.remote_path };
        }
        if (exLocal.startsWith(newLocal + "/")) {
          return { error: "local_overlap", conflicting_local_path: pair.local_path, conflicting_remote_path: pair.remote_path };
        }
        if (newRemote === exRemote) {
          return { error: "remote_exact", conflicting_local_path: pair.local_path, conflicting_remote_path: pair.remote_path };
        }
        if (isRemoteSubpath(newRemote, exRemote)) {
          return { error: "remote_nesting", conflicting_local_path: pair.local_path, conflicting_remote_path: pair.remote_path };
        }
        // TODO(deferred 6-2 D1): reverse remote overlap not checked — if exRemote is a
        // strict subdirectory of newRemote, no error is returned. See deferred-work.md [6-2 D1].
      }
      return null;
    }
    ```
  - [ ] 1.3 — `validateNewPair` and helpers are NOT exported (they are pure functions, tested indirectly via `handleCommand`). Do not use `export`.

- [ ] Task 2 — Engine: wire validation into add_pair handler (AC: 1–4, 6)
  - [ ] 2.1 — In `engine/src/main.ts`, inside the `if (command.type === "add_pair")` block, after the `!localPath || !remotePath` guard (~line 500) and BEFORE the `let remoteId = ""` block, insert:
    ```typescript
    const validationError = validateNewPair(localPath, remotePath, stateDb.listPairs());
    if (validationError !== null) {
      return {
        type: "add_pair_result",
        id: command.id,
        payload: {
          error: validationError.error,
          conflicting_local_path: validationError.conflicting_local_path,
          conflicting_remote_path: validationError.conflicting_remote_path,
        },
      };
    }
    ```
  - [ ] 2.2 — Confirm that validation runs before `listRemoteFolders` (network call) — the early return from 2.1 guarantees this. Do not reorder the `add_pair` block.
  - [ ] 2.3 — `stateDb.listPairs()` is already called for file watcher restart at line ~558. The new call at validation time is a separate, independent query — this is intentional (snapshot of pairs at command entry time).

- [ ] Task 3 — UI: update AddPairDialog to handle validation errors (AC: 1–5)
  - [ ] 3.1 — In `ui/src/protondrive/widgets/add_pair_dialog.py`, add `import os` at the top (if not already present from 6-1 implementation).
  - [ ] 3.2 — In `_on_pair_created(self, payload: dict[str, Any]) -> None`, extend the error branch (currently shows `payload.get("error", "unknown_error")`) to format validation errors with named conflicting pair. Replace the bare `self.error_label.set_label(payload.get("error", "unknown_error"))` line with:
    ```python
    self.error_label.set_label(self._format_pair_error(payload))
    ```
  - [ ] 3.3 — Add `_format_pair_error(self, payload: dict[str, Any]) -> str` method to `AddPairDialog`:
    ```python
    def _format_pair_error(self, payload: dict[str, Any]) -> str:
        error = payload.get("error", "")
        conflicting_local = payload.get("conflicting_local_path", "")
        pair_name = os.path.basename(conflicting_local.rstrip("/")) or conflicting_local or "existing pair"
        if error == "local_nesting":
            return f"This folder is inside your ‘{pair_name}’ sync pair — syncing a subfolder separately would cause duplicate files"
        if error == "local_overlap":
            return f"Your ‘{pair_name}’ sync pair folder is inside this folder — this would cause duplicate files"
        if error == "remote_nesting":
            return f"This remote folder is inside your ‘{pair_name}’ sync pair — syncing a subfolder separately would cause duplicate files"
        if error == "remote_exact":
            return f"Already in use by ‘{pair_name}’"
        return payload.get("error", "unknown_error")
    ```
    Note: `‘` and `’` are Unicode left/right single quotation marks (typographic). `—` is an em dash. This matches GNOME HIG copy conventions.
  - [ ] 3.4 — Verify: the existing `_on_pair_created` already calls `self.spinner.stop()` + `self.spinner.set_visible(False)` before the if/else branch — that pattern handles all errors including validation errors. No change needed there.
  - [ ] 3.5 — Verify: the existing `_on_pair_created` already re-enables `add_pair_button` in the error branch. No change needed there.
  - [ ] 3.6 — Type hint: `_format_pair_error` must have full type hints (matches project style from `project-context.md`).

- [ ] Task 4 — Engine tests: all four validation checks (AC: 1–4, 6, 7)
  - [ ] 4.1 — In `engine/src/main.test.ts`, add the following 8 tests inside the existing `describe("add_pair command")` block, after the existing `stateDb undefined` test (vt-7 and vt-8 cover the `normRemote` no-leading-slash normalization and the `isRemoteSubpath` root-path edge case respectively — both explicitly documented in the Dev Notes):

    ```typescript
    it("validation: new local is subdir of existing local → local_nesting", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-1",
        local_path: "/home/user/Docs",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-1",
        payload: { local_path: "/home/user/Docs/Sub", remote_path: "/Other" },
      });
      expect(response!.payload["error"]).toBe("local_nesting");
      expect(response!.payload["conflicting_local_path"]).toBe("/home/user/Docs");
    });

    it("validation: new local equals existing local → local_nesting (exact-match case)", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-2",
        local_path: "/home/user/Docs",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-2",
        payload: { local_path: "/home/user/Docs", remote_path: "/Other" },
      });
      expect(response!.payload["error"]).toBe("local_nesting");
    });

    it("validation: existing local is subdir of new local → local_overlap", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-3",
        local_path: "/home/user/Docs/Sub",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-3",
        payload: { local_path: "/home/user/Docs", remote_path: "/Other" },
      });
      expect(response!.payload["error"]).toBe("local_overlap");
      expect(response!.payload["conflicting_local_path"]).toBe("/home/user/Docs/Sub");
    });

    it("validation: new remote equals existing remote → remote_exact", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-4",
        local_path: "/home/user/Docs",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-4",
        payload: { local_path: "/home/user/Photos", remote_path: "/Documents" },
      });
      expect(response!.payload["error"]).toBe("remote_exact");
      expect(response!.payload["conflicting_local_path"]).toBe("/home/user/Docs");
    });

    it("validation: new remote is subdir of existing remote → remote_nesting", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-5",
        local_path: "/home/user/Docs",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-5",
        payload: { local_path: "/home/user/Photos", remote_path: "/Documents/Work" },
      });
      expect(response!.payload["error"]).toBe("remote_nesting");
      expect(response!.payload["conflicting_local_path"]).toBe("/home/user/Docs");
    });

    it("validation: no-overlap paths → success (no false positives)", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-6",
        local_path: "/home/user/Docs",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-6",
        payload: { local_path: "/home/user/Photos", remote_path: "/Pictures" },
      });
      expect(response!.payload["error"]).toBeUndefined();
      expect(response!.payload["pair_id"]).toBeTruthy();
    });

    it("validation: new remote without leading slash equals existing remote → remote_exact (normRemote normalization)", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-7",
        local_path: "/home/user/Docs",
        remote_path: "/Documents",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-7",
        payload: { local_path: "/home/user/Photos", remote_path: "Documents" }, // no leading slash
      });
      expect(response!.payload["error"]).toBe("remote_exact");
    });

    it("validation: existing remote is root '/' → any new non-root remote is remote_nesting", async () => {
      const db = new StateDb(":memory:");
      _setStateDbForTests(db);
      db.insertPair({
        pair_id: "existing-8",
        local_path: "/home/user/Docs",
        remote_path: "/",
        remote_id: "",
        created_at: new Date().toISOString(),
        last_synced_at: null,
      });
      const mockClient = { listRemoteFolders: mock(async () => []) } as unknown as DriveClient;
      _setDriveClientForTests(mockClient);
      const response = await handleCommand({
        type: "add_pair", id: "vt-8",
        payload: { local_path: "/home/user/Photos", remote_path: "/Documents" },
      });
      expect(response!.payload["error"]).toBe("remote_nesting");
    });
    ```

  - [ ] 4.2 — Note: each test creates a fresh `new StateDb(":memory:")` and sets it via `_setStateDbForTests`, overriding the `beforeEach` instance for that test's run. `afterEach` calls both `_setDriveClientForTests(null)` and `_setStateDbForTests(undefined)`, resetting state after every test. `XDG_CONFIG_HOME` is set by `beforeEach`; `writeConfigYaml` (called only in the success test vt-6) will write to `tmpDir`. `_setServerForTests(addPairServer)` is wired in `beforeEach`; the success test inherits it (FileWatcher calls `server.emitEvent` on the stub server). No `:memory:` resource leak — in-memory SQLite has no file handles.
  - [ ] 4.3 — Verify `DriveClient` import type is available: already imported as `import type { DriveClient } from "./sdk.js"` at line 8 of `main.test.ts`.

- [ ] Task 5 — UI tests: validation error display (AC: 1–4, 5)
  - [ ] 5.1 — In `ui/tests/test_add_pair_dialog.py` (created by Story 6-1), add the following tests:

    ```python
    def test_format_pair_error_local_nesting():
        dialog = object.__new__(AddPairDialog)
        msg = dialog._format_pair_error({
            "error": "local_nesting",
            "conflicting_local_path": "/home/user/Documents",
        })
        assert "Documents" in msg
        assert "subfolder" in msg.lower() or "inside" in msg.lower()

    def test_format_pair_error_local_overlap():
        dialog = object.__new__(AddPairDialog)
        msg = dialog._format_pair_error({
            "error": "local_overlap",
            "conflicting_local_path": "/home/user/Documents/Work",
        })
        assert "Work" in msg

    def test_format_pair_error_remote_exact():
        dialog = object.__new__(AddPairDialog)
        msg = dialog._format_pair_error({
            "error": "remote_exact",
            "conflicting_local_path": "/home/user/Photos",
        })
        assert "Photos" in msg
        assert "Already in use" in msg or "already in use" in msg.lower()

    def test_format_pair_error_remote_nesting():
        dialog = object.__new__(AddPairDialog)
        msg = dialog._format_pair_error({
            "error": "remote_nesting",
            "conflicting_local_path": "/home/user/Documents",
        })
        assert "Documents" in msg

    def test_format_pair_error_unknown_falls_back_to_raw_code():
        dialog = object.__new__(AddPairDialog)
        msg = dialog._format_pair_error({"error": "db_write_failed"})
        assert msg == "db_write_failed"

    def test_format_pair_error_empty_conflicting_path_uses_fallback():
        dialog = object.__new__(AddPairDialog)
        msg = dialog._format_pair_error({"error": "local_nesting", "conflicting_local_path": ""})
        assert "existing pair" in msg
    ```

  - [ ] 5.2 — Use `object.__new__` pattern (same as existing test_add_pair_dialog.py tests) — avoids GTK widget instantiation. `_format_pair_error` is a pure string-formatting method with no GTK dependencies.
  - [ ] 5.3 — Import: `from protondrive.widgets.add_pair_dialog import AddPairDialog` (already at top of test file from 6-1).

- [ ] Task 6 — Full test suite validation (AC: all)
  - [ ] 6.1 — `cd engine && bun test` — all tests green, exit 0
  - [ ] 6.2 — `.venv/bin/pytest ui/tests/ -v` from project root — all tests green, exit 0
  - [ ] 6.3 — No Meson compile step needed: no new Blueprint files, no new GResource entries. The only changes are to existing Python and TypeScript source files.

## Dev Notes

### Architecture: Validation is Engine-Side

Validation runs **inside the engine's `add_pair` handler**, before any DB write or network call. The engine is the authoritative source of truth for all existing pairs via `stateDb.listPairs()`. Client-side (UI) pre-validation would introduce a TOCTOU race (user adds two pairs simultaneously from two windows). Engine-side is the correct location. Zero changes to the UI's `add_pair` call site in `AddPairDialog._on_add_pair_clicked`.

### Validation Runs Before Remote ID Resolution

The remote ID resolution block (`listRemoteFolders` → find matching root folder) is a network call. If validation fails, we return early before this block — no network call is made for rejected pairs. The insertion order in Task 2.1 is critical: validation first, then `let remoteId = ""`.

### Path Normalization Rules

**Local paths:** Absolute POSIX paths from XDG file chooser. Always has leading `/`, never trailing `/` after normalization. `normLocal` strips trailing slash only.
- `/home/user/Docs` → `/home/user/Docs` ✓
- `/home/user/Docs/` → `/home/user/Docs` ✓

**Remote paths:** Virtual ProtonDrive paths. May arrive with or without leading `/`, never trailing `/` after normalization. `normRemote` ensures leading `/` and strips trailing `/`.
- `Documents` → `/Documents` ✓
- `/Documents` → `/Documents` ✓
- `/Documents/` → `/Documents` ✓
- `/` → `/` ✓ (root, special case in `isRemoteSubpath`)

**Root remote path edge case:** If `parentRemote === "/"`, then every non-root path is a subpath of it. `isRemoteSubpath` handles this explicitly. An existing pair with remote path `/` would block any new pair except one with the same remote path `/` (caught by `remote_exact` first).

### Path Prefix Collision Safety

The `startsWith(parent + "/")` pattern prevents false positives from shared path prefixes:
- `/home/user/Documents` vs `/home/user/DocumentsBackup` → no conflict ✓
- `/home/user/Documents/` vs `/home/user/Documents/Work` → after normalization, `/home/user/Documents` is parent; `startsWith("/home/user/Documents/")` = true ✓

This pattern is already used throughout the codebase (e.g., relative path comparison in sync-engine.ts).

### Check Order and Exact-Match Local Path

Checks run in this order within the pair loop: local_nesting → local_overlap → remote_exact → remote_nesting. The first matching check returns immediately.

**Local exact match** (`newLocal === exLocal`) is caught by the `local_nesting` check (which tests `newLocal === exLocal || newLocal.startsWith(exLocal + "/")`). There is no separate `local_exact` error code — same-path local is treated as nesting since the user's intent is ambiguous and the outcome (duplicate sync) is the same.

### Error Payload Structure

New error payloads for validation failures:
```typescript
{ error: "local_nesting", conflicting_local_path: string, conflicting_remote_path: string }
```

- `conflicting_local_path` — the `local_path` field of the conflicting existing pair (raw, from DB)
- `conflicting_remote_path` — the `remote_path` field of the conflicting existing pair (raw, from DB)
- Both fields use raw DB values, not normalized. UI must use `os.path.basename(conflicting_local_path.rstrip("/"))` to derive the display name (same as `window.py:398` pattern).

Existing error codes (`engine_not_ready`, `invalid_payload`, `db_write_failed`, `config_write_failed`) are unaffected.

### UI Error Label Reuse

Story 6-1's `error_label` is a general-purpose error label positioned below the remote picker in the content Gtk.Box. It is reused for validation errors. Since only one validation error can occur at a time (the first failing check short-circuits), one error label is sufficient. The error message text identifies the affected field (local vs. remote path) via its wording.

No Blueprint change, no new widgets.

### Display Name Derivation in `_format_pair_error`

```python
pair_name = os.path.basename(conflicting_local.rstrip("/")) or conflicting_local or "existing pair"
```

- `os.path.basename("/home/user/Documents")` → `"Documents"` ✓
- `os.path.basename("/home/user/Documents/")` → after `rstrip("/")`: `"Documents"` ✓
- Empty string fallback (`or conflicting_local`) → show full path if basename is somehow empty
- Double fallback (`or "existing pair"`) → defensive; the engine always returns a non-empty `conflicting_local_path` for the 4 validation error codes

This matches `window.py:398`: `pair_name = os.path.basename(local_path.rstrip("/")) or local_path`.

### Unicode Quotation Marks

Use `‘` (left single quotation mark) and `’` (right single quotation mark) around pair names in error messages, not ASCII apostrophes. This matches GNOME HIG typography conventions used throughout the codebase (e.g., `status_footer_bar.py` toast messages).

### TypeScript Strict Mode Compliance

`validateNewPair` and helpers must compile cleanly under `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. The `for (const pair of existingPairs)` loop is clean — no index access. `pair.local_path` and `pair.remote_path` are non-optional fields on `SyncPair` (see `state-db.ts:10`). No `!` operator needed.

The `PairValidationError` interface is local to `main.ts` (not in `state-db.ts`) because it describes an IPC response payload shape, not a DB entity.

### No FileWatcher or SyncEngine Changes

Validation is a pure check on existing `SyncPair` data. No file system access, no watcher restart, no sync trigger. The watcher restart code (line ~553) runs only after a successful `insertPair` + `writeConfigYaml` — it is never reached on validation failure due to the early return.

### Test Pattern: Per-Test StateDb

Each validation test creates a fresh `new StateDb(":memory:")` and sets it via `_setStateDbForTests`. This avoids test pollution. The `beforeEach` in `describe("add_pair command")` already does this — but each validation test overrides it with its own instance that has a pre-inserted pair. This is the correct pattern since we need to call `insertPair` on the instance before `handleCommand` runs.

The `afterEach` already calls `_setStateDbForTests(undefined)` implicitly via `_setDriveClientForTests(null)` pattern... wait, actually checking: `afterEach` sets `_setDriveClientForTests(null)` and `_setStateDbForTests(undefined)`. The per-test `_setStateDbForTests(db)` overrides the `beforeEach` call. That's fine — `afterEach` always runs regardless and resets both.

### Out of Scope

- **Existing-remote-inside-new-remote** check: the UX spec and ACs only specify 4 checks (local_nesting, local_overlap, remote_exact, remote_nesting). The inverse remote direction (existing remote inside new remote) is not specified. Do NOT add a `remote_overlap` check.
- **Edit/update pair validation**: if a future story allows editing a pair's paths, validation would need to run there too. Not in scope for 6-2.
- **Move/rename detection**: no UX; out of scope.

### File Locations

Modified files only (no new files):
- `engine/src/main.ts` — add `PairValidationError` interface, `normLocal`/`normRemote`/`isRemoteSubpath`/`validateNewPair` helpers, and wire into `add_pair` handler
- `engine/src/main.test.ts` — 6 new tests in existing `describe("add_pair command")` block
- `ui/src/protondrive/widgets/add_pair_dialog.py` — `import os` (if not already present), `_format_pair_error` method, update `_on_pair_created` to call it
- `ui/tests/test_add_pair_dialog.py` — 6 new tests

### References

- [Source: engine/src/main.ts:482–577] — `add_pair` handler; Tasks 1–2 modify this block
- [Source: engine/src/main.ts:168–182] — `_setDriveClientForTests`, `_setStateDbForTests` test injection pattern
- [Source: engine/src/main.test.ts:254–371] — existing `add_pair` describe block; append Task 4 tests here
- [Source: engine/src/state-db.ts:9–16, 186–190] — `SyncPair` interface, `listPairs()` return type
- [Source: ui/src/protondrive/widgets/add_pair_dialog.py] — `AddPairDialog._on_pair_created` method (Story 6-1)
- [Source: ui/src/protondrive/window.py:184–187, 397–399] — `_get_pair_name` pattern (`os.path.basename(local_path.rstrip("/")) or pair_id`)
- [Source: ui/tests/test_add_pair_dialog.py] — existing tests from Story 6-1; append Task 5 tests here
- [Source: _bmad-output/planning-artifacts/epics/epic-6-multi-pair-management-validation.md#story-62] — canonical ACs
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md:746–757] — UX-DR14 validation table
- [Source: _bmad-output/project-context.md] — TypeScript strict flags, Blueprint rule, no-lambda rule

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List
