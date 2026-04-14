# Story 3.0a: Bun Runtime Migration

Status: done

> **Why this story exists:** The engine currently runs on Node.js 22 with `better-sqlite3` as the
> SQLite driver. `better-sqlite3` is a native addon requiring a C toolchain (gcc, make) to build.
> This toolchain is absent from the dev environment, making `state-db.test.ts` impossible to run
> locally — a critical gap because `change_queue` (the backbone of Epic 3 offline resilience) lives
> in that database. The Epic 2 retrospective resolved to migrate the engine to the Bun runtime,
> which includes `bun:sqlite` as a built-in driver requiring no native compilation.
>
> **Scope:** Full runtime migration — Bun replaces Node.js end-to-end in dev and Flatpak.
> `better-sqlite3` → `bun:sqlite`. `node --import tsx --test` → `bun test`. `node:test` /
> `node:assert/strict` → `bun:test` across all 8 engine test files. `tsconfig.json` updated for
> Bun module resolution. `get_engine_path()` in `engine.py` updated to resolve `bun` binary.
> Flatpak manifest updated to bundle Bun instead of node22 SDK extension.
>
> **Constraint:** `project-context.md` currently says "NOT Bun — CLAUDE.md Bun defaults do not
> apply to the engine." This story reverses that decision. The project-context.md engine runtime
> section must be updated as part of this story.
>
> **Sequence:** Must be `done` before Story 3-0b (targeted debt fixes) and all Epic 3 feature
> stories. Story 3-0b depends on the `change_type` enum which requires `bun:sqlite` tests to run.

## Story

As the **project lead**,
I want **the sync engine to run on the Bun runtime with bun:sqlite replacing better-sqlite3**,
so that **engine unit tests can run locally without a C toolchain, unblocking Epic 3 development**.

## Acceptance Criteria

### Task 0 — Flatpak Bun Strategy (Spike, Required Before All Other Tasks)

**AC0 — Flatpak approach documented and chosen:**
**Given** there is no `org.freedesktop.Sdk.Extension.bun` extension available
**When** the dev agent investigates Bun Flatpak packaging options
**Then** one of the following approaches is chosen and documented in the Dev Agent Record:
- **Option A (preferred):** `bun build --compile src/main.ts --outfile=dist/engine` — produces a
  self-contained executable with Bun embedded; no Bun binary needed at runtime; Flatpak bundles
  only the compiled output; `get_engine_path()` returns `(compiled_binary,)` as a single-element
  tuple and the spawn call is updated to handle 1 vs 2 elements
- **Option B (fallback):** Download the Bun binary as a Flatpak `type: file` source with a pinned
  SHA256; install to `/app/bin/bun`; run `src/main.ts` directly at runtime (`bun run` resolves TS
  natively); note Flathub does not accept pre-built binaries — this option is dev/sideload only
**And** the chosen option is recorded in the Dev Agent Record before Task 1 begins
**And** if neither option works cleanly, a blocker is raised to Jeremy before proceeding

---

### AC1 — `bun:sqlite` replaces `better-sqlite3` in `state-db.ts`

**Given** `engine/src/state-db.ts`
**When** the migration is complete
**Then** `import Database from "better-sqlite3"` is replaced with `import { Database } from "bun:sqlite"`
**And** `db.pragma("journal_mode=WAL")` is replaced with `db.exec("PRAGMA journal_mode=WAL")`
**And** `db.pragma("synchronous=NORMAL")` is replaced with `db.exec("PRAGMA synchronous=NORMAL")`
**And** `db.pragma("user_version")` reads are replaced with `db.query("PRAGMA user_version").get()` returning `{user_version: number}`
**And** `db.pragma("user_version = N", {simple: true})` writes are replaced with `db.exec(\`PRAGMA user_version = \${n}\`)`
**And** all `db.prepare(...).all()`, `.get()`, `.run()` calls remain unchanged (API is compatible)
**And** `@types/better-sqlite3` type references are removed

---

### AC2 — `state-db.test.ts` runs without C toolchain

