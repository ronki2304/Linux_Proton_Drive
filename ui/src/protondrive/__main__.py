"""Entry point for `python -m protondrive`."""
import os

# WebKit environment flags — must precede every GI import so WebKit reads them
# before initialising its renderer process.
#
# WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: bubblewrap sandbox is incompatible
#   with Bazzite/Silverblue kernel restrictions; Flatpak provides its own sandbox.
# WEBKIT_DISABLE_DMABUF_RENDERER: the DMA-BUF renderer (default since 2.42)
#   creates a separate EGL surface whose Wayland input region is not registered,
#   causing pointer events to be swallowed on KDE/KWin Wayland sessions.
# WEBKIT_DISABLE_COMPOSITING_MODE: disables the nested Wayland compositor used
#   for accelerated compositing, guaranteeing the WebView renders as a plain GTK
#   widget that receives pointer events through the normal GTK event chain.
os.environ["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"
os.environ["WEBKIT_DISABLE_DMABUF_RENDERER"] = "1"
os.environ["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"

from gi.repository import Gio

# Register the GResource bundle before any @Gtk.Template decorator fires.
# The bundle is built by meson into builddir/ and installed alongside the
# package. For development runs, PROTONDRIVE_RESOURCE_PATH can point to the
# builddir .gresource file directly.
_resource_path = os.environ.get(
    "PROTONDRIVE_RESOURCE_PATH",
    os.path.join(os.path.dirname(__file__), "protondrive-resources.gresource"),
)
if os.path.exists(_resource_path):
    Gio.Resource.load(_resource_path)._register()

from protondrive.main import main

raise SystemExit(main())
