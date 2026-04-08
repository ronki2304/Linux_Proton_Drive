"""AccountHeaderBar widget displaying user account info and storage usage."""

from __future__ import annotations

from gi.repository import Gtk


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/account-header-bar.ui")
class AccountHeaderBar(Gtk.Box):
    """Displays avatar, account name, and storage bar."""

    __gtype_name__ = "ProtonDriveAccountHeaderBar"

    avatar_label: Gtk.Label = Gtk.Template.Child()
    account_name_label: Gtk.Label = Gtk.Template.Child()
    storage_bar: Gtk.LevelBar = Gtk.Template.Child()
    storage_label: Gtk.Label = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.set_accessible_role(Gtk.AccessibleRole.GROUP)
        self.connect("notify::default-width", self._on_size_changed)

    def _on_size_changed(self, widget: Gtk.Widget, pspec: object) -> None:
        """Hide storage label text when window is narrow (<480px)."""
        allocation = self.get_allocation()
        root = self.get_root()
        if root is not None and hasattr(root, "get_width"):
            width = root.get_width()
        else:
            width = allocation.width
        self.storage_label.set_visible(width >= 480)

    def update_account(
        self,
        display_name: str,
        email: str,
        storage_used: int,
        storage_total: int,
        plan: str,
    ) -> None:
        """Update all account display elements.

        Args:
            display_name: User's display name.
            email: User's email address.
            storage_used: Bytes used.
            storage_total: Total bytes available.
            plan: Account plan name.
        """
        initials = _extract_initials(display_name)
        self.avatar_label.set_text(initials)
        self.account_name_label.set_text(display_name)

        fraction = storage_used / storage_total if storage_total > 0 else 0.0
        self.storage_bar.set_value(min(fraction, 1.0))

        # Apply warning/critical styling
        self._apply_storage_style(fraction, storage_used, storage_total)

        # Accessibility
        used_str = _format_bytes(storage_used)
        total_str = _format_bytes(storage_total)
        self.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [f"Signed in as {display_name}, {used_str} of {total_str} storage used"],
        )

    def _apply_storage_style(
        self, fraction: float, storage_used: int, storage_total: int
    ) -> None:
        """Apply CSS classes based on storage usage thresholds."""
        # Clear previous state classes
        for cls in ("warning", "error"):
            self.storage_bar.remove_css_class(cls)
            self.storage_label.remove_css_class(cls)

        used_str = _format_bytes(storage_used)
        total_str = _format_bytes(storage_total)

        if fraction >= 0.99:
            self.storage_bar.add_css_class("error")
            self.storage_label.add_css_class("error")
            self.storage_label.set_text("Storage full")
        elif fraction >= 0.9:
            self.storage_bar.add_css_class("warning")
            self.storage_label.add_css_class("warning")
            self.storage_label.set_text(f"{used_str} / {total_str}")
        else:
            self.storage_label.set_text(f"{used_str} / {total_str}")


def _extract_initials(name: str) -> str:
    """Extract up to 2 initials from a display name."""
    parts = name.strip().split()
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][0].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _format_bytes(num_bytes: int) -> str:
    """Format bytes as human-readable GB string."""
    gb = num_bytes / (1024 ** 3)
    if gb >= 10:
        return f"{gb:.0f} GB"
    return f"{gb:.1f} GB"
