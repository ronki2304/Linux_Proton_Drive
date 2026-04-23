# Flatpak Permission Justifications

This document explains each Flatpak sandbox permission declared in
`io.github.ronki2304.ProtonDriveLinuxClient.yml`.

## `--share=network`

Required to connect to ProtonDrive API endpoints (`api.proton.me`) and the
Proton authentication server.

## `--share=ipc`

Required for X11 MIT-SHM shared memory. GTK4/Libadwaita use GPU-accelerated
compositing which requires shared memory to communicate with the X server.
Wayland sessions are unaffected.

## `--socket=wayland` and `--socket=fallback-x11`

Grants access to the Wayland compositor socket (primary) and the X11 display
server socket (fallback). The app supports both display servers.

## `--device=dri`

Required for GPU-accelerated rendering. GTK4/Libadwaita render via OpenGL/Vulkan
through `/dev/dri`. Without this, the app renders entirely on CPU, causing
visual lag.

## `--filesystem=home`

This is the most invasive permission and requires explanation.

ProtonDrive Linux Client uses `inotify` to watch your sync folders for file
changes. `inotify` is a Linux kernel feature that delivers real-time
notifications when files are created, modified, or deleted.

**Why not use the Flatpak portal instead?**

The Flatpak portal provides a FUSE filesystem layer that sandboxes file access.
Unfortunately, the FUSE layer does NOT generate `inotify` events — files
modified through the portal appear static to the kernel-level watcher.

This is a known upstream limitation:
https://github.com/flatpak/xdg-desktop-portal/issues/567

Until that bug is resolved upstream, `--filesystem=home` is the only way to
provide reliable file-change detection. We have reviewed this decision with
Flathub maintainers and will revisit when xdg-desktop-portal #567 is fixed.

**What this permission grants:**
- Read and write access to files in your home directory
- The app only touches the specific sync folders you configure

## Credential Storage (Secret Portal)

Credentials (your Proton session token) are stored using the Flatpak Secret
portal (`org.freedesktop.portal.Secret`). This portal:
- Stores secrets in your host keyring (GNOME Keyring or KWallet)
- Restricts access so only this app can read its own secrets
- Does NOT require `--talk-name=org.freedesktop.secrets` (which would grant
  access to all apps' secrets — we intentionally do NOT request this)

## Proxy Support

System proxy settings (`http_proxy`/`https_proxy` env vars) are automatically
respected by the sync engine's HTTP client. The engine uses Bun's built-in
`fetch`, which honours these environment variables at the process level since
Bun 1.1+. To use a proxy, set the variables in your environment before
launching the app, or pass them via `flatpak run --env=http_proxy=... io.github.ronki2304.ProtonDriveLinuxClient`.

GNOME proxy settings (`org.gnome.system.proxy` GSettings) are not automatically
read by the engine in v1. Use the `http_proxy`/`https_proxy` env var mechanism
described above.
