---
project_name: 'ProtonDrive-LinuxClient'
user_name: 'Jeremy'
date: '2026-04-05'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'code_quality_rules', 'workflow_rules', 'critical_rules']
status: 'complete'
rule_count: 47
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- **Runtime/compiler:** Bun 1.3.x — use `bun run`, `bun test`, `bun build --compile`; do NOT use Node.js, ts-node, jest, webpack, or vite
- **Language:** TypeScript ^5, ES2022 target, ESNext modules, `moduleResolution: "bundler"`
- **CLI framework:** Commander ^14.0.3
- **State store:** `bun:sqlite` (built-in) — do NOT use `better-sqlite3` or any sqlite npm package; rows return as `unknown`, always cast to a typed interface
- **Credential store:** `@napi-rs/keyring` ^1.2.0 — bundles cleanly into Bun compiled binary (validated Bun 1.3.11); mock at `CredentialStore` interface level in tests, not at the `@napi-rs/keyring` package directly (requires OS keychain at runtime)
- **ProtonDrive SDK:** `@protontech/drive-sdk` ^0.14.3
- **PGP library:** `openpgp` ^6.3.0 — use the full bundle; do NOT import from `openpgp/lightweight`; v6 uses `Uint8Array<ArrayBufferLike>` while the SDK expects `Uint8Array<ArrayBuffer>`; casts required at boundary (see `src/sdk/openpgp-proxy.ts`)
- **Config parser:** `js-yaml` ^4.1.1
- **Password hashing:** `bcryptjs` ^3.0.3 (pure JS — no native addon)
- **Build command:** `bun build --compile src/cli.ts --outfile dist/protondrive`
- **Test commands:** `bun test` (unit), `bun test src/__e2e__/` (binary e2e — requires pre-built binary at `dist/protondrive`), `bun test src/__integration__/` (live API — requires real Proton credentials)
- **TypeScript strict flags — agent impact:**
  - `noUncheckedIndexedAccess`: `arr[0]` returns `T | undefined`, not `T`; use `!` assertion after a length/existence check, never assume a defined value from an array index
  - `verbatimModuleSyntax`: type-only imports MUST use `import type { ... }` syntax; mixing is a compile error
  - `noImplicitOverride`: class method overrides require the `override` keyword explicitly
- **Integration test exclusion is conventional only:** files named `*.integration.test.ts` outside `src/__integration__/` WILL run in the default `bun test`; the exclusion is by directory, not by config
- **SDK mock boundary:** mock the `DriveClient` class in tests, never mock `@protontech/drive-sdk` imports directly

## Critical Implementation Rules

### Language-Specific Rules

- **Local imports use `.js` extension** — TypeScript files import each other as `.js` (e.g., `import { foo } from "./bar.js"`); Bun ESM resolves `.ts` at runtime. Never use `.ts` extensions in imports.
- **`import type` is mandatory for type-only imports** — `verbatimModuleSyntax` is on; mixing value and type imports in one statement is a compile error.
- **`arr[0]` is `T | undefined`** — `noUncheckedIndexedAccess` is enabled; always use `!` after a length/bounds check, never assume a defined value from an index.
- **`override` keyword required** — `noImplicitOverride` is on; any class method that overrides a base class method must carry the `override` keyword or it will not compile.
- **`async/await` everywhere** — no raw `.then()/.catch()` chains in application code; no callbacks outside Commander's `.action()` wrapper.
- **JSON imports require `with { type: "json" }`** — e.g., `import pkg from "../package.json" with { type: "json" }`.
- **Credential store stores only the access token string** — `auth login` stores `token.accessToken` (a `string`), not the full `SessionToken` object. `getSessionToken()` returns `Promise<string>`. Code that needs a full `SessionToken` must handle this accordingly.

### Framework-Specific Rules

- **Command module pattern** — each subcommand exports a single `register(program: Command): void` function; no business logic inside; delegate immediately to `src/core/`. Never export a class or default export from a command file.
- **Global options on parent program** — `--json` and `--config` are on the root `program`. Top-level commands read them via `program.opts()`; auth subcommands (nested under `auth`) use `program.parent?.opts()` (optional chaining required). Getting the depth wrong silently produces `undefined`.
- **`process.exit()` is command-layer only** — never call in `src/core/`, `src/auth/`, or `src/sdk/`; only in `src/commands/` and `src/cli.ts`.
- **`console.log/error` is forbidden outside commands** — core, auth, and sdk pass progress via `onProgress: (msg: string) => void` callback. Commands supply `makeProgressCallback()`. Core never writes to stdout/stderr directly.
- **SDK boundary: `DriveClient` only** — never import from `@protontech/drive-sdk` outside `src/sdk/client.ts`. All production code uses `createLiveDriveClient(token, password, opts)` async factory. Tests use `new DriveClient(token, opts)` and mock individual methods with `spyOn()` — the constructor intentionally sets `sdkClient = null`, so unmocked methods throw loudly. Do not call `_setSdkClient()` in new code.
- **`CredentialStore` mock boundary** — in tests, inject a mock implementing the `CredentialStore` interface (from `src/auth/credentials.ts`). Never mock `KeyringStore`, `FileStore`, or `@napi-rs/keyring` directly.
- **`StateDB` factory pattern** — always instantiate via `await StateDB.init(optionalPath)`; constructor is private. Always `stateDb.close()` in a `finally` block in every command action that opens a DB.
- **Auth subcommands nest under `auth` group** — `auth login` and `auth logout` register on the `auth` sub-command, not directly on `program`.

