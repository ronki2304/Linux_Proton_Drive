# Story 8.4: Release Engineering & Version Management

Status: done

## Story

As a maintainer,
I want a canonical version source, pre-release CI support, and a documented release runbook,
so that I can safely exercise the full release pipeline and perform repeatable releases before and after the v1 public post.

## Acceptance Criteria

### AC1 — `VERSION` file is the canonical version source

**Given** the project root
**When** this story is complete
**Then** a `VERSION` file exists at the project root containing `0.1.0` (no trailing newline required — the bump script handles consistency)
**And** `ui/meson.build`'s `project()` version is kept in sync by the release runbook / bump script
**And** `engine/package.json` `"version"` is kept in sync by the bump script
**And** `metainfo.xml` `<release version>` and `date` attribute are kept in sync by the bump script

### AC2 — `scripts/bump-version.sh` updates all four version locations atomically

**Given** the dev runs `./scripts/bump-version.sh 0.2.0`
**When** the script completes
**Then** `VERSION` contains `0.2.0`
**And** `ui/meson.build` first `version:` value is `'0.2.0'`
**And** `engine/package.json` `"version"` field is `"0.2.0"`
**And** `metainfo.xml` `<release version>` attribute is `"0.2.0"` and `date` attribute is today's date (ISO 8601, e.g. `2026-04-25`)
**And** the script is executable (`chmod +x`)
**And** the script exits non-zero with a clear usage message if called with no argument

### AC3 — CI validates git tag version matches `VERSION` before building

**Given** the `release` job in `.github/workflows/release.yml`
**When** a `v*` tag is pushed
**Then** the first post-checkout step extracts the base version from the tag (strips `v` prefix and any pre-release suffix after `-`, e.g. `v0.1.0-rc1` → `0.1.0`)
**And** compares it against `cat VERSION`
**And** if they differ: the step fails immediately with a human-readable error that includes the exact `bump-version.sh` command to fix it
**And** if they match: the step passes and the Flatpak build proceeds

### AC4 — CI marks pre-release tags as GitHub pre-releases

**Given** the `softprops/action-gh-release` step in `.github/workflows/release.yml`
**When** a tag containing `-` is pushed (e.g. `v0.1.0-rc1`)
**Then** the resulting GitHub Release is marked as a pre-release (`prerelease: true`) — it does not appear as "Latest Release" on the repository home page
**When** a tag without `-` is pushed (e.g. `v0.1.0`)
**Then** the resulting GitHub Release is marked as a stable release (`prerelease: false`) — it promotes to "Latest Release"

### AC5 — "Releasing" section added to `CONTRIBUTING.md`

**Given** a contributor wants to cut a release
**When** they read `CONTRIBUTING.md`
**Then** a "Releasing" section exists covering:
- **Pre-release dry run** — exact commands to push a `v0.1.0-rc1` tag, verify CI, verify the GitHub pre-release and bundle download, then clean up the rc tag
- **Final release** — exact commands: run `bump-version.sh`, commit, push tag, verify
- **Failure recovery** — exact commands to delete a bad tag locally (`git tag -d`) and remotely (`git push origin :refs/tags/…`) plus instruction to delete the GitHub Release via web UI
- **Pre-tag checklist** — six items: tests passing, `VERSION` updated, metainfo version + date updated, `engine/package.json` version updated, `ui/meson.build` version updated (all automated by bump script but worth confirming), and all changes committed and pushed

### AC6 — End-to-end pre-release exercise (manual, Jeremy)

**Given** AC1–AC5 are implemented and pushed to `main`
**When** Jeremy runs:
```
git tag v0.1.0-rc1
git push origin v0.1.0-rc1
```
**Then** the `test` and `release` CI jobs complete successfully
**And** a GitHub pre-release is created for `v0.1.0-rc1` with the Flatpak bundle attached
**And** the bundle is downloadable from the GitHub release page
**And** the pre-release label is correctly applied (not "Latest Release")
**After verification** Jeremy deletes the rc1 tag locally and remotely per the runbook cleanup procedure

**Note:** The `v0.1.0-rc1` tag version check: `0.1.0-rc1` → base `0.1.0` == `VERSION` `0.1.0` ✓ — the CI check passes for rc tags.

