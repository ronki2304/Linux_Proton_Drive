# Story 7.3: CI/CD Pipelines

Status: ready-for-dev

## Story

As a developer,
I want automated CI/CD pipelines for testing and releasing,
so that every PR is tested and releases are built reproducibly.

## Acceptance Criteria

1. **CI gate (PR)** — `.github/workflows/ci.yml` runs on every PR; runs both test suites: engine (`bun test` in `engine/`) and UI (`meson compile -C builddir && ui/.venv/bin/pytest ui/tests/`); both must pass for the PR to be mergeable.
2. **Engine type-check** — CI also runs `bunx tsc --noEmit` from `engine/` to catch type errors not caught by `bun test`.
3. **Release pipeline** — `.github/workflows/release.yml` triggers on `v*` tag push; builds the Flatpak bundle using `flatpak-builder`; creates a GitHub Release with the `.flatpak` artifact attached.
4. **Release gate** — release pipeline runs the engine test suite before building; a test failure prevents the release artifact from being created. UI/Meson tests are intentionally excluded from the release gate — they require GNOME SDK 50 installation (very slow); the PR gate (ci.yml) already validated both suites before the tag was created.
5. **E2E workflow fixed** — `.github/workflows/e2e.yml` updated to reference current paths (`engine/src/__integration__/` not stale `src/__integration__/`); manual trigger and `v*` tag trigger preserved.
6. **CONTRIBUTING.md** — Created at project root; covers: two-terminal dev launch, integration test token workflow (manual auth → `secret-tool lookup` → env vars → `bun test`), token expiry behaviour, test commands for both UI and engine, branch naming conventions, commit message conventions; satisfies the architecture doc requirement "integration test prerequisite documented in CONTRIBUTING.md".

## Tasks / Subtasks

- [ ] **Task 1 — Rewrite `ci.yml`** (AC: 1, 2)
  - [ ] 1.1 Replace the entire existing file — current content references old CLI structure (`src/cli.ts`, wrong `bun install` at project root) and is completely wrong for the two-process desktop app
  - [ ] 1.2 Add **engine job**: `runs-on: ubuntu-latest`; steps: checkout → setup Bun 1.3.11 (via `oven-sh/setup-bun@v2`) → `cd engine && bun install --frozen-lockfile` → `bunx tsc --noEmit` → `bun test`
  - [ ] 1.3 Add **ui-tests job**: `runs-on: ubuntu-latest`; steps: checkout → install apt packages (`blueprint-compiler python3-venv python3-pip meson ninja-build`) → create venv (`python3 -m venv ui/.venv && ui/.venv/bin/pip install pytest pyyaml`) → `meson setup builddir` → `meson compile -C builddir` → `ui/.venv/bin/pytest ui/tests/`; **no `xvfb-run` needed** — the full GI/GTK stack is mocked in `ui/tests/conftest.py` so no X display is required; **no heavy GIR apt packages needed** — `gir1.2-*` are unnecessary since GI is fully mocked
  - [ ] 1.4 Both jobs run in parallel (no dependency between engine and ui-tests jobs)
  - [ ] 1.5 Pin action SHAs as in the existing file (commit hash comments, not just tags)

- [ ] **Task 2 — Rewrite `release.yml`** (AC: 3, 4)
  - [ ] 2.1 Replace the entire existing file — current content references AppImage (`packaging/appimage/build-appimage.sh`) and `src/cli.ts`; both are wrong; AppImage was never implemented, Flatpak is the distribution format
  - [ ] 2.2 Trigger: `on: push: tags: ["v*"]`; `permissions: contents: write`
  - [ ] 2.3 Add test gate before build: engine tests (`cd engine && bun install --frozen-lockfile && bun test`) must pass
  - [ ] 2.4 Build Flatpak bundle using `flatpak/flatpak-github-actions/flatpak-builder@v6` (see Dev Notes for action config and known constraints); **pin this action to a full commit SHA** per Task 1.5's SHA-pinning policy — find SHA via `gh api repos/flathub/flatpak-github-actions/git/refs/tags/v6` or the action's GitHub releases page; format: `flatpak/flatpak-github-actions/flatpak-builder@<sha> # v6`
  - [ ] 2.5 Produce artifact named `io.github.ronki2304.ProtonDriveLinuxClient.flatpak`
  - [ ] 2.6 Create GitHub Release using `softprops/action-gh-release@v2` with `generate_release_notes: true`; attach the `.flatpak` bundle

