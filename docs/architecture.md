# ProtonDrive Linux Client — Architecture

**Date:** 2026-04-05
**Pattern:** Layered CLI
**Type:** CLI (Monolith)

## Executive Summary

ProtonDrive Linux Client uses a four-layer architecture: a thin **Commands** layer delegates to a **Core** business-logic layer, which calls a **SDK** abstraction layer wrapping `@protontech/drive-sdk`. A separate **Auth** layer manages authentication state and credential storage independently.

The entire application compiles to a self-contained binary via `bun build --compile`. There is no web server, no REST API, and no database server — state is persisted in a local SQLite file via `bun:sqlite`.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                    CLI Entry Point                    │
│                     src/cli.ts                        │
│           (Commander program + command reg)           │
└─────────────────────────┬────────────────────────────┘
                          │
          ┌───────────────▼───────────────┐
          │        Commands Layer          │
          │       src/commands/            │
          │  auth-login  auth-logout       │
          │  upload  download  sync  status│
          └──────┬──────────────┬─────────┘
                 │              │
    ┌────────────▼────┐  ┌──────▼────────────────────┐
    │   Auth Layer    │  │       Core Layer            │
    │   src/auth/     │  │       src/core/             │
    │ credentials     │  │  config     conflict        │
    │ keyring-store   │  │  state-db   sync-engine     │
    │ file-store      │  │  output                     │
    │ srp             │  └──────────────┬──────────────┘
    └────────────┬────┘                 │
                 │              ┌───────▼───────────────┐
                 │              │       SDK Layer         │
                 └─────────────►│       src/sdk/          │
                                │  client (DriveClient)   │
                                │  account-service        │
                                │  openpgp-proxy          │
                                │  srp-module             │
                                └───────────┬─────────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │   @protontech/drive-sdk    │
                              │   openpgp (v6)             │
                              │   Proton API               │
                              └───────────────────────────┘
```

## Layer Responsibilities

### Commands Layer (`src/commands/`)

- **Responsibility:** Parse CLI arguments, validate input, call core/auth, format output
- **Pattern:** One file per command; thin handlers — no business logic
- **Commands:** `auth login`, `auth logout`, `upload`, `download`, `sync`, `status`
- **Framework:** Commander 14 `.action()` callbacks wrapping `async/await`

### Auth Layer (`src/auth/`)

- **Responsibility:** Manage session tokens and the SRP authentication protocol
- **Key design:** `CredentialStore` interface with two implementations:
  - `KeyringStore` — OS keychain via `@napi-rs/keyring` (primary)
  - `FileStore` — File-based fallback
- **What is stored:** `accessToken` string only (not the full `SessionToken` object)
- **SRP:** `srp.ts` implements Proton's Secure Remote Password challenge-response
- **Test boundary:** Mock at the `CredentialStore` interface level; never mock `@napi-rs/keyring` directly (requires OS keychain at runtime)

### Core Layer (`src/core/`)

- **Responsibility:** Business logic — sync orchestration, state management, conflict handling, config
- **State:** `state-db.ts` uses `bun:sqlite` (built-in); rows return as `unknown` — always cast to typed interfaces
- **Sync:** `sync-engine.ts` orchestrates diff → apply → reconcile; calls SDK layer for drive operations
- **Conflicts:** `conflict.ts` detects and resolves sync conflicts (local vs remote change divergence)
- **Config:** `config.ts` parses user YAML config via `js-yaml`
- **Output:** `output.ts` formats terminal output (tables, progress, errors)

### SDK Layer (`src/sdk/`)

- **Responsibility:** Thin adapters around `@protontech/drive-sdk` and `openpgp`
- **Mock boundary:** `client.ts` exports `DriveClient` — always mock this class in tests, never mock the package import
- **Type boundary:** `openpgp-proxy.ts` handles the `Uint8Array<ArrayBufferLike>` vs `Uint8Array<ArrayBuffer>` mismatch between openpgp v6 and the SDK (casts required at this boundary only)
- **SRP module:** `srp-module.ts` provides cryptographic helpers for the SRP protocol used during auth

## Data Flow

### Login Flow

```
auth login command
  → srp.ts: SRP challenge/response with Proton API
  → account-service.ts: exchange SRP proof for session token
  → credentials.ts: store accessToken via CredentialStore (keyring preferred)
```

### Upload Flow

```
upload command
  → config.ts: load user config
  → credentials.ts: retrieve accessToken
  → client.ts (DriveClient): authenticate SDK
  → openpgp-proxy.ts: PGP-encrypt file content
  → DriveClient.upload(): send encrypted payload to Proton API
  → state-db.ts: record upload in sync state
```

### Sync Flow

```
sync command
  → state-db.ts: read last-known sync state
  → DriveClient: fetch remote file listing
  → sync-engine.ts: diff local vs remote
  → conflict.ts: resolve any conflicts
  → upload/download as needed
  → state-db.ts: update sync state
```

## Key Technical Constraints

| Constraint | Detail |
|-----------|--------|
| TypeScript strict | `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noImplicitOverride` all enabled |
| Import extensions | Local imports use `.js` extension (e.g. `import { foo } from "./bar.js"`) |
| Type imports | `import type { ... }` mandatory for type-only imports |
| Array indexing | `arr[0]` returns `T \| undefined` — use `!` only after bounds check |
| Method overrides | `override` keyword required on all class method overrides |
| Async | `async/await` everywhere; no `.then()/.catch()` chains |
| JSON imports | Require `with { type: "json" }` assertion |
| openpgp bundle | Always import from `openpgp` (full bundle), never `openpgp/lightweight` |
| SDK mock boundary | Mock `DriveClient` class, never `@protontech/drive-sdk` package imports |

## Technology Decisions

| Decision | Choice | Rationale |
|---------|--------|-----------|
| Runtime | Bun | Single binary compilation, built-in SQLite, fast test runner |
| Credential store | @napi-rs/keyring | Bundles cleanly into Bun compiled binary (validated 1.3.11) |
| Encryption | openpgp v6 (full bundle) | Lightweight variant causes import issues with Bun bundler |
| Password hashing | bcryptjs | Pure JS — no native addon needed in compiled binary |
| State storage | bun:sqlite | Built-in, zero-dependency SQLite |

## Testing Strategy

| Level | Location | How to Run | When to Use |
|-------|---------|-----------|-------------|
| Unit | `src/**/*.test.ts` | `bun test` | Always; CI gate |
| E2E (binary) | `src/__e2e__/` | `bun test src/__e2e__/` | After `bun build --compile` |
| Integration (live) | `src/__integration__/` | `bun test src/__integration__/` | With real Proton credentials |

---

_Generated using BMAD Method `document-project` workflow_
