# Domain-Specific Requirements

## Privacy

- Files are encrypted client-side before leaving the machine — the app must never log, cache, or expose decrypted file content or file paths beyond what sync requires
- The application makes no network connections of its own — all network I/O is delegated to the ProtonDrive SDK; no analytics, telemetry, update checks, or CDN calls exist in application code; updates are delivered exclusively via Flathub
- The app introduces no additional data storage or transmission beyond what the SDK sends to Proton's infrastructure — no third-party endpoints, no phone-home of any kind
- SQLite state DB stores file paths and sync history in plaintext — acceptable for v1, must be explicitly documented in README and security notes

## Security

- Session token must never appear in logs, stdout, stderr, or JSON output under any circumstances
- Credentials stored via libsecret Secret portal (GNOME) or libsecret local fallback (cross-desktop) — never in plaintext config files
- FileStore credential file must be `0600` permissions, set immediately on creation before any content is written
- Localhost auth server: bind to `127.0.0.1` only (not `0.0.0.0`), use a randomly assigned ephemeral port, close the listener immediately after the auth callback is received — no persistent open port
- Decrypted content buffers zeroed after use — best-effort in v1 given GC runtime constraints, but documented as a requirement
- Crash output must be sanitised — no file paths, tokens, credentials, or user data in crash output or stderr dumps

## Technical Constraints (Flatpak)

- Static `--filesystem=home` permission required — the app must watch arbitrary user-chosen sync directories via inotify, and portal-mediated FUSE access does not fire inotify events (confirmed upstream bug xdg-desktop-portal #567); no portal-based alternative provides both dynamic folder selection and file watching; `--filesystem=home` is the minimum scope that supports "pick any folder in your home directory"; Flathub submission must include a plain-language justification explaining this platform limitation
- Credential storage via Secret portal or libsecret local fallback — never via direct `--talk-name=org.freedesktop.secrets` (insecure: grants cross-app secret access)
- System proxy settings must be respected (`http_proxy`/`https_proxy` env vars and GNOME proxy settings) — or explicitly documented as unsupported in v1 with a filed issue
- No in-app update mechanism — Flathub OSTree is the sole update delivery channel; self-update would bypass sandbox verification
- Background Portal autostart ships in V1 — requires one-time user approval via system dialog; no silent systemd service registration

## Log Policy

- No persistent logs in v1 — if any error output is written to disk in future versions, it goes to `$XDG_CACHE_HOME/protondrive/logs/`, contains no file paths, tokens, or file content, and is rotated with a defined size cap

## SDK Risks

- ProtonDrive SDK is pre-release (`v0.14.3`) — treat as potentially breaking; wrapper/adapter layer must insulate the UI and sync engine from version transitions
- Proton crypto migration expected in 2026 — openpgp version boundary must be encapsulated in `src/sdk/`; the UI layer must never import openpgp directly
- API rate limiting: sync engine must implement exponential backoff on `429` responses and surface rate-limit state visibly to the user ("sync paused — rate limited, resuming in Xs") rather than silently failing
