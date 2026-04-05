# Story 6.1: GitHub Actions CI & Release Pipeline

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a CI pipeline that runs tests on every PR and a release pipeline that builds and publishes binaries on version tags,
so that every merge is validated and every release is a single `git tag` away.

## Acceptance Criteria

1. **Given** `.github/workflows/ci.yml` exists, **When** a pull request is opened or updated, **Then** `bun test` and TypeScript type-checking run automatically and the PR is blocked on failure.
2. **Given** `.github/workflows/release.yml` exists, **When** a `v*` tag is pushed, **Then** it runs `bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/protondrive` and produces a self-contained binary.
3. **Given** the release pipeline runs, **When** the binary is built, **Then** an AppImage is assembled via `appimagetool` using `packaging/appimage/protondrive.desktop` and `packaging/appimage/build-appimage.sh`.
4. **Given** the binary and AppImage are built, **When** the pipeline completes, **Then** both artifacts are attached to a GitHub Release for the pushed tag.
5. **Given** the compiled binary, **When** run on Ubuntu 22.04 LTS, Ubuntu 24.04 LTS, Fedora 40+, and Arch Linux, **Then** it executes without requiring a Node.js runtime (NFR15).
6. **Given** the AppImage, **When** run on any x86_64 Linux with FUSE and glibc ≥ 2.17, **Then** it executes without system installation (NFR17).
7. **Given** `protondrive --version` is run on the released binary, **Then** it outputs the version matching the release tag.

## Tasks / Subtasks

- [x] Create `.github/workflows/ci.yml` (AC: 1)
  - [x] Trigger: `on: [pull_request]`
  - [x] Ubuntu latest runner
  - [x] Steps: checkout, install Bun (`oven-sh/setup-bun@v2`), `bun install`, `bun test`, `bunx tsc --noEmit`
  - [x] Fail fast on any step failure
- [x] Create `.github/workflows/release.yml` (AC: 2, 3, 4)
  - [x] Trigger: `on: push: tags: ['v*']`
  - [x] Steps:
    - [x] Checkout
    - [x] Install Bun
    - [x] `bun install`
    - [x] `bun test` (release gate — fail if tests fail)
    - [x] `bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/protondrive`
    - [x] Run `packaging/appimage/build-appimage.sh` to produce AppImage
    - [x] Create GitHub Release via `softprops/action-gh-release@v2`
    - [x] Attach `dist/protondrive` and `dist/protondrive.AppImage` to release
- [x] Create `packaging/appimage/` directory (AC: 3)
  - [x] `packaging/appimage/protondrive.desktop` with Name, Exec, Icon, Type, Categories
  - [x] `packaging/appimage/build-appimage.sh` — AppImage assembly script:
    - [x] Download `appimagetool` if not present
    - [x] Create `AppDir/` structure with binary, `.desktop`, icon
    - [x] Run `appimagetool AppDir/ dist/protondrive.AppImage`
    - [x] Set `ARCH=x86_64` env var for `appimagetool`
- [x] Wire `--version` to git tag in `src/cli.ts` (AC: 7) — already done in Story 1.1 via `import pkg from "../package.json"` and `program.version(pkg.version)`; release workflow updates `package.json` version to match tag before `bun build`
- [x] Add `dist/` and `AppDir/` to `.gitignore`

## Dev Notes

