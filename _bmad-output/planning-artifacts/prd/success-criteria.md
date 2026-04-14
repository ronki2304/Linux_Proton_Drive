# Success Criteria

## User Success

- First-run experience completes without terminal use and without reading documentation — user authenticates, selects a folder, and sees sync start within 5 minutes of installing from Flathub
- Sync runs reliably while the app is open — no silent failures; errors surface visibly in the UI
- Conflict copies are created correctly, users are notified in-app, and conflict copies are locatable from the UI without needing a file manager
- Re-authentication flow is clear when session token expires — user is prompted via a visible in-app modal or banner, not left with a stalled sync

## Business Success

- Flathub listing published and passing quality review at v1 launch *(primary gate)*
- Flathub submission submitted before implementation completes; first review response tracked within 2 weeks of submission
- 1,000 Flathub installs within 3 months of stable release *(stretch goal)*
- At least X% of installers have an active sync pair after 7 days *(retention signal — baseline TBD from first-month data)*
- 500 GitHub stars within 6 months
- Active community presence on r/ProtonMail, r/linux, and Proton community forum at launch week
- Community answer shift measurable: this project is the linked answer in the top ProtonDrive Linux threads on Reddit and Proton forum within 6 months
- Project linked from at least one Proton-official knowledge base or status page within 6 months

## Technical Success

- Sync engine language and IPC mechanism decided and documented before implementation begins
- Passes Flathub quality review with correct sandbox permissions justified (static `--filesystem` for inotify, libsecret for credentials)
- Zero critical data loss reports before stable release — conflict copy behaviour verified across real-world conflicting-edit scenarios
- Auth succeeds on Fedora 43, Ubuntu 24/25, Bazzite, Arch — the distros DonnieDice failed on
- Binary builds reproducibly via CI on tag push; no manual release steps

## Measurable Outcomes

- Zero data loss is a hard ongoing requirement post-launch, not just a pre-stable gate
- Flathub install count is the primary adoption signal; 7-day retention rate is the product health signal
- Community answer shift tracked via specific Reddit and Proton forum thread monitoring