### Testing Rules

- **Three-tier test model** — (1) unit tests co-located as `*.test.ts` alongside source (`src/core/sync-engine.test.ts`); (2) binary e2e tests in `src/__e2e__/` (spawn compiled binary, no live network, requires pre-built `dist/protondrive`); (3) live integration tests in `src/__integration__/` (require real Proton credentials, excluded from default `bun test`).
- **Never put integration tests outside `src/__integration__/`** — files named `*.integration.test.ts` anywhere else WILL run under default `bun test`; exclusion is by directory, not filename.
- **Run commands** — `bun test` (unit only), `bun test src/__e2e__/` (binary e2e, binary must exist), `bun test src/__integration__/` (live API).
- **E2e tests spawn the binary as a child process** — assert on stdout, stderr, and exit codes. Do not import source modules directly in `src/__e2e__/`.
- **Integration tests require env vars** — `PROTON_TEST_USER` and `PROTON_TEST_PASS`; `afterAll` must clean up all test data from the Proton account.
- **Mock at interface boundaries** — mock `DriveClient` methods with `spyOn()`, inject a `CredentialStore` mock, pass a test `StateDB.init()` path. Never mock deep internals (`@napi-rs/keyring`, `bun:sqlite`, `@protontech/drive-sdk`).
- **Test file naming** — `*.test.ts` for unit, `*.e2e.test.ts` for binary e2e, `*.integration.test.ts` for live API. Never `__tests__/` directories or `tests/` top-level folder.

### Code Quality & Style Rules

- **File naming: kebab-case** — `src/commands/auth-login.ts`, `src/core/sync-engine.ts`. No PascalCase or camelCase filenames. Exception: `index.ts`.
- **TypeScript naming** — functions/variables: `camelCase`; classes/interfaces/types: `PascalCase` (no `I` prefix on interfaces); module-level constants: `UPPER_SNAKE_CASE`.
- **SQLite columns: snake_case** — `sync_pair_id`, `last_sync_mtime`, `local_path`. Table names: singular snake_case (`sync_state`, `sync_pair`). Never camelCase in SQL.
- **Config YAML keys: snake_case** — `sync_pairs`, `conflict_strategy`. Never `syncPairs` or `conflictStrategy`.
- **Timestamps: ISO 8601** — all dates serialized as `2026-04-01T14:30:00.000Z`. Conflict copy suffix uses `YYYY-MM-DD` local date (`.conflict-2026-04-01`). SQLite stores timestamps as TEXT, not INTEGER epoch.
- **Error classes: typed subclasses only** — always throw a subclass of `ProtonDriveError` (`AuthError`, `SyncError`, `NetworkError`, `ConfigError`). Never throw `new Error(...)` or a plain string from application code.
- **JSON output wrapper** — success: `{ ok: true, data: {...} }`; error: `{ ok: false, error: { code, message } }`. The `ok` field is always present. Never emit bare objects from `--json` mode.
- **Human output format** — progress to stdout with `[command]` prefix; errors to stderr with bare `error: CODE — message` format. Use `formatSuccess()`, `formatError()`, `makeProgressCallback()` from `src/core/output.ts` — never hand-roll output formatting.
- **No comments on obvious code** — only add comments where logic is non-evident. The `src/sdk/client.ts` boundary comment is the canonical exception (it enforces the SDK import rule).

### Development Workflow Rules

