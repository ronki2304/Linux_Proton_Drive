# ProtonDrive Linux Client — Development Guide

**Date:** 2026-04-05

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (tested with 1.3.11 in CI)
- Linux (the keychain credential store requires an OS keyring — GNOME Keyring, KWallet, or `secret-service` compatible)
- A Proton account (for integration tests only)

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd ProtonDrive-LinuxClient

# Install dependencies
bun install
```

## Project Structure

See [source-tree-analysis.md](./source-tree-analysis.md) for a fully annotated directory tree.

## Common Development Tasks

### Type-check without building

```bash
bunx tsc --noEmit
```

### Run unit tests

```bash
bun test
```

Tests matching `src/**/*.test.ts` run automatically. No setup required.

### Build the binary

```bash
bun build --compile src/cli.ts --outfile dist/protondrive
```

### Run the CLI locally

```bash
./dist/protondrive --help
./dist/protondrive --version
./dist/protondrive auth login
```

### Run end-to-end tests

Requires the binary to be built first:

```bash
bun build --compile src/cli.ts --outfile dist/protondrive
bun test src/__e2e__/
```

### Run integration tests

Requires real Proton account credentials (configure via environment or config file):

```bash
bun test src/__integration__/
```

> **Warning:** Integration tests make live API calls. Do not run against a production account with important data.

## TypeScript Rules (Agent-Critical)

These strict flags are active and affect how you write code:

| Flag | Effect |
|------|--------|
| `verbatimModuleSyntax` | Type-only imports **must** use `import type { ... }` |
| `noUncheckedIndexedAccess` | `arr[0]` returns `T \| undefined` — use `!` only after bounds check |
| `noImplicitOverride` | Class method overrides require explicit `override` keyword |

**Local imports use `.js` extension:**

```ts
// Correct
import { foo } from "./bar.js";

// Wrong — will not compile
import { foo } from "./bar.ts";
```

**Type-only imports:**

```ts
// Correct
import type { MyType } from "./types.js";

// Wrong — verbatimModuleSyntax violation
import { MyType } from "./types.js";
```

**JSON imports require type assertion:**

```ts
import pkg from "../package.json" with { type: "json" };
```

## Testing Guidelines

### Unit tests

- Use `bun test` with `import { test, expect } from "bun:test"`
- Mock at the `CredentialStore` interface level (not `@napi-rs/keyring`)
- Mock at the `DriveClient` class level (not `@protontech/drive-sdk` package)
- Do not place `*.integration.test.ts` files outside `src/__integration__/` — they will run with `bun test`

### Bun built-in APIs

Prefer Bun native APIs over npm equivalents:

| Use | Instead of |
|-----|-----------|
| `bun:sqlite` | `better-sqlite3` |
| `Bun.file()` | `fs.readFile` / `fs.writeFile` |
| `Bun.$\`cmd\`` | `execa` |
| `Bun.serve()` | `express` (not applicable here) |

## Dependency Notes

### `@napi-rs/keyring`

- Bundles cleanly into Bun compiled binary (validated with Bun 1.3.11)
- Requires OS keyring at **runtime** — mock at `CredentialStore` interface in tests

### `openpgp` v6

- Always import from `openpgp` (full bundle)
- **Never** import from `openpgp/lightweight` — causes bundler issues
- v6 uses `Uint8Array<ArrayBufferLike>`; the SDK expects `Uint8Array<ArrayBuffer>` — type casts happen only in `src/sdk/openpgp-proxy.ts`

### `bun:sqlite`

- Rows return as `unknown` — always cast to a typed interface after fetch
- Built-in; no npm package needed

## CI Pipeline

Pull requests trigger `.github/workflows/ci.yml`:

1. Checkout
2. Install Bun 1.3.11 (`oven-sh/setup-bun@v2`)
3. `bun install`
4. `bunx tsc --noEmit`
5. `bun test`

All steps must pass for a PR to merge.

## Building for Distribution

| Target | Command / Notes |
|--------|----------------|
| Binary | `bun build --compile src/cli.ts --outfile dist/protondrive` |
| AppImage | See `packaging/appimage/` |
| AUR (Arch) | See `packaging/aur/` (PKGBUILD) |
| Nix | `nix build` using `flake.nix` |

---

_Generated using BMAD Method `document-project` workflow_
