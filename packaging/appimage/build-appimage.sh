#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
APPDIR="$PROJECT_ROOT/AppDir"

# appimagetool: upstream only ships a rolling 'continuous' release with no versioned tags.
# Pin integrity by setting APPIMAGETOOL_SHA256 to the expected sha256sum output.
# To update: curl -sSfL "$APPIMAGETOOL_URL" | sha256sum
# Then set APPIMAGETOOL_SHA256="<that value>" below.
APPIMAGETOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256=""  # TODO: fill in after verifying — see comment above
APPIMAGETOOL="$DIST_DIR/appimagetool"

# Verify input binary exists before building AppDir
if [ ! -f "$DIST_DIR/protondrive" ]; then
  echo "ERROR: $DIST_DIR/protondrive not found — ensure bun build completed successfully" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

# Download appimagetool if not already present
if [ ! -f "$APPIMAGETOOL" ]; then
  echo "Downloading appimagetool..."
  curl -sSfL "$APPIMAGETOOL_URL" -o "$APPIMAGETOOL"
  chmod +x "$APPIMAGETOOL"
fi

# Verify integrity if a SHA256 is configured
if [ -n "$APPIMAGETOOL_SHA256" ]; then
  echo "${APPIMAGETOOL_SHA256}  ${APPIMAGETOOL}" | sha256sum -c || {
    echo "ERROR: appimagetool integrity check failed — delete $APPIMAGETOOL and re-run" >&2
    rm -f "$APPIMAGETOOL"
    exit 1
  }
fi

# Build AppDir structure
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"

# Copy binary
cp "$DIST_DIR/protondrive" "$APPDIR/usr/bin/protondrive"
chmod +x "$APPDIR/usr/bin/protondrive"

# Copy .desktop file
cp "$SCRIPT_DIR/protondrive.desktop" "$APPDIR/protondrive.desktop"

# Create a minimal icon (1x1 PNG placeholder — replace with real icon)
# appimagetool requires an icon; use a minimal one if none provided
ICON_SRC="$SCRIPT_DIR/protondrive.png"
if [ ! -f "$ICON_SRC" ]; then
  # Generate a minimal valid 1x1 PNG (base64-encoded)
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$ICON_SRC"
fi
cp "$ICON_SRC" "$APPDIR/protondrive.png"

# AppRun entrypoint
cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/sh
exec "${APPDIR:?APPDIR not set — run via AppImage runtime}/usr/bin/protondrive" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# Build AppImage
export ARCH=x86_64
"$APPIMAGETOOL" --no-appstream "$APPDIR" "$DIST_DIR/protondrive.AppImage"

echo "AppImage built: $DIST_DIR/protondrive.AppImage"
