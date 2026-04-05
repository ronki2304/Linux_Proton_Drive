# Story 1.4: YAML Config Loader

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want to define sync pairs in a YAML config file at a well-known path,
so that all commands share a consistent, version-control-safe configuration with no credentials.

## Acceptance Criteria

1. **Given** `~/.config/protondrive/config.yaml` exists with valid content, **When** `loadConfig()` is called, **Then** it returns a parsed `Config` object containing `sync_pairs` and `options`.
2. **Given** `XDG_CONFIG_HOME` is set to a custom path, **When** `loadConfig()` is called, **Then** it resolves the config path to `$XDG_CONFIG_HOME/protondrive/config.yaml`.
3. **Given** the config file does not exist, **When** `loadConfig()` is called, **Then** it throws a `ConfigError` with a clear, actionable message on stderr.
4. **Given** the config file contains malformed YAML, **When** `loadConfig()` is called, **Then** it throws a `ConfigError` identifying the parse failure — sync does not proceed.
5. **Given** a valid config file, **When** it is parsed, **Then** no session token or credentials are present in the returned object.
6. **Given** a `--config <path>` flag is passed, **When** any command is run, **Then** it reads config from the specified path instead of the default.
7. **Given** `bun test` is run, **Then** all config loader unit tests pass, including: missing file, malformed YAML, XDG override, and custom `--config` path.

## Tasks / Subtasks

- [x] Create `src/core/config.ts` (AC: 1, 2, 3, 4, 5)
  - [x] Define `Config` type: `{ sync_pairs: SyncPair[]; options?: ConfigOptions }`
  - [x] Define `ConfigOptions` type: `{ conflict_strategy?: 'copy' }` (only strategy in v1)
  - [x] Implement `getDefaultConfigPath(): string`
    - [x] Use `process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')` + `/protondrive/config.yaml`
  - [x] Implement `loadConfig(configPath?: string): Promise<Config>`
    - [x] Resolve path: use `configPath` if provided, else `getDefaultConfigPath()`
    - [x] Read file with `Bun.file(path).text()` — throw `ConfigError` if file not found
    - [x] Parse YAML using a YAML library — throw `ConfigError` on parse failure
    - [x] Validate `sync_pairs` is an array — throw `ConfigError` if missing/invalid
    - [x] Assert no `token`, `password`, or credential fields in returned object
    - [x] Return typed `Config`
  - [x] Add `--config <path>` option to root Commander program in `src/cli.ts`
- [x] Write unit tests in `src/core/config.test.ts` (AC: 7)
  - [x] Test: valid config file returns `Config` with `sync_pairs`
  - [x] Test: missing file throws `ConfigError` with helpful message
  - [x] Test: malformed YAML throws `ConfigError`
  - [x] Test: `XDG_CONFIG_HOME` override resolves correct path
  - [x] Test: `--config` custom path overrides default
  - [x] Test: no credentials in returned object

## Dev Notes

- **YAML library**: Use `js-yaml` (`bun add js-yaml`) — it is the most widely used, actively maintained, and has TypeScript types via `@types/js-yaml`. Do not use `yaml` package or write a custom parser.
- **XDG base directory compliance** (mandatory): Config path must use `${XDG_CONFIG_HOME ?? '~/.config'}/protondrive/config.yaml` — not a hardcoded `~/.config` path. [Source: architecture.md#Additional Requirements]
- **No credentials in config** (FR24, NFR6, NFR7): The `Config` type must not have fields for `token`, `password`, `session`, or any credential. If a parsed YAML file happens to contain those keys, they must be stripped/ignored — not returned.
- **`ConfigError` on fail-fast** (NFR13): If config is missing or malformed, throw immediately. Never proceed to network calls.
- **Config YAML schema** (example):
  ```yaml
  sync_pairs:
    - local: ~/Documents
      remote: /Documents
      id: docs
    - local: ~/Pictures
      remote: /Pictures
      id: pics
  ```
- **`SyncPair` type** is already defined in `src/types.ts` from Story 1.2 — import it; do not redefine.
- **`--config` flag**: Add to Commander root program, not individual subcommands. Pass resolved path into `loadConfig()`.
- **Bun file reading**: `await Bun.file(path).text()` throws if file doesn't exist — catch and re-throw as `ConfigError`.
- **Import boundary**: `src/core/config.ts` imports from `src/types.ts` and `src/errors.ts` only. No SDK imports.

### Project Structure Notes

- File: `src/core/config.ts`
- Test: `src/core/config.test.ts` (co-located)
- Config YAML keys use `snake_case` (matches PRD schema): `sync_pairs`, `local`, `remote`
- No `src/config/` subdirectory — config logic lives in `src/core/`

### References

- XDG base directory compliance [Source: architecture.md#Additional Requirements]
- Config type and YAML schema [Source: epics.md#Story 1.4 Acceptance Criteria]
- NFR13 fail-fast on bad config [Source: epics.md#NonFunctional Requirements]
- No credentials in config (FR24–FR25) [Source: epics.md#Functional Requirements]
- `SyncPair` type already in `src/types.ts` [Source: Story 1.2]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- `src/core/config.ts`: `Config`, `ConfigOptions` types; `getDefaultConfigPath()` (XDG-compliant); `loadConfig()` with fail-fast on missing/malformed YAML; credential stripping via `CREDENTIAL_KEYS` set.
- `js-yaml@4.1.1` added as dependency.
- `src/cli.ts`: added `--config <path>` global option.
- 12 unit tests in `src/core/config.test.ts`; all 51 tests pass.

### File List

- `src/core/config.ts` (new)
- `src/core/config.test.ts` (new)
- `src/cli.ts` (modified — added --config option)
- `package.json` (modified — added js-yaml, @types/js-yaml)
- `bun.lock` (updated)

### Review Findings

- [x] [Review][Patch] YAML array documents pass `typeof !== "object"` check — fixed: added `|| Array.isArray(parsed)` to the CONFIG_INVALID guard [src/core/config.ts]
- [x] [Review][Patch] `sync_pairs` entries had zero field validation — fixed: validation loop checks each entry has string `id`, `local`, `remote`; throws `CONFIG_INVALID_PAIR` with index on failure [src/core/config.ts]

### Change Log

- 2026-04-02: Story 1.4 implemented — YAML config loader with XDG compliance, credential stripping, fail-fast errors.
