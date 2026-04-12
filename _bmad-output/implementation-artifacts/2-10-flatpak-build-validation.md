# Story 2.10: Flatpak Build Validation

Status: in-progress

## Story

As a developer,
I want to verify the app builds and runs correctly as a Flatpak,
So that sandbox issues are caught early and not discovered at Flathub submission time.

## Acceptance Criteria

**AC1 — Manifest completeness:**
**Given** the Flatpak manifest at `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** inspecting it
**Then** `org.freedesktop.Sdk.Extension.node22` is listed under `sdk-extensions`
**And** `--filesystem=home` and `--share=network` are in `finish-args`
**And** `--talk-name=org.freedesktop.secrets` is in `finish-args` (Secret portal for libsecret)
**And** `--socket=fallback-x11` and `--socket=wayland` are in `finish-args`

**AC2 — Engine module build:**
**Given** the Flatpak manifest
**When** inspecting the `protondrive-engine` module
**Then** it compiles the TypeScript engine using `node22` from the SDK extension
**And** `better-sqlite3` native addon is built from source (not a pre-compiled binary) — `npm ci --build-from-source`
**And** the compiled engine output is installed to `/app/lib/protondrive-engine/`

**AC3 — Flatpak build success:**
**Given** the build command `flatpak-builder --user --install --force-clean builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** run in the project root
**Then** the build completes without errors
**And** both `protondrive-ui` (meson) and `protondrive-engine` (npm + tsc) modules succeed

**AC4 — App launches in sandbox:**
**Given** the installed Flatpak
**When** `flatpak run io.github.ronki2304.ProtonDriveLinuxClient` is executed
**Then** the app starts, the main window appears, and no immediate crash occurs
**And** the engine subprocess spawns within the sandbox and IPC connects

**AC5 — XDG paths in sandbox:**
**Given** the Flatpak sandbox
**When** the engine creates the SQLite database
**Then** it creates the DB at the sandbox-mapped `$XDG_DATA_HOME` (typically `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/data/protondrive/state.db`)
**And** inotify watches work on `$HOME` (accessible via `--filesystem=home`)

**AC6 — `.flatpak-builder` cache excluded:**
**Given** the project `.gitignore`
**When** a Flatpak build is performed
**Then** `.flatpak-builder/` and `*.flatpak` are listed in `.gitignore` and not committed
(`builddir/` and `dist` are already in `.gitignore`)

---

## Tasks / Subtasks

