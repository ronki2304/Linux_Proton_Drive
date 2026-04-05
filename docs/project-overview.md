# ProtonDrive Linux Client — Project Overview

**Date:** 2026-04-05
**Type:** CLI
**Architecture:** Layered CLI (commands → core → sdk)

## Executive Summary

ProtonDrive Linux Client is a self-contained command-line tool that lets Linux users interact with their ProtonDrive cloud storage. It provides file upload, download, and bidirectional sync operations, authenticated via Proton's SRP (Secure Remote Password) protocol. The compiled binary bundles all dependencies — no Node.js or runtime required on the target machine.

## Project Classification

- **Repository Type:** Monolith
- **Project Type:** CLI
- **Primary Language:** TypeScript 5 (ES2022, ESNext modules)
- **Runtime/Compiler:** Bun 1.3.x
- **Architecture Pattern:** Layered — Commands → Core → SDK

## Technology Stack

| Category | Technology | Version | Notes |
|----------|-----------|---------|-------|
| Runtime/Compiler | Bun | 1.3.x | Compiles to self-contained binary |
| Language | TypeScript | ^5 | Strict mode, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` |
| CLI Framework | Commander | ^14.0.3 | Command parsing and routing |
| ProtonDrive SDK | @protontech/drive-sdk | ^0.14.3 | Official Proton API client |
| PGP / Encryption | openpgp | ^6.3.0 | End-to-end encryption (full bundle) |
| Credential Store | @napi-rs/keyring | ^1.2.0 | OS keychain integration |
| State Store | bun:sqlite (built-in) | — | Local sync state database |
| Config Parser | js-yaml | ^4.1.1 | YAML config file parsing |
| Password Hashing | bcryptjs | ^3.0.3 | Pure JS bcrypt (no native addon) |
| Auth Protocol | SRP | — | Secure Remote Password (Proton auth) |

## Key Features

- **Authentication** — SRP-based login/logout with OS keychain credential storage
- **File Upload** — Upload local files to ProtonDrive with PGP encryption
- **File Download** — Download and decrypt files from ProtonDrive
- **Sync** — Bidirectional file synchronisation with conflict detection
- **Status** — Report local sync state from SQLite state database
- **Self-contained binary** — Compiled via `bun build --compile`, no runtime dependency

## Architecture Highlights

The codebase is organised into four layers:

1. **Commands** (`src/commands/`) — Thin Commander action handlers; parse CLI args and delegate to core/sdk
2. **Core** (`src/core/`) — Business logic: sync engine, conflict resolution, config management, SQLite state tracking, output formatting
3. **Auth** (`src/auth/`) — SRP authentication flow, credential storage abstraction (OS keyring with file-store fallback)
4. **SDK** (`src/sdk/`) — Thin wrapper around `@protontech/drive-sdk`; adapts types (Uint8Array boundary casts), proxies OpenPGP operations

Type-only imports are enforced via `verbatimModuleSyntax`. All async operations use `async/await` — no `.then()` chains. The SDK mock boundary is always at the `DriveClient` class level, never at the package import.

## Development Overview

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1

### Getting Started

```bash
# Install dependencies
bun install

# Build self-contained binary
bun build --compile src/cli.ts --outfile dist/protondrive

# Run
./dist/protondrive --version
```

### Key Commands

- **Install:** `bun install`
- **Type-check:** `bunx tsc --noEmit`
- **Test (unit):** `bun test`
- **Test (e2e):** `bun test src/__e2e__/` _(requires pre-built binary at `dist/protondrive`)_
- **Test (integration):** `bun test src/__integration__/` _(requires real Proton credentials)_
- **Build:** `bun build --compile src/cli.ts --outfile dist/protondrive`

## Repository Structure

```
ProtonDrive-LinuxClient/
├── src/            # All TypeScript source code
├── docs/           # Generated project documentation
├── packaging/      # Linux distribution packaging (AppImage, AUR, Nix)
├── dist/           # Compiled binary output (gitignored)
├── .github/        # CI/CD workflows
├── package.json    # Dependencies and metadata
├── tsconfig.json   # TypeScript compiler config (strict)
├── bunfig.toml     # Bun runtime config
└── flake.nix       # Nix flake for reproducible builds
```

## Documentation Map

- [index.md](./index.md) — Master documentation index
- [architecture.md](./architecture.md) — Detailed technical architecture
- [source-tree-analysis.md](./source-tree-analysis.md) — Annotated directory structure
- [development-guide.md](./development-guide.md) — Local setup and development workflow
- [component-inventory.md](./component-inventory.md) — Catalog of commands and components

---

_Generated using BMAD Method `document-project` workflow_