### AC7 — Story stops at `review`

## Tasks / Subtasks

- [x] **T1 — Create `VERSION` file at project root** (AC1)
  - [x] Create `/VERSION` with content `0.1.0`
  - [x] No trailing newline issues: the bump script always uses `echo "X" > VERSION` which adds a trailing newline; the CI check uses `cat VERSION` which reads it correctly; meson.build reads via sed so the newline is irrelevant

- [x] **T2 — Create `scripts/bump-version.sh`** (AC2)
  - [x] Note: `scripts/` directory already exists (contains `check-boundaries.sh`, `epic-pipeline.sh`) — just add the new file
  - [x] Create `scripts/bump-version.sh` — executable shell script:
    ```bash
    #!/usr/bin/env bash
    # Bump all version strings to a new version.
    # Usage: ./scripts/bump-version.sh 0.2.0
    set -euo pipefail

    if [ $# -ne 1 ]; then
      echo "Usage: $0 <version>"
      echo "Example: $0 0.2.0"
      exit 1
    fi

    VERSION="$1"
    TODAY="$(date -I)"
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ROOT="$SCRIPT_DIR/.."

    # 1. VERSION file
    echo "$VERSION" > "$ROOT/VERSION"

    # 2. ui/meson.build — first occurrence of version: '...'
    sed -i "0,/version: '[^']*'/s/version: '[^']*'/version: '$VERSION'/" "$ROOT/ui/meson.build"

    # 3. engine/package.json — "version" field
    tmp="$(mktemp)"
    jq --arg v "$VERSION" '.version = $v' "$ROOT/engine/package.json" > "$tmp"
    mv "$tmp" "$ROOT/engine/package.json"

    # 4. metainfo.xml — <release version="..." date="...">
    sed -i "s/<release version=\"[^\"]*\" date=\"[^\"]*\">/<release version=\"$VERSION\" date=\"$TODAY\">/" \
      "$ROOT/ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml"

    echo "✓ Bumped to $VERSION (metainfo date: $TODAY)"
    echo ""
    echo "Next: review changes, then:"
    echo "  git add VERSION ui/meson.build engine/package.json ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml"
    echo "  git commit -m 'chore: bump version to $VERSION'"
    ```
  - [x] `chmod +x scripts/bump-version.sh`
  - [x] Requires `jq` — add bullet to the CONTRIBUTING.md Prerequisites list (not a table) and note in script comment

- [x] **T3 — Update `.github/workflows/release.yml`** (AC3, AC4)
  - [x] Add version consistency check step to the `release` job, immediately after "Checkout":
    ```yaml
    - name: Validate version consistency
      run: |
        TAG_BASE="${GITHUB_REF_NAME#v}"
        TAG_BASE="${TAG_BASE%%-*}"
        FILE_VERSION="$(cat VERSION)"
        if [ "$TAG_BASE" != "$FILE_VERSION" ]; then
          echo "ERROR: Tag '${GITHUB_REF_NAME}' base version ('${TAG_BASE}') != VERSION file ('${FILE_VERSION}')."
          echo "Run: ./scripts/bump-version.sh ${TAG_BASE} && git add VERSION ui/meson.build engine/package.json ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml && git commit -m 'chore: bump version to ${TAG_BASE}' && git push"
          exit 1
        fi
        echo "✓ Version ${FILE_VERSION} matches tag ${GITHUB_REF_NAME}"
    ```
  - [x] Add `prerelease` detection to `softprops/action-gh-release` step:
    ```yaml
    with:
      files: io.github.ronki2304.ProtonDriveLinuxClient.flatpak
      generate_release_notes: true
      prerelease: ${{ contains(github.ref_name, '-') }}
    ```

- [x] **T4 — Add "Releasing" section to `CONTRIBUTING.md`** (AC5)
  - [x] Add a new top-level section `## Releasing` after the "## Commit Messages" section
  - [x] See "Dev Notes — CONTRIBUTING.md Releasing section" below for the exact content