- [ ] **Task 3 — Fix `e2e.yml`** (AC: 5)
  - [ ] 3.1 Update `bun test src/__e2e__/` → remove (no e2e directory exists)
  - [ ] 3.2 Update `bun test src/__integration__/` → `cd engine && bun test src/__integration__/`
  - [ ] 3.3 Remove `src/cli.ts` build step — engine binary is at `engine/` not project root
  - [ ] 3.4 Build step: `cd engine && bun build --compile src/main.ts --outfile=dist/engine` (not `--target=bun-linux-x64 src/cli.ts`)
  - [ ] 3.5 Keep triggers: `workflow_dispatch` and `on: push: tags: ["v*"]`
  - [ ] 3.6 Wire correct secret env vars: replace `PROTON_TEST_USER`/`PROTON_TEST_PASS` with `PROTON_TEST_TOKEN` and `PROTON_TEST_FOLDER` (these are the env vars the integration tests use per project-context.md); remove the `if: github.event_name == 'push'` condition from the integration tests step — integration tests must run on both `workflow_dispatch` and `v*` tag triggers, not just tag pushes
  - [ ] 3.7 Fix `bun install` step: change `run: bun install` to `cd engine && bun install --frozen-lockfile` — project root has no `package.json`; all npm state lives in `engine/`; the current file runs install at root which fails silently

- [ ] **Task 4 — Create `CONTRIBUTING.md`** (AC: 6)
  - [ ] 4.1 Create at project root (not in `ui/` or `engine/`)
  - [ ] 4.2 Section: **Development Setup** — prerequisites (GNOME SDK 50, Bun 1.3.11, Blueprint compiler, Meson, Flatpak Builder); two-terminal launch commands (see Dev Notes)
  - [ ] 4.3 Section: **Running Tests** — exact commands for both suites; use the test command table from Dev Notes; note that both local and CI UI runs use pytest (`ui/.venv/bin/pytest ui/tests/`), and `meson compile -C builddir` precedes pytest in CI to validate Blueprint compilation
  - [ ] 4.4 Section: **Integration Tests** — manual auth flow for `PROTON_TEST_TOKEN`; token expiry warning; why automation is impossible (CAPTCHA); `afterAll` cleanup requirement
  - [ ] 4.5 Section: **Branch Naming** — `feat/<story-id>-short-desc`, `fix/<issue>-short-desc`, `chore/<desc>`
  - [ ] 4.6 Section: **Commit Messages** — Conventional Commits with `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:` prefixes; imperative mood; scope optional

- [ ] **Task 5 — Validate** (AC: 1–6)
  - [ ] 5.1 Lint YAML: `yamllint .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/e2e.yml` or visual inspection
  - [ ] 5.2 Verify `ci.yml` references `engine/` working directory, not project root, for all Bun commands
  - [ ] 5.3 Verify `release.yml` references correct manifest path: `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
  - [ ] 5.4 Verify CONTRIBUTING.md test commands match project-context.md exactly (no drift)
  - [ ] 5.5 Set story status to `review`

---

## Dev Notes

### CRITICAL: Epic spec vs. actual implementation divergence

The epic spec (written before the Bun migration) contains stale references:
- Epic says: `node --import tsx --test engine/src/**/*.test.ts` → **WRONG** — engine uses Bun; correct command is `bun test` from `engine/`
- Epic says: `better-sqlite3 native addon is compiled from source` → **WRONG** — engine uses `bun:sqlite` (built-in, no native compilation); `bun build --compile` embeds the runtime; no native addon
- Epic says: `--import tsx` loader is required → **Only true for Node.js**, which is not used; irrelevant for Bun

Use `bun test` (from `engine/` directory) everywhere. `bun:sqlite` requires nothing special — it's bundled into the Bun binary.

### Engine working directory

All Bun commands must run from `engine/` (not project root). Project root has no `package.json` — `bun install` at root will fail.

```yaml
- run: |
    cd engine
    bun install --frozen-lockfile
    bunx tsc --noEmit
    bun test
```

Or use `working-directory`:
```yaml
- run: bun install --frozen-lockfile
  working-directory: engine
- run: bunx tsc --noEmit
  working-directory: engine
- run: bun test
  working-directory: engine
```

### UI test dependencies on Ubuntu (CI)

Because `ui/tests/conftest.py` fully mocks the GI/GTK stack, CI only needs a minimal set of packages. Install these before `meson setup builddir`:

```bash
sudo apt-get update
sudo apt-get install -y \
  blueprint-compiler \
  meson ninja-build \
  python3-venv python3-pip
