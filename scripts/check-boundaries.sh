#!/usr/bin/env bash
# BOUNDARY RULES ENFORCEMENT
#
# Rules enforced:
#   1. SDK imports (@protontech/drive-sdk) confined to sdk.ts only
#   2. openpgp imports confined to sdk.ts only
#   3. Network I/O in engine confined to sdk.ts only
#   4. Network I/O in UI confined to auth.py (localhost-only callback)
#   5. sdk.ts imports only from errors.ts (one-way dependency)
#   6. ipc.ts does not import from sdk.ts (cross-module isolation)
#   7. errors.ts has zero internal imports (leaf module)
#
# Exit 0 = all checks pass; Exit 1 = violation found

set -euo pipefail

VIOLATIONS=0
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

check() {
  local label="$1"
  shift
  local result
  result=$("$@" 2>/dev/null || true)
  if [ -n "$result" ]; then
    echo "FAIL: $label"
    echo "$result"
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  else
    echo "PASS: $label"
  fi
}

echo "=== SDK Boundary Checks ==="
echo ""

# 1. SDK imports outside sdk.ts
check "No @protontech/drive-sdk imports outside sdk.ts" \
  grep -rn "@protontech/drive-sdk" "$PROJECT_ROOT/engine/src/" \
  --include="*.ts" \
  --exclude="sdk.ts" --exclude="sdk.test.ts"

# 2. openpgp imports outside sdk.ts (catches openpgp and openpgp/lightweight etc.)
check "No openpgp imports outside sdk.ts" \
  grep -rn 'from ["'\''"]openpgp' "$PROJECT_ROOT/engine/src/" \
  --include="*.ts" \
  --exclude="sdk.ts" --exclude="sdk.test.ts"

# 3. Network imports in engine outside sdk.ts
check "No node:http/https imports in engine outside sdk.ts" \
  grep -rn 'import.*"node:http\|import.*'\''node:http' "$PROJECT_ROOT/engine/src/" \
  --include="*.ts" \
  --exclude="sdk.ts" --exclude="sdk.test.ts"

check "No node-fetch imports in engine" \
  grep -rn '"node-fetch"\|'\''node-fetch'\''' "$PROJECT_ROOT/engine/src/" \
  --include="*.ts" \
  --exclude="sdk.ts" --exclude="sdk.test.ts"

check "No axios imports in engine" \
  grep -rn '"axios"\|'\''axios'\''' "$PROJECT_ROOT/engine/src/" \
  --include="*.ts" \
  --exclude="sdk.ts" --exclude="sdk.test.ts"

# 4. Network imports in UI outside auth.py/auth_window.py
# Note: urllib.parse is allowed (local URL parsing, no network I/O)
# Only flag urllib.request and http.client (actual network code)
check "No network library imports in UI outside auth files" \
  grep -rn 'import http\.client\|from http\.client\|import urllib\.request\|from urllib\.request\|import requests\|from requests\|import aiohttp\|from aiohttp\|import httpx\|from httpx' \
  "$PROJECT_ROOT/ui/src/" \
  --include="*.py" \
  --exclude="auth.py" --exclude="auth_window.py"

# 5. sdk.ts one-way dependency (only errors.ts allowed)
check "sdk.ts does not import from disallowed modules" \
  grep -En 'from "./sync-engine|from "./ipc|from "./state-db|from "./conflict|from "./watcher|from "./main' \
  "$PROJECT_ROOT/engine/src/sdk.ts"

# 6. ipc.ts does not import from sdk.ts (check both quote styles)
check "ipc.ts does not import from sdk" \
  grep -En "from [\"']\\./sdk" "$PROJECT_ROOT/engine/src/ipc.ts"

# 7. errors.ts zero internal imports
check "errors.ts has zero internal imports" \
  grep -En 'from "./' "$PROJECT_ROOT/engine/src/errors.ts"

echo ""
if [ "$VIOLATIONS" -gt 0 ]; then
  echo "FAILED: $VIOLATIONS boundary violation(s) found"
  exit 1
else
  echo "ALL BOUNDARY CHECKS PASSED"
  exit 0
fi
