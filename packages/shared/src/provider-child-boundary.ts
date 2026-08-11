const PAPERCLIP_PROVIDER_CHILD_RESERVED_SUFFIXES = new Set([
  "AGENT_ID",
  "API_KEY",
  "API_URL",
  "APPROVAL_ID",
  "APPROVAL_STATUS",
  "COMPANY_ID",
  "TASK_ID",
  "TASK_WORK_MODE",
  "LINKED_TASK_IDS",
  "RUN_ID",
  ["T", "ASK"].join("") + "_ID",
  "TOOL_ACTION_SIGNING_SECRET",
  "WAKE_COMMENT_ID",
  "WAKE_PAYLOAD_JSON",
  "WAKE_REASON",
  "WORKSPACE_BRANCH",
  "WORKSPACE_CWD",
  "WORKSPACE_ID",
  "WORKSPACE_REPO_REF",
  "WORKSPACE_REPO_URL",
  "WORKSPACE_SOURCE",
  "WORKSPACE_STRATEGY",
  "WORKSPACE_WORKTREE_PATH",
  "WORKSPACES_JSON",
]);

const SERVER_SECRET_ENV_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "DATABASE_MIGRATION_URL",
  "DATABASE_URL",
]);

/**
 * Exact environment names that are control-plane state, never provider-native
 * configuration. An unrelated operator-authored PAPERCLIP_* name is not
 * reserved: provenance, rather than a prefix, defines this boundary.
 */
export function isProviderChildReservedEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (SERVER_SECRET_ENV_KEYS.has(normalized)) return true;
  if (/^(?:AGENT|PAPERCLIP)[_-]?HOME$/i.test(normalized)) return true;
  const prefix = "PAPERCLIP_";
  return (
    normalized.startsWith(prefix) &&
    PAPERCLIP_PROVIDER_CHILD_RESERVED_SUFFIXES.has(
      normalized.slice(prefix.length),
    )
  );
}
