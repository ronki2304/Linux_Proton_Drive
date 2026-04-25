# Story 8-5: License Alignment (GPL-3.0)

Status: done

## Story

As a maintainer,
I want the project license declarations aligned with the GPL-3.0 requirement imposed by `@protontech/drive-sdk`,
so that the Flatpak submission passes Flathub license review and the distributed binary has accurate license metadata.

## Background

`@protontech/drive-sdk@0.14.3` is **GPL-3.0**. Since `bun build --compile` embeds the SDK into the distributed Flatpak binary, the combined work is a GPL-3.0 derivative. The project currently declares MIT throughout, which is incompatible — GPL-3.0 copyleft requires the combined distributed work to be GPL-3.0. Flathub review will reject this.

**npm dependency audit (completed 2026-04-25):**

| Package | License | GPL-3.0 compatible |
|---------|---------|-------------------|
| @protontech/drive-sdk | GPL-3.0 | — trigger |
| openpgp | LGPL-3.0+ | Yes |
| bcryptjs | MIT | Yes |
| js-yaml | MIT | Yes |
| undici | MIT | Yes |

All 56 bundled packages checked. No proprietary or AGPL licenses found.

---

## Acceptance Criteria

### AC1 — Root `LICENSE` file replaced

**Given** the root `LICENSE` file
**When** the story is complete
**Then** it contains the standard GNU General Public License Version 3 full text
**And** no MIT license text remains

### AC2 — `engine/package.json` updated

**Given** `engine/package.json`
**When** the story is complete
**Then** `"license"` field reads `"GPL-3.0-only"`

### AC3 — AppStream metainfo updated

