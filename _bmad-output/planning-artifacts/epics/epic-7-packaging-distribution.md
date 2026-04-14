# Epic 7: Packaging & Distribution

User can install from Flathub with one click. AppStream metainfo, desktop file, CI/CD pipelines, and Flatpak manifest with justified permissions are complete and pass Flathub quality review.

## Story 7.1: Flatpak Manifest & Permission Justifications

As a user,
I want the app to have correct Flatpak permissions with clear justifications,
So that the app passes Flathub review and I can understand why each permission is needed.

**Acceptance Criteria:**

**Given** the Flatpak manifest at `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
**When** inspecting `finish-args`
**Then** `--share=network` is declared (required for ProtonDrive API access)
**And** `--filesystem=home` is declared (inotify requires direct filesystem access; portal FUSE does not fire inotify events — confirmed upstream bug xdg-desktop-portal #567)
**And** Secret portal access is declared for credential storage
**And** no `--talk-name=org.freedesktop.secrets` (insecure — grants cross-app secret access)

**Given** the finish-args justification
**When** a document is prepared
**Then** a plain-language justification explains the `--filesystem=home` permission: the platform limitation in terms both Flathub reviewers and end users can understand
**And** the justification is included as comments in the manifest and as a separate document

**Given** FR40 (proxy support)
**When** evaluating proxy implementation
**Then** either system proxy settings are respected (`http_proxy`/`https_proxy` and GNOME proxy settings) OR proxy support is explicitly documented as unsupported in v1 with a filed GitHub issue

---

## Story 7.2: AppStream Metainfo & Desktop File

As a user,
I want the app to appear correctly in GNOME Software / KDE Discover with proper metadata,
So that I can discover the app and understand what it does before installing.

**Acceptance Criteria:**

**Given** `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml`
**When** inspecting the AppStream metainfo
**Then** it includes: app ID (`io.github.ronki2304.ProtonDriveLinuxClient`), display name ("ProtonDrive Linux Client"), summary ("Unofficial open-source sync client for ProtonDrive on Linux"), description, developer info, screenshots, release notes, and OARS content rating (`oars-1.1`, all fields `none`)
**And** release notes are treated as first-class user-facing content (FR41)
**And** MIT license is referenced

**Given** `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.desktop`
**When** inspecting the desktop file
**Then** `Categories=Network;FileTransfer;` is set
**And** `Keywords=sync;proton;drive;cloud;` is set
**And** correct Flatpak `Exec=` line is configured
**And** `StartupNotify=true` is set

**Given** the project README
**When** `README.md` is created at the project root
**Then** it includes: what the project is, Flathub install badge, screenshot of the main window, what makes it different (official SDK, solved WebKitGTK auth), link to Flatpak manifest permissions with justification summary, link to CONTRIBUTING.md, MIT license badge
**And** the README is the GitHub front door — written for r/linux and r/ProtonMail readers who arrive skeptical

**Given** the AppStream metainfo
**When** validated with `appstream-util validate`
**Then** validation passes with no errors

---

## Story 7.3: CI/CD Pipelines

As a developer,
I want automated CI/CD pipelines for testing and releasing,
So that every PR is tested and releases are built reproducibly.

**Acceptance Criteria:**

**Given** `.github/workflows/ci.yml`
**When** a PR is opened or updated
**Then** the pipeline runs both test suites: `meson test -C builddir` (UI/Python) AND `node --import tsx --test engine/src/**/*.test.ts` (engine/TypeScript)
**And** both must pass for the PR to be mergeable

**Given** `.github/workflows/release.yml`
**When** a `v*` tag is pushed
**Then** the pipeline builds the Flatpak bundle
**And** creates a GitHub Release with the built artifact
**And** the build is reproducible — no manual release steps (FR42)

**Given** the CI pipeline
**When** inspecting the test commands
**Then** engine tests use `--import tsx` loader (without it, Node 22 cannot parse TypeScript imports)
**And** UI tests run via `meson test` (not raw `python -m pytest` — Meson compiles Blueprint and GSettings first)

**Given** the release pipeline
**When** inspecting the build
**Then** `better-sqlite3` native addon is compiled from source
**And** the build uses `org.gnome.Platform//50` runtime

**Given** the project CONTRIBUTING.md
**When** `CONTRIBUTING.md` is created at the project root
**Then** it documents: development setup (two-terminal launch), integration test token workflow (manual auth → `secret-tool lookup` → env vars → `node --test`), token expiry behaviour, test commands for both UI (`meson test`) and engine (`node --import tsx --test`), branch naming conventions, commit message conventions
**And** it covers the architecture doc's explicit requirement: "integration test prerequisite documented in CONTRIBUTING.md"

---

## Story 7.4: End-to-End MVP Validation & Manual Test Protocol

As a developer,
I want a manual validation checklist that walks through all 5 user journeys on the target distro matrix,
So that the MVP is verified as a complete, working product before Flathub submission.

**Acceptance Criteria:**

**Given** the MVP is feature-complete (all stories in Epics 1-6 done)
**When** manual validation is performed
**Then** all 5 PRD user journeys are executed end-to-end:

1. **First Run (Journey 1):** Install from Flatpak → authenticate → set up first sync pair → see files sync with progress → verify "Last synced X seconds ago"
2. **Conflict (Journey 2):** Edit same file locally and remotely while app is closed → open app → verify conflict copy created → verify conflict notification → "Reveal in Files" works
3. **Token Expiry (Journey 3):** Force token expiry → verify re-auth modal with queued change count → re-authenticate → verify queued changes replay without false conflicts
4. **Contributor (Journey 4):** Verify SDK boundary in source → verify Flatpak permission justifications → verify credential storage error handling on non-GNOME desktop
5. **Sync Pair Removal (Journey 5):** Remove a sync pair → verify confirmation dialog copy → verify files untouched on both sides

**Given** the target distro matrix
**When** validation is performed
**Then** all 5 journeys pass on: Fedora 43, Ubuntu 24/25, Bazzite, Arch
**And** auth specifically succeeds on the distros where DonnieDice fails

**Given** the manual test protocol
**When** it is documented
**Then** a `TESTING.md` file exists in the project root with step-by-step instructions for each journey
**And** integration test prerequisites are documented (manual auth flow for `PROTON_TEST_TOKEN`)
**And** known limitations are listed (no automated integration tests due to CAPTCHA)

**Given** accessibility validation
**When** performed as part of E2E
**Then** all 3 critical journeys (first run, conflict handling, re-auth) are completed using keyboard only
**And** Orca screen reader correctly announces all interactive elements, status changes, and error states
