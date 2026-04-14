# Executive Summary

Over 100 million people trust Proton with their most sensitive files. On Windows and macOS, that trust comes with a desktop sync client. On Linux, it comes with nothing — rclone's ProtonDrive backend broke in September 2025 and was delisted in February 2026, the only community GUI attempt (DonnieDice) fails authentication on every mainstream distro, and Celeste — the last maintained multi-cloud sync Flatpak with ProtonDrive support — was archived in November 2025. The Flathub slot is vacant. Users are cancelling subscriptions and moving to pCloud.

ProtonDrive Linux Client is an open-source GTK4/Libadwaita desktop application that syncs selected folders between the user's machine and ProtonDrive. Authenticate once, select your folders, and sync runs continuously while the app is open. It ships on Flathub — the only distribution channel that reaches immutable distro users on Bazzite, Silverblue, and SteamOS — before Proton's own announced CLI (Q2 2026) captures the mindshare, and with no GUI or Flatpak commitment from Proton on the horizon.

## What Makes This Special

The enabling event is the publication of `@protontech/drive-sdk` — Proton's official, MIT-licensed SDK. Every prior community attempt reverse-engineered a private API. This project is built on the same foundation as Proton's own applications, which means it tracks breaking changes before they hit users rather than discovering them after. The SDK publication transformed this from "another workaround" into a legitimate client.

The auth problem that killed DonnieDice is solved: Tauri's `tauri://` URI scheme blocks WebKitGTK Web Workers, which Proton's SRP crypto requires. A native GTK4 app serves the auth webview over `http://127.0.0.1`, which WebKitGTK treats as a fully trusted origin. Workers load, SRP completes, login works — not a workaround, the correct embedding architecture.

For immutable distro users (Bazzite, Silverblue, SteamOS) — the fastest-growing segment of the Linux desktop market — Flatpak is structurally the only delivery mechanism. Flathub-first packaging is the primary design constraint, not an afterthought. The app is open-source by necessity: ProtonDrive's value is client-side E2EE, and a closed-source sync client is a contradiction for users who chose Proton precisely because they can verify what handles their keys.