- [ ] **T5 — Manual: Pre-release dry run** (AC6) ⚠️ DEFERRED — to be run at end of Epic 8
  - [ ] Ensure AC1–AC4 changes are merged to `main` (or the release branch)
  - [ ] Run:
    ```bash
    git tag v0.1.0-rc1
    git push origin v0.1.0-rc1
    ```
  - [ ] Monitor CI: both `test` and `release` jobs must be green
  - [ ] Verify GitHub pre-release created with Flatpak bundle attached; confirm it is labelled "Pre-release" (not "Latest Release")
  - [ ] Optionally download and `flatpak install` the bundle to confirm it is valid
  - [ ] Clean up:
    ```bash
    git tag -d v0.1.0-rc1
    git push origin :refs/tags/v0.1.0-rc1
    # Also delete the GitHub Release via: https://github.com/ronki2304/ProtonDrive-LinuxClient/releases
    ```
  - [ ] Mark AC6 complete in this story file

## Dev Notes

### Why `VERSION` + `bump-version.sh` rather than a single canonical source parsed by all tools

Meson's `project()` call cannot use `fs.read()` before `project()` is declared (the `fs` module is only available after project initialization). The cleanest approach in this codebase is:

1. `VERSION` file = single human-editable canonical source (readable by shell scripts and CI)
2. `bump-version.sh` = atomic updater for all 4 locations
3. CI = tag-vs-VERSION consistency gate

This avoids the complexity of Meson trying to read files before its module system is ready. Future migration to `run_command('cat', '../VERSION')` in meson.build is possible but adds a `cat` dependency and produces identical developer experience.

### CI version check — why strip pre-release suffix

The version check in CI strips the pre-release suffix from the tag to allow `v0.1.0-rc1` to validate against `VERSION=0.1.0`. This means:
- You do NOT update `VERSION` for rc tags (VERSION stays `0.1.0` throughout the rc cycle)
- The VERSION file only changes when the final tag changes (e.g., `0.1.0` → `0.2.0`)
- The metainfo `<release version>` also stays at the final version (not `0.1.0-rc1`)

### `jq` prerequisite

`scripts/bump-version.sh` uses `jq` to edit `engine/package.json` (sed-based JSON editing is fragile). Add a `jq` bullet to the existing CONTRIBUTING.md Prerequisites bullet list (it is NOT a table). On Fedora: `sudo dnf install jq`. On Ubuntu: `sudo apt install jq`.

### CONTRIBUTING.md "Releasing" section content

Insert after the "## Commit Messages" section:

```markdown
## Releasing

### Prerequisites

In addition to the development prerequisites above, releasing requires:
- **`jq`** — JSON processor for the version bump script (`sudo dnf install jq` / `sudo apt install jq`)
- GitHub write access to push tags

### Pre-release dry run (safe — does not affect "Latest Release")

Use this path to exercise the full release pipeline without publishing the stable release:

```bash
# 1. Ensure tests pass
cd engine && bun test --path-ignore-patterns '__integration__'
cd .. && .venv/bin/pytest ui/tests/

# 2. Bump version (if needed) — updates VERSION, meson.build, package.json, metainfo
./scripts/bump-version.sh 0.1.0
git add VERSION ui/meson.build engine/package.json \
  ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml
git commit -m "chore: bump version to 0.1.0"
git push

# 3. Push a pre-release tag (contains '-' → GitHub pre-release, not "Latest Release")
git tag v0.1.0-rc1
git push origin v0.1.0-rc1

# 4. Monitor CI and verify:
#    - Both 'test' and 'release' jobs are green
#    - GitHub Release page shows a "Pre-release" badge (not "Latest Release")
#    - Flatpak bundle is attached to the release

# 5. Clean up after verification
git tag -d v0.1.0-rc1
git push origin :refs/tags/v0.1.0-rc1
# Also delete the GitHub Release via the web UI
```

### Final release

```bash
# 1. Ensure pre-release dry run passed (see above)

# 2. Bump version if not already done
./scripts/bump-version.sh 0.1.0   # no-op if already at 0.1.0
git add VERSION ui/meson.build engine/package.json \
  ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml
git commit -m "chore: bump version to 0.1.0"
git push

