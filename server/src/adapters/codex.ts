import {
  type AdapterModel,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { resolveApprovedAcpLaunch } from "@paperclipai/adapter-utils/acp-subprocess";

const launchProfile = resolveApprovedAcpLaunch("codex");

export const codexModels = Object.freeze([
  Object.freeze({
    id: "gpt-5.6",
    label: "GPT-5.6",
    value: "gpt-5.6",
    limits: Object.freeze({
      contextTokenLimit: 1_050_000,
      inputTokenLimit: 922_000,
      outputTokenLimit: 128_000,
    }),
  }),
  Object.freeze({
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    value: "gpt-5.6-sol",
    limits: Object.freeze({
      contextTokenLimit: 1_050_000,
      inputTokenLimit: 922_000,
      outputTokenLimit: 128_000,
    }),
  }),
] satisfies readonly AdapterModel[]);

/**
 * Paperclip's first conformance-approved adapter is data only. The common ACP
 * worker resolves, launches, configures, and speaks to this frontend.
 */
export const codexAdapter = Object.freeze({
  type: "codex",
  definition: Object.freeze({
    version: "acp-subprocess/v1",
    launchProfile,
    environment: Object.freeze({
      cwd: "execution-workspace",
      additionalDirectories: "authorized-workspace-only",
      drivers: Object.freeze(
        ["local", "ssh", "sandbox", "plugin"] as const,
      ),
      environmentKeys: Object.freeze([]),
    }),
    readiness: Object.freeze({
      protocolVersion: 1,
      resume: true,
      cancel: true,
      sessionConfig: true,
      sessionScopedMcpReplacement: true,
      cliNativeAuthentication: true,
    }),
    ui: Object.freeze({
      label: "Codex",
      description:
        "Codex through the pinned upstream ACP frontend and the CLI's native authentication.",
      recommended: true,
    }),
    configSchema: Object.freeze({
      fields: Object.freeze([
        Object.freeze({
          key: "model",
          label: "Model",
          type: "select",
          required: true,
          options: Object.freeze(
            codexModels.map((model) =>
              Object.freeze({ label: model.label, value: model.value }),
            ),
          ),
          hint: "Exact model value advertised by the Codex ACP session.",
        }),
      ]),
    }),
    configOptions: Object.freeze([
      Object.freeze({
        id: "model",
        configKey: "model",
        label: "Model",
        required: true,
        values: Object.freeze(
          codexModels.map((model) =>
            Object.freeze({ label: model.label, value: model.value }),
          ),
        ),
      }),
    ]),
    modelConfigOptionId: "model",
    models: codexModels,
    modelProfiles: Object.freeze([]),
    configurationDoc:
      "Install and authenticate Codex with its native CLI flow. Paperclip stores no AI credential and sends model selection through stable ACP session configuration.",
  }),
} satisfies ServerAdapterModule);