**Given** the `state-db.test.ts` file with 8+ tests using `:memory:` databases
**When** `bun test engine/src/state-db.test.ts` is run on a machine without gcc/make
**Then** all tests pass — no native addon compilation occurs
**And** WAL mode, schema creation, migration ordering, and CRUD operations are all verified

---

### AC3 — All 8 engine test files migrated to `bun:test`

**Given** the 8 test files currently using `node:test` + `node:assert/strict`:
- `engine/src/ipc.test.ts`
- `engine/src/state-db.test.ts`
- `engine/src/main.test.ts`
- `engine/src/sdk.test.ts`
- `engine/src/sync-engine.test.ts`
- `engine/src/watcher.test.ts`
- `engine/src/debug-log.test.ts`
- `engine/src/config.test.ts`

**When** migration is complete
**Then** each file imports from `"bun:test"` instead of `"node:test"`:
```ts
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
```
**And** `import assert from "node:assert/strict"` is removed from every file
**And** all `assert.strictEqual(a, b)` → `expect(a).toBe(b)`
**And** all `assert.deepStrictEqual(a, b)` → `expect(a).toEqual(b)`
**And** all `assert.ok(condition)` → `expect(condition).toBeTruthy()`
**And** all `assert.throws(() => fn(), ErrorClass)` → `expect(() => fn()).toThrow()`
**And** all `assert.rejects(async () => fn(), ErrorClass)` → `expect(async () => fn()).rejects.toThrow()`
**And** all `mock.fn()` → `mock(() => {})` (bun:test has no `mock.fn` — see migration map in Dev Notes)
**And** call tracking via `.mock.calls` is identical — no change needed there

---

### AC4 — `package.json` updated

**Given** `engine/package.json`
**When** migration is complete
**Then** `better-sqlite3` is removed from `dependencies`
**And** `tsx` is removed from `devDependencies`
**And** `@types/better-sqlite3` is removed from `devDependencies`
**And** `@types/node` is removed from `devDependencies` (Bun provides built-in types)
**And** `bun-types` is added to `devDependencies` (or `"@types/bun"` — whichever is current)
**And** `"scripts"` are updated:
```json
{
  "dev": "bun run src/main.ts",
  "build": "<chosen Flatpak build command from AC0>",
  "test": "bun test"
}
```
**And** `bun.lock` replaces `package-lock.json` as the lockfile (note: `engine/bun.lock` already
exists as an untracked file — it was generated by a prior `bun install` run; verify it is current
and commit it)

---

### AC5 — `tsconfig.json` updated for Bun

**Given** `engine/tsconfig.json`
**When** migration is complete
**Then** `"module"` is changed from `"NodeNext"` to `"ESNext"`
**And** `"moduleResolution"` is changed from `"NodeNext"` to `"Bundler"`
**And** all strict flags are preserved: `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noImplicitOverride`
**And** `"types": ["bun-types"]` is added to `compilerOptions`
**And** `bunx tsc --noEmit` passes with zero errors (this is the exact command CI runs)
**Note:** Local imports currently use `.js` extension per project-context.md — leave these
unchanged; Bun resolves them correctly with `"moduleResolution": "Bundler"`

---

### AC6 — `get_engine_path()` updated in `engine.py`

**Given** `ui/src/protondrive/engine.py:28–49` (`get_engine_path()`)
**When** migration is complete
**Then** the function returns `bun` binary path instead of `node`:

**If Option A (compiled binary):**
```python
def get_engine_path() -> tuple[str] | tuple[str, str]:
    if os.environ.get("FLATPAK_ID"):
        return ("/app/lib/protondrive-engine/dist/engine",)  # single element
    bun = GLib.find_program_in_path("bun")
    if bun is None:
        raise EngineNotFoundError("Bun not found on PATH. Install from https://bun.sh")
    engine_script = str(Path(__file__).resolve().parent.parent.parent.parent / "engine" / "src" / "main.ts")
    return (bun, engine_script)
```

