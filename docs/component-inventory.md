# ProtonDrive Linux Client — Component Inventory

**Date:** 2026-04-05
**Scan Level:** Quick (pattern-based)

## CLI Commands

| Command | File | Purpose |
|---------|------|---------|
| `auth login` | `src/commands/auth-login.ts` | Initiates SRP auth flow, stores session token in OS keychain |
| `auth logout` | `src/commands/auth-logout.ts` | Clears stored credentials from keychain/file store |
| `upload` | `src/commands/upload.ts` | PGP-encrypts and uploads a local file to ProtonDrive |
| `download` | `src/commands/download.ts` | Downloads and decrypts a file from ProtonDrive |
| `sync` | `src/commands/sync.ts` | Runs bidirectional sync between local directory and ProtonDrive |
| `status` | `src/commands/status.ts` | Displays current sync state from local SQLite database |

## Auth Components

| Component | File | Purpose |
|-----------|------|---------|
| `CredentialStore` (interface) | `src/auth/credentials.ts` | Abstraction for storing/retrieving the session access token |
| `KeyringStore` | `src/auth/keyring-store.ts` | OS keychain implementation via `@napi-rs/keyring` |
| `FileStore` | `src/auth/file-store.ts` | File-based credential fallback store |
| SRP Auth | `src/auth/srp.ts` | Proton SRP challenge-response authentication protocol |

> **Test note:** Mock at `CredentialStore` interface level — never mock `@napi-rs/keyring` directly.

## Core Components

| Component | File | Purpose |
|-----------|------|---------|
| Config | `src/core/config.ts` | Parses user YAML config file via `js-yaml` |
| State DB | `src/core/state-db.ts` | SQLite database (`bun:sqlite`) tracking local sync state |
| Sync Engine | `src/core/sync-engine.ts` | Orchestrates diff → apply → reconcile sync operations |
| Conflict | `src/core/conflict.ts` | Detects and resolves local vs remote file conflicts |
| Output | `src/core/output.ts` | Terminal output formatting (tables, progress indicators, errors) |

## SDK Components

| Component | File | Purpose |
|-----------|------|---------|
| `DriveClient` | `src/sdk/client.ts` | Wrapper around `@protontech/drive-sdk` — **primary mock boundary in tests** |
| Account Service | `src/sdk/account-service.ts` | Proton account API: user info, session management |
| OpenPGP Proxy | `src/sdk/openpgp-proxy.ts` | Bridges `Uint8Array<ArrayBufferLike>` (openpgp v6) ↔ `Uint8Array<ArrayBuffer>` (SDK) |
| SRP Module | `src/sdk/srp-module.ts` | SRP cryptographic helpers used during authentication |

## Shared Types & Utilities

| File | Purpose |
|------|---------|
| `src/types.ts` | Shared TypeScript interfaces and type aliases |
| `src/errors.ts` | Custom error classes used across all layers |

## Packaging Targets

| Target | Directory | Notes |
|--------|-----------|-------|
| AppImage | `packaging/appimage/` | Universal Linux binary bundle |
| AUR | `packaging/aur/` | Arch Linux User Repository PKGBUILD |
| Nix | `packaging/nix/` | Nix derivation; `flake.nix` at project root |

## CI/CD Pipelines

| Pipeline | File | Trigger | Steps |
|---------|------|---------|-------|
| CI | `.github/workflows/ci.yml` | Pull request | Checkout → Install Bun 1.3.11 → `bun install` → `bunx tsc --noEmit` → `bun test` |
| E2E | `.github/workflows/e2e.yml` | — | Binary-level tests against compiled artifact |
| Release | `.github/workflows/release.yml` | — | Build and publish distribution packages |

---

_Generated using BMAD Method `document-project` workflow_
