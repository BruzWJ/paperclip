#!/usr/bin/env bash
set -euo pipefail

worktree_cwd="$(pwd -P)"
git_common_dir="$(git -C "$worktree_cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "Worktree provisioning requires a git checkout: $worktree_cwd" >&2
  exit 1
}

if [[ ! -f "$worktree_cwd/.git" ]]; then
  echo "Worktree provisioning is only valid in a linked git worktree." >&2
  exit 1
fi

worktree_database_url="${PAPERCLIP_WORKTREE_DATABASE_URL:-}"
if [[ -z "$worktree_database_url" ]]; then
  echo "PAPERCLIP_WORKTREE_DATABASE_URL must name an explicit external PostgreSQL database." >&2
  exit 1
fi

primary_cwd="$(git -C "$worktree_cwd" worktree list --porcelain | awk '/^worktree / { print substr($0, 10); exit }')"
if [[ -z "$primary_cwd" ]]; then
  echo "Unable to resolve the primary checkout for parent verification." >&2
  exit 1
fi

parent_config_path="${PAPERCLIP_CONFIG:-$primary_cwd/.paperclip/config.json}"
parent_env_path="$(dirname "$parent_config_path")/.env"
if [[ ! -f "$parent_config_path" || ! -f "$parent_env_path" ]]; then
  echo "The primary Paperclip config and adjacent env must exist before worktree creation." >&2
  exit 1
fi

worktree_name="$(git -C "$worktree_cwd" branch --show-current)"
worktree_name="${worktree_name:-$(basename "$worktree_cwd")}"

run_creation() {
  if [[ -f "$worktree_cwd/package.json" && -f "$worktree_cwd/pnpm-lock.yaml" ]]; then
    (
      cd "$worktree_cwd"
      PAPERCLIP_CONFIG="$parent_config_path" \
        pnpm paperclipai worktree init \
          --name "$worktree_name" \
          --database-url "$worktree_database_url"
    )
    return
  fi
  if command -v paperclipai >/dev/null 2>&1; then
    (
      cd "$worktree_cwd"
      PAPERCLIP_CONFIG="$parent_config_path" \
        paperclipai worktree init \
          --name "$worktree_name" \
          --database-url "$worktree_database_url"
    )
    return
  fi
  echo "paperclipai CLI is required for worktree provisioning." >&2
  exit 1
}

run_creation

echo "Configured Paperclip worktree state for its external database."
echo "The pinned target and secret are stored in .paperclip/.env (mode 0600)."
