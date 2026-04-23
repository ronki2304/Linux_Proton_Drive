# Story 7.2: AppStream Metainfo & Desktop File

Status: done

## Story

As a user,
I want the app to appear correctly in GNOME Software / KDE Discover with proper metadata,
so that I can discover the app and understand what it does before installing.

## Acceptance Criteria

1. **Metainfo completeness** — `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` includes: app ID, display name, summary, description, developer info, screenshots (≥1), release notes for v0.1.0, OARS content rating (`oars-1.1`, all fields `none`), MIT license reference, launchable tag, homepage URL (`https://github.com/ronki2304/ProtonDrive-LinuxClient`), and bugtracker URL.
2. **Release notes first-class** (FR41) — `<releases>` section present with v0.1.0 entry; description lists key features in human-readable prose/bullets, not internal story references.
3. **Desktop file complete** — `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.desktop` has `Keywords=sync;proton;drive;cloud;` added (only missing field), all other required fields already present.
4. **AppStream validation passes** — `appstreamcli validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` returns no errors (warnings acceptable for screenshot placeholder).
5. **README enhancements** — `README.md` at project root gains: Flathub install badge, MIT license badge, screenshot of main window, link to `flatpak/PERMISSIONS.md` for permission justification.

## Tasks / Subtasks

- [x] **Task 1 — Update desktop file** (AC: 3)
  - [x] 1.1 Open `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.desktop`
  - [x] 1.2 Add `Keywords=sync;proton;drive;cloud;` after the `Categories=` line
  - [x] 1.3 Verify `Exec=protondrive` matches the launcher script name in meson.build (it does — no change needed)
  - [x] 1.4 Verify `StartupNotify=true` is present (it is — no change needed)

- [x] **Task 2 — Expand AppStream metainfo** (AC: 1, 2, 4)
  - [x] 2.1 Open `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
  - [x] 2.2 Add `<developer id="io.github.ronki2304"><name>ronki2304</name></developer>` (Flathub requires the `id` attribute — see Dev Notes)
  - [x] 2.3 Expand `<description>` with 2–3 paragraphs covering: what it does, why it exists (official SDK, WebKitGTK auth), and key capabilities
  - [x] 2.4 Add `<screenshots>` section with ≥1 screenshot entry (see Dev Notes for URL pattern and placeholder approach)
  - [x] 2.5 Add `<releases>` section with v0.1.0 entry and first-class release notes (see Dev Notes for content); use the actual implementation date for `date=` rather than the literal `2026-04-23` shown in the Dev Notes if implementing on a different day
  - [x] 2.6 Expand `<content_rating type="oars-1.1">` with all explicit `none` fields (see Dev Notes for complete list)
  - [x] 2.7 Verify `<metadata_license>CC0-1.0</metadata_license>` and `<project_license>MIT</project_license>` are present (they are)
  - [x] 2.8 Fix homepage URL — the current stub has the **wrong URL** (`ProtonDriveLinuxClient`, missing the hyphen); replace with `https://github.com/ronki2304/ProtonDrive-LinuxClient`. Also verify `<launchable type="desktop-id">` is present (it is — no change needed there).
  - [x] 2.9 Add `<url type="bugtracker">https://github.com/ronki2304/ProtonDrive-LinuxClient/issues</url>` after the homepage URL (see target-state XML in Dev Notes)

- [x] **Task 3 — Take and commit screenshot** (AC: 1, 5) — **If the app cannot be launched this session, use Option B from Dev Notes** (add `<screenshots>` block with placeholder URL and a TODO comment; appstreamcli will warn but not error — acceptable per AC4).
  - [x] 3.1 Build and run via the two-terminal dev launch (see CONTRIBUTING.md once created, or: terminal 1 runs the compiled engine binary, terminal 2 runs the UI via meson). Alternatively build the Flatpak and run with `flatpak run io.github.ronki2304.ProtonDriveLinuxClient`
  - [x] 3.2 Take a screenshot of the main window showing at least one sync pair
  - [x] 3.3 Save as `screenshots/main-window.png` at project root (create `screenshots/` directory)
  - [x] 3.4 Reference in metainfo (see Dev Notes — use GitHub raw URL pattern)