- [x] **Task 1: Update Flatpak manifest** (AC: #1, #2)
  - [x] 1.1 Open `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
  - [x] 1.2 Add missing `finish-args` entries (two items to add; others already present):
    ```yaml
    finish-args:
      - --share=network        # already present
      - --share=ipc            # already present
      - --socket=fallback-x11  # already present
      - --socket=wayland       # already present
      - --device=dri           # already present
      - --filesystem=home      # ADD: required for inotify on home directory
      - --talk-name=org.freedesktop.secrets  # ADD: Secret portal for libsecret
    ```
  - [x] 1.3 Replace `protondrive-engine` module placeholder with real build:
    ```yaml
    - name: protondrive-engine
      buildsystem: simple
      build-options:
        env:
          npm_config_nodedir: /usr/lib/sdk/node22
          npm_config_cache: /run/build/protondrive-engine/.npm
      build-commands:
        - /usr/lib/sdk/node22/bin/npm ci --build-from-source
        - /usr/lib/sdk/node22/bin/npx tsc
        - /usr/lib/sdk/node22/bin/npm prune --omit=dev
        - mkdir -p /app/lib/protondrive-engine
        - cp -r dist /app/lib/protondrive-engine/
        - cp -rP node_modules /app/lib/protondrive-engine/
        - cp package.json /app/lib/protondrive-engine/
      sources:
        - type: dir
          path: ../engine
    ```
    Notes:
    - `npm prune --omit=dev` runs after `tsc` (which needs `typescript` devDep) and before copying — removes ~130MB of devDependencies (typescript, tsx, @types/*) from the Flatpak install.
    - `cp -rP node_modules` preserves symlinks (npm creates bin symlinks in `node_modules/.bin/`); `-r` without `-P` dereferences them, creating corrupt entries.
    - The `simple` buildsystem runs commands in the source directory — no `cp -r . /run/build/...` prefix needed.
  - [x] 1.4 Verify engine entry point path is consistent with Task 2 update:
    - `tsconfig.json` has `rootDir: "."` and `outDir: "./dist"` with `include: ["src/**/*.ts"]`
    - `src/main.ts` compiles to `dist/src/main.js`
    - Flatpak engine path = `/app/lib/protondrive-engine/dist/src/main.js`

- [x] **Task 2: Update engine spawn path in engine.py** (AC: #4)
  - [x] 2.1 In `ui/src/protondrive/engine.py`, update `get_engine_path()` — change the Flatpak branch only:
    ```python
    # CURRENT (lines 31-34):
    if os.environ.get("FLATPAK_ID"):
        return (
            "/usr/lib/sdk/node22/bin/node",
            "/app/lib/protondrive/engine.js",
        )

    # AFTER:
    if os.environ.get("FLATPAK_ID"):
        return (
            "/usr/lib/sdk/node22/bin/node",
            "/app/lib/protondrive-engine/dist/src/main.js",
        )
    ```
  - [x] 2.2 **`get_engine_path()` dev branch (lines 36-48): FROZEN — do not modify.** It already resolves `engine/dist/src/main.js`, which is the correct tsc output path.
  - [x] 2.3 **Do not add `--import tsx` to the dev spawn command.** Dev mode runs compiled JS; tsx is only for the manual two-terminal workflow documented in project-context.md.

- [x] **Task 3: Update .gitignore** (AC: #6)
  - [x] 3.1 Add the following to `.gitignore` (note: `builddir` and `dist` already present):
    ```
    .flatpak-builder/
    *.flatpak
    ```

- [x] **Task 4: tsconfig.json outDir verification** (AC: #2) — READ-ONLY verification
  - [x] 4.1 Confirm `engine/tsconfig.json` has all three: `"outDir": "./dist"`, `"rootDir": "."`, `"include": ["src/**/*.ts"]` — if any differ, the compiled path changes and the manifest `cp -r dist` target in Task 1.3 must be adjusted to match. Current state: all three are correct, no changes needed.

- [ ] **Task 5: Manual build validation** (AC: #3, #4, #5) — MANUAL STEP
  - [ ] 5.1 Install prerequisites if not present:
    ```bash
    flatpak install flathub org.gnome.Sdk//50 org.gnome.Platform//50
    flatpak install flathub org.freedesktop.Sdk.Extension.node22
    sudo dnf install flatpak-builder  # Fedora
    ```
  - [ ] 5.2 Build the engine first to confirm tsc output path:
    ```bash
    cd engine && npm ci && npx tsc && ls dist/src/main.js
    ```
  - [ ] 5.3 Run Flatpak build:
    ```bash
    flatpak-builder --user --install --force-clean builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml
    ```
  - [ ] 5.4 Verify build succeeds (exit code 0, no errors)
  - [ ] 5.5 Verify the engine script path exists in the sandbox before launching the full app:
    ```bash
    flatpak run --command=sh io.github.ronki2304.ProtonDriveLinuxClient \
      -c 'ls /app/lib/protondrive-engine/dist/src/main.js && echo PATH_OK'
    ```
    If this prints `PATH_OK`, AC4 path alignment is confirmed. If it errors, the manifest install path does not match `engine.py` — fix the manifest before proceeding.
  - [ ] 5.6 Run app: `flatpak run io.github.ronki2304.ProtonDriveLinuxClient`
  - [ ] 5.7 Verify: main window appears, no immediate crash
  - [ ] 5.8 Document any issues found in Completion Notes below

> **No automated test gate for this story.** AC3–AC5 are verified manually above. Do not create test files. Mark done after manual steps pass.

### Review Findings

- [x] [Review][Decision] Node binary path `/usr/lib/sdk/node22/bin/node` not available at Flatpak runtime — SDK extensions are build-time only; at runtime inside the sandbox `/usr/lib/sdk/node22/bin/node` does not exist, causing engine spawn to fail with "file not found". Fix requires either (a) copying node binary to `/app/bin/node` in the manifest and updating `engine.py` to use `/app/bin/node`, or (b) restructuring the engine to not require a separate node binary. Decision needed: what is the correct node runtime path strategy? [engine.py:32, manifest:build-commands]
- [x] [Review][Patch] `npx tsc` may resolve SDK's `tsc` over project-pinned version — `append-path` makes `/usr/lib/sdk/node22/bin` first on PATH; if SDK ships a `tsc`, it takes precedence over `node_modules/.bin/tsc`. Fix: replace `npx tsc` with `./node_modules/.bin/tsc` in manifest build-commands. [flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml:38]
- [x] [Review][Defer] Double GLib.timeout_add in engine.py `start()` [ui/src/protondrive/engine.py:147-155] — deferred, pre-existing
- [x] [Review][Defer] Node binary path not validated before `spawnv` — `get_engine_path()` returns node binary + script; only script existence is checked via `isfile`, not the node binary itself; a missing node binary produces a generic error with no root-cause hint [ui/src/protondrive/engine.py:28-34] — deferred, pre-existing

---

## Dev Notes

### Current File States (as of Story 2.9)

| File | Current State | Action |
|------|--------------|--------|
| `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` | Has placeholder engine module; missing 2 `finish-args` | Update manifest |
| `ui/src/protondrive/engine.py` | Flatpak path points to wrong location (`/app/lib/protondrive/engine.js`) | Update Flatpak path only |
| `engine/tsconfig.json` | Correct: `outDir: "./dist"`, `rootDir: "."` | No changes needed |
| `.gitignore` | Has `builddir` and `dist`; missing `.flatpak-builder/` and `*.flatpak` | Add two entries |

### Architecture doc engine path vs. this story

`architecture.md:392` specifies `/app/lib/protondrive/engine.js` (a single flat file). That path assumed a future bundling step (esbuild/ncc). The project has no bundler — `package.json` `"build"` script is just `tsc`. `main.ts` imports `./ipc.js`, `./sdk.js`, etc. as relative modules, so the full `dist/src/` tree must be co-located. This story intentionally uses `/app/lib/protondrive-engine/dist/src/main.js` and copies the entire dist tree — that is the correct approach given the current build setup. Do not "fix" this to match the architecture doc's single-file path.

### CRITICAL: Engine path must be consistent across manifest and engine.py

The path the manifest installs the engine to **must match** the path `engine.py` spawns from:

- Manifest: copies `engine/dist/` to `/app/lib/protondrive-engine/dist/`
- tsconfig: `rootDir: "."`, `include: ["src/**/*.ts"]` → `src/main.ts` compiles to `dist/src/main.js`
- Full Flatpak path: `/app/lib/protondrive-engine/dist/src/main.js`
- `engine.py` Flatpak branch must use exactly: `/app/lib/protondrive-engine/dist/src/main.js`

**Do NOT use** `/app/lib/protondrive-engine/dist/main.js` — that path does not exist given the tsconfig structure.

### CRITICAL: better-sqlite3 is a native Node.js addon

`better-sqlite3` requires compilation against Node.js headers. In the Flatpak sandbox:
- `npm_config_nodedir` must point to `/usr/lib/sdk/node22` (the node22 SDK extension)
- `npm ci --build-from-source` forces compilation from source (no pre-built binaries)
- The `simple` buildsystem runs build-commands from the source directory (`../engine`)

### Flatpak build sandbox has no network access

Production Flatpak builds cannot fetch npm packages at build time. For initial validation (AC3), if offline mode fails, use the `flatpak-node-generator` approach:
```bash
pip install flatpak-node-generator
flatpak-node-generator --runtime node22 npm engine/package-lock.json
# This produces generated-sources.json to bundle in the manifest
```

For first-pass validation, you can test with a local build (network allowed by default in `flatpak-builder`). Network is only blocked on the Flathub CI, not local `flatpak-builder` invocations.

### Flatpak manifest — current full content to replace

The manifest currently has `build-commands: [echo "Engine module placeholder"]` and `sources: []`. Replace the entire `protondrive-engine` module block. The UI `protondrive-ui` module using meson is already correct — do not modify it.

### finish-args already correct (partial)

The manifest already has: `--share=network`, `--share=ipc`, `--socket=fallback-x11`, `--socket=wayland`, `--device=dri`.
Only two are missing: `--filesystem=home` and `--talk-name=org.freedesktop.secrets`.

`--filesystem=home` is required because inotify requires real filesystem access — the portal-based FUSE approach is broken (`xdg-desktop-portal #567`). Without it, `InotifyWatcher` cannot watch files in the user's home directory.

`--talk-name=org.freedesktop.secrets` enables the Secret Service portal for libsecret credential storage (tokens, passwords).

### engine.py — dev path is correct, do not change

Current dev path at `engine.py:36-48`:
```python
node = GLib.find_program_in_path("node")
engine_script = str(
    Path(__file__).resolve().parent.parent.parent.parent
    / "engine"
    / "dist"
    / "src"
    / "main.js"
)
return (node, engine_script)
```

This uses `engine/dist/src/main.js` which is exactly where `tsc` puts the compiled output given the current tsconfig (`rootDir: "."`, `include: ["src/**/*.ts"]`, `outDir: "./dist"`). The dev workflow requires running `npx tsc` (or equivalent) before launching the UI. Do NOT introduce tsx into the spawned command — the existing code runs compiled JS, not TypeScript source.

### Pre-existing bug in engine.py — do not touch

`engine.py:145-154` has a duplicate GLib.timeout_add block (identical 4-line setup repeated twice). This is a pre-existing bug — not introduced by this story and not in scope to fix here. Touch only line 33 (the Flatpak path string). Do not refactor or "clean up" surrounding code.

### No GLib.spawn_async() — EngineClient uses Gio.SubprocessLauncher

The engine spawn in `engine.py` uses `Gio.SubprocessLauncher.spawnv()` (not `GLib.spawn_async()`). `Gio.Subprocess` returns None if spawn fails — existing code checks `proc.get_identifier()`. This is already correct and requires no changes.

### Testing this story

This story has no automated tests — validation is manual (Task 5). The acceptance criteria are verified by:
- Inspecting the manifest file (AC1, AC2)
- Running `flatpak-builder` and checking exit code (AC3)
- Launching the installed Flatpak and observing the window (AC4)
- Checking XDG paths inside the sandbox (AC5): `flatpak run --command=sh io.github.ronki2304.ProtonDriveLinuxClient -c 'ls $XDG_DATA_HOME/protondrive/'`
- Inspecting `.gitignore` (AC6)

Since there are no automated tests, mark the story done after manual verification passes. Document any issues or deferred items in Completion Notes.

### XDG paths inside Flatpak sandbox

| Data | Sandbox path |
|------|-------------|
| State DB | `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/data/protondrive/state.db` |
| Config | `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/config/protondrive/config.yaml` |
| IPC socket | `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock` |
| Engine logs | `~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/cache/protondrive/engine.log` |

### References

- `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` — manifest to update
- `ui/src/protondrive/engine.py:28-49` — `get_engine_path()` function
- `engine/tsconfig.json` — confirms outDir and rootDir
- `.gitignore` — add .flatpak-builder/ and *.flatpak
- `_bmad-output/planning-artifacts/architecture.md` — Flatpak App ID, finish-args requirements

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` — update: engine module build-commands, add 2 finish-args
- `ui/src/protondrive/engine.py` — update: Flatpak engine path from `/app/lib/protondrive/engine.js` to `/app/lib/protondrive-engine/dist/src/main.js`
- `.gitignore` — add `.flatpak-builder/` and `*.flatpak`

## Change Log

- 2026-04-09: Story 2.10 created — Flatpak Build Validation
- 2026-04-11: Enhanced with current file state analysis — corrected engine path discrepancy, confirmed tsconfig outDir, documented exact diff for engine.py Flatpak branch
- 2026-04-11: Quality review applied — added npm prune step (saves ~130MB), cp -rP for symlinks, architecture path divergence note, isfile verification step in Task 5, pre-existing duplicate timer guard, hardened dev-branch freeze constraint
