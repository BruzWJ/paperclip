import {
  resolveApprovedAcpLaunch,
} from "../../../packages/adapter-utils/src/acp-subprocess/index.ts";
import type {
  AdapterModel,
  ServerAdapterModule,
} from "../../../packages/adapter-utils/src/index.ts";

export const type = "example_codex";

const launchProfile = resolveApprovedAcpLaunch("codex");

export const models = Object.freeze([
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
] satisfies readonly AdapterModel[]);

/**
 * A server adapter is immutable data. The common Paperclip ACP client owns
 * process launch, session setup, prompts, cancellation, updates, and cleanup.
 */
export function createServerAdapter(): ServerAdapterModule {
  return Object.freeze({
    type,
    definition: Object.freeze({
      version: "acp-subprocess/v1",
      launchProfile,
      environment: Object.freeze({
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        drivers: Object.freeze(["local", "ssh", "sandbox", "plugin"] as const),
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
        label: "Example Codex definition",
        description: "The approved Codex ACP frontend with declarative metadata.",
      }),
      configSchema: Object.freeze({
        fields: Object.freeze([
          Object.freeze({
            key: "model",
            label: "Model",
            type: "select",
            required: true,
            options: Object.freeze([
              Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
            ]),
          }),
        ]),
      }),
      configOptions: Object.freeze([
        Object.freeze({
          id: "model",
          configKey: "model",
          label: "Model",
          required: true,
          values: Object.freeze([
            Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
          ]),
        }),
      ]),
      modelConfigOptionId: "model",
      models,
      modelProfiles: Object.freeze([]),
      configurationDoc:
        "Install and authenticate Codex through its native CLI before running Paperclip.",
    }),
  });
}