- [x] **Task 4 — Update README.md** (AC: 5)
  - [x] 4.1 Add Flathub badge at the top (see Dev Notes for badge markdown)
  - [x] 4.2 Add MIT license badge near the existing License section
  - [x] 4.3 Add a screenshot after the feature list (reference `screenshots/main-window.png`)
  - [x] 4.4 In the "Why `--filesystem=home`?" section, **replace** the existing sentence "A full plain-language justification is included in the manifest comments." with a link to `flatpak/PERMISSIONS.md` (see Dev Notes for the exact markdown). The old sentence is stale — PERMISSIONS.md now exists and is the canonical reference.
  - [x] 4.5 Leave existing `CONTRIBUTING.md` reference as-is — that file is created in Story 7-3; the forward reference in the README is fine

- [x] **Task 5 — Validate** (AC: 4)
  - [x] 5.1 Run directly on host (preferred — appstreamcli is at `/usr/bin/appstreamcli`):
    `appstreamcli validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
  - [x] 5.2 Or in distrobox if preferred: `distrobox-enter -n LinuxProtonDrive -- appstreamcli validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
  - [x] 5.3 Resolve any errors (warnings for missing screenshot content-hash or remote URL are acceptable)
  - [x] 5.4 Set story status to `review`

---

## Dev Notes

### CRITICAL: File locations differ from architecture doc

The architecture document (`project-structure-boundaries.md`) lists these files under `flatpak/`, but the actual `meson.build` installs them from `ui/data/`. The **authoritative locations** are:

| File | Actual path |
|------|-------------|
| AppStream metainfo | `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` |
| Desktop entry | `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.desktop` |

Both files already exist as stubs. Do NOT create new files under `flatpak/` — `meson.build` won't pick them up.

The Flatpak manifest (`flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`) uses `buildsystem: meson` for the `protondrive-ui` module, which runs `meson install` and picks up these files automatically. No manifest changes are needed in this story.

### Desktop file — current state (only Keywords is missing)

```ini
[Desktop Entry]
Name=ProtonDrive Linux Client
Comment=Unofficial open-source sync client for ProtonDrive on Linux
Exec=protondrive
Icon=io.github.ronki2304.ProtonDriveLinuxClient
Terminal=false
Type=Application
Categories=Network;FileTransfer;
StartupNotify=true
```

Add one line after `Categories=`:
```ini
Keywords=sync;proton;drive;cloud;
```

The `Exec=protondrive` is correct — inside the Flatpak sandbox the binary is at `/app/bin/protondrive`, and the Flatpak system wraps it with `flatpak run` in the system-level desktop file automatically. Do NOT change Exec= to `flatpak run ...` — that would break non-Flatpak dev installs.

### AppStream metainfo — target state

