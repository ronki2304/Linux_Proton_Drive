# Contributing to ProtonDrive Linux Client

## Development Setup

### Prerequisites

- **GNOME SDK 50** — required for the GTK UI and Flatpak build
- **Bun 1.3.11** — JavaScript runtime for the sync engine; install via [bun.sh](https://bun.sh)
- **Blueprint compiler** — for `.blp` UI files (`apt install blueprint-compiler` on Ubuntu 24.04)
- **Meson + Ninja** — build system for the GTK UI (`apt install meson ninja-build`)
- **Python 3 + venv** — for the UI test suite (`apt install python3-venv python3-pip` on Ubuntu; included with Python on Fedora/Arch)
- **Flatpak Builder** — for building the Flatpak bundle (`apt install flatpak-builder`)

For full Flatpak permission rationale see [`flatpak/PERMISSIONS.md`](flatpak/PERMISSIONS.md).

### Two-Terminal Launch

The app is a two-process desktop application. Launch both processes in separate terminals.

```bash
# Terminal A — Sync Engine
cd engine
bun install        # first time only
bun run src/main.ts

# Terminal B — GTK UI
meson setup ui builddir   # first time only (source dir is ui/)
meson compile -C builddir
PYTHONPATH=ui/src PROTONDRIVE_RESOURCE_PATH=builddir/protondrive-resources.gresource python3 -m protondrive
```

---

## Running Tests

| Scope | Command | When to use |
|-------|---------|-------------|
| Engine unit | `cd engine && bun test --path-ignore-patterns '__integration__'` | Local dev, always |
| Engine type-check | `cd engine && bunx tsc --noEmit` | Before pushing |
| UI (local) | `.venv/bin/pytest ui/tests/` | Local dev, always |
| UI (CI) | `meson compile -C builddir && ui/.venv/bin/pytest ui/tests/` | CI validates blueprint compilation first |
| Integration | `cd engine && bun test src/__integration__/` | Only with valid `PROTON_TEST_TOKEN` |

To set up the Python virtual environment for UI tests (first time):

```bash
python3 -m venv ui/.venv
ui/.venv/bin/pip install pytest pyyaml
```

---

## Integration Tests

Integration tests talk to the live Proton Drive API and require a real access token.

### Getting a token

1. Launch the app and complete sign-in through the embedded browser.
2. After sign-in succeeds, retrieve the stored token:
   ```bash
   secret-tool lookup service proton-drive-engine account default
   ```
3. Export it before running tests:
   ```bash
   export PROTON_TEST_TOKEN=<token from secret-tool>
   export PROTON_TEST_FOLDER=<remote folder path to use as test root>
   ```

### Token expiry

Tokens expire. If integration tests start failing with 401 errors, fetch a fresh token by repeating the steps above. Automation of this step is impossible — the Proton auth flow requires CAPTCHA and 2FA.

### Cleanup requirement

Each integration test file must call `afterAll` to delete any files or folders it created. Tests that leak remote state will fail the next run.

```ts
afterAll(async () => {
  // delete test-created remote files/folders
});
```

---

## Retrieving Logs

### Flatpak (production install)

Enable debug logging:

```bash
flatpak override --user --env=PROTONDRIVE_DEBUG=1 io.github.ronki2304.ProtonDriveLinuxClient
```

Engine log path:

```
~/.var/app/io.github.ronki2304.ProtonDriveLinuxClient/cache/protondrive/engine.log
```

Stream GNOME/systemd app logs:

```bash
journalctl --user -f _FLATPAK_APP_ID=io.github.ronki2304.ProtonDriveLinuxClient
```

### Native dev

Engine log (when `PROTONDRIVE_DEBUG=1`):

```
~/.cache/protondrive/engine.log   # default XDG_CACHE_HOME
```

---

## Branch Naming

**Default: one branch per story.** This keeps PRs small and lets CI validate each story before the next one starts.

| Type | Pattern | Example |
|------|---------|---------|
| Story (default) | `story/<epic>-<story>-short-desc` | `story/8-1-incremental-reconciliation` |
| Epic (docs/planning only) | `epic/<epic>-short-desc` | `epic/7-packaging` |
| Bug fix | `fix/<story-or-issue>-short-desc` | `fix/7-4-token-cleanup` |
| Chore | `chore/<desc>` | `chore/update-deps` |

Use an epic-level branch only when the work is pure documentation or planning with no code changes. For all implementation stories, use `story/<epic>-<story>-...`.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/). Use imperative mood. Scope is optional.

```
<type>[optional scope]: <description>

[optional body]
```

| Prefix | Use for |
|--------|---------|
| `feat:` | New user-facing feature |
| `fix:` | Bug fix |
| `chore:` | Maintenance, dependency updates, tooling |
| `docs:` | Documentation only |
| `test:` | Adding or updating tests |
| `refactor:` | Code restructuring with no behaviour change |

**Examples:**

```
feat(engine): add rate-limit backoff with exponential retry
fix(ui): prevent double-click on sync pair delete button
chore: update Bun to 1.3.11
docs: add CONTRIBUTING.md
test(engine): cover offline queue replay edge cases
```
