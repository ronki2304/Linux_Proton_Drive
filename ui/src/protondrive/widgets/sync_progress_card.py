"""SyncProgressCard widget — shows active sync progress for the selected pair."""

from __future__ import annotations

from gi.repository import GLib, Gtk


def _fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024**2:
        return f"{n / 1024:.1f} KB"
    if n < 1024**3:
        return f"{n / 1024**2:.1f} MB"
    return f"{n / 1024**3:.1f} GB"


@Gtk.Template(resource_path="/io/github/ronki2304/ProtonDriveLinuxClient/ui/sync-progress-card.ui")
class SyncProgressCard(Gtk.Box):
    """Progress card shown during active sync — indeterminate while counting, determinate once total is known."""

    __gtype_name__ = "ProtonDriveSyncProgressCard"

    progress_bar: Gtk.ProgressBar = Gtk.Template.Child()
    count_label: Gtk.Label = Gtk.Template.Child()
    bytes_label: Gtk.Label = Gtk.Template.Child()
    eta_label: Gtk.Label = Gtk.Template.Child()

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._pulsing = False
        self._pulse_timer_id: int | None = None

    def set_counting(self) -> None:
        """Switch to indeterminate (counting) state."""
        self.progress_bar.set_fraction(0.0)
        self.count_label.set_text("Counting files...")
        self.bytes_label.set_text("")
        self.eta_label.set_text("")
        self._pulsing = True
        self._pulse_timer_id = GLib.timeout_add(200, self._pulse)

    def set_progress(
        self,
        files_done: int,
        files_total: int,
        bytes_done: int,
        bytes_total: int,
    ) -> None:
        """Switch to determinate state with known totals."""
        self._cancel_pulse()
        fraction = files_done / files_total if files_total > 0 else 0.0
        self.progress_bar.set_fraction(fraction)
        self.count_label.set_text(f"{files_done} / {files_total} files")
        self.bytes_label.set_text(f"{_fmt_bytes(bytes_done)} / {_fmt_bytes(bytes_total)}")
        self.eta_label.set_text("--")

    def _pulse(self) -> bool:
        if self._pulsing:
            self.progress_bar.pulse()
            return GLib.SOURCE_CONTINUE
        self._pulse_timer_id = None
        return GLib.SOURCE_REMOVE

    def _cancel_pulse(self) -> None:
        self._pulsing = False
        if self._pulse_timer_id is not None:
            GLib.source_remove(self._pulse_timer_id)
            self._pulse_timer_id = None
