#!/usr/bin/env bash
# Epic pipeline — two-phase autonomous story execution.
#
# Phase 1 (prep): SM → create-story → validate   (generates all .md story files)
# Human checkpoint: review story files in _bmad-output/implementation-artifacts/
# Phase 2 (dev):  DS → CR                         (implements + reviews each story)
#
# Usage:
#   ./scripts/epic-pipeline.sh phase1 5-3 5-4 5-5 5-6
#   ./scripts/epic-pipeline.sh phase2 5-3 5-4 5-5 5-6
#   ./scripts/epic-pipeline.sh all    5-3 5-4 5-5    # phase1 + human prompt + phase2
#
# Stories are identified by their ID (e.g. "5-3"), matching sprint-status.yaml keys.

set -euo pipefail

STORIES_DIR="_bmad-output/implementation-artifacts"
LOG_DIR=".claude/pipeline-logs"
mkdir -p "$LOG_DIR"

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

log() { echo "[$(date +%H:%M:%S)] $*"; }

run_claude() {
  local label="$1"
  local story="$2"
  local prompt="$3"
  local logfile="$LOG_DIR/${story}-${label}.log"

  log "▶ $label — story $story"
  # --print runs non-interactively; context is fresh per invocation (equivalent to /clear)
  claude --dangerously-skip-permissions --print "$prompt" 2>&1 | tee "$logfile"
  log "✓ $label — story $story (log: $logfile)"
}

story_file() {
  local story="$1"
  # Find the .md file whose name starts with the story ID
  find "$STORIES_DIR" -maxdepth 1 -name "${story}-*.md" | head -1
}

# ──────────────────────────────────────────────
# Phases
# ──────────────────────────────────────────────

phase1() {
  local stories=("$@")
  log "=== PHASE 1: story prep (SM → create-story → validate) ==="
  for story in "${stories[@]}"; do
    log "--- Story $story ---"
    run_claude "sm"       "$story" "/bmad-agent-sm CS code $story"
    run_claude "create"   "$story" "/bmad-create-story please validate $story — after validation, run /bmad-party-mode for team validation and apply the consensus"
  done
  log "=== PHASE 1 DONE ==="
  log ""
  log "Review story files:"
  for story in "${stories[@]}"; do
    local f
    f=$(story_file "$story")
    if [[ -n "$f" ]]; then
      log "  $f"
    else
      log "  (no file found for $story)"
    fi
  done
}

phase2() {
  local stories=("$@")
  log "=== PHASE 2: implementation (DS → CR) ==="
  for story in "${stories[@]}"; do
    log "--- Story $story ---"
    run_claude "ds" "$story" "/bmad-agent-dev DS $story"
    run_claude "cr" "$story" "/bmad-agent-dev CR $story — after the review, run /bmad-party-mode for team validation and apply the consensus"
    run_claude "" "" "rtk git commit and push"
  done
  log "=== PHASE 2 DONE ==="
}

human_checkpoint() {
  local stories=("$@")
  echo ""
  echo "┌─────────────────────────────────────────────────┐"
  echo "│  CHECKPOINT — review story files before phase 2  │"
  echo "└─────────────────────────────────────────────────┘"
  for story in "${stories[@]}"; do
    local f
    f=$(story_file "$story")
    echo "  ${f:-[missing: $story]}"
  done
  echo ""
  read -rp "Continue to phase 2? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { log "Aborted by user."; exit 0; }
}

# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────

MODE="${1:-}"
shift || true
STORIES=("$@")

if [[ ${#STORIES[@]} -eq 0 ]]; then
  echo "Usage: $0 <phase1|phase2|all> <story-id> [story-id ...]"
  echo "  Example: $0 all 5-3 5-4 5-5"
  exit 1
fi

case "$MODE" in
  phase1) phase1 "${STORIES[@]}" ;;
  phase2) phase2 "${STORIES[@]}" ;;
  all)
    phase1 "${STORIES[@]}"
    phase2 "${STORIES[@]}"
    ;;
  *)
    echo "Unknown mode: $MODE. Use phase1, phase2, or all."
    exit 1
    ;;
esac
