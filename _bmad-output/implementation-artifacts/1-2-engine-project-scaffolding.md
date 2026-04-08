# Story 1.2: Engine Project Scaffolding

Status: done

## Story

As a developer,
I want a TypeScript/Node project scaffold with strict tsconfig and the typed error hierarchy,
so that all subsequent engine stories have a buildable foundation with consistent error handling.

## Acceptance Criteria

1. **Given** `npm init` has been run in `engine/`, **when** inspecting `tsconfig.json`, **then** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride` are all `true`, **and** `target` is `ES2022`, `module` is `NodeNext`, `moduleResolution` is `NodeNext`.

2. **Given** `engine/src/errors.ts` exists, **when** inspecting its imports, **then** it has zero internal imports from other engine files, **and** it exports `EngineError` base class and typed subclasses: `SyncError`, `NetworkError`, `IpcError`, `ConfigError`.

3. **Given** `@protontech/drive-sdk` is added to `package.json`, **when** inspecting the version, **then** it is pinned to exact version `0.14.3` (no `^` or `~` prefix).

4. **Given** `openpgp` is added to `package.json`, **when** inspecting the version, **then** it is pinned to `^6.3.0`.

5. **Given** the engine project, **when** running `npx tsc --noEmit`, **then** the project compiles without errors.

## Tasks / Subtasks

- [x] Task 1: Initialize npm project in `engine/` (AC: #1, #3, #4)
  - [x] 1.1 Run `npm init -y` in `engine/` directory; set `"type": "module"` in `package.json` (required for NodeNext module resolution)
  - [x] 1.2 Install production dependencies: `@protontech/drive-sdk` at exact `0.14.3` (no caret), `openpgp` at `^6.3.0`
  - [x] 1.3 Install dev dependencies: `typescript` ^5, `tsx`, `@types/node` (matching Node 22)
  - [x] 1.4 Verify `package.json` shows `"@protontech/drive-sdk": "0.14.3"` (no `^`) and `"openpgp": "^6.3.0"`
  - [x] 1.5 Add `engine/node_modules/` and `engine/dist/` to `.gitignore`

- [x] Task 2: Create `tsconfig.json` (AC: #1)
  - [x] 2.1 Create `engine/tsconfig.json` with all required compiler options:
    - `strict: true`
    - `noUncheckedIndexedAccess: true`
    - `verbatimModuleSyntax: true`
    - `noImplicitOverride: true`
    - `target: "ES2022"`
    - `module: "NodeNext"`
    - `moduleResolution: "NodeNext"`
    - `outDir: "./dist"`
    - `rootDir: "./src"`
    - `declaration: true`
    - `sourceMap: true`
    - `skipLibCheck: true`
  - [x] 2.2 Set `include: ["src/**/*.ts"]` and `exclude: ["node_modules", "dist"]`

- [x] Task 3: Create `errors.ts` (AC: #2)
  - [x] 3.1 Create `engine/src/errors.ts` with zero internal imports
  - [x] 3.2 Export `EngineError` base class extending `Error` (sets `name` property, captures stack)
  - [x] 3.3 Export `SyncError`, `NetworkError`, `IpcError`, `ConfigError` extending `EngineError`
  - [x] 3.4 Each subclass sets its own `name` property for serialization/debugging
  - [x] 3.5 Optionally accept a `cause` parameter for error chaining (Node 22 supports `Error.cause`)

- [x] Task 4: Create minimal `main.ts` entry point (AC: #5)
  - [x] 4.1 Create `engine/src/main.ts` as a placeholder that imports from `errors.js` to validate the build
  - [x] 4.2 This is a stub only -- real logic comes in Story 1.3+

- [x] Task 5: Verify compilation (AC: #5)
  - [x] 5.1 Run `npx tsc --noEmit` from `engine/` -- must exit 0
  - [x] 5.2 Verify no type errors from `errors.ts` or `main.ts`

## Dev Notes

### TypeScript Strict Flags -- Agent Impact

These flags change how you write code for the entire engine:

- **`noUncheckedIndexedAccess`**: `arr[0]` returns `T | undefined`. After a bounds check, use non-null assertion `!` to narrow.
- **`verbatimModuleSyntax`**: Type-only imports MUST use `import type { Foo } from "./bar.js"`. Mixing value and type imports in one statement is a compile error.
- **`noImplicitOverride`**: Class method overrides require the `override` keyword.

### Local Import Convention

All local imports use `.js` extension, even when the source is `.ts`:
```typescript
import { EngineError } from "./errors.js";
import type { SomeType } from "./errors.js";
```
Node ESM resolves `.js` to `.ts` via `tsx` in dev. Never use `.ts` in import paths.

### Engine Source Layout

Engine source is **flat** -- all files directly under `engine/src/`. No subdirectories except `__integration__/`. Do not create `src/core/`, `src/ipc/`, `src/errors/`, etc.

### `errors.ts` Design Constraints

- **Zero internal imports** -- `errors.ts` is imported by every other engine file. Any import from another engine file creates circular dependencies.
- **Never `new Error(...)`** -- all engine code throws typed subclasses of `EngineError`.
- **Never return errors** -- throw them. Engine functions never return `{ error: ... }` or `null` to signal failure.

### Error Class Structure

```typescript
export class EngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineError";
  }
}

