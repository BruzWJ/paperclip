import type {
  AdapterModel,
  AdapterModelProfileDefinition,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { resolveApprovedAcpLaunch } from "@paperclipai/adapter-utils/acp-subprocess";

const launchProfile = resolveApprovedAcpLaunch("codex");

export function createDeclarativeTestAdapter(input: {
  type: string;
  label?: string;
  models?: readonly AdapterModel[];
  modelProfiles?: readonly AdapterModelProfileDefinition[];
}): ServerAdapterModule {
  const models = input.models ?? [{
    id: `${input.type}-model`,
    label: `${input.type} model`,
    value: `${input.type}-model`,
    limits: {
      contextTokenLimit: 200_000,
      outputTokenLimit: 16_000,
    },
  }];
  const options = models.map((model) => ({
    label: model.label,
    value: model.value,
  }));
  return {
    type: input.type,
    definition: {
      version: "acp-subprocess/v1",
      launchProfile,
      environment: {
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: ["local", "ssh", "sandbox", "plugin"],
        environmentKeys: [],
      },
      readiness: {
        protocolVersion: 1,
        resume: true,
        cancel: true,
        sessionConfig: true,
        sessionScopedMcpReplacement: true,
        cliNativeAuthentication: true,
      },
      ui: {
        label: input.label ?? input.type,
        description: `${input.type} declarative ACP test adapter`,
      },
      configSchema: {
        fields: [{
          key: "model",
          label: "Model",
          type: "select",
          required: true,
          options,
        }],
      },
      configOptions: [{
        id: "model",
        configKey: "model",
        label: "Model",
        required: true,
        values: options,
      }],
      modelConfigOptionId: "model",
      models,
      modelProfiles: input.modelProfiles ?? [],
      configurationDoc: "Authenticate through the target CLI.",
    },
  };
}
