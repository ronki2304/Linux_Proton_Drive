# ProtonDrive Linux Client (work in progress not usable)

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


## License

MIT — see [LICENSE](./LICENSE).
