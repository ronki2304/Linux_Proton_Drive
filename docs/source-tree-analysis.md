# ProtonDrive Linux Client — Source Tree Analysis

**Date:** 2026-04-05
**Scan Level:** Quick (pattern-based)

## Annotated Directory Tree

```
ProtonDrive-LinuxClient/                    # Project root
├── src/                                    # All TypeScript source
│   ├── cli.ts                              # ★ CLI entry point — Commander program setup, command registration
│   ├── types.ts                            # Shared type definitions (used across all layers)
│   ├── errors.ts                           # Custom error classes
│   │
│   ├── commands/                           # Command layer — thin Commander action handlers
│   │   ├── auth-login.ts                   # `protondrive auth login` — triggers SRP auth flow
│   │   ├── auth-logout.ts                  # `protondrive auth logout` — clears stored credentials
│   │   ├── download.ts                     # `protondrive download` — download + decrypt file
│   │   ├── status.ts                       # `protondrive status` — reports local sync state
│   │   ├── sync.ts                         # `protondrive sync` — bidirectional file sync
│   │   ├── upload.ts                       # `protondrive upload` — encrypt + upload file
│   │   │
│   │   ├── auth-login.test.ts              # Unit tests
│   │   ├── auth-logout.test.ts
│   │   ├── download.test.ts
│   │   ├── status.test.ts
│   │   ├── sync.test.ts
│   │   └── upload.test.ts
│   │
│   ├── auth/                               # Authentication layer
│   │   ├── credentials.ts                  # Credential abstraction — get/set/clear session token
│   │   ├── file-store.ts                   # File-based credential fallback store
│   │   ├── keyring-store.ts                # OS keychain store via @napi-rs/keyring
│   │   ├── srp.ts                          # SRP authentication protocol implementation
│   │   │
│   │   ├── credentials.test.ts
│   │   ├── file-store.test.ts
│   │   ├── keyring-store.test.ts
│   │   └── srp.test.ts
│   │
│   ├── core/                               # Core business logic layer
│   │   ├── config.ts                       # YAML config file parsing (js-yaml)
│   │   ├── conflict.ts                     # Sync conflict detection and resolution strategy
│   │   ├── output.ts                       # Terminal output formatting helpers
│   │   ├── state-db.ts                     # SQLite state database (bun:sqlite) — tracks sync state
│   │   ├── sync-engine.ts                  # Sync orchestration — diff, apply, reconcile
│   │   │
│   │   ├── config.test.ts
│   │   ├── conflict.test.ts
│   │   ├── output.test.ts
│   │   ├── state-db.test.ts
│   │   └── sync-engine.test.ts
│   │
│   ├── sdk/                                # ProtonDrive SDK abstraction layer
│   │   ├── client.ts                       # DriveClient wrapper — the mock boundary in tests
│   │   ├── account-service.ts              # Proton account API calls (user info, session)
│   │   ├── openpgp-proxy.ts                # OpenPGP adapter — bridges Uint8Array type mismatch
│   │   ├── srp-module.ts                   # SRP cryptographic helpers (Proton protocol)
│   │   └── client.test.ts
│   │
│   ├── __e2e__/                            # End-to-end tests (require built binary at dist/protondrive)
│   │   ├── cli.e2e.test.ts                 # CLI invocation and output tests
│   │   └── workflow.test.ts                # Full auth → upload → download → sync workflow
│   │
│   └── __integration__/                    # Live API integration tests (require real credentials)
│       ├── auth.integration.test.ts        # Auth flow against real Proton API
│       └── sync.integration.test.ts        # Sync operations against real ProtonDrive
│
├── docs/                                   # ★ Generated project documentation (this folder)
│
├── packaging/                              # Linux distribution packaging
│   ├── appimage/                           # AppImage build scripts
│   ├── aur/                                # Arch User Repository (AUR) PKGBUILD
│   └── nix/                                # Nix derivation / flake module
│
├── dist/                                   # Compiled binary output (gitignored)
│   └── protondrive                         # Self-contained executable
│
├── .github/
│   └── workflows/
│       ├── ci.yml                          # PR gate: type-check + unit tests
│       ├── release.yml                     # Release automation
│       └── e2e.yml                         # End-to-end test workflow
│
├── node_modules/                           # Bun-managed dependencies
├── package.json                            # Project metadata and dependencies
├── tsconfig.json                           # TypeScript strict config
├── bunfig.toml                             # Bun runtime configuration
├── bun.lock                                # Bun lockfile
├── flake.nix                               # Nix flake for reproducible builds
├── CLAUDE.md                               # AI agent project instructions
└── README.md                               # Basic setup guide
```

## Critical Directories

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `src/` | All source code | `cli.ts` (entry), `types.ts`, `errors.ts` |
| `src/commands/` | CLI command handlers | One file per command + matching test |
| `src/auth/` | Authentication | `credentials.ts`, `srp.ts`, `keyring-store.ts` |
| `src/core/` | Business logic | `sync-engine.ts`, `state-db.ts`, `conflict.ts` |
| `src/sdk/` | SDK abstraction | `client.ts` (mock boundary), `openpgp-proxy.ts` |
| `src/__e2e__/` | Binary-level tests | Require `dist/protondrive` pre-built |
| `src/__integration__/` | Live API tests | Require real Proton credentials |
| `packaging/` | Linux distro packaging | AppImage, AUR, Nix |
| `.github/workflows/` | CI/CD pipelines | ci.yml, release.yml, e2e.yml |

## Entry Points

- **Primary:** `src/cli.ts` — Commander program; registers all commands
- **Build output:** `dist/protondrive` — compiled self-contained binary

## Test Structure

Three test tiers, each with different requirements:

| Tier | Location | Run Command | Requires |
|------|---------|-------------|---------|
| Unit | `src/**/*.test.ts` | `bun test` | Nothing |
| E2E | `src/__e2e__/` | `bun test src/__e2e__/` | Built binary at `dist/protondrive` |
| Integration | `src/__integration__/` | `bun test src/__integration__/` | Real Proton account credentials |

> **Note:** Files named `*.integration.test.ts` outside `src/__integration__/` will run with `bun test` — exclusion is by directory convention, not compiler config.

---

_Generated using BMAD Method `document-project` workflow_