```

**No GIR packages needed:** `gir1.2-gtk-4.0`, `gir1.2-adw-1`, `gir1.2-webkitgtk-6.0`, `python3-gi`, etc. are NOT required — conftest.py replaces all GI imports with MagicMock before any test module is loaded.

**No xvfb needed:** No real GTK windows are created during pytest runs. The `xvfb-run` prefix is unnecessary.

**Blueprint compiler availability:** `blueprint-compiler` is in Ubuntu 24.04 main. On 22.04 it may need `pip install blueprint-compiler`. Confirm `ubuntu-latest` version before finalising workflow (ubuntu-latest as of 2026 is 24.04).

### Meson setup in CI

`ui/meson.build` has **no `test()` stanza** — `meson test -C builddir` would exit 0 with "0 tests ran" (silent false-pass). Do NOT use `meson test` for the UI test job.

The correct CI approach runs `meson compile` (to validate Blueprint compilation and build gresources) then `pytest` directly:

```yaml
- name: Set up Python venv
  run: python3 -m venv ui/.venv && ui/.venv/bin/pip install pytest pyyaml

- name: Meson setup
  run: meson setup builddir

- name: Compile blueprints
  run: meson compile -C builddir

- name: Run UI tests
  run: ui/.venv/bin/pytest ui/tests/
```

**Why no `xvfb-run`:** `ui/tests/conftest.py` installs mocks for the entire `gi.repository` namespace at import time — no real GTK display is ever created, so X11 is not needed.

**Why no `gir1.2-*` apt packages:** GI type introspection libraries are only needed when importing live GI bindings. Since conftest.py replaces all GI imports with `MagicMock`, installing `gir1.2-gtk-4.0` etc. is unnecessary overhead.

**Required apt packages (minimal set):**
```bash
sudo apt-get install -y blueprint-compiler python3-venv python3-pip meson ninja-build
```

Note: `meson setup builddir` must run from the project root (it finds `ui/meson.build` automatically). Do NOT call `meson` from `ui/` subdirectory or from inside distrobox in CI — use system Meson on ubuntu-latest directly.

### Flatpak release build

Use `flatpak/flatpak-github-actions/flatpak-builder@v6`:

```yaml
- uses: flatpak/flatpak-github-actions/flatpak-builder@v6
  with:
    bundle: io.github.ronki2304.ProtonDriveLinuxClient.flatpak
    manifest-path: flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml
    cache-key: flatpak-builder-${{ github.sha }}
```

This action:
- Installs `flatpak-builder`
- Installs `org.gnome.Platform//50` and `org.gnome.Sdk//50` runtimes
- Runs `flatpak-builder` with `--user` and `--install`
- Produces the named `.flatpak` bundle

**Network requirement:** The engine module's `build-options.build-args` already includes `--share=network` (required to download Bun during build). The `flatpak-github-actions` action handles the `--allow-rwx-tmpfs` and other flags automatically.

**Build time:** Flatpak build downloads the Bun binary (~80MB) and runs `bun install` — expect 5–10 minutes. Enable caching via `cache-key` to speed up subsequent runs.

**Artifact location:** After the action runs, the bundle is at `io.github.ronki2304.ProtonDriveLinuxClient.flatpak` in the workspace root.

### Release workflow structure

```yaml
jobs:
  test:
    name: Test gate
    # engine tests only (fast); UI tests deferred to separate CI job
    ...

  release:
    name: Build & Release
    needs: test
    steps:
      - checkout
      - flatpak-github-actions/flatpak-builder  # builds Flatpak
      - softprops/action-gh-release             # creates release + attaches bundle
```

Running full UI/Meson tests in the release job would require GNOME 50 SDK installation — very slow. The release gate only requires the engine tests to pass (fast). The PR gate (ci.yml) already validated both suites before the tag was created.

### e2e.yml — correct integration test paths

Current stale paths (all wrong):
- `src/__e2e__/` → **does not exist** — remove this step
- `src/__integration__/` → **wrong** → `engine/src/__integration__/`
- `src/cli.ts` → **wrong** → `engine/src/main.ts`

Integration test env vars per project-context.md: `PROTON_TEST_TOKEN` and `PROTON_TEST_FOLDER`. The current stale file uses `PROTON_TEST_USER` and `PROTON_TEST_PASS` — those never existed in this project.

### CONTRIBUTING.md — test command table

```
| Scope | Command | When to use |
|-------|---------|-------------|
| Engine unit | `cd engine && bun test` | Local dev, always |
| Engine type-check | `cd engine && bunx tsc --noEmit` | Before pushing |
| UI (local) | `ui/.venv/bin/pytest ui/tests/` | Local dev, always |
| UI (CI) | `meson compile -C builddir && ui/.venv/bin/pytest ui/tests/` | CI validates blueprint compilation first |
| Integration | `cd engine && bun test src/__integration__/` | Only with valid PROTON_TEST_TOKEN |
```

### CONTRIBUTING.md — two-terminal launch

