#!/usr/bin/env bash
#
# Kill all local Paperclip dev server processes (across all worktrees).
#
# Usage:
#   scripts/kill-dev.sh        # kill all paperclip dev processes
#   scripts/kill-dev.sh --dry  # preview what would be killed
#

set -euo pipefail
shopt -s nullglob

DRY_RUN=false
if [[ "${1:-}" == "--dry" || "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"

node_pids=()
node_lines=()
browser_pids=()
browser_lines=()

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pid=$(echo "$line" | awk '{print $2}')
  node_pids+=("$pid")
  node_lines+=("$line")
done < <(ps aux | grep -E '/paperclip(-[^/]+)?/' | grep node | grep -v grep || true)

# --- Agent browser processes (headless Chrome from ~/.agent-browser) ---
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pid=$(echo "$line" | awk '{print $2}')
  browser_pids+=("$pid")
  browser_lines+=("$line")
done < <(ps aux | grep -E 'agent-browser/browsers/chrome-.*/Google Chrome for Testing' | grep -v grep || true)

if [[ ${#node_pids[@]} -eq 0 && ${#browser_pids[@]} -eq 0 ]]; then
  echo "No Paperclip dev processes found."
  exit 0
fi

if [[ ${#node_pids[@]} -gt 0 ]]; then
  echo "Found ${#node_pids[@]} Paperclip dev node process(es):"
  echo ""

  for i in "${!node_pids[@]:-}"; do
    line="${node_lines[$i]}"
    pid=$(echo "$line" | awk '{print $2}')
    start=$(echo "$line" | awk '{print $9}')
    cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')
    cmd=$(echo "$cmd" | sed "s|$HOME/||g")
    printf "  PID %-7s  started %-10s  %s\n" "$pid" "$start" "$cmd"
  done

  echo ""
fi

if [[ ${#browser_pids[@]} -gt 0 ]]; then
  echo "Found ${#browser_pids[@]} agent browser process(es):"
  echo ""

  for i in "${!browser_pids[@]:-}"; do
    line="${browser_lines[$i]}"
    pid=$(echo "$line" | awk '{print $2}')
    start=$(echo "$line" | awk '{print $9}')
    cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')
    cmd=$(echo "$cmd" | sed "s|$HOME/||g")
    printf "  PID %-7s  started %-10s  %s\n" "$pid" "$start" "$cmd"
  done

  echo ""
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run — re-run without --dry to kill these processes."
  exit 0
fi

if [[ ${#node_pids[@]} -gt 0 ]]; then
  echo "Sending SIGTERM to Paperclip node processes..."
  for pid in "${node_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null && echo "  signaled $pid" || echo "  $pid already gone"
  done
  echo "Waiting briefly for node processes to exit..."
  sleep 2
fi

if [[ ${#browser_pids[@]} -gt 0 ]]; then
  echo "Sending SIGTERM to agent browser processes..."
  for pid in "${browser_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null && echo "  signaled $pid" || echo "  $pid already gone"
  done
fi

if [[ ${#node_pids[@]} -gt 0 ]]; then
  for pid in "${node_pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  node $pid still alive, sending SIGKILL..."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

if [[ ${#browser_pids[@]} -gt 0 ]]; then
  for pid in "${browser_pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  agent browser $pid still alive, sending SIGKILL..."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

echo "Done."