# 3. Push the stable tag (no '-' suffix → marked as stable "Latest Release")
git tag v0.1.0
git push origin v0.1.0
```

### Pre-tag checklist

Before pushing any `v*` tag, confirm:

- [ ] `bun test` and `.venv/bin/pytest ui/tests/` pass locally
- [ ] `VERSION` file contains the intended release version (base, no pre-release suffix)
- [ ] `metainfo.xml` `<release version>` matches and `date` is today
- [ ] `engine/package.json` `"version"` matches
- [ ] `ui/meson.build` `version:` matches
- [ ] All changes committed and pushed

### Failure recovery — deleting a bad tag

If CI fails or the release has an error after tagging:

```bash
# Delete locally
git tag -d v0.1.0

# Delete remotely
git push origin :refs/tags/v0.1.0

# Delete the GitHub Release (if created):
# Go to: https://github.com/ronki2304/ProtonDrive-LinuxClient/releases
# Click the release → Edit → scroll to bottom → "Delete this release"
# Note: deleting the GH Release does NOT automatically delete the tag
```
```

### `release.yml` — exact position of new step

Insert the "Validate version consistency" step in the `release` job immediately after the existing "Checkout" step and before "Install Flatpak dependencies". The `release` job (not the `test` job) is the right place because the `test` job runs on all tags and doesn't need the version check; the release build is where a mismatch matters.

### Pre-existing version locations (for reference)

| File | Field | Current value |
|---|---|---|
| `VERSION` (new) | file content | `0.1.0` |
| `ui/meson.build:3` | `version:` in `project()` | `'0.1.0'` |
| `engine/package.json` | `"version"` | `"0.1.0"` |
| `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml:46` | `<release version=` | `"0.1.0"` |

### Project Structure Notes

New files:
| File | Purpose |
|---|---|
| `VERSION` | Canonical version string (project root) |
| `scripts/bump-version.sh` | Atomic version bump across all 4 locations |

Modified files:
| File | Change |
|---|---|
| `.github/workflows/release.yml` | Add version consistency check step + prerelease detection |
| `CONTRIBUTING.md` | Add "Releasing" section |

No changes to: engine source files, Python UI files, Blueprint files, meson.build version field (stays at `0.1.0`; bump script handles future changes), GSettings schema, test files.

### Anti-Patterns to Avoid

- **Never use `sed` to edit JSON** — `package.json` update uses `jq`; sed-based JSON editing breaks on formatting changes
- **Never hardcode the tag version inside the Flatpak build** — the Flatpak bundle version comes from meson.build which is updated by the bump script; the tag is only a git concept
- **Never tag without running the bump script** — the CI check will catch it, but "fail fast in CI" is worse than "fail fast locally"
- **Never delete only the GitHub Release while keeping the tag** — the tag itself still appears in the GitHub Releases tab even without a formal release object; to clean up completely, delete both: the tag (locally with `git tag -d` and remotely with `git push origin :refs/tags/…`) AND the Release via web UI
- **Never use `git push --force` on a tag** — just delete and recreate; force-pushing tags is disorienting for anyone who already fetched them

### References

