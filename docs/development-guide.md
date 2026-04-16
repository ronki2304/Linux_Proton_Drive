# ProtonDrive Linux Client — Development Guide

**Last Updated:** 2026-04-16

## Architecture at a glance

Two-process desktop application:

- **UI Process** — Python 3.12 + GTK4 + Libadwaita 1.8, Blueprint `.blp` files, Meson build
- **Sync Engine** — TypeScript + Bun 1.3.11, compiled to a self-contained binary via `bun build --compile`
- **IPC** — Unix domain socket, 4-byte big-endian length-prefixed JSON framing

See `_bmad-output/project-context.md` for the authoritative rule set (89 rules, agent-critical).

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Python | 3.12 (pinned by GNOME 50 runtime) | system |
| Bun | 1.3.11 | `curl -fsSL https://bun.sh/install \| bash -s "bun-v1.3.11"` |
| Meson | ≥1.0 | `sudo dnf install meson` (Fedora) |
| Blueprint compiler | latest | `sudo dnf install blueprint-compiler` (Fedora) |
| GNOME Platform/SDK | 50 | `flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50` |
| flatpak-builder | any | `sudo dnf install flatpak-builder` (Fedora, packaging only) |

## Initial setup

```bash
# Clone and install engine deps
rtk git clone <repo-url>
cd ProtonDrive-LinuxClient
cd engine && rtk bun install && cd ..

# Configure the UI build
meson setup ui/builddir ui
```

## Local dev — two-terminal launch

Run the engine and UI separately during development so engine stdout is visible.

```bash
# Terminal A — engine
cd engine
rtk bun run src/main.ts

# Terminal B — UI
cd ui
meson compile -C builddir
python3 -m protondrive
```

The UI auto-discovers `bun` via `GLib.find_program_in_path()` when spawning the engine itself (production path). In the two-terminal flow the UI connects to the already-running engine over its Unix socket.

## Testing

### Engine unit tests

```bash
cd engine
rtk bun test                # full unit suite
rtk bun test src/ipc.test.ts   # single file
rtk bunx tsc --noEmit          # type-check
```

- `bun:test` is Jest-compatible — use `mock()` factory (not `mock.fn()`)
- Mock at the `DriveClient` wrapper boundary — never mock `@protontech/drive-sdk` directly

### Engine integration tests (live Proton API)

Integration tests live in `engine/src/__integration__/` and require a pre-authenticated session token. Proton's CAPTCHA blocks unattended auth, so the test token is obtained via a manual flow and expires without warning.

```bash
export PROTON_TEST_TOKEN=...     # session token
export PROTON_TEST_FOLDER=...    # sandbox folder id
cd engine
rtk bun test src/__integration__/
```

If tests start failing with 401 errors, re-run the manual auth flow.

### UI tests (pytest via Meson)

```bash
cd ui
meson test -C builddir           # preferred — Meson compiles .blp → .ui, schemas, GResource first
```

> **Important:** Raw `python3 -m pytest` skips Meson's preprocessing steps and breaks any test touching `@Gtk.Template` or `Gio.Settings`. Always route through `meson test`.

Widget tests need an X server; set `CI_SKIP_WIDGET_TESTS=1` to skip them in environments without Xvfb.

## Building the Flatpak

App ID: `io.github.ronki2304.ProtonDriveLinuxClient` (permanent — changing it breaks installed instances)

```bash
rtk flatpak-builder --user --install --force-clean \
  builddir-flatpak \
  flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml

rtk flatpak run io.github.ronki2304.ProtonDriveLinuxClient
```

The manifest pulls Bun 1.3.11 (aarch64 or x86_64) as a source module and uses `bun build --compile` to produce a self-contained engine binary at `/app/lib/protondrive-engine/dist/engine` — no Bun runtime is shipped.

Supported distros (validated before each release): Fedora 43, Ubuntu 24/25, Bazzite, Arch.

## Key language-specific rules (agent-critical)

### TypeScript (engine)

| Flag | Effect |
|---|---|
| `verbatimModuleSyntax` | Type-only imports MUST use `import type { ... }` |
| `noUncheckedIndexedAccess` | `arr[0]` returns `T \| undefined` — use `!` only after a bounds check |
| `noImplicitOverride` | Class method overrides require explicit `override` keyword |

- Local imports use `.js` extension: `import { foo } from "./bar.js"` (not `.ts`)
- JSON imports: `import pkg from "../package.json" with { type: "json" }`
- Throw typed `EngineError` subclasses only (`SyncError`, `NetworkError`, `IpcError`, `ConfigError`) — never plain `new Error(...)`
- Engine never writes to stdout/stderr in production (corrupts IPC framing); all output via IPC push events or `PROTONDRIVE_DEBUG=1` log file

### Python (UI)

- Type hints on all public functions, including `__init__` and GTK signal handlers; `from __future__ import annotations` for forward refs
- No `lambda` in `signal.connect(...)` — causes GObject reference cycles; use bound method references
- All widget structure in Blueprint `.blp` files — never construct widget trees in Python
- Blueprint widget IDs are `kebab-case`; GTK auto-maps them to `snake_case` for `Gtk.Template.Child()`

## Paths (XDG with Flatpak fallbacks)

| Data | Path |
|---|---|
| Config | `$XDG_CONFIG_HOME/protondrive/config.yaml` |
| State DB | `$XDG_DATA_HOME/protondrive/state.db` (SQLite, WAL mode) |
| Credentials | libsecret Secret portal (never on disk plaintext) |
| Window state | `$XDG_STATE_HOME/protondrive/` |
| IPC socket | `$XDG_RUNTIME_DIR/io.github.ronki2304.ProtonDriveLinuxClient/sync-engine.sock` |
| Engine logs (debug only) | `$XDG_CACHE_HOME/protondrive/engine.log` |

Always resolve via env var with fallback — never hardcode `~/.config`. Flatpak sandbox paths differ from native; test explicitly in both.

## CI / CD

- `.github/workflows/ci.yml` — PR gate: `meson test` (UI) + `rtk bun test` (engine unit). Both must pass.
- `.github/workflows/release.yml` — on `v*` tag: Flatpak build + GitHub Release.
- No automated integration tests in CI (Proton CAPTCHA blocks unattended auth).

## Git conventions

- Solo repo — commit directly to `main`, no feature branches.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:` — imperative mood, scope optional.
- `dist/` and `builddir/` are gitignored.
