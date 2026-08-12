export type ProjectPluginTab = `plugin:${string}:${string}`;

export const PROJECT_PLUGIN_TAB_PATTERN =
  /^plugin:[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;

export function isProjectPluginTab(
  value: string | null | undefined,
): value is ProjectPluginTab {
  return typeof value === "string" && PROJECT_PLUGIN_TAB_PATTERN.test(value);
}