- [Source: _bmad-output/implementation-artifacts/epic-7-retro-2026-04-24.md#Challenges §4–5] — "Release pipeline untested end-to-end" and "No canonical version source" — the two root problems this story resolves
- [Source: .github/workflows/release.yml] — current release workflow; `softprops/action-gh-release@153bb8e…` supports `prerelease:` field
- [Source: ui/meson.build:1–4] — `project()` with hardcoded `version: '0.1.0'`; first occurrence targeted by sed
- [Source: engine/src/main.ts:124,136] — `import pkg from "../package.json" with { type: "json" }` → `ENGINE_VERSION = pkg.version`; this is the version string sent in the IPC `ready` event
- [Source: ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml:46] — `<release version="0.1.0" date="2026-04-23">`
- [Source: engine/package.json] — `"version": "0.1.0"`
- [Source: _bmad-output/project-context.md §Git Conventions] — conventional commit format for `chore: bump version` message

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- **T1**: Created `VERSION` file at project root with content `0.1.0`. AC1 satisfied.
- **T2**: Created `scripts/bump-version.sh` (executable); uses `jq` for package.json, `sed` for meson.build and metainfo.xml. Added `jq` prerequisite bullet to CONTRIBUTING.md Prerequisites. AC2 satisfied.
- **T3**: Added "Validate version consistency" step to `release` job in `.github/workflows/release.yml` (after Checkout, before Install Flatpak dependencies). Added `prerelease: ${{ contains(github.ref_name, '-') }}` to `softprops/action-gh-release` step. AC3, AC4 satisfied.
- **T4**: Added `## Releasing` section to `CONTRIBUTING.md` after `## Commit Messages`, covering pre-release dry run, final release, pre-tag checklist, and failure recovery. AC5 satisfied.
- **T5**: Manual task — requires Jeremy to push `v0.1.0-rc1` tag, verify CI, verify GitHub pre-release, and clean up. AC6 not yet complete.
- All 400 engine tests and 696 UI tests pass with no regressions.

### File List

- `VERSION` (new)
- `scripts/bump-version.sh` (new)
- `.github/workflows/release.yml` (modified)
- `CONTRIBUTING.md` (modified)

### Review Findings

- [x] [Review][Decision] Failure recovery / Pre-tag checklist ordering in CONTRIBUTING.md — reordered to match spec (Failure recovery before Pre-tag checklist); also corrected deletion order within Failure recovery (Release before tag). ✅ fixed
- [x] [Review][Patch] Executable bit not committed to git — fixed: `git add --chmod=+x`; index now shows mode 100755 [scripts/bump-version.sh] ✅
- [x] [Review][Patch] No version format validation — fixed: added `^[0-9]+\.[0-9]+\.[0-9]+$` regex guard before any file writes [scripts/bump-version.sh] ✅
- [x] [Review][Patch] Metainfo.xml sed replaces ALL `<release>` entries — fixed: added `0,/<release.../` anchor to update first entry only [scripts/bump-version.sh] ✅
- [x] [Review][Patch] Silent success when sed substitution doesn't match — fixed: added `grep -q` verification after each sed call [scripts/bump-version.sh] ✅
- [x] [Review][Patch] mktemp temp file not cleaned up + permissions mismatch — fixed: added `trap "rm -f $tmp" EXIT` and `chmod --reference` before mv [scripts/bump-version.sh] ✅
- [x] [Review][Patch] VERSION file missing guard in release.yml — fixed: added `[ -f VERSION ]` check before `cat VERSION` [.github/workflows/release.yml] ✅
- [x] [Review][Patch] `date -I` is GNU-only — fixed: changed to `date +%Y-%m-%d` [scripts/bump-version.sh] ✅
- [x] [Review][Patch] Misleading "no-op" comment in CONTRIBUTING.md final release example — fixed: updated comment to "safe to re-run; always overwrites all four locations" [CONTRIBUTING.md] ✅
- [x] [Review][Patch] Wrong deletion order in failure recovery — fixed: reordered to delete GitHub Release before tag; added explanatory note [CONTRIBUTING.md] ✅
- [x] [Review][Defer] No atomicity/rollback on partial bump — sequential file writes with no rollback on SIGINT/disk full; `set -e` provides fast-fail — deferred, pre-existing complexity tradeoff
- [x] [Review][Defer] ROOT path not validated — standard BASH_SOURCE derivation pattern; acceptable for dev tool — deferred, pre-existing
- [x] [Review][Defer] Metainfo sed breaks if `<release>` tag spans multiple lines — file currently uses single-line format — deferred, not currently triggered
- [x] [Review][Defer] Prerelease detection overly broad (any `-` in tag) — documented convention in project; date-based tags not used — deferred, accepted tradeoff
- [x] [Review][Defer] Hardcoded `0.1.0` in CONTRIBUTING.md examples will go stale — expected for v1 documentation — deferred, pre-existing
- [x] [Review][Defer] Python window.py / test hardcoded versions not updated by bump script — outside AC2 scope (4 specified files) — deferred, out of story scope
- [x] [Review][Defer] jq reformats package.json — 2-space indent is conventional; minor diff noise — deferred, pre-existing
- [x] [Review][Defer] Flatpak manifest Bun version not in bump script scope — pre-existing cross-file coordination gap — deferred, pre-existing