```xml
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>io.github.ronki2304.ProtonDriveLinuxClient</id>
  <name>ProtonDrive Linux Client</name>
  <summary>Unofficial open-source sync client for ProtonDrive on Linux</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <developer id="io.github.ronki2304">
    <name>ronki2304</name>
  </developer>

  <description>
    <p>
      ProtonDrive Linux Client is an unofficial, open-source desktop sync client for
      ProtonDrive, built with GTK4 and Libadwaita. It uses Proton's official
      @protontech/drive-sdk — the same SDK Proton uses for their own CLI — ensuring
      long-term API compatibility.
    </p>
    <p>
      Authenticate with your Proton account through an embedded browser window with
      full 2FA support. Set up one or more local folders to sync with ProtonDrive,
      with two-way sync, conflict detection, and automatic conflict copies.
    </p>
    <p>
      The client handles real-world failure modes: offline change queuing with replay on
      reconnect, token expiry recovery without data loss, and actionable errors for disk
      full, permission denied, inotify limit exceeded, and file locked conditions.
    </p>
  </description>

  <launchable type="desktop-id">io.github.ronki2304.ProtonDriveLinuxClient.desktop</launchable>

  <url type="homepage">https://github.com/ronki2304/ProtonDrive-LinuxClient</url>
  <url type="bugtracker">https://github.com/ronki2304/ProtonDrive-LinuxClient/issues</url>

  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/ronki2304/ProtonDrive-LinuxClient/main/screenshots/main-window.png</image>
      <caption>Main window showing sync pair management</caption>
    </screenshot>
  </screenshots>

  <releases>
    <release version="0.1.0" date="2026-04-23">
      <description>
        <p>Initial release of ProtonDrive Linux Client.</p>
        <ul>
          <li>Authenticate with your Proton account via an embedded browser — no manual token management</li>
          <li>Set up and manage multiple local folders synced to ProtonDrive</li>
          <li>Two-way file sync with conflict detection and automatic conflict copies</li>
          <li>Offline resilience — changes queue while offline and replay automatically on reconnect</li>
          <li>Token expiry recovery with a re-auth modal showing queued change count</li>
          <li>Actionable error surfacing for disk full, permission denied, inotify limit, and file locked</li>
          <li>Missing local folder detection with recovery prompt</li>
        </ul>
      </description>
    </release>
  </releases>

  <content_rating type="oars-1.1">
    <content_attribute id="social-chat">none</content_attribute>
    <content_attribute id="social-info">none</content_attribute>
    <content_attribute id="social-audio">none</content_attribute>
    <content_attribute id="social-location">none</content_attribute>
    <content_attribute id="social-contacts">none</content_attribute>
    <content_attribute id="money-purchasing">none</content_attribute>
    <content_attribute id="money-gambling">none</content_attribute>
  </content_rating>
</component>
```

**OARS note:** The `<content_rating type="oars-1.1" />` (self-closing) in the current stub is technically valid and means all `none`. Expanding to explicit fields makes it unambiguous and satisfies stricter Flathub validators. Use the explicit list above.

### Screenshot approach

Option A (recommended): Take a real screenshot and commit it.
```
screenshots/
└── main-window.png   ← PNG, ideally 1280×800 or similar, showing the main window with ≥1 sync pair visible
```

Then reference as:
```
https://raw.githubusercontent.com/ronki2304/ProtonDrive-LinuxClient/main/screenshots/main-window.png
```

Option B (if screenshot cannot be taken this session): Add the `<screenshots>` block with a TODO comment and a placeholder image URL that returns 404. `appstreamcli validate` will warn but not error on unreachable screenshots. The warning is acceptable for initial submission; fix before Flathub review.

### README badge markdown

Add at the very top of README.md, before the h1 title or just after it:

```markdown
[![Flathub](https://img.shields.io/flathub/v/io.github.ronki2304.ProtonDriveLinuxClient?label=Flathub)](https://flathub.org/apps/io.github.ronki2304.ProtonDriveLinuxClient)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
```

Note: The Flathub badge will show "not found" until the app is actually on Flathub. That is expected and acceptable — it shows intent and will auto-resolve on submission.

In the "Why `--filesystem=home`?" section, add a link to the full justification:
```markdown
A full plain-language justification is in [`flatpak/PERMISSIONS.md`](./flatpak/PERMISSIONS.md).
```

For the screenshot in README.md (after the feature list):
```markdown
![ProtonDrive Linux Client main window](screenshots/main-window.png)
```

### `<developer id>` attribute — Flathub requirement

Flathub's AppStream guidelines (AppStream 1.0) require `id` on the `<developer>` element. The `id` should be the reverse-DNS developer identifier. For this project:

```xml
<developer id="io.github.ronki2304">
  <name>ronki2304</name>
</developer>
```

Without the `id` attribute, `appstreamcli validate --pedantic` (used by Flathub CI) will warn. Non-pedantic validation may pass, but include it to be Flathub-ready.

### AppStream validation in distrobox

```bash
# Install if not present
distrobox-enter -n LinuxProtonDrive -- sudo dnf install appstream

# Validate
distrobox-enter -n LinuxProtonDrive -- appstreamcli validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml

# Alternative (older tool, more lenient)
distrobox-enter -n LinuxProtonDrive -- appstream-util validate-relax ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml
```

Flathub CI uses `appstreamcli validate --pedantic`. The story AC requires no errors with `appstreamcli validate` (non-pedantic). Warnings are acceptable.

### What the Flatpak build already handles