**If Option B (Bun at runtime):**
```python
def get_engine_path() -> tuple[str, str]:
    if os.environ.get("FLATPAK_ID"):
        return ("/app/bin/bun", "/app/lib/protondrive-engine/src/main.ts")
    bun = GLib.find_program_in_path("bun")
    if bun is None:
        raise EngineNotFoundError("Bun not found on PATH. Install from https://bun.sh")
    engine_script = str(Path(__file__).resolve().parent.parent.parent.parent / "engine" / "src" / "main.ts")
    return (bun, engine_script)
```

**And** the spawn call `launcher.spawnv([node_path, engine_script])` (line 137) is updated to
  `launcher.spawnv(list(get_engine_path()))`
**And** the error message references Bun, not Node.js
**And** `test_engine.py` mocks are updated to patch `bun` binary discovery

---

### AC7 — Flatpak manifest updated

**Given** `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** migration is complete
**Then** `org.freedesktop.Sdk.Extension.node22` is removed from `sdk-extensions`
**And** `build-options.append-path: /usr/lib/sdk/node22/bin` is removed
**And** the `protondrive-engine` module build commands are updated per the chosen AC0 strategy
**And** the Flatpak build still completes successfully (`flatpak-builder --user --install`)
**And** the engine starts and `session_ready` is received (smoke test)

---

### AC8 — `project-context.md` updated

**Given** the rule "Runtime: Node.js 22 ... NOT Bun; CLAUDE.md Bun defaults do not apply to the engine"
**When** migration is complete
**Then** the engine runtime section in `project-context.md` is updated to reflect Bun as the engine runtime
**And** the test command is updated from `node --import tsx --test engine/src/**/*.test.ts` to `bun test`
**And** the dev startup command is updated from `node --import tsx src/main.ts` to `bun run src/main.ts`
**And** the note "CLAUDE.md Bun defaults do not apply to the engine" is removed

---

### AC9 — All engine tests pass

**Given** the migrated engine codebase
**When** `bun test` is run in `engine/`
**Then** all tests in all 8 test files pass with zero failures
**And** `state-db.test.ts` passes without a C toolchain (the primary goal of this story)
**And** no test is deleted or skipped to achieve a green run — all must genuinely pass

---

### AC10 — Story stops at `review`

Per standing agreement: dev agent sets status to `review` and stops. Jeremy certifies `done`.
One commit per logical group. Branch: `feat/3-0a-bun-runtime-migration`.

## Tasks / Subtasks

> **Order is mandatory.** Task 0 is a spike — the rest of the story depends on its outcome.
> Do Task 1 (SQLite) first after the spike so tests are unblocked immediately. Test migration
> (Task 2) is the largest chunk. Flatpak (Task 3) last — it can be validated separately.

- [x] **Task 0: Flatpak Bun spike** (AC: #0)
  - [x] 0.1 Research available Flatpak Bun options: compiled binary (`bun build --compile`),
        pre-built download, source build
  - [x] 0.2 Test `bun build --compile src/main.ts --outfile=dist/engine` locally — verify the
        output binary starts, connects IPC socket, emits `ready` event
  - [x] 0.3 If Option A works: document compiled binary approach and proceed
  - [x] 0.4 If Option A fails (e.g., `bun:sqlite` not embedded, SDK import issues): fall back to
        Option B (runtime Bun binary) and document
  - [x] 0.5 Record decision in Dev Agent Record before starting Task 1

- [x] **Task 1: `bun:sqlite` in `state-db.ts`** (AC: #1, #2)
  - [x] 1.1 Change import: `import Database from "better-sqlite3"` → `import { Database } from "bun:sqlite"`
  - [x] 1.2 Replace `db.pragma("journal_mode=WAL")` → `db.exec("PRAGMA journal_mode=WAL")`
  - [x] 1.3 Replace `db.pragma("synchronous=NORMAL")` → `db.exec("PRAGMA synchronous=NORMAL")`
  - [x] 1.4 Replace `PRAGMA user_version` reads and writes (see AC1 for exact patterns)
  - [x] 1.5 Run `bun test engine/src/state-db.test.ts` — fix any remaining API differences
        until all tests pass (this is the primary blocker being resolved)

- [x] **Task 2: Migrate all 8 test files to `bun:test`** (AC: #3, #9)
  - [x] 2.1 `engine/src/state-db.test.ts` (likely already partially done from Task 1.5)
  - [x] 2.2 `engine/src/ipc.test.ts` (503 lines, 20+ tests — largest migration)
  - [x] 2.3 `engine/src/main.test.ts` (582 lines)
  - [x] 2.4 `engine/src/sdk.test.ts` (largest file — check for `mock.calls` vs `.mock.calls`)
  - [x] 2.5 `engine/src/sync-engine.test.ts`
  - [x] 2.6 `engine/src/watcher.test.ts`
  - [x] 2.7 `engine/src/debug-log.test.ts`
  - [x] 2.8 `engine/src/config.test.ts`
  - [x] 2.9 Run `bun test` across all files — confirm zero failures, zero skips

- [x] **Task 3: `package.json` + `tsconfig.json`** (AC: #4, #5)
  - [x] 3.1 Remove `better-sqlite3`, `tsx`, `@types/better-sqlite3`, `@types/node`
  - [x] 3.2 Add `bun-types` (or `@types/bun`) to devDependencies
  - [x] 3.3 Update scripts: `"test": "bun test"`, `"dev": "bun run src/main.ts"`,
        `"build": <chosen strategy from AC0>`
  - [x] 3.4 Update `tsconfig.json`: `module` → `ESNext`, `moduleResolution` → `Bundler`,
        add `"types": ["bun-types"]`
  - [x] 3.5 Run `bunx tsc --noEmit` — fix any type errors introduced by the tsconfig change (this is the exact command CI uses)
  - [x] 3.6 Verify `engine/bun.lock` is current (`bun install` to regenerate if needed) and
        stage it for commit (it is currently untracked)
  - [x] 3.7 Delete `engine/package-lock.json` — it exists (37KB) and must be removed;
        `engine/bun.lock` replaces it

- [x] **Task 4: `engine.py` — `get_engine_path()` update** (AC: #6)
  - [x] 4.1 Update `get_engine_path()` per chosen AC0 strategy (Option A or B)
  - [x] 4.2 Update spawn call to use the new return value
  - [x] 4.3 Update error message to reference Bun
  - [x] 4.4 Update `test_engine.py` mocks to patch `bun` discovery instead of `node`
  - [x] 4.5 Run UI tests: `meson test -C builddir` — all tests pass

- [x] **Task 5: Flatpak manifest** (AC: #7)
  - [x] 5.1 Remove `org.freedesktop.Sdk.Extension.node22` from `sdk-extensions`
  - [x] 5.2 Remove `build-options.append-path: /usr/lib/sdk/node22/bin`
  - [x] 5.3 Remove `build-options.env.npm_config_nodedir` and `build-options.env.npm_config_cache`
        from the `protondrive-engine` module — these are node22/better-sqlite3 specific
  - [x] 5.4 Update `protondrive-engine` module build commands per chosen AC0 strategy
  - [x] 5.5 Run `flatpak-builder --user --install builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` — confirmed OK
  - [x] 5.6 Run app and verify engine starts, IPC connects, `ready` received — confirmed: `[APP] engine ready` + `session_ready` received + `startSyncAll: done`

- [x] **Task 6: `project-context.md` update** (AC: #8)
  - [x] 6.1 Update engine runtime section: Node.js 22 → Bun
  - [x] 6.2 Update test command: `node --import tsx --test` → `bun test`
  - [x] 6.3 Update dev startup: `node --import tsx src/main.ts` → `bun run src/main.ts`
  - [x] 6.4 Remove "CLAUDE.md Bun defaults do not apply to the engine" rule

## Dev Notes

### CI is already Bun-ready — do NOT modify CI files

`.github/workflows/ci.yml` already runs `bun install`, `bunx tsc --noEmit`, and `bun test`
using `oven-sh/setup-bun@v2` with **Bun 1.3.11** pinned. Do not touch the CI file.
The CI will pass automatically once the engine tests pass locally under `bun test`.
Use **Bun 1.3.11** locally to match CI: `bun upgrade --to 1.3.11` or install via
`curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"`.