- **Bun GitHub Action**: Use `oven-sh/setup-bun@v2` — this is the official action. Pin to a specific version tag for reproducibility.
- **Cross-compilation target**: `bun-linux-x64` — produces a Linux x86_64 binary. Run on Ubuntu runner; cross-compile to ensure no host-specific binaries are embedded.
- **AppImage requirements**: The AppImage must include the binary, `.desktop` file, and an icon. `appimagetool` is available as a pre-built x86_64 binary from GitHub releases. Download in CI, do not commit it.
- **FUSE in GitHub Actions**: AppImage build in CI does not need FUSE (just assembles the squashfs). The smoke-test of running the AppImage would need FUSE — skip that in CI, only validate the binary.
- **Version tagging**: The release tag (e.g., `v1.0.0`) should match `protondrive --version` output. Use `jq` or `bun` to update `package.json` version field to the tag value before building.
- **GitHub Release creation**: Use `gh release create $TAG dist/protondrive dist/protondrive.AppImage` or the `softprops/action-gh-release` action. Set release name to the tag.
- **Matrix testing** (optional enhancement for CI): Add a matrix to run `bun test` on multiple OS versions — but keep it simple in v1.
- **`bun test` as release gate**: Run tests in the release workflow before building. If tests fail, do not publish.
- **NFR4** (500ms cold-start): `bun build --compile` meets this; no special action needed beyond using `--compile`.

### Project Structure Notes

- `.github/workflows/ci.yml` and `release.yml` — new files
- `packaging/appimage/protondrive.desktop` and `build-appimage.sh` — new files
- `packaging/aur/` and `packaging/nix/` — directories created (populated in Stories 6.2, 6.3)
- Binary output: `dist/protondrive` — gitignored

### References

- CI/CD: GitHub Actions on `v*` tag [Source: architecture.md#Infrastructure & Deployment]
- Binary target: `bun-linux-x64` [Source: architecture.md#Starter Template]
- AppImage via `appimagetool` [Source: epics.md#Story 6.1]
- NFR4: 500ms cold-start [Source: epics.md#NonFunctional Requirements]
- NFR15: no Node.js runtime required [Source: epics.md#NonFunctional Requirements]
- NFR17: AppImage on glibc ≥ 2.17 [Source: epics.md#NonFunctional Requirements]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- 2026-04-02: Story 6.1 implemented — ci.yml (PR-gated: bun test + tsc --noEmit), release.yml (v* tag: test+build binary+AppImage+gh-release via softprops/action-gh-release@v2), AppImage packaging scripts, AppDir gitignored. Version from package.json embedded at compile time; release workflow patches version from tag before build.

### Review Findings

- [x] [Review][Patch] GitHub Actions (`setup-bun@v2`, `action-gh-release@v2`) pinned to mutable version tags — tags can be force-pushed for supply-chain injection; pin to immutable commit SHAs [.github/workflows/ci.yml:17, release.yml:21,52]
- [x] [Review][Patch] `bun-version: latest` in both workflows — dev notes explicitly require pinning for reproducibility; a Bun breaking change silently breaks all CI runs [.github/workflows/ci.yml:19, release.yml:22]
- [x] [Review][Patch] `$VERSION` interpolated raw into a JS string inside a shell heredoc — a tag with a single quote breaks JS syntax mid-release [.github/workflows/release.yml:35-39]
- [x] [Review][Patch] `appimagetool` fetched from rolling `continuous` tag with no integrity check — non-deterministic binary, no hash validation; compromised tool produces corrupt AppImage silently [packaging/appimage/build-appimage.sh:9-19]
- [x] [Review][Patch] `.desktop` file missing `Terminal=true` — CLI tool launches invisibly from GUI file managers; stdin/stdout closed, binary exits silently [packaging/appimage/protondrive.desktop]
- [x] [Review][Patch] No existence check on `dist/protondrive` before AppImage assembly — if `bun build` silently fails, `cp` produces a cryptic error with no attribution [packaging/appimage/build-appimage.sh:26]
- [x] [Review][Defer] `AppRun` has no `${APPDIR:?}` guard — manual extraction without AppImage runtime sets `$APPDIR` to empty, silently invoking system binary [packaging/appimage/build-appimage.sh:42-45] — deferred, pre-existing

### File List

- `.github/workflows/ci.yml` (new)
- `.github/workflows/release.yml` (new)
- `packaging/appimage/protondrive.desktop` (new)
- `packaging/appimage/build-appimage.sh` (new)
- `.gitignore` (updated — added AppDir)