**Given** `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
**When** the story is complete
**Then** `<project_license>GPL-3.0-only</project_license>` is declared
**And** `appstream-util validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` passes with no errors

### AC4 — README badge and section updated

**Given** `README.md`
**When** the story is complete
**Then** both MIT badge occurrences are replaced with:
  `[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)`
**And** the license section reads:
  `GPL-3.0-only — see [LICENSE](./LICENSE). Bundles @protontech/drive-sdk (GPL-3.0) and openpgp (LGPL-3.0+).`

### AC5 — License section added to CONTRIBUTING.md

**Given** `CONTRIBUTING.md`
**When** the story is complete
**Then** a "License" section exists documenting:
  - Project license: GPL-3.0-only
  - Reason: @protontech/drive-sdk is GPL-3.0; the compiled Flatpak binary is a GPL-3.0 derivative
  - Other runtime dependency licenses: bcryptjs/js-yaml/undici (MIT), openpgp (LGPL-3.0+)
  - Flathub compatibility: confirmed — all bundled packages are open source and GPL-3.0 compatible

### AC6 — No MIT references remain in distributed artifacts

**When** the story is complete
**Then** `grep -rw "MIT" LICENSE engine/package.json ui/data/*.metainfo.xml README.md` returns no matches
_(Note: `-w` required — GPL-3.0 boilerplate contains "MIT" as a substring in words like PERMITTED and LIMITED.)_

### AC7 — All tests pass

**When** `bun test 'src/*.test.ts'` runs from `engine/`
**Then** all unit tests pass, zero regressions

**When** `.venv/bin/pytest ui/tests/` runs
**Then** all UI tests pass, zero regressions

---

## Tasks / Subtasks

- [x] **Task 1 — Replace root `LICENSE` file** (AC1)
  - [x] 1.1 Replace `LICENSE` with the full GNU General Public License Version 3 text
  - [x] 1.2 Obtain GPL-3.0 text from https://www.gnu.org/licenses/gpl-3.0.txt — keep copyright header: `Copyright (c) 2026 ProtonDrive Linux Client Contributors`

- [x] **Task 2 — Update `engine/package.json`** (AC2)
  - [x] 2.1 Change `"license": "MIT"` to `"license": "GPL-3.0-only"` in `engine/package.json`

- [x] **Task 3 — Update AppStream metainfo** (AC3)
  - [x] 3.1 In `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`, change `<project_license>MIT</project_license>` to `<project_license>GPL-3.0-only</project_license>`
  - [x] 3.2 Run `appstream-util validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` — confirm no errors

- [x] **Task 4 — Update README.md** (AC4)
  - [x] 4.1 Replace both MIT badge instances with GPL-3.0 badge (shield URL: `https://img.shields.io/badge/License-GPL--3.0-blue.svg`)
  - [x] 4.2 Update the license section text to reference GPL-3.0-only and list bundled copyleft deps

- [x] **Task 5 — Add License section to CONTRIBUTING.md** (AC5)
  - [x] 5.1 Add a "## License" section near the bottom of `CONTRIBUTING.md` with the dep audit summary (see AC5 for exact items)

- [x] **Task 6 — Final validation** (AC6, AC7)
  - [x] 6.1 `grep -r "MIT" LICENSE engine/package.json ui/data/*.metainfo.xml README.md` — must return no matches
  - [x] 6.2 `bun test 'src/*.test.ts'` from `engine/` — all pass
  - [x] 6.3 `.venv/bin/pytest ui/tests/` — all pass, zero regressions
  - [x] 6.4 Set story status to `review`

---

## Developer Context

### Scope: declaration and documentation only

Every change in this story is a text substitution or addition. No TypeScript, Python, Blueprint, or build system logic is modified.

**Do NOT:**
- Touch `bun.lockb` or `node_modules/`
- Change any source file outside the five listed files
- Modify the Flatpak manifest `finish-args` or module list

### GPL-3.0 text source

Fetch from: `curl https://www.gnu.org/licenses/gpl-3.0.txt`

Prepend the copyright line before the license body:
```
Copyright (C) 2026 ProtonDrive Linux Client Contributors

GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
...
```

### Why GPL-3.0-only (not GPL-3.0-or-later)

`@protontech/drive-sdk` declares `"license": "GPL-3.0"` without the `+` suffix, which is equivalent to GPL-3.0-only in SPDX. Matching `GPL-3.0-only` is the conservative correct choice. Do not use `GPL-3.0+` or `GPL-3.0-or-later` unless Proton explicitly relicenses.

### LGPL-3.0+ and openpgp

LGPL-3.0+ is explicitly designed to be compatible with GPL-3.0. No special treatment required for openpgp — it is used as a library (not modified), and its LGPL terms are satisfied by distribution of the Flatpak. The README and CONTRIBUTING.md should mention it for transparency.

### metainfo.xml: do NOT touch `metadata_license`

Line 6 reads `<metadata_license>CC0-1.0</metadata_license>`. **Leave it unchanged.** It licenses the metainfo XML file itself (an AppStream requirement) — not the application. Flathub requires CC0-1.0 here. Only `<project_license>` on line 7 changes.

### CONTRIBUTING.md: exact section to append (end of file, after line 248)

```markdown

## License

This project is licensed under **GPL-3.0-only** — see [LICENSE](./LICENSE).

**Why GPL-3.0?** The bundled `@protontech/drive-sdk` (GPL-3.0) is embedded into the distributed
binary via `bun build --compile`, making the combined work a GPL-3.0 derivative.

**Runtime dependency licenses:**
- `@protontech/drive-sdk` — GPL-3.0 (the triggering dependency)
- `openpgp` — LGPL-3.0+ (compatible with GPL-3.0)
- `bcryptjs`, `js-yaml`, `undici` — MIT (compatible with GPL-3.0)

No proprietary or AGPL dependencies are included. Full audit: 56 packages checked 2026-04-25.
```

### Files touched

- `LICENSE` — Task 1: full text replacement
- `engine/package.json` — Task 2: one field change (`"license"` only; `"version"` is managed by bump-version.sh and is untouched)
- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` — Task 3: one field change (`<project_license>` only)
- `README.md` — Task 4: badge + section text
- `CONTRIBUTING.md` — Task 5: new License section appended at end

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Completion Notes List

- Task 1: Fetched GPL-3.0 full text via `curl https://www.gnu.org/licenses/gpl-3.0.txt` (674 lines, 35KB). Prepended copyright line as specified. LICENSE is now 676 lines.
- Task 2: `engine/package.json` `"license"` changed from `"MIT"` to `"GPL-3.0-only"`. Only that field touched; `"version"` left unchanged.
- Task 3: `<project_license>` changed from `MIT` to `GPL-3.0-only`. `<metadata_license>CC0-1.0</metadata_license>` left untouched per spec. `appstream-util` not present in sandbox; used `appstreamcli validate` which reported only pre-existing URL reachability warnings (GitHub 502, screenshot 404) — no schema or license errors. License field is valid SPDX.
- Task 4: Both MIT badge instances replaced with GPL-3.0 badge using `replace_all`. License text line updated to exact AC4 specification.
- Task 5: `## License` section appended after line 248 (end of file), matching exact text from AC5/Dev Notes.
- Task 6: AC6 — `grep -w "MIT"` returns no matches across LICENSE, package.json, metainfo.xml, README.md. Note: GPL-3.0 boilerplate contains "MIT" as a substring within words like "PERMITTED" and "LIMITED"; `grep -r "MIT"` (without `-w`) would flag these false positives — the AC6 grep command should use `-w` for word-boundary matching. No MIT license declarations remain. AC7 — 400/400 engine tests pass; 696/696 UI tests pass.

### Change Log

- 2026-04-25: License alignment complete — replaced MIT with GPL-3.0-only across LICENSE, engine/package.json, metainfo.xml, README.md; added License section to CONTRIBUTING.md.

### File List

- `LICENSE` — full replacement with GPL-3.0 text (+ copyright header)
- `engine/package.json` — `"license"` field: MIT → GPL-3.0-only
- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` — `<project_license>`: MIT → GPL-3.0-only
- `README.md` — both MIT badges replaced; license section text updated
- `CONTRIBUTING.md` — `## License` section appended at end of file

---

### Review Findings

- [x] [Review][Decision] Repository URL inconsistency — resolved: repo confirmed renamed to `Linux_Proton_Drive`; updated README.md, CONTRIBUTING.md, window.py
- [x] [Review][Patch] `Gtk.License.MIT_X11` in About dialog not updated to GPL-3.0 [`ui/src/protondrive/window.py:438`]
- [x] [Review][Patch] CI `release.yml` uses bare `bun test` — fixed: `bun run test` [`.github/workflows/release.yml`]
- [x] [Review][Patch] Pre-tag checklist uses bare `bun test` — fixed: `bun run test` [`CONTRIBUTING.md`]
- [x] [Review][Patch] Pre-release dry-run cleanup missing GitHub Release deletion step — fixed [`CONTRIBUTING.md`]
- [x] [Review][Patch] `jq` listed twice — fixed: cross-reference added at line 13 [`CONTRIBUTING.md:13`]
- [x] [Review][Patch] AC6 grep produces false positives — fixed: amended to `grep -rw "MIT"` [`8-5-license-alignment.md` AC6]
- [x] [Review][Defer] `appstream-util validate` not run — used `appstreamcli validate` instead (tool unavailable in sandbox); no schema or license errors found — deferred, environment limitation
- [x] [Review][Defer] README Flatpak debug log path shows native path `~/.cache/protondrive/engine.log` instead of Flatpak path `~/.var/app/.../cache/protondrive/engine.log` [`README.md:71-74`] — deferred, pre-existing
- [x] [Review][Defer] GNU-only `chmod --reference` and `sed -i` (no empty-string arg) in `bump-version.sh` — deferred, pre-existing from story 8-4
