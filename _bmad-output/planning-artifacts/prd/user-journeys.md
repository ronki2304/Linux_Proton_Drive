# User Journeys

## Journey 1: First Run — "It Finally Works"

**Persona:** Layla, 34, software developer, Fedora Silverblue, paying ProtonDrive subscriber who has been manually uploading files through the browser for two years. Sees the Flathub listing on r/linux, recognises it's different from DonnieDice, opens GNOME Software.

**Opening Scene:** One click install. She opens the app and sees an embedded browser loading Proton's real login page. She enters her credentials, completes 2FA, and the app transitions to a post-auth overview screen: her account name, 47GB of 200GB used, and a list of her existing ProtonDrive folders. She knows auth worked. She trusts what she's looking at.

**Rising Action:** She clicks "Add sync pair." A folder picker lets her select `~/Documents` locally and `Documents` in ProtonDrive. She clicks Start. The sync status panel shows a live count: "Syncing 1,247 files — 340MB of 2.1GB — about 8 minutes remaining." She doesn't walk away thinking it's broken. She makes a coffee.

**Climax:** The status panel shows "Last synced 4 seconds ago." She adds a second sync pair — `~/Projects` ↔ `Projects` — from the main window without re-running any wizard. It starts immediately.

**Resolution:** No terminal. No documentation. Eleven minutes from install to two folders syncing. She posts: "Confirmed working on Silverblue. This is the one."

**Requirements revealed:** Flathub install, WebKitGTK auth, post-auth account overview (name + storage), first-run folder pair wizard, first-sync progress (file count + bytes + ETA), live sync status panel, add-subsequent-sync-pair from main UI.

---

## Journey 2: The Conflict — "I Trust It Got This Right"

**Persona:** Marcus, 41, freelance journalist, two Fedora machines (desktop at home, laptop for travel). Uses ProtonDrive for draft articles and source notes. Has been burned by last-write-wins sync before.

**Opening Scene:** Monday evening Marcus edits `interview-notes-2026-04-06.md` on his desktop, then closes the app before leaving for a trip. On Tuesday, travelling, he opens his laptop — the app was also closed there. He edits the same file, different section, and closes the laptop without opening the sync app.

**Rising Action:** Wednesday morning, home. He opens the app on his desktop. The sync engine loads its last-known state from the database, checks the remote, and detects that the remote version has a newer mtime than its last recorded sync — and so does the local file. Both changed independently since the last known sync point.

**Climax:** A yellow banner: "1 conflict — `interview-notes-2026-04-06.md`." He clicks "View conflict log." Both versions are intact: the current file, and `interview-notes-2026-04-06.md.conflict-2026-04-06` sitting in the same folder. He opens both in his editor, merges the additions, deletes the conflict copy. "It didn't choose for me. Good."

**Resolution:** Nothing lost. The safety guarantee held even across app restarts and offline edits on two machines.

**Requirements revealed:** Conflict detection across app restarts, persistent sync state in StateDB (last-known mtime per file), conflict copy creation (`filename.ext.conflict-YYYY-MM-DD`), in-app conflict notification banner, conflict log UI, no silent overwrites.

---

## Journey 3: Token Expiry — "Don't Just Stall On Me"

**Persona:** Layla again, six weeks after first run. Sync is background noise — she doesn't think about it. While her session token was expired, she edited four files.

**Opening Scene:** The sync engine gets a 401. It does not retry into a loop. The app detects the four locally-changed files are queued but unsent. The window header shifts to a warning state. When Layla brings the window forward she sees a modal: "Your session has expired. 4 local changes are waiting to sync. Sign in to resume."

**Rising Action:** She clicks "Sign in." WebKitGTK auth opens — same embedded flow. She completes 2FA. The modal closes.

**Climax:** The sync engine replays the four queued local changes against the current remote state. None of them conflict with remote changes — they were local-only edits made during the downtime. No spurious conflict copies are created. The status panel shows "4 files synced."

**Resolution:** 45-second interruption. Layla returns to work. No reconfiguration, no lost changes, no false conflict copies for files she edited during the gap.

**Requirements revealed:** 401 detection, change queue preserved during expired session, re-auth modal with queued change count, change queue replayed without false conflicts after re-auth, sync state preserved across re-auth.

---

## Journey 4: The Contributor — "I Need to See the Code"

**Persona:** Tariq, 28, security engineer, NixOS. Does not install software he cannot read. Uses ProtonDrive for encrypted backups of contracts, identity documents, and PGP key material. Found the project via Hacker News.

**Opening Scene:** Tariq reads the repository before touching GNOME Software. He checks the Flatpak manifest permissions and the justification comments. He reads the SDK boundary in `src/sdk/client.ts`. He checks credential storage — libsecret via the Secret portal. He reads the conflict copy logic. Nothing surprises him badly.

**Rising Action:** He installs the Flatpak. On NixOS, libsecret's Secret portal path doesn't resolve as expected — the app detects this, surfaces a clear error: "Credential storage unavailable via Secret portal — falling back to encrypted file store at `~/.var/app/.../credentials`." Explicit. Not silent. He files a bug with a detailed NixOS-specific repro. The maintainer responds within 24 hours.

**Climax:** Tariq submits a PR improving the credential storage fallback path for non-standard XDG environments. It gets merged. He stars the repo and links it from his security blog: "open-source cloud sync clients worth trusting."

**Resolution:** The audit, the failure, the fix, and the contribution — all in one week. This is what open source on the official SDK enables.

**Requirements revealed:** SDK boundary enforcement and documentation, documented Flatpak permission justifications, credential storage fallback with explicit error (not silent fail), public issue tracker with responsive maintainer, MIT license prominent.

---

## Journey 5: The Goodbye — "Don't Touch My Files"

**Persona:** Layla, three months in. Reorganising her folder structure, wants to stop syncing `~/Documents` and replace it with a more specific subfolder.

**Opening Scene:** She opens the sync pairs list and clicks "Remove" next to the `~/Documents` pair. A confirmation dialog appears: "Stop syncing this folder pair? Local files in `~/Documents` will not be affected. Remote files in `ProtonDrive/Documents` will not be affected. Sync will simply stop."

**Resolution:** She confirms. Both sets of files remain exactly where they are. Nothing deleted. Nothing surprising. She adds a new pair for `~/Documents/work` and moves on.

**Requirements revealed:** Sync pair removal confirmation dialog, explicit "no files will be deleted" language, removal leaves both local and remote files intact.

---

## Journey Requirements Summary

| Journey | Key Capabilities Required |
|---|---|
| First Run | Post-auth account overview, first-sync progress (count/bytes/ETA), add-subsequent-pair from main UI |
| Conflict | Persistent StateDB sync state across restarts, conflict copy, in-app conflict notification + log |
| Token Expiry | 401 detection, change queue preservation + replay, re-auth modal with queued count, no false conflicts |
| Contributor | SDK boundary docs, Flatpak permission justifications, credential fallback with explicit error |
| Sync Pair Removal | Confirmation dialog, explicit no-delete guarantee, both-sides files untouched |