- **Run without building** — `bun run src/cli.ts <command>` during development; no compile step needed.
- **Build binary** — `bun build --compile src/cli.ts --outfile dist/protondrive`; required before running `bun test src/__e2e__/`.
- **Release** — push a `v*` tag; GitHub Actions builds the binary and AppImage and attaches them to a GitHub Release.
- **XDG paths** — config: `${XDG_CONFIG_HOME:-~/.config}/protondrive/config.yaml`; state DB and credentials: `${XDG_DATA_HOME:-~/.local/share}/protondrive/`. Always resolve via env var with `??` fallback, never hardcode `~/.config` or `~/.local/share` directly.
- **Atomic file writes for downloads** — write to `<localPath>.dl-tmp-<timestamp>-<random>` in the same directory, then `fs.renameSync()` on success; `fs.unlinkSync()` the tmp file on failure. Never write directly to the destination path.
- **Retry logic lives in `src/sdk/client.ts`** — `withRetry()` handles 3 attempts with 1s/2s/4s backoff for `NetworkError`; `AuthError` and `ConfigError` fail immediately. Do not add retry logic in commands or core.
- **Exit codes** — 0: success; 1: operational error (`ProtonDriveError` non-config); 2: config/usage error (`ConfigError` or unknown command). Applied uniformly — never per-command ad-hoc codes.
- **`dist/` is gitignored** — never commit the compiled binary; it's built by CI on tag push.

### Critical Don't-Miss Rules

- **Never import `@protontech/drive-sdk` outside `src/sdk/client.ts`** — any accidental import elsewhere breaks the SDK migration boundary. The boundary comment at the top of `client.ts` is the enforcement signal.
- **Never return errors — throw them** — core functions never return `{ error: ... }` or `null` to signal failure; they throw a typed `ProtonDriveError` subclass. Returning errors bypasses the top-level handler and loses exit code enforcement.
- **Never swallow errors in core** — no catch-and-log in `src/core/`, `src/auth/`, or `src/sdk/`; let them propagate to the command action's top-level catch.
- **openpgp: full bundle only** — import from `openpgp`, never `openpgp/lightweight`. v6 uses `Uint8Array<ArrayBufferLike>`; the SDK expects `Uint8Array<ArrayBuffer>` — casts are required at the boundary (see `src/sdk/openpgp-proxy.ts`).
- **Token must never appear in output** — not in stdout, stderr, logs, or JSON. `auth login --json` returns `{ ok: true, data: {} }` with no token field.
- **2FA throws `TwoFactorRequiredError`** — callers must catch and either prompt TOTP (interactive TTY) or re-throw as `AuthError` with code `TOTP_NO_TTY` (headless). Never hang waiting for input.
- **`bun:sqlite` rows are `unknown`** — always cast query results to a typed interface (e.g., `as DbRow | null`). Never access properties directly on the raw query result.
- **One-way dependency rule is load-bearing** — `src/core/` must not import from `src/commands/`; `src/sdk/` must not import from `src/core/` or `src/commands/`; `src/auth/` must not import from `src/core/` or `src/commands/`. Violations break the shared-engine design.
- **Core receives credentials as parameters, not imports** — `src/core/` never imports from `src/auth/`. The command layer retrieves the session token and passes it as a function argument into core/sdk calls.
- **No silent overwrites** — sync engine creates a conflict copy (`filename.conflict-YYYY-MM-DD`) instead of overwriting a changed local file. Never skip conflict detection to simplify implementation.
- **Conflict copy suffix appends after the extension** — `notes.md` → `notes.md.conflict-2026-04-01`, not `notes.conflict-2026-04-01.md`.
- **`MaybeNode` must be unwrapped** — SDK methods return `MaybeNode<T>`; always call `resolveNode(maybeNode)` before accessing the value. Never access `.value` without checking `.ok` first.
- **`process.stdout.write()` not `console.log()`** — all output uses `process.stdout.write(msg + "\n")`. `console.log()` uses a different buffer and corrupts JSON output in `--json` mode.
- **One `DriveClient` per command invocation** — construct once per command action, never inside a loop. `DriveClient` holds the session token at construction time.
- **FileStore credentials file must be `0600`** — call `fs.chmodSync(path, 0o600)` immediately after creating `~/.local/share/protondrive/credentials`, before writing any content.
- **`--json` pre-parse detection** — `cli.ts` uses `process.argv.includes('--json')` for top-level error handling before `program.parseAsync()` completes. New top-level error handlers must use the same pattern, not `program.opts().json`.
- **`StateDB` PK is `local_path`** — not `sync_pair_id`. `upsert()` uses `INSERT OR REPLACE` keyed on `local_path`. Do not add a `mkdir` call before `StateDB.init()` — it handles directory creation internally.
- **`@napi-rs/keyring` bundles cleanly in Bun 1.3.x** — validated on Fedora 43; the `.node` native addon is embedded by `bun build --compile`. No `dbus-next` fallback needed for v1.

---

## Usage Guidelines

**For AI Agents:**
- Read this file before implementing any code in this project
- Follow ALL rules exactly as documented — they encode hard-won decisions
- When in doubt, prefer the more restrictive option
- Never import across the documented module boundaries

**For Humans:**
- Keep this file lean and focused on agent needs
- Update when technology stack or patterns change
- Remove rules that become obvious over time

_Last Updated: 2026-04-05_
