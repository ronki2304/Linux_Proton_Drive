#!/usr/bin/env bash
# Epic pipeline — two-phase autonomous story execution.
#
# Phase 1 (prep): SM → create-story → validate (party mode, autonomous)
# Human checkpoint: review story files in _bmad-output/implementation-artifacts/
# Phase 2 (dev):  dev review → DS → CR (party mode, autonomous) → commit
#
# Both party-mode steps (validate + CR) resolve ALL findings autonomously —
# they never halt to ask which fixes to apply.
#
# Usage:
#   ./scripts/epic-pipeline.sh phase1   6-1 6-2 6-3 6-4
#   ./scripts/epic-pipeline.sh phase2   6-1 6-2 6-3 6-4
#   ./scripts/epic-pipeline.sh summary  6-1 6-2 6-3 6-4  # status table + commit lines + CR insights
#   ./scripts/epic-pipeline.sh all      6-1 6-2 6-3 6-4  # phase1 + phase2 + summary
#
# Stories are identified by their ID (e.g. "6-1"), matching sprint-status.yaml keys.

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
  find "$STORIES_DIR" -maxdepth 1 -name "${story}-*.md" | head -1
}

# Abort if any [ ] items remain in the story file — both validate and CR must be clean.
check_resolved() {
  local sf="$1"
  local step="$2"
  # Only flag unresolved review findings — implementation task checkboxes stay [ ] until DS runs.
  if grep -qP '^\- \[ \] \[Review\]' "$sf" 2>/dev/null; then
    log "ERROR: unresolved [Review] findings in $(basename "$sf") after $step — aborting"
    grep -P '^\- \[ \] \[Review\]' "$sf" | head -10
    exit 1
  fi
}

# ──────────────────────────────────────────────
# Phases
# ──────────────────────────────────────────────

phase1() {
  local stories=("$@")
  log "=== PHASE 1: story prep (SM → create-story → validate) ==="
  for story in "${stories[@]}"; do
    log "--- Story $story ---"

    run_claude "sm" "$story" \
      "/bmad-agent-sm CS code $story"

    run_claude "create" "$story" \
      "/bmad-create-story $story"

    local sf
    sf=$(story_file "$story")

    run_claude "validate" "$story" \
      "/bmad-party-mode validate story $sf —
      Resolve ALL findings autonomously. Do not present a menu or ask the user which
      fixes to apply — make the call yourself. Apply every critical and enhancement.
      For decisions between options, pick the best option and document your rationale
      in the story file. Defer scope-expanding items with a TODO comment and a
      deferred-work.md entry. Every finding must be marked [x] before you return."

    check_resolved "$sf" "validate"
  done
  log "=== PHASE 1 DONE ==="
  log ""
  log "Review story files:"
  for story in "${stories[@]}"; do
    local f
    f=$(story_file "$story")
    log "  ${f:-[missing: $story]}"
  done
}

summary() {
  local stories=("$@")
  local phases=(sm create validate dev ds cr commit)
  local all_done=true

  printf "\n%-12s" "STORY"
  for p in "${phases[@]}"; do printf "%-10s" "$p"; done
  echo ""
  printf "%-12s" "─────────"
  for p in "${phases[@]}"; do printf "%-10s" "─────────"; done
  echo ""

  for story in "${stories[@]}"; do
    printf "%-12s" "$story"
    for phase in "${phases[@]}"; do
      local f="$LOG_DIR/${story}-${phase}.log"
      if [ -f "$f" ] && [ -s "$f" ]; then
        printf "%-10s" "✅"
      else
        printf "%-10s" "❌"
        all_done=false
      fi
    done
    echo ""
  done
  echo ""

  echo "=== COMMIT LINES ==="
  for story in "${stories[@]}"; do
    local f="$LOG_DIR/${story}-commit.log"
    if [ -f "$f" ] && [ -s "$f" ]; then
      echo "  [$story] $(cat "$f" | tr -d '\n')"
    else
      echo "  [$story] no commit log"
    fi
  done

  echo ""
  echo "=== KEY INSIGHTS ==="
  for story in "${stories[@]}"; do
    local cr="$LOG_DIR/${story}-cr.log"
    if [ -f "$cr" ] && [ -s "$cr" ]; then
      echo "  [$story CR] $(tail -3 "$cr" | grep -v '^$' | head -1)"
    fi
  done
  echo ""

  if $all_done; then
    log "All phases complete for stories: ${stories[*]}"
  else
    log "WARNING: some phases are missing — check logs in $LOG_DIR"
  fi
}

phase2() {
  local stories=("$@")
  log "=== PHASE 2: implementation (dev review → DS → CR → commit) ==="
  for story in "${stories[@]}"; do
    log "--- Story $story ---"

    local sf
    sf=$(story_file "$story")

    # Dev agent reads the story and flags any blockers before DS touches code.
    run_claude "dev" "$story" \
      "/bmad-agent-dev review story $sf —
      Read the story thoroughly. Identify any blockers, ambiguities, or missing
      implementation context that would prevent a clean DS run. If the story is
      clear and ready, confirm READY. If there are genuine blockers, list them
      explicitly so the pipeline can be reviewed before proceeding."

    run_claude "ds" "$story" \
      "/bmad-agent-dev DS $story"

    run_claude "cr" "$story" \
      "/bmad-agent-dev CR $story —
      After the review, run /bmad-party-mode for team review and apply ALL findings
      autonomously. Apply patches unconditionally. For decisions between options,
      pick the best option and document your rationale in the story file. Do not
      present a menu or ask the user which fixes to apply — make the call. Defer
      scope-expanding items with a TODO comment and a deferred-work.md entry.
      Every finding must be marked [x] before you return."

    sf=$(story_file "$story")
    check_resolved "$sf" "cr"

    run_claude "commit" "$story" \
      "commit and push story $story"
  done
  log "=== PHASE 2 DONE ==="
}

# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────

MODE="${1:-}"
shift || true
STORIES=("$@")

if [[ ${#STORIES[@]} -eq 0 ]]; then
  echo "Usage: $0 <phase1|phase2|all> <story-id> [story-id ...]"
  echo "  Example: $0 all 6-1 6-2 6-3 6-4"
  exit 1
fi

case "$MODE" in
  phase1) phase1 "${STORIES[@]}" ;;
  phase2) phase2 "${STORIES[@]}" ;;
  summary) summary "${STORIES[@]}" ;;
  all)
    phase1 "${STORIES[@]}"
    phase2 "${STORIES[@]}"
    summary "${STORIES[@]}"
    ;;
  *)
    echo "Unknown mode: $MODE. Use phase1, phase2, all, or summary."
    exit 1
    ;;
esac