The `protondrive-ui` module in the Flatpak manifest uses `buildsystem: meson`, which runs `ninja install` inside the sandbox. `meson.build` already has:
- `install_data('data/io.github.ronki2304.ProtonDriveLinuxClient.desktop', install_dir: ...)` → installs to `/app/share/applications/`
- `install_data('data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml', install_dir: ...)` → installs to `/app/share/metainfo/`

No Flatpak manifest changes are required for this story. The post-install step `glib-compile-schemas /app/share/glib-2.0/schemas` in the manifest is already there for GSettings; no AppStream post-install step is needed.

### No engine or Python code changes required

This story is purely file-content work: XML/INI/Markdown. No Python, TypeScript, Blueprint, GSettings, or Meson build logic changes beyond the data files.

### Project Structure Notes

- Desktop and metainfo files live at `ui/data/` (not `flatpak/`) — meson.build is authoritative
- Screenshot assets: `screenshots/` at project root (new directory)
- README.md: project root
- `flatpak/PERMISSIONS.md` created in Story 7-1 — link to it from README, do not duplicate content

### References

- Epic 7 spec: `_bmad-output/planning-artifacts/epics/epic-7-packaging-distribution.md#story-72`
- Architecture: Flatpak identity: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#flatpak-identity`
- Architecture: Project structure: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`
- Previous story (7-1) result: `_bmad-output/implementation-artifacts/7-1-flatpak-manifest-and-permission-justifications.md`
- AppStream spec: https://www.freedesktop.org/software/appstream/docs/
- Flathub AppStream requirements: https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines/

---

## Party-Mode Validation Record

**Validated:** 2026-04-23 by Bob 🏃 (SM), Winston 🏗️ (Architect), Amelia 💻 (Dev), Quinn 🧪 (QA)

### Findings

- [x] **[C1] CRITICAL — Task 2.8 wrong guidance (homepage URL):** Current stub has `ProtonDriveLinuxClient` (no `-Drive-` hyphen). Task 2.8 said "verify it's present (it is)" — misleadingly implied no change needed. `appstreamcli validate` won't catch this; Flathub reviewers would. **Fixed:** Task 2.8 rewritten to say "Fix homepage URL" with the correct target URL.
- [x] **[C2] CRITICAL — Bugtracker URL in target state but no task covered it:** Dev Notes target XML included `<url type="bugtracker">` but no task (2.x) directed the dev to add it, and AC1 didn't require it. Dev would produce non-spec output without noticing. **Fixed:** Added Task 2.9; updated AC1 to list bugtracker URL.
- [x] **[E1] ENHANCEMENT — Task 3 body didn't reference Option B:** Subtasks 3.1–3.4 only described the success path. Option B (placeholder screenshot if app can't be launched) was buried in Dev Notes. A dev following the task list would get stuck. **Fixed:** Option B reference added to Task 3 header.
- [x] **[E2] ENHANCEMENT — Release date hardcoded with no guidance:** Dev Notes showed `date="2026-04-23"` without telling the dev to use the actual implementation date. **Fixed:** Task 2.5 note added.
- [x] **[E3] ENHANCEMENT — Task 4.4 ambiguous: add vs. replace:** README already has "justification is included in the manifest comments" (stale). Task 4.4 said "add link" without saying to replace the stale sentence — both would coexist and contradict. **Fixed:** Task 4.4 clarified to say "replace."
- [x] **[D1] DEFERRED — OARS 1.1 full field expansion:** 7 fields listed; ~20+ exist in the full OARS spec. Sufficient for initial submission; full expansion deferred. See `deferred-work.md` [7-2 D1].
- [x] **[D2] DEFERRED — `<keywords>` element in metainfo:** Flathub recommends but doesn't require. Out of scope for this story. See `deferred-work.md` [7-2 D2].
- [x] **[D3] DEFERRED — `<url type="vcs-browser">` in metainfo:** Optional AppStream element. Out of scope. See `deferred-work.md` [7-2 D3].

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (Bob SM, create-story workflow)
claude-sonnet-4-6 (Amelia Dev, bmad-dev-story workflow, 2026-04-23)

### Debug Log References

- appstreamcli validate --no-net: exit 0, 1 pedantic (uppercase in app ID `ProtonDriveLinuxClient` — inherent to Flatpak identity, not fixable)
- appstreamcli validate (with net): 3 warnings — url-not-reachable for homepage/bugtracker (private/nonexistent repo), screenshot-image-not-found (placeholder per Option B). All warnings, no errors. AC4 satisfied.
- Task 3: Option B used — app cannot be launched in this session (no display server / GUI). Placeholder screenshot URL added to metainfo with TODO comment. `screenshots/` directory created with `.gitkeep`.

### Completion Notes List

- Task 1: Added `Keywords=sync;proton;drive;cloud;` to desktop file after `Categories=` line. All other fields verified present/correct.
- Task 2: Full metainfo rewrite — added `<developer id>`, expanded 3-paragraph `<description>`, added `<screenshots>` (placeholder, Option B), added `<releases>` v0.1.0 with feature bullets, expanded `<content_rating>` with 7 explicit OARS fields, fixed homepage URL (added hyphen: ProtonDrive-LinuxClient), added bugtracker URL.
- Task 3: Option B — placeholder screenshot URL in metainfo; `screenshots/.gitkeep` created. appstreamcli warns (acceptable per AC4).
- Task 4: README badges (Flathub + MIT) added at top; screenshot reference added after feature list; stale manifest-comments sentence replaced with link to `flatpak/PERMISSIONS.md`; MIT badge also added near License section.
- Task 5: appstreamcli validate --no-net passes exit 0. Network warnings are expected/acceptable per AC4.

### File List

- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.desktop`
- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
- `README.md`
- `screenshots/.gitkeep`