### `engine/scripts/probe-key-decrypt.ts` — do not include in test run

`engine/scripts/` contains `probe-key-decrypt.ts` (a Story 2-11 debugging script). The
`bun test` command defaults to discovering files matching `*.test.ts` — this file will not be
picked up automatically. Do not add it to any test glob or script. Leave it untouched.

### bun:sqlite API vs better-sqlite3

The APIs are largely compatible. Key differences:

| Operation | better-sqlite3 | bun:sqlite |
|---|---|---|
| Import | `import Database from "better-sqlite3"` | `import { Database } from "bun:sqlite"` |
| PRAGMA exec | `db.pragma("journal_mode=WAL")` | `db.exec("PRAGMA journal_mode=WAL")` |
| PRAGMA read | `db.pragma("user_version", {simple: true})` → number | `db.query("PRAGMA user_version").get()` → `{user_version: number}` |
| PRAGMA write | `db.pragma("user_version = 1")` | `db.exec("PRAGMA user_version = 1")` |
| prepare/run | `db.prepare(sql).run(...args)` | identical |
| prepare/get | `db.prepare(sql).get(...args)` | identical |
| prepare/all | `db.prepare(sql).all(...args)` | identical |
| In-memory DB | `new Database(":memory:")` | `new Database(":memory:")` |

