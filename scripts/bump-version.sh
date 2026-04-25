#!/usr/bin/env bash
# Bump all version strings to a new version.
# Usage: ./scripts/bump-version.sh 0.2.0
# Requires: jq (sudo dnf install jq / sudo apt install jq)
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

VERSION="$1"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: invalid version format '$VERSION'. Expected X.Y.Z (e.g. 0.2.0)"
  exit 1
fi

TODAY="$(date +%Y-%m-%d)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# 1. VERSION file
echo "$VERSION" > "$ROOT/VERSION"

# 2. ui/meson.build — first occurrence of version: '...'
sed -i "0,/version: '[^']*'/s/version: '[^']*'/version: '$VERSION'/" "$ROOT/ui/meson.build"
grep -q "version: '$VERSION'" "$ROOT/ui/meson.build" || { echo "ERROR: meson.build version update failed — pattern not found"; exit 1; }

# 3. engine/package.json — "version" field
tmp="$(mktemp)"
trap "rm -f $tmp" EXIT
chmod --reference="$ROOT/engine/package.json" "$tmp"
jq --arg v "$VERSION" '.version = $v' "$ROOT/engine/package.json" > "$tmp"
mv "$tmp" "$ROOT/engine/package.json"

# 4. metainfo.xml — <release version="..." date="..."> (first entry only)
METAINFO="$ROOT/ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml"
sed -i "0,/<release version=\"[^\"]*\" date=\"[^\"]*\">/s/<release version=\"[^\"]*\" date=\"[^\"]*\">/<release version=\"$VERSION\" date=\"$TODAY\">/" \
  "$METAINFO"
grep -q "<release version=\"$VERSION\" date=\"$TODAY\">" "$METAINFO" || { echo "ERROR: metainfo.xml version update failed — pattern not found"; exit 1; }

echo "✓ Bumped to $VERSION (metainfo date: $TODAY)"
echo ""
echo "Next: review changes, then:"
echo "  git add VERSION ui/meson.build engine/package.json ui/data/io.github.ronki2304.ProtonDriveLinuxClient.metainfo.xml"
echo "  git commit -m 'chore: bump version to $VERSION'"
