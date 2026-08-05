import type {
  PaperclipPluginManifestV1,
  PluginToolDeclaration,
} from "@paperclipai/shared";

export interface PluginAgentToolManifest {
  pluginKey: string;
  manifest: PaperclipPluginManifestV1;
}

export function listAuthorizedPluginAgentTools(
  input: PluginAgentToolManifest,
): readonly PluginToolDeclaration[] {
  if (
    input.manifest.id !== input.pluginKey ||
    !input.manifest.capabilities.includes("agent.tools.register")
  ) {
    return [];
  }
  return input.manifest.tools ?? [];
}

export function pluginManifestDeclaresAgentTool(
  input: PluginAgentToolManifest,
  namespacedToolName: string,
): boolean {
  return listAuthorizedPluginAgentTools(input).some(
    (tool) => `${input.pluginKey}:${tool.name}` === namespacedToolName,
  );
}