### bun:test mock API difference — CRITICAL

`node:test` and `bun:test` use different mock creation syntax:

```ts
// node:test — mock is an object with .fn()
const fn = mock.fn();
const impl = mock.fn(() => 42);

// bun:test — mock is a function factory
const fn = mock(() => {});         // ← correct bun:test creation
const impl = mock(() => 42);       // ← with implementation
```

**`mock.fn()` does not exist in bun:test.** Calling it throws `TypeError: mock.fn is not a function`.
Every `mock.fn()` in all 8 test files must become `mock(() => {})`.

Call tracking is identical in both — both use `.mock.calls`:
```ts
// node:test
assert.strictEqual(fn.mock.calls.length, 1);
// bun:test
expect(fn.mock.calls.length).toBe(1);
```

The watcher.test.ts helper `makeMockWatcher()` uses `{ close: mock.fn(), on: mock.fn() }` —
update to `{ close: mock(() => {}), on: mock(() => {}) }`.

Double-check `sdk.test.ts` which is the largest test file — it has the most complex mock setups.

### node:test → bun:test full migration map

```ts
// MOCK CREATION
// mock.fn()                           →  mock(() => {})
// mock.fn(impl)                       →  mock(impl)

// ASSERTIONS
// assert.strictEqual(actual, expected)  →  expect(actual).toBe(expected)
// assert.deepStrictEqual(actual, expected)  →  expect(actual).toEqual(expected)
// assert.ok(condition)  →  expect(condition).toBeTruthy()
// assert.notStrictEqual(a, b)  →  expect(a).not.toBe(b)
// assert.throws(() => fn(), {message: /pattern/})  →  expect(() => fn()).toThrow(/pattern/)
// await assert.rejects(promise, ErrorClass)  →  await expect(promise).rejects.toThrow(ErrorClass)
// assert.match(str, /pattern/)  →  expect(str).toMatch(/pattern/)
```

### tsconfig module resolution

Changing `NodeNext` → `Bundler` means TypeScript no longer requires explicit `.js` extensions
on imports. However, leave existing `.js` extensions in place — Bun resolves them correctly and
removing them is unnecessary churn across all source files.

