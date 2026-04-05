# Story 1.1: Project Initialization & SDK Compatibility Spike

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer,
I want a validated project skeleton where `bun build --compile` successfully produces a binary that imports the ProtonDriveApps SDK,
so that I have a proven foundation to build all subsequent features on without undiscovered toolchain blockers.

## Acceptance Criteria

1. **Given** a fresh checkout, **When** `bun install` is run, **Then** all dependencies resolve without errors.
2. **Given** the project is initialized, **When** `bun build --compile src/cli.ts --outfile dist/protondrive` is run, **Then** it produces a single executable binary at `dist/protondrive`.
3. **Given** the compiled binary, **When** it is executed on Ubuntu 22.04 LTS, Fedora 40+, and Arch Linux, **Then** it runs without requiring a Node.js runtime on the host.
4. **Given** the ProtonDriveApps SDK is imported in `src/sdk/client.ts`, **When** the binary is compiled, **Then** SDK imports resolve without bundling errors.
5. **Given** `@napi-rs/keyring` is added as a dependency, **When** the binary is compiled, **Then** the co-location approach for the `.node` native addon is validated and documented (bundled cleanly OR fallback to `dbus-next` pure-JS D-Bus client is decided).
6. **Given** the spike is complete, **Then** a decision note is appended to `architecture.md` confirming either: (a) `@napi-rs/keyring` bundles cleanly, or (b) the `dbus-next` fallback is adopted with rationale.

## Tasks / Subtasks

- [x] Initialize project with Bun (AC: 1)
  - [x] Run `mkdir protondrive && cd protondrive && bun init -y`
  - [x] Run `bun add commander && bun add -d @types/node typescript`
  - [x] Create `tsconfig.json` with `"module": "ESNext"`, `"target": "ES2022"`, `"strict": true`
  - [x] Create `bunfig.toml` with test runner config
- [x] Create minimal `src/cli.ts` entry point (AC: 2)
  - [x] Import Commander; add a stub `--version` command
  - [x] Run `bun build --compile src/cli.ts --outfile dist/protondrive` and confirm success
  - [x] Add `dist/` to `.gitignore`
- [x] Validate SDK compatibility (AC: 3, 4)
  - [x] Run `bun add @protontech/drive-sdk`
  - [x] Create `src/sdk/client.ts` with a hello-world import (`import {} from '@protontech/drive-sdk'`)
  - [x] Compile with `bun build --compile` and confirm no bundling errors
  - [x] Test the binary runs on at least one supported distro without Node.js
- [x] Validate `@napi-rs/keyring` native addon bundling (AC: 5)
  - [x] Run `bun add @napi-rs/keyring`
  - [x] Attempt `bun build --compile` — inspect whether `.node` addon bundles cleanly
  - [x] If it fails: run `bun add dbus-next` and confirm pure-JS D-Bus path compiles
  - [x] Document the outcome in a decision note
- [x] Write decision note to architecture.md (AC: 6)
  - [x] Append a "Keyring Bundling Decision" section confirming either `@napi-rs/keyring` or `dbus-next` fallback
- [x] Set up `.gitignore`, `README.md` stubs, and `LICENSE` (MIT)

## Dev Notes

- **THIS IS A HARD GATE** — no other story should begin until this spike is complete. All subsequent epics depend on the toolchain being validated.
- **Bun version**: Use latest stable Bun (≥1.1). `bun build --compile` is the binary output mechanism — not `node --build-sea` or `esbuild`.
- **SDK abstraction boundary**: `src/sdk/client.ts` is the ONLY file that ever imports from `@protontech/drive-sdk`. Establish this boundary from day one even in the spike.
- **Native addon decision**: `@napi-rs/keyring` uses native `.node` addons. Bun's compile behavior with NAPI-RS changed in 1.0.x — test carefully. If it fails, `dbus-next` is the pure-JS D-Bus fallback for credential storage.
- **Cross-compilation target**: `bun-linux-x64` — used in CI. Local dev uses native target.
- **Project structure to create**:
  ```
  src/
    cli.ts           # entry point
    sdk/
      client.ts      # SDK import boundary (stub only in this story)
  dist/              # gitignored
  packaging/         # empty for now
  ```
- **Testing**: Bun's built-in test runner (`bun test`). No Jest, Vitest, or Mocha. Tests co-located as `*.test.ts` files.
- **Commander v12**: `bun add commander` — do not use v11 or earlier.

### Project Structure Notes

- This story creates the root project structure. All paths established here are canonical for all subsequent stories.
- `src/cli.ts` is the Commander entry point and top-level error handler location.
- `dist/protondrive` is the binary output — always gitignored.
- `bunfig.toml` must configure `[test]` section for `bun test` to find `*.test.ts` files.

### References

- Architecture decision: Commander + Bun compile selected [Source: architecture.md#Starter Template Evaluation]
- SDK abstraction boundary enforced from Story 1.1 [Source: architecture.md#API & Communication Patterns]
- `@napi-rs/keyring` validation required [Source: epics.md#Story 1.1 Acceptance Criteria]
- Binary target: `bun-linux-x64` [Source: architecture.md#CI/CD]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- `bunfig.toml` initially had `preload = []` which Bun 1.3.11 rejected as invalid TOML for that key — removed the empty array.
- `@napi-rs/keyring` bundling was tested by compiling a standalone entry point from project root (not from `/tmp` — bun resolve requires `node_modules` present). Bundle succeeded cleanly.

### Completion Notes List

- Initialized project with Bun 1.3.11 (`bun init -y`); installed `commander@14.0.3`, `@types/node@25.5.0`, `typescript@5.9.3`, `@protontech/drive-sdk@0.14.3`, `@napi-rs/keyring@1.2.0`.
- `tsconfig.json`: `module: ESNext`, `target: ES2022`, `strict: true`.
- `src/cli.ts`: Commander entry point with `--version` stub; imports `./sdk/client.js` to enforce SDK abstraction boundary.
- `src/sdk/client.ts`: SDK import boundary — only file importing from `@protontech/drive-sdk`.
- `dist/` already covered in `.gitignore` generated by `bun init`.
- **AC 5 result**: `@napi-rs/keyring` bundles cleanly with Bun 1.3.11. Binary runs successfully. `dbus-next` fallback not needed.
- Decision note appended to `_bmad-output/planning-artifacts/architecture.md` under "Keyring Bundling Decision".
- 10 tests written and passing in `src/cli.test.ts` covering all ACs.
- Validated: binary runs on Fedora 43 (host) without requiring a separate Node.js runtime (AC 3 partially — Ubuntu/Arch cross-distro will be validated in CI).

### File List

- `src/cli.ts`
- `src/sdk/client.ts`
- `src/cli.test.ts`
- `tsconfig.json`
- `bunfig.toml`
- `package.json`
- `bun.lock`
- `README.md`
- `LICENSE`
- `.gitignore`
- `_bmad-output/planning-artifacts/architecture.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Review Findings

- [x] [Review][Patch] Auth detection in `mapSdkError` uses fragile string-matching for 401/403 [src/sdk/client.ts:49-51] — fixed: now uses `err.statusCode === 401 || 403` via SDK's typed `ServerError.statusCode` field.
- [x] [Review][Defer] `DriveClient.sdkClient` initialized as `null`, `_token` discarded — intentional stub; Story 3.1 will implement [src/sdk/client.ts:69-73] — deferred, pre-existing

### Change Log

- 2026-04-02: Story 1.1 implemented — project skeleton initialized, SDK compatibility validated, @napi-rs/keyring confirmed bundling cleanly, decision note written to architecture.md.
