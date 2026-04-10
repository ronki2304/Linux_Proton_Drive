# Story 2.10: Flatpak Build Validation

Status: ready-for-dev

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
**And** `better-sqlite3` native addon is built from source (not a pre-compiled binary) — `npm install --build-from-source` or `npm rebuild`
**And** the compiled engine output is installed to `/app/lib/protondrive-engine/`

**AC3 — Flatpak build success:**
**Given** the build command `flatpak-builder --user --install builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
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
**Then** it creates the DB at the sandbox-mapped `$XDG_DATA_HOME` (typically `~/.var/app/<app-id>/data/protondrive/state.db`)
**And** inotify watches work on `$HOME` (accessible via `--filesystem=home`)

**AC6 — `.flatpak-builder` cache excluded:**
**Given** the project `.gitignore`
**When** a Flatpak build is performed
**Then** `builddir/` and `.flatpak-builder/` are listed in `.gitignore` and not committed

## Tasks / Subtasks

- [ ] **Task 1: Update Flatpak manifest** (AC: #1, #2)
  - [ ] 1.1 Open `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
  - [ ] 1.2 Ensure `finish-args` contains:
    - `--share=network`
    - `--share=ipc`
    - `--socket=fallback-x11`
    - `--socket=wayland`
    - `--device=dri`
    - `--filesystem=home` (required for inotify on home directory)
    - `--talk-name=org.freedesktop.secrets` (Secret portal for libsecret)
  - [ ] 1.3 Replace `protondrive-engine` module placeholder with a real build:
    ```yaml
    - name: protondrive-engine
      buildsystem: simple
      build-options:
        env:
          npm_config_nodedir: /usr/lib/sdk/node22
      build-commands:
        - cp -r . /run/build/protondrive-engine
        - cd /run/build/protondrive-engine && /usr/lib/sdk/node22/bin/npm ci --build-from-source
        - cd /run/build/protondrive-engine && /usr/lib/sdk/node22/bin/npx tsc
        - mkdir -p /app/lib/protondrive-engine
        - cp -r /run/build/protondrive-engine/dist /app/lib/protondrive-engine/
        - cp -r /run/build/protondrive-engine/node_modules /app/lib/protondrive-engine/
        - cp /run/build/protondrive-engine/package.json /app/lib/protondrive-engine/
      sources:
        - type: dir
          path: ../engine
    ```
    Note: exact `build-commands` depend on actual `tsconfig.json` `outDir`. Adjust `dist` path to match.
  - [ ] 1.4 Verify the engine entry point in the UI's engine spawn command matches `/app/lib/protondrive-engine/dist/main.js`

- [ ] **Task 2: Update engine spawn path in engine.py** (AC: #4)
  - [ ] 2.1 In `ui/src/protondrive/engine.py`, update the engine binary path for Flatpak:
    - Check if running in Flatpak (`os.environ.get('FLATPAK_ID')`) → use `/app/lib/protondrive-engine/dist/main.js`
    - Else (development) → use the development path relative to the project
    - Engine command: `['/usr/lib/sdk/node22/bin/node', engine_path]` in Flatpak; `['node', '--import', 'tsx', engine_path]` in dev

- [ ] **Task 3: Update .gitignore** (AC: #6)
  - [ ] 3.1 Add `builddir/` and `.flatpak-builder/` to `.gitignore` if not already present
  - [ ] 3.2 Also add `*.flatpak` to `.gitignore`

- [ ] **Task 4: Manual build validation** (AC: #3, #4, #5)
  - [ ] 4.1 Run `flatpak-builder --user --install --force-clean builddir flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
  - [ ] 4.2 Verify build succeeds (no error exit code)
  - [ ] 4.3 Run `flatpak run io.github.ronki2304.ProtonDriveLinuxClient`
  - [ ] 4.4 Verify: window appears, no immediate crash, engine connects (check auth flow works)
  - [ ] 4.5 Document any issues found in the story's Completion Notes

- [ ] **Task 5: tsconfig.json outDir verification** (AC: #2)
  - [ ] 5.1 Check `engine/tsconfig.json` — ensure `outDir` is set to `"dist"` so compiled JS goes to `engine/dist/main.js`
  - [ ] 5.2 If `outDir` is missing or different, update `tsconfig.json` accordingly
  - [ ] 5.3 Verify `engine/src/main.ts` compiles correctly with `npx tsc --noEmit` first

## Dev Notes

### Flatpak build requirements
Install `flatpak-builder` before running:
```bash
sudo dnf install flatpak-builder  # Fedora
# or
sudo apt install flatpak-builder  # Debian/Ubuntu
```
Install GNOME 50 SDK:
```bash
flatpak install flathub org.gnome.Sdk//50
flatpak install flathub org.freedesktop.Sdk.Extension.node22
```

### better-sqlite3 native addon
`better-sqlite3` is a native Node.js addon requiring compilation. In Flatpak:
- `npm ci --build-from-source` forces compilation from source
- `npm_config_nodedir` must point to the Node.js headers provided by `node22` SDK extension
- If `npm ci` fails due to network (Flatpak sandbox restricts network during build), use `npm ci --offline` with pre-downloaded modules bundled in the manifest

### Offline npm approach for Flatpak
Flatpak build sandbox has no network access. Use the `flatpak-node-generator` tool to generate a `generated-sources.json` for npm dependencies:
```bash
# Install flatpak-node-generator
pip install flatpak-node-generator
# Generate sources from package-lock.json
flatpak-node-generator --runtime node22 npm engine/package-lock.json
```
This generates `generated-sources.json` which is referenced in the manifest as an additional source for the engine module. This is the recommended approach for production Flatpak builds.

For initial validation (AC3), `--network-access` flag can be used temporarily:
```bash
flatpak-builder --user --install --force-clean --allow-missing-sources builddir flatpak/...yml
```

### Engine spawn path detection
```python
import os

def _get_engine_path() -> list[str]:
    if os.environ.get('FLATPAK_ID'):
        node_bin = '/usr/lib/sdk/node22/bin/node'
        engine_js = '/app/lib/protondrive-engine/dist/main.js'
        return [node_bin, engine_js]
    else:
        # Development: use tsx for TypeScript
        project_root = Path(__file__).parent.parent.parent.parent
        engine_src = project_root / 'engine' / 'src' / 'main.ts'
        return ['node', '--import', 'tsx', str(engine_src)]
```

### tsconfig.json outDir
Ensure `engine/tsconfig.json` has:
```json
{
  "compilerOptions": {
    "outDir": "dist",
    ...
  }
}
```
The Flatpak module copies `engine/dist/` to `/app/lib/protondrive-engine/dist/`.

### References
- [Source: flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml] — manifest to update
- [Source: ui/src/protondrive/engine.py] — engine spawn path
- [Source: engine/tsconfig.json] — outDir configuration
- [Source: engine/package.json] — dependencies for offline manifest generation
- [Source: _bmad-output/planning-artifacts/architecture.md] — Flatpak App ID, finish-args requirements

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

### File List

- `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` — update: engine module, finish-args
- `ui/src/protondrive/engine.py` — update: Flatpak/dev engine path detection
- `engine/tsconfig.json` — update: ensure outDir = "dist"
- `.gitignore` — add builddir, .flatpak-builder, *.flatpak

## Change Log

- 2026-04-09: Story 2.10 created — Flatpak Build Validation
