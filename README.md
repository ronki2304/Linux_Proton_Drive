# ProtonDrive Linux Client

A command-line client for [ProtonDrive](https://proton.me/drive) on Linux. Upload, download, and keep your files in sync — straight from the terminal.

- No runtime required — ships as a single self-contained binary
- Credentials stored securely in your OS keychain
- Two-factor authentication (TOTP) supported
- Machine-readable `--json` output for scripting

---

## Installation

### Pre-built binary (any distro)

Download the latest binary from [GitHub Releases](https://github.com/ronki2304/ProtonDrive-LinuxClient/releases), make it executable, and put it on your PATH:

```bash
curl -sSfL https://github.com/ronki2304/ProtonDrive-LinuxClient/releases/latest/download/protondrive \
  -o ~/.local/bin/protondrive
chmod +x ~/.local/bin/protondrive
```

### Arch Linux (AUR)

```bash
yay -S protondrive
# or
paru -S protondrive
```

### Nix / NixOS

Run directly without installing:

```bash
nix run github:ronki2304/ProtonDrive-LinuxClient
```

Or add it to your system packages:

```nix
# flake.nix
inputs.protondrive.url = "github:ronki2304/ProtonDrive-LinuxClient/v1.0.0";

# in your configuration
environment.systemPackages = [ inputs.protondrive.packages.${system}.default ];
```

### Build from source

You'll need [Bun](https://bun.sh) ≥ 1.1.

```bash
git clone https://github.com/ronki2304/ProtonDrive-LinuxClient
cd ProtonDrive-LinuxClient
bun install
bun build --compile src/cli.ts --outfile dist/protondrive
```

The compiled binary is at `dist/protondrive` — copy it anywhere on your PATH.

---

## Getting started

### 1. Log in

```bash
protondrive auth login
```

You'll be prompted for your Proton username and password. If your account has two-factor authentication enabled, you'll be asked for your 6-digit TOTP code as well.

Your session token is stored securely in your OS keychain (GNOME Keyring, KWallet, or any `secret-service`-compatible store).

### 2. Create a config file

For `sync` and `status`, you need a config file at `~/.config/protondrive/config.yaml`:

```yaml
sync_pairs:
  - id: documents
    local: ~/Documents
    remote: /Documents

  - id: photos
    local: ~/Pictures/Proton
    remote: /Photos

options:
  conflict_strategy: copy   # keeps both versions on conflict
```

Each `sync_pair` needs a unique `id`, a `local` path, and a `remote` path on ProtonDrive.

> The config path can be overridden with `--config <path>`.

---

## Commands

### `auth login` / `auth logout`

```bash
protondrive auth login    # save credentials to keychain
protondrive auth logout   # remove credentials from keychain
```

### `upload`

```bash
protondrive upload <local> <remote>
```

Upload a file or an entire directory to ProtonDrive.

```bash
# Upload a single file
protondrive upload ~/report.pdf /Documents/report.pdf

# Upload a whole folder
protondrive upload ~/Projects /Projects
```

### `download`

```bash
protondrive download <remote> <local>
```

Download a file or directory from ProtonDrive. Downloads are written to a temporary file first and renamed atomically, so a failed download never leaves a partial file behind.

```bash
# Download a single file
protondrive download /Documents/report.pdf ~/Downloads/report.pdf

# Download a folder
protondrive download /Photos ~/Downloads/Photos
```

### `sync`

```bash
protondrive sync
```

Runs a two-way sync for every pair defined in your config file. Files changed on either side are reconciled. If the same file was changed in both places, a conflict copy is created locally and you're notified.

```bash
# Use a custom config
protondrive sync --config ~/work-protondrive.yaml
```

### `status`

```bash
protondrive status
```

Shows the current sync state for each pair in your config — no network calls, reads only from the local state database.

```
Sync status:
  documents:   ~/Documents  ↔  /Documents  [synced]   last sync: 2026-04-05T10:30:00Z
  photos:      ~/Pictures   ↔  /Photos     [pending]  last sync: never
```

---

## Global flags

These flags work with every command:

| Flag | Description |
|------|-------------|
| `--json` | Output results as JSON (useful for scripting) |
| `--config <path>` | Path to config file (default: `~/.config/protondrive/config.yaml`) |
| `--version` | Print the version and exit |
| `--help` | Show help |

### JSON output example

```bash
protondrive status --json
```

```json
{
  "ok": true,
  "pairs": [
    {
      "id": "documents",
      "local": "~/Documents",
      "remote": "/Documents",
      "state": "synced",
      "last_sync_mtime": "2026-04-05T10:30:00Z"
    }
  ],
  "last_sync": "2026-04-05T10:30:00Z"
}
```

---

## License

MIT — see [LICENSE](./LICENSE).
