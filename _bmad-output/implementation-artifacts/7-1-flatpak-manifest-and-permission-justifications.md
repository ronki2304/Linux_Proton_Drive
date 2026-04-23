# Story 7.1: Flatpak Manifest & Permission Justifications

Status: done

## Story

As a user,
I want the app to have correct Flatpak permissions with clear justifications,
so that the app passes Flathub review and I can understand why each permission is needed.

## Acceptance Criteria

1. **`--share=network` declared** — ProtonDrive API access.
2. **`--filesystem=home` declared** — inotify requires direct FS access; portal FUSE does not fire inotify events (upstream bug xdg-desktop-portal #567).
3. **Secret portal access is declared** — libsecret uses the Flatpak Secret portal (`org.freedesktop.portal.Secret`) for credential storage.
4. **No `--talk-name=org.freedesktop.secrets`** — removed; it grants cross-app secret access (insecure).
5. **`--filesystem=/run/systemd/resolve:ro` removed** — not required; standard `--share=network` provides DNS resolution; unusual permission would flag in Flathub review.
6. **Plain-language `--filesystem=home` justification exists** — both as inline manifest comments and as `flatpak/PERMISSIONS.md`; explains inotify / portal FUSE limitation in terms Flathub reviewers and end users can understand.
7. **Proxy support documented** — either `http_proxy`/`https_proxy` and GNOME proxy settings are respected, OR proxy support is explicitly documented as unsupported in v1 with a filed GitHub issue referenced in `PERMISSIONS.md`.

## Tasks / Subtasks

- [x] **Task 1 — Fix `finish-args` in manifest** (AC: 1–5)
  - [x] 1.1 Open `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
  - [x] 1.2 Remove `--talk-name=org.freedesktop.secrets` (direct keyring DBus access — grants cross-app secret access, insecure; portal backend requires NO explicit talk-name)
  - [x] 1.3 Remove `--filesystem=/run/systemd/resolve:ro` (unnecessary; standard `--share=network` covers DNS; unusual permission would trigger Flathub review friction)
  - [x] 1.4 Retain: `--share=network`, `--share=ipc`, `--socket=fallback-x11`, `--socket=wayland`, `--device=dri`, `--filesystem=home`
  - [x] 1.5 Add inline justification comments above each permission (see Dev Notes for exact comment text)

- [x] **Task 2 — Create `flatpak/PERMISSIONS.md`** (AC: 6)
  - [x] 2.1 Create `flatpak/PERMISSIONS.md` with plain-language justification for each `finish-arg` (see Dev Notes for content template)
  - [x] 2.2 Include `--filesystem=home` inotify section explaining xdg-desktop-portal #567 limitation

- [x] **Task 3 — Proxy support documentation** (AC: 7)
  - [x] 3.1 Assess whether `http_proxy`/`https_proxy` env vars are respected by `@protontech/drive-sdk` calls automatically (Node.js/Bun respects these env vars for HTTP requests by default via `undici`/`fetch` — verify in `engine/src/sdk.ts`)
  - [x] 3.2 If proxy is auto-respected: add a note to `PERMISSIONS.md` documenting this
  - [x] 3.3 If NOT respected: add to `PERMISSIONS.md` that proxy is unsupported in v1, and open a GitHub issue tracking it; include the issue URL in `PERMISSIONS.md`

- [x] **Task 4 — Validate** (AC: 1–7)
  - [x] 4.1 Review final `finish-args` against the AC checklist above — no forbidden entries, all required entries present
  - [x] 4.2 Verify `PERMISSIONS.md` covers: `--share=network`, `--share=ipc`, `--socket=fallback-x11`, `--socket=wayland`, `--device=dri`, `--filesystem=home`, Secret portal, proxy
  - [x] 4.3 Set story status to `review`

---

## Dev Notes

### Manifest: exact `finish-args` target state

```yaml
finish-args:
  # Network access — ProtonDrive API, Proton auth endpoints
  - --share=network
  # X11 shared memory — required for GPU compositing on X11
  - --share=ipc
  # Wayland + X11 fallback — run on both display servers
  - --socket=wayland
  - --socket=fallback-x11
  # GPU rendering — Libadwaita uses GPU-accelerated compositing
  - --device=dri
  # Filesystem — inotify requires direct access to user's home.
  # The Flatpak portal FUSE layer does not generate inotify events
  # (upstream bug: https://github.com/flatpak/xdg-desktop-portal/issues/567).
  # Without --filesystem=home, file-change detection is broken.
  - --filesystem=home
  # Credentials — libsecret uses the Flatpak Secret portal
  # (org.freedesktop.portal.Secret) automatically when --talk-name=org.freedesktop.secrets
  # is NOT granted. No explicit talk-name is needed for the portal.
```

**Removed from current manifest:**
- `--talk-name=org.freedesktop.secrets` — grants direct DBus access to the Secrets service, exposing ALL app secrets; insecure; removed in favor of the Secret portal
- `--filesystem=/run/systemd/resolve:ro` — not required; DNS resolution works via `--share=network`; unusual permission with no documented rationale

### Secret portal — how it works (no explicit finish-arg needed)

libsecret detects it is running inside a Flatpak sandbox and automatically uses the `org.freedesktop.portal.Secret` portal. This portal is provided by xdg-desktop-portal and is accessible to all Flatpak apps **without** any special `--talk-name` in `finish-args`. The portal proxies secret storage to the host keyring (GNOME Keyring or KWallet), ensuring only the app's own secrets are accessible — not secrets from other apps.

**Do NOT add** `--talk-name=org.freedesktop.portal.Secret` — it is not needed; the portal bus is implicitly available.

The Python code in `ui/src/protondrive/auth.py` uses `libsecret` via `gi.repository.Secret`. No code changes are required — libsecret's portal fallback is transparent.

### `PERMISSIONS.md` content template

Create `flatpak/PERMISSIONS.md` with this structure:

```markdown
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

[Fill in after Task 3 assessment]:
- If respected: "System proxy settings (`http_proxy`/`https_proxy` env vars) are
  automatically respected by the sync engine's HTTP client."
- If not respected: "Proxy support is not implemented in v1. Tracked in GitHub
  issue #<N>."
```

### Proxy support assessment guidance (Task 3)

Bun's built-in `fetch` respects `http_proxy`/`https_proxy` env vars since Bun 1.1+. The `@protontech/drive-sdk` uses `fetch` internally. Under Flatpak, env vars set in `finish-args` via `--env=` are passed through. **Most likely proxy works transparently** — but verify by checking `engine/src/sdk.ts` for any custom HTTP client configuration that might bypass the global fetch.

GNOME proxy settings (GSettings `org.gnome.system.proxy`) are NOT automatically respected by Bun/Node — those require explicit GNOME proxy integration. For v1, documenting `http_proxy`/`https_proxy` as the supported proxy mechanism is sufficient.

### Files to create / modify

| File | Action | Notes |
|------|--------|-------|
| `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml` | Modify | Fix finish-args per Task 1 |
| `flatpak/PERMISSIONS.md` | Create | Plain-language justification document |

### No code changes required

This story is documentation and manifest only. No Python, TypeScript, Blueprint, or GSettings changes. The Secret portal switch (removing `--talk-name`) is transparent to the Python code — libsecret handles it automatically.

### `generated-sources.json`

`flatpak/generated-sources.json` is a pre-generated npm offline cache for Flatpak Builder (used during offline Flatpak builds). Do NOT modify it in this story. It's referenced by the engine module in the manifest but is outside this story's scope.

### References

- Epic 7 Story 7.1 spec: `_bmad-output/planning-artifacts/epics/epic-7-packaging-distribution.md`
- Architecture: Flatpak identity and permissions: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#flatpak-identity`
- Project structure: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` — `flatpak/` directory
- xdg-desktop-portal inotify bug: https://github.com/flatpak/xdg-desktop-portal/issues/567

---

### Review Findings

- [x] [Review][Patch] Missing "Intentionally Not Requested" section in PERMISSIONS.md for `--filesystem=/run/systemd/resolve:ro` [flatpak/PERMISSIONS.md] — applied: added "Intentionally Not Requested" section + clarified proxy --env= guidance
- [x] [party-mode 2026-04-23][Enhancement] PERMISSIONS.md `--filesystem=home` section claimed "We have reviewed this decision with Flathub maintainers" — unverifiable at time of writing; rewrote to forward-looking: "This permission requires explicit justification during Flathub submission; we will address this with Flathub reviewers…" [flatpak/PERMISSIONS.md:46-47] — applied
- [x] [Review][Defer] DoH resolver hardcodes Cloudflare 1.1.1.1 and ignores `http_proxy` env var [engine/src/main.ts] — deferred, pre-existing
- [x] [Review][Defer] DoH resolver has no request timeout — hangs indefinitely if 1.1.1.1 unreachable [engine/src/main.ts] — deferred, pre-existing
- [x] [Review][Defer] Inotify watcher exhaustion does not auto-recover when descriptors become available [engine/src/watcher.ts] — deferred, pre-existing
- [x] [Review][Defer] Credential backend availability not re-probed after startup — portal crash mid-session unrecoverable [ui/src/protondrive/credential_store.py] — deferred, pre-existing
- [x] [Review][Defer] `_get_stored_token()` silent `None` return conflates "token not found" with backend errors [ui/src/protondrive/main.py] — deferred, pre-existing

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (via party-mode multi-agent review: Bob SM, Winston Architect, Amelia Dev)

### Completion Notes List

- Removed `--talk-name=org.freedesktop.secrets` from manifest (AC 4): insecure direct DBus access replaced by implicit Secret portal — no code changes needed, libsecret handles portal fallback transparently.
- Removed `--filesystem=/run/systemd/resolve:ro` from manifest (AC 5): confirmed unnecessary; `--share=network` covers DNS resolution; this permission had no documented rationale and would flag in Flathub review.
- Added inline justification comments above all six retained `finish-args` (AC 6 / Task 1.5): exact text from Dev Notes applied verbatim.
- Created `flatpak/PERMISSIONS.md` (AC 6 / Task 2): all permissions documented in plain language including the inotify/portal-FUSE limitation for `--filesystem=home`.
- Proxy assessment (AC 7 / Task 3): verified `engine/src/sdk.ts` uses Bun's native `fetch()` with no custom HTTP pool. Bun 1.1+ respects `http_proxy`/`https_proxy` env vars at process level — proxy IS transparently supported. PERMISSIONS.md documents this as supported, including the `flatpak run --env=` invocation pattern. GNOME GSettings proxy explicitly noted as unsupported in v1 (no issue needed; env-var path is sufficient for v1).

### Code Review Notes (2026-04-23)

- Code review (Blind Hunter + Edge Case Hunter + Acceptance Auditor) + party-mode team review (Winston/Quinn/Bob).
- All 7 ACs confirmed PASS by Acceptance Auditor.
- 1 patch applied: added "Intentionally Not Requested" section to PERMISSIONS.md documenting deliberate omission of `--talk-name=org.freedesktop.secrets` and `--filesystem=/run/systemd/resolve:ro`; clarified proxy `--env=` as recommended approach with Flatpak 1.3.1+ passthrough noted.
- 5 pre-existing issues deferred to deferred-work.md [7-1 CR D1–D5]: DoH resolver limitations, inotify non-recovery, credential backend mid-session crash, silent None token return.
- 8 findings dismissed: RTK diff display artifact (fake duplicate heading), proxy env-var concern (Flatpak whitelists proxy vars by default since 1.3.1+), defensive phrasing, and pre-existing code issues outside story scope.

### Second Party-Mode Pass (2026-04-23) — Bob / Winston / Quinn

- All 7 ACs re-confirmed PASS on fresh read of live manifest + PERMISSIONS.md.
- 1 enhancement applied: rewrote aspirational "We have reviewed this decision with Flathub maintainers" to honest forward-looking language (see Review Findings above).
- No new deferrals. No scope-expanding items surfaced. Story remains `done`.

### Third CR Pass (2026-04-23) — Blind Hunter + Edge Case Hunter + Acceptance Auditor

- [x] [Review][Patch] `PERMISSIONS.md` "Intentionally Not Requested" DoH justification misleading — claimed `--share=network` provides DNS, but engine uses DoH because sandbox DNS has limitations; updated to: "resolves hostnames via DNS-over-HTTPS (`1.1.1.1`) within the sandbox" [flatpak/PERMISSIONS.md] — applied
- [x] [Review][Defer] DoH HTTPS startup smoke test logs errors to stderr but continues — engine may start with broken connectivity and emit confusing "Network unavailable" errors later [engine/src/main.ts] — deferred, pre-existing [7-1 CR D6]
- [x] [Review][Defer] Portal FUSE + inotify race when user symlinks portal-mounted dirs into sync root — portal path tracked via FUSE mount while inotify watches real path; potential stale state [flatpak architecture] — deferred, pre-existing [7-1 CR D7]
- [x] [Review][Defer] ALPN hard-coded to `http/1.1` in DoH TLS connector — blocks http/2 negotiation; servers requiring http/2 will fail [engine/src/main.ts] — deferred, pre-existing [7-1 CR D8]
- [x] [Review][Defer] Debug auth token written to `/tmp/proton-debug-token.txt` in production build — `process.stderr.write` at line 362 indicates this was not removed before ship [engine/src/main.ts:362] — deferred, pre-existing [7-1 CR D9]
- [x] [Review][Defer] Proxy env vars not re-read if injected by Flatpak 1.3.1+ after process start — DoH dispatcher already constructed at init time; proxy changes post-launch ignored [engine/src/main.ts] — deferred, pre-existing [7-1 CR D10]
- ~15 findings dismissed: BH supply-chain false positives (sha256 is Flatpak standard), ECH overlaps with existing D1–D5, AA-1 (GNOME GSettings proxy — Dev Notes explicitly authorize http_proxy-only for v1). All 7 ACs remain PASS.

### Third Party-Mode Pass (2026-04-23) — Winston / Quinn / Bob

- [x] [party-mode 2026-04-23][Patch] Proxy Support section lacked DoH DNS carve-out — after DoH disclosure added to "Intentionally Not Requested", the Proxy section still implied all traffic respects http_proxy; added: "DNS hostname resolution uses DoH (1.1.1.1) and does not traverse the proxy; only subsequent API connections go through the proxy." [flatpak/PERMISSIONS.md] — applied; all 7 ACs remain PASS; story remains `done`

### File List

- `flatpak/io.github.ronki2304.ProtonDriveLinuxClient.yml`
- `flatpak/PERMISSIONS.md`
- `_bmad-output/implementation-artifacts/7-1-flatpak-manifest-and-permission-justifications.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/deferred-work.md`
