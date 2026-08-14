import {
  pluginAgentToolName,
  type PaperclipPluginManifestV1,
  type PluginToolDeclaration,
} from "@paperclipai/shared";

interface PluginAgentToolManifest {
  pluginKey: string;
  manifest: PaperclipPluginManifestV1;
}

export function listAuthorizedPluginAgentTools(
  input: PluginAgentToolManifest,
): readonly PluginToolDeclaration[] {
  if (input.manifest.id !== input.pluginKey) {
    throw new Error(
      `Plugin manifest identity '${input.manifest.id}' does not match installation key '${input.pluginKey}'`,
    );
  }
  if (!input.manifest.capabilities.includes("agent.tools.register")) {
    if ((input.manifest.tools?.length ?? 0) > 0) {
      throw new Error(`Plugin '${input.pluginKey}' declares agent tools without agent.tools.register`);
    }
    return [];
  }
  return input.manifest.tools ?? [];
}

export function pluginManifestDeclaresAgentTool(
  input: PluginAgentToolManifest,
  namespacedToolName: string,
): boolean {
  return listAuthorizedPluginAgentTools(input).some(
    (tool) => pluginAgentToolName(input.pluginKey, tool.name) === namespacedToolName,
  );
}