### Change Log

- 2026-04-23: Story 7-2 implemented — desktop file Keywords added, metainfo fully expanded (developer, description, screenshots, releases, OARS, URL fixes), README badges + screenshot reference + PERMISSIONS.md link added, appstreamcli validation passes (no errors).

---

## Code Review Findings

**Reviewed:** 2026-04-23 — 3 layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor)
**Result:** 0 decision-needed, 0 patch, 4 defer, 8 dismissed

### Deferred

- [x] [Review][Defer] Screenshot URL pinned to `main` branch — `raw.githubusercontent.com/.../main/screenshots/...` will break if branch is renamed or commit changes main; stable tag reference preferred. Intentional Option B design decision; fix when real screenshot is committed. `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml:40` — deferred, Option B design decision
- [x] [Review][Defer] TODO comment left in production metainfo — `<!-- TODO: replace with real screenshot once app is running in CI -->`. Intentional per Option B; tracked for pre-Flathub cleanup. `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml:38` — deferred, Option B design decision
- [x] [Review][Defer] OARS 1.1 field list incomplete (7 of ~20+ fields) — already tracked as [7-2 D1] in deferred-work.md. — deferred, pre-existing [7-2 D1]
- [x] [Review][Defer] Git remote URL mismatch — remote is `git@github.com:ronki2304/Linux_Proton_Drive.git`; README/metainfo reference `ProtonDrive-LinuxClient`. Pre-existing naming inconsistency; developer will rename/reorganize before Flathub submission. `README.md:55`, `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml:34-35` — deferred, repo rename planned pre-Flathub

### Dismissed (8)

- Release date hardcoded `2026-04-23` — correct implementation date per story spec; not stale
- Flathub badge app ID vs repo URL — intentionally different namespacing (Flatpak ID uses no hyphens; GitHub repo name uses hyphen); both correct
- Trailing semicolon in `Keywords=` — FreeDesktop spec requires trailing semicolons for list values; correct
- Screenshot file missing locally — intentional Option B; `.gitkeep` placeholder in `screenshots/`
- `<image>` missing `type`/dimensions — `type="source"` is the default when omitted; dimensions optional for source images
- Desktop file missing `StartupWMClass`/`DBusActivatable` — not required; pre-existing; out of scope
- No `metadata_version` declaration — not a real AppStream requirement; false positive
- AC4 URL reachability warnings — acceptable per spec; dev record confirms exit 0 with `--no-net`; warnings expected for private/nonexistent repo
