# Story 8-5: License Alignment (GPL-3.0)

Status: ready-for-dev

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
**Then** `grep -r "MIT" LICENSE engine/package.json ui/data/*.metainfo.xml README.md` returns no matches

### AC7 — All tests pass

**When** `bun test 'src/*.test.ts'` runs from `engine/`
**Then** all unit tests pass, zero regressions

**When** `.venv/bin/pytest ui/tests/` runs
**Then** all UI tests pass, zero regressions

---

## Tasks / Subtasks

- [ ] **Task 1 — Replace root `LICENSE` file** (AC1)
  - [ ] 1.1 Replace `LICENSE` with the full GNU General Public License Version 3 text
  - [ ] 1.2 Obtain GPL-3.0 text from https://www.gnu.org/licenses/gpl-3.0.txt — keep copyright header: `Copyright (c) 2026 ProtonDrive Linux Client Contributors`

- [ ] **Task 2 — Update `engine/package.json`** (AC2)
  - [ ] 2.1 Change `"license": "MIT"` to `"license": "GPL-3.0-only"` in `engine/package.json`

- [ ] **Task 3 — Update AppStream metainfo** (AC3)
  - [ ] 3.1 In `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`, change `<project_license>MIT</project_license>` to `<project_license>GPL-3.0-only</project_license>`
  - [ ] 3.2 Run `appstream-util validate ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` — confirm no errors

- [ ] **Task 4 — Update README.md** (AC4)
  - [ ] 4.1 Replace both MIT badge instances with GPL-3.0 badge (shield URL: `https://img.shields.io/badge/License-GPL--3.0-blue.svg`)
  - [ ] 4.2 Update the license section text to reference GPL-3.0-only and list bundled copyleft deps

- [ ] **Task 5 — Add License section to CONTRIBUTING.md** (AC5)
  - [ ] 5.1 Add a "## License" section near the bottom of `CONTRIBUTING.md` with the dep audit summary (see AC5 for exact items)

- [ ] **Task 6 — Final validation** (AC6, AC7)
  - [ ] 6.1 `grep -r "MIT" LICENSE engine/package.json ui/data/*.metainfo.xml README.md` — must return no matches
  - [ ] 6.2 `bun test 'src/*.test.ts'` from `engine/` — all pass
  - [ ] 6.3 `.venv/bin/pytest ui/tests/` — all pass, zero regressions
  - [ ] 6.4 Set story status to `review`

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

### Files touched

- `LICENSE` — Task 1: full text replacement
- `engine/package.json` — Task 2: one field change
- `ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml` — Task 3: one field change
- `README.md` — Task 4: badge + section text
- `CONTRIBUTING.md` — Task 5: new License section

---

## Dev Agent Record

### Agent Model Used

<!-- fill in -->

### Completion Notes List

<!-- fill in -->

### File List

<!-- fill in -->