export class SyncError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SyncError";
  }
}
// Same pattern for NetworkError, IpcError, ConfigError
```

`ErrorOptions` includes `cause` for error chaining (standard in ES2022+/Node 22).

### SDK Version Pinning

- `@protontech/drive-sdk`: exact `"0.14.3"` -- no `^` or `~`. Pre-release SDK; semver guarantees don't apply at `0.x`. Use `npm install @protontech/drive-sdk@0.14.3 --save-exact`.
- `openpgp`: `"^6.3.0"` -- caret range is intentional here.

### `package.json` Requirements

- `"type": "module"` is mandatory for `NodeNext` module resolution.
- `"name"` should be `"protondrive-engine"` or similar (not published to npm).
- No `"main"` field needed yet -- entry point defined in Story 1.3.

### Testing Framework

- **`node:test`** (`describe`/`it`/`test`) + **`node:assert/strict`** -- NOT Jest, Vitest, or `expect()`.
- No tests required for this scaffolding story. Test infrastructure validates in later stories.
- Test command: `node --import tsx --test engine/src/**/*.test.ts`
- Unit tests are co-located: `*.test.ts` alongside source files.

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| TypeScript files | `kebab-case.ts` | `sync-engine.ts`, `state-db.ts` |
| Functions/variables | `camelCase` | `getToken()`, `pairId` |
| Classes/interfaces | `PascalCase` (no `I` prefix) | `EngineError`, `DriveClient` |
| Error classes | `PascalCase` + `Error` suffix | `SyncError`, `NetworkError` |

### Target Project Structure After This Story

```
engine/
  package.json              <- "type": "module", pinned deps
  package-lock.json
  tsconfig.json             <- strict + all required flags
  src/
    errors.ts               <- EngineError + 4 subclasses, zero imports
    main.ts                 <- minimal stub importing errors.js
```

### What This Story Does NOT Include

- `state-db.ts`, `sdk.ts`, `ipc.ts`, `sync-engine.ts` -- created in later stories
- `better-sqlite3` dependency -- added in Story 1.4 (State DB)
- Test files -- added alongside their source modules
- npm scripts in `package.json` -- added as needed in later stories

### References

- [Source: _bmad-output/planning-artifacts/epics.md, lines 338-367]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 481-501 (project structure)]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 397-401 (tsconfig flags)]
- [Source: _bmad-output/project-context.md, lines 30-36 (engine stack), 66-76 (TS rules), 190-196 (code org)]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
None — scaffolding story.

### Completion Notes List
- npm project initialized with `"type": "module"` for NodeNext
- `@protontech/drive-sdk` pinned to exact `0.14.3` (no caret) — verified in package.json
- `openpgp` at `^6.3.0` — verified
- tsconfig.json has all required strict flags
- `errors.ts` has zero internal imports, exports EngineError + 4 typed subclasses
- `npx tsc --noEmit` exits 0 with no errors
- Added `builddir` to .gitignore for Meson build output

### Change Log
- 2026-04-08: Story 1-2 implemented — TypeScript engine scaffold with strict config and error hierarchy

### File List
- engine/package.json (new)
- engine/package-lock.json (new)
- engine/tsconfig.json (new)
- engine/src/errors.ts (new)
- engine/src/main.ts (new)
- .gitignore (modified — added builddir)

### Review Findings
- [x] [Review][Patch] JSON import `../package.json` outside `rootDir` breaks `tsc` build with `declaration: true` — FIXED: replaced with ENGINE_VERSION constant
- [x] [Review][Patch] Test script glob `src/**/*.test.ts` unquoted — FIXED: quoted glob so Node's test runner handles expansion