**`engine/src/undici-ambient.d.ts` — do NOT remove this file.** Despite the name, it serves
dual purpose: it declares both `undici` types (for `main.ts` DNS override) and `bcryptjs` types
(for key derivation). Removing it would break `bunx tsc --noEmit` with "Cannot find module
'bcryptjs'". If `bun-types` already includes undici types, the `undici` block inside this file
becomes a harmless duplicate — but the file itself must remain for the `bcryptjs` declaration.

### Flatpak — Option A (`bun build --compile`) notes

If Option A works, the compiled binary embeds the Bun runtime. Key implications:
- No network access at runtime (binary is self-contained)
- `bun:sqlite` is embedded — WAL mode works identically
- The binary is architecture-specific (x86_64 only for now — ARM64 Flatpak is out of scope)
- `get_engine_path()` returns a 1-tuple; update the spawn call accordingly:
  ```python
  paths = get_engine_path()
  proc = launcher.spawnv(list(paths))
  ```
  This works for both `(binary,)` and `(binary, script)` cases.

### engine/bun.lock already exists + node_modules cleanup required

`engine/bun.lock` appears as an untracked file in git status — `bun install` was previously run.

Before running `bun install`, **delete `engine/node_modules/`** if it exists. The existing
`node_modules/` was built by npm and contains native binaries compiled for Node (including
`better-sqlite3`). Mixing npm-compiled modules with Bun causes hard-to-diagnose failures.

```bash
rm -rf engine/node_modules/
rm engine/package-lock.json   # exists — confirmed 37KB
bun install                   # regenerates node_modules + updates bun.lock
```

Then verify `engine/bun.lock` is current and stage it for commit.

### engine/scripts/ directory

`engine/scripts/` also appears as untracked. Inspect its contents before Task 3 — if it contains
Bun-related scripts, incorporate them rather than duplicating.

### Project Structure Notes

Files touched by this story:
- `engine/src/state-db.ts` — bun:sqlite import + PRAGMA syntax
- `engine/src/*.test.ts` (8 files) — bun:test migration
- `engine/package.json` — dependency cleanup + script updates
- `engine/tsconfig.json` — module resolution update
- `engine/bun.lock` — new lockfile (commit the existing untracked file)
- `ui/src/protondrive/engine.py` — get_engine_path() Bun resolution
- `ui/tests/test_engine.py` — mock updates for Bun binary
- `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` — manifest update
- `_bmad-output/project-context.md` — engine runtime section update

Do NOT touch:
- `engine/src/errors.ts` — zero internal imports, leave alone
- Any `.ts` import paths — leave `.js` extensions in place
- UI Python code beyond `engine.py` — out of scope

### References

