"""Settings page with account info, storage usage, and logout."""

from __future__ import annotations

from typing import Any, Callable

from gi.repository import Adw, Gdk, Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/settings.ui")
class SettingsPage(Adw.Bin):
    """Settings page displaying account details and logout option."""

    __gtype_name__ = "ProtonDriveSettingsPage"

    display_name_row: Adw.ActionRow = Gtk.Template.Child()
    email_row: Adw.ActionRow = Gtk.Template.Child()
    plan_row: Adw.ActionRow = Gtk.Template.Child()
    storage_row: Adw.ActionRow = Gtk.Template.Child()
    storage_bar: Gtk.LevelBar = Gtk.Template.Child()
    storage_label: Gtk.Label = Gtk.Template.Child()
    manage_account_row: Adw.ActionRow = Gtk.Template.Child()
    logout_button: Gtk.Button = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._logout_callback: Callable[[], None] | None = None

        self.manage_account_row.connect("activated", self._on_manage_account)
        self.logout_button.connect("clicked", self._on_logout_clicked)

    def set_logout_callback(self, callback: Callable[[], None]) -> None:
        """Set callback for logout action. Called by window.py."""
        self._logout_callback = callback

    def update_account(
        self,
        display_name: str,
        email: str,
        storage_used: int,
        storage_total: int,
        plan: str,
    ) -> None:
        """Populate account fields from session_ready data."""
        self.display_name_row.set_subtitle(display_name)
        self.email_row.set_subtitle(email)
        self.plan_row.set_subtitle(plan)

        fraction = storage_used / storage_total if storage_total > 0 else 0.0
        self.storage_bar.set_value(min(fraction, 1.0))

        self._apply_storage_style(fraction, storage_used, storage_total)

    def _apply_storage_style(
        self, fraction: float, storage_used: int, storage_total: int
    ) -> None:
        """Apply warning/critical CSS classes to storage bar."""
        ctx = self.storage_bar.get_style_context()
        label_ctx = self.storage_label.get_style_context()

        for cls in ("warning", "error"):
            ctx.remove_class(cls)
            label_ctx.remove_class(cls)

        used_str = _format_bytes(storage_used)
        total_str = _format_bytes(storage_total)

        if fraction > 0.99:
            ctx.add_class("error")
            label_ctx.add_class("error")
            self.storage_label.set_text("Storage full")
        elif fraction > 0.9:
            ctx.add_class("warning")
            label_ctx.add_class("warning")
            self.storage_label.set_text(f"{used_str} / {total_str}")
        else:
            self.storage_label.set_text(f"{used_str} / {total_str}")

    def _on_manage_account(self, row: Adw.ActionRow) -> None:
        """Open Proton account management in system browser."""
        root = self.get_root()
        Gtk.show_uri(root, "https://account.proton.me", Gdk.CURRENT_TIME)

    def _on_logout_clicked(self, button: Gtk.Button) -> None:
        """Show logout confirmation dialog."""
        dialog = Adw.AlertDialog(
            heading="Sign out?",
            body=(
                "Sign out of your Proton account? Your synced local files "
                "will not be deleted. You will need to sign in again to "
                "resume sync."
            ),
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("sign-out", "Sign out")
        dialog.set_response_appearance(
            "sign-out", Adw.ResponseAppearance.DESTRUCTIVE
        )
        dialog.set_response_appearance(
            "cancel", Adw.ResponseAppearance.SUGGESTED
        )
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        dialog.connect("response", self._on_logout_response)
        dialog.present(self.get_root())

    def _on_logout_response(self, dialog: Adw.AlertDialog, response: str) -> None:
        """Handle logout dialog response."""
        if response == "sign-out" and self._logout_callback is not None:
            self._logout_callback()


def _format_bytes(num_bytes: int) -> str:
    """Format bytes as human-readable GB string."""
    gb = num_bytes / (1024 ** 3)
    if gb >= 10:
        return f"{gb:.0f} GB"
    return f"{gb:.1f} GB"
