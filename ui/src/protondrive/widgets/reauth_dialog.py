"""ReauthDialog — AdwAlertDialog prompting re-authentication after session expiry."""

from __future__ import annotations

from gi.repository import Adw, Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/reauth-dialog.ui")
class ReauthDialog(Adw.AlertDialog):
    """Modal dialog shown when the engine emits token_expired.

    Displays the count of locally-queued changes and offers a "Sign in"
    button that re-enters the standard WebKitGTK auth flow.

    Heading is set in Blueprint.  Body is set dynamically via
    set_queued_changes() so the [N] count is live.
    """

    __gtype_name__ = "ProtonDriveReauthDialog"

    def set_queued_changes(self, count: int) -> None:
        """Set the dialog body with the live queued-change count."""
        base = (
            "Your Proton session has expired \u2014 this can happen after a "
            "password change or routine token refresh."
        )
        if count == 1:
            tail = "1 local change is waiting to sync. Sign in to resume."
        elif count > 1:
            tail = f"{count} local changes are waiting to sync. Sign in to resume."
        else:
            tail = "Sign in to resume."
        self.set_body(f"{base} {tail}")