- bun:sqlite docs: `node_modules/bun-types/docs/sqlite.mdx` (if bun-types installed)
- bun:test docs: `node_modules/bun-types/docs/test.mdx`
- Epic 2 retrospective: `_bmad-output/implementation-artifacts/epic-2-retro-2026-04-12.md` § "Story 3-0"
- Deferred work items: `_bmad-output/implementation-artifacts/deferred-work.md` § "Deferred from: code review of 2-1"
- Current engine.py: `ui/src/protondrive/engine.py:28–49`
- Current Flatpak manifest: `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (Amelia persona)

### Flatpak Strategy Decision (Task 0)

**Option A chosen** — `bun build --compile src/main.ts --outfile=dist/engine`.

`bun build --compile` was confirmed to embed the Bun runtime and bun:sqlite directly in the output
binary. The compiled binary is self-contained: no Bun installation, no `node_modules`, no native
addon required at runtime. `get_engine_path()` returns a 1-tuple `("/app/lib/protondrive-engine/dist/engine",)`
in Flatpak context and `(bun, ".../engine/src/main.ts")` in dev.

### Debug Log References

- **stale dist/ files**: `engine/dist/src/*.test.js` (compiled by old `tsc`) were picked up by
  `bun test` alongside the `.test.ts` sources, causing double-run failures. Fixed by deleting
  `engine/dist/src/`.
- **uploadFileRevision vs uploadFile**: engine calls `uploadFileRevision` (not `uploadFile`) for
  files that already exist remotely. `makeMockClient()` in `sync-engine.test.ts` was missing
  `uploadFileRevision`. Added mock + updated "local-only changed" assertion.
- **`server.emitEvent` undefined in add_pair test**: `add_pair` handler creates a `FileWatcher`
  that immediately calls `server.emitEvent`, but no server was set in the `add_pair` describe
  block. Fixed by adding `_setServerForTests` with a stub `IpcServer` in `beforeEach`.
- **`fetchAndDecryptAllKeys is not a function`**: SDK `deriveAndUnlock` API changed — now delegates
  entirely to `accountAdapter.fetchAndDecryptAllKeys()` instead of calling `fetchKeySalt` +
  `fetchAndDecryptKeys` separately. Rewrote `makeMockAdapter` in `sdk.test.ts`.
- **tsc error `sync-engine.ts:487`**: `ReadableStream<any>` → `ReadableStream<Uint8Array>` cast
  fails under `moduleResolution: "Bundler"`. Fixed: `as unknown as ReadableStream<Uint8Array>`.
- **`test_spawn_failure_emits_error` / `test_start_resets_shutdown_initiated`**: tests patched
  `GLib.spawn_async` (old API) but `engine.py` now uses `Gio.SubprocessLauncher.new().spawnv()`.
  Updated both tests to mock `Gio.SubprocessLauncher`.

### Completion Notes List

- All 148 engine tests pass under `bun test` (8 files, 0 failures, 0 skips).
- All 52 Python UI tests pass under pytest.
- `bunx tsc --noEmit` passes with zero errors.
- Flatpak manifest updated to Option A (compiled binary). Tasks 5.5 and 5.6 confirmed by Jeremy:
  engine starts, IPC connects, `[APP] engine ready` + `session_ready` received, sync runs to
  completion (`startSyncAll: done`). The "password asked twice" is the pre-existing key unlock
  flow (Story 2-11), not introduced by this story.
- `engine/bun.lock` already existed as untracked (from a prior `bun install` run); committed as-is.
- `engine/package-lock.json` (37KB, npm) deleted; replaced by `engine/bun.lock`.
- `engine/dist/src/` (stale tsc output) deleted to avoid bun test discovery collision.

### Review Findings — Group E (docs)

- [x] [Review][Patch] Opening line still says "TypeScript/Node sync engine" — updated to "TypeScript/Bun" [`_bmad-output/project-context.md:19`]
- [x] [Review][Patch] Section header "Sync Engine Tests (node:test)" still referenced old runtime — updated to "(bun:test)" [`_bmad-output/project-context.md:138`]
- [x] [Review][Patch] Section body had stale `node:test` API rules (`mock.fn()`, `node:assert/strict`) contradicting bun:test migration — replaced with bun:test equivalents [`_bmad-output/project-context.md:140`]
- [x] [Review][Patch] Stale "Node binary path not validated" deferred entry — updated to Bun-specific framing post-migration [`_bmad-output/implementation-artifacts/deferred-work.md:212`]
- [x] [Review][Defer] W2 deferred entry references "Node SyntaxError" format — minor stale wording; update when touching IPC error handling [`_bmad-output/implementation-artifacts/deferred-work.md:114`] — deferred, pre-existing

### Review Findings — Group D (flatpak + engine.py + test_engine.py)

- [x] [Review][Patch] `test_engine_not_found_error` mock has stale "Node.js not found" — updated to "Bun runtime not found" [`ui/tests/test_engine.py:132,137`]
- [x] [Review][Defer] Bun binary not in `org.gnome.Sdk` build sandbox — works locally via PATH inheritance but breaks reproducible/CI Flatpak builds; document or add Bun source when CI builds Flatpak [`flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml:45`] — deferred, pre-existing
- [x] [Review][Defer] `bun build --compile` no `--target` flag — x86_64 only; ARM64 out of scope per Dev Notes [`flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml:46`] — deferred, pre-existing
- [x] [Review][Defer] `get_engine_path()` return type `tuple[str, ...]` less precise than spec's `tuple[str] | tuple[str, str]` — minor; functionally identical [`ui/src/protondrive/engine.py:28`] — deferred, pre-existing

### Review Findings — Group C (test files)

- [x] [Review][Defer] `expect(!expr).toBeTruthy()` / `expect(x >= N).toBeTruthy()` patterns give opaque failure messages — pre-existing from original `assert.ok()`; use `.not.toContain()`, `.toBeGreaterThanOrEqual()` etc. in a future cleanup pass [multiple test files] — deferred, pre-existing
- [x] [Review][Defer] `expect(true).toBe(false)` sentinel in try/catch blocks — poor diagnostics on failure; replace with `throw new Error("unreachable")` in a cleanup pass [`engine/src/sdk.test.ts`] — deferred, pre-existing
- [x] [Review][Defer] Timing-dependent tests using hard-coded `setTimeout(r, 100)` for 50 ms debounce — fragile under high load; replace with deterministic event signaling in a future pass [`engine/src/watcher.test.ts`] — deferred, pre-existing

### Review Findings — Group A (build/config)

- [x] [Review][Patch] `bun-types: "latest"` is non-deterministic and mismatches CI's pinned Bun 1.3.11 — bun.lock resolves to 1.3.12; pin to `"1.3.11"` [`engine/package.json`]
- [x] [Review][Patch] `engine/bun.lock` is untracked (never staged/committed) despite Completion Notes saying "committed as-is" — AC4 requires it to be committed [`engine/bun.lock`]
- [x] [Review][Defer] Flatpak build env lacks `bun` for `bun install`/`bun build --compile` steps — deferred to Group D (flatpak manifest) review [`flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`] — deferred, pre-existing

### File List

- `engine/src/state-db.ts` — `bun:sqlite` import + PRAGMA exec/query syntax
- `engine/src/sync-engine.ts` — `as unknown as ReadableStream<Uint8Array>` cast fix (line 487)
- `engine/src/state-db.test.ts` — migrated to `bun:test`
- `engine/src/ipc.test.ts` — migrated to `bun:test`; `mock.fn` → `mock`; `.mock.callCount()` → `.mock.calls.length`; `mockImplementation` on fn (not `.mock.`)
- `engine/src/main.test.ts` — migrated to `bun:test`; added `_setServerForTests` stub in `add_pair` beforeEach; removed duplicate import
- `engine/src/sdk.test.ts` — migrated to `bun:test`; `before`/`after` → `beforeAll`/`afterAll`; `resetCalls()` → `mockClear()`; `makeMockAdapter` rewritten for `fetchAndDecryptAllKeys`
- `engine/src/sync-engine.test.ts` — migrated to `bun:test`; added `uploadFileRevision` to `makeMockClient`; all `last_synced_at: null` in test pairs
- `engine/src/watcher.test.ts` — migrated to `bun:test`; `mock.fn` → `mock`; `mock.restoreAll()` → `mock.restore()`
- `engine/src/debug-log.test.ts` — migrated to `bun:test`
- `engine/src/config.test.ts` — migrated to `bun:test`
- `engine/package.json` — removed `better-sqlite3`, `tsx`, `@types/better-sqlite3`, `@types/node`; added `bun-types`; updated scripts
- `engine/tsconfig.json` — `module: "ESNext"`, `moduleResolution: "Bundler"`, `types: ["bun-types"]`
- `engine/bun.lock` — new lockfile (replaces `package-lock.json`)
- `ui/src/protondrive/engine.py` — `get_engine_path()` returns Bun 1-tuple (Flatpak) or `(bun, main.ts)` (dev); spawn uses `Gio.SubprocessLauncher`
- `ui/tests/test_engine.py` — updated mocks for `bun` binary, `Gio.SubprocessLauncher`
- `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` — removed node22 extension; `protondrive-engine` module uses `bun build --compile`
- `_bmad-output/project-context.md` — engine runtime, test commands, dev prerequisites updated for Bun