```
# Terminal A — Sync Engine
cd engine
bun install        # first time only
bun run src/main.ts

# Terminal B — GTK UI
meson setup builddir   # first time only
meson compile -C builddir
python -m protondrive
```

### Project Structure Notes

- `ci.yml`, `release.yml`, `e2e.yml` all live at `.github/workflows/` (existing directory, existing files — rewrite in place)
- `CONTRIBUTING.md` at project root (new file)
- Do NOT create any files under `ui/`, `engine/`, or `flatpak/` for this story
- `flatpak/PERMISSIONS.md` was created in Story 7-1 — reference from CONTRIBUTING.md if documenting Flatpak permission rationale, do not duplicate

### References

- Epic 7 spec: `_bmad-output/planning-artifacts/epics/epic-7-packaging-distribution.md#story-73`
- Project context (CI/CD section): `_bmad-output/project-context.md` — authoritative for test commands
- Flatpak manifest: `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
- Architecture doc (integration test requirement): `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` (CONTRIBUTING.md requirement)
- Previous story (7-2) result: `_bmad-output/implementation-artifacts/7-2-appstream-metainfo-and-desktop-file.md`
- Permissions doc: `flatpak/PERMISSIONS.md` (created in Story 7-1)

---

## Party-Mode Validation — 2026-04-23

Agents: Winston (Architect), Amelia (Dev), Quinn (QA), Bob (SM)

All findings resolved autonomously. Rationale documented inline.

- [x] **F1 [CRITICAL] AC 4 / Task 2 conflict — "both test suites" in release gate.** AC 4 said "both test suites" but Task 2.3 and Dev Notes specified engine-only. Rationale: UI/Meson tests require GNOME SDK installation (very slow); the PR gate already validates both suites; release gate should be fast. **Fix:** Rewrote AC 4 to "engine test suite only" with explicit rationale.

- [x] **F2 [CRITICAL] `meson test -C builddir` is a no-op — `ui/meson.build` has no `test()` stanza.** Running `meson test` would exit 0 with 0 tests run, giving false CI confidence. Additionally: `ui/tests/conftest.py` mocks the entire GI/GTK stack, so `xvfb-run` and `gir1.2-*` apt packages are unnecessary overhead. **Fix:** Changed AC 1 and Task 1.3 to use `meson compile -C builddir && ui/.venv/bin/pytest ui/tests/` directly. Added explicit Python venv setup step (`pip install pytest pyyaml`). Reduced apt packages to minimal set (`blueprint-compiler meson ninja-build python3-venv python3-pip`). Removed `xvfb-run`. Updated Dev Notes sections accordingly.

- [x] **F3 [ENHANCEMENT] Task 3.6 — `if: github.event_name == 'push'` condition blocks integration tests on `workflow_dispatch`.** The current e2e.yml condition causes integration tests to skip on manual triggers, defeating the `workflow_dispatch` purpose. **Fix:** Updated Task 3.6 to explicitly require removing this condition.

- [x] **F4 [ENHANCEMENT] Task 2.4 — no SHA pinning instruction for `flatpak-github-actions`.** Task 1.5 requires all actions to be SHA-pinned, but Task 2.4 introduced a new action without pinning guidance. **Fix:** Added SHA-pinning note to Task 2.4 with the lookup command.

- [x] **F5 [MINOR] Dev Notes "Meson setup in CI" section showed `xvfb-run meson test -C builddir`.** Contradicted the corrected CI approach. **Fix:** Rewrote section to show the pytest-based approach with explanation.

- [x] **F6 [CRITICAL] Task 3 doesn't fix `bun install` step in e2e.yml — project root has no `package.json`.** Task 3 is phrased as targeted updates (not a full rewrite), and none of subtasks 3.1–3.6 addressed the `bun install` step. The current e2e.yml runs `bun install` at project root; that directory has no `package.json`, so it creates an empty `bun.lockb` and installs nothing, causing the subsequent `bun test` / `bun build` to fail silently. **Fix:** Added Task 3.7 explicitly: `cd engine && bun install --frozen-lockfile`.

- [x] **F7 [ENHANCEMENT] Task 2.3 used `bun install` without `--frozen-lockfile`, inconsistent with Task 1.2.** CI jobs should use `--frozen-lockfile` for reproducibility — prevents lockfile drift from silently pulling newer transitive deps in the release gate vs. the PR gate. Rationale: the release gate should build from the exact same dependency tree that was validated at PR time; `--frozen-lockfile` enforces this. **Fix:** Updated Task 2.3 to `bun install --frozen-lockfile`.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (Bob SM, create-story workflow)

### Debug Log References

### Completion Notes List

### File List
