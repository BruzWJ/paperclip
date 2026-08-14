import { Readable as ReadableImport } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type CompanyPortabilityFileEntry,
} from "@paperclipai/shared";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { testSecretsRuntimeConfig } from "./helpers/secrets-runtime.js";
export const Readable = ReadableImport;
export const companySvc = {
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const agentSvc = {
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const runtimeAgentConfigurationSvc = {
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const adapterConfigurationSvc = {
  createRevision: vi.fn(),
};

export const operationalConfigurationSvc = {
  update: vi.fn(),
};

export const preflightAdapterConfiguration = vi.fn();

export const accessSvc = {
  ensureMembership: vi.fn(),
  stampRoleGrants: vi.fn(),
  listActiveUserMemberships: vi.fn(),
  copyActiveUserMemberships: vi.fn(),
  setPrincipalPermission: vi.fn(),
};

export const projectSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const taskSvc = {
  list: vi.fn(),
  listComments: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
};

export const ordinaryTaskRuntime = {
  create: vi.fn(),
};

export const taskSessionProducers = {
  appendCanonicalControlNotice: vi.fn(),
  appendCanonicalUserComment: vi.fn(),
};

export const routineSvc = {
  list: vi.fn(),
  getDetail: vi.fn(),
  create: vi.fn(),
  createTrigger: vi.fn(),
};

export const assetSvc = {
  getById: vi.fn(),
  create: vi.fn(),
};

export const secretSvc = {
  create: vi.fn(async () => ({ id: "secret-created" })),
  remove: vi.fn(async () => true),
  normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
  syncEnvBindingsForTarget: vi.fn(async () => []),
};

vi.mock("../services/companies.js", () => ({
  companyService: () => companySvc,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => agentSvc,
}));

vi.mock("../services/runtime-agent-configuration.js", () => ({
  createRuntimeAgentConfigurationService: () => runtimeAgentConfigurationSvc,
}));

vi.mock("../services/agent-adapter-config-revisions.js", () => ({
  createAgentAdapterConfigurationService: () => adapterConfigurationSvc,
  validateRegisteredAdapterRuntimeConfiguration: preflightAdapterConfiguration,
}));

vi.mock("../services/agent-operational-configuration.js", () => ({
  createAgentOperationalConfigurationService: () => operationalConfigurationSvc,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => accessSvc,
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => projectSvc,
}));

vi.mock("../services/tasks.js", () => ({
  taskService: () => taskSvc,
}));

vi.mock("../services/ordinary-task-runtime.js", () => ({
  createOrdinaryTaskRuntime: () => ordinaryTaskRuntime,
}));

vi.mock("../services/task-session-producers.js", () => taskSessionProducers);

vi.mock("../services/routines.js", () => ({
  routineService: () => routineSvc,
}));

vi.mock("../services/assets.js", () => ({
  assetService: () => assetSvc,
}));

vi.mock("../services/secrets.js", async () => {
  const actual = await vi.importActual<typeof import("../services/secrets.js")>("../services/secrets.js");
  return {
    ...actual,
    secretService: () => secretSvc,
  };
});

vi.mock("../routes/org-chart-svg.js", () => ({
  renderOrgChartPng: vi.fn(async () => Buffer.from("png")),
}));

const { companyPortabilityService: createCompanyPortabilityService } =
  await import("../services/company-portability.js");

export const testBoardAuthorization = testBoardSessionActor({
  userId: "user-1",
  companyIds: ["company-1"],
});

export const SOURCE_ADAPTER_REVISION_ID = "11111111-1111-4111-8111-111111111111";
export const FALLBACK_SELECTED_ID = "31111111-1111-4111-8111-111111111111";

export function sourceAcpConfiguration() {
  const model = "gpt-5.6";
  return {
    contractVersion: "acpx-runtime/v1" as const,
    launchProfile: {
      registryName: "codex",
    },
    sessionConfigSelections: [{ configId: "model", value: model }],
    model: {
      value: model,
      label: model,
    },
  };
}

export async function sourceAdapterRevisionRows() {
  const listedAgents = await agentSvc.list();
  return listedAgents
    .filter((agent: Record<string, any>) => typeof agent.currentAdapterConfigRevisionId === "string")
    .map((agent: Record<string, any>) => ({
      id: agent.currentAdapterConfigRevisionId,
      companyId: agent.companyId ?? "company-1",
      agentId: agent.id,
      acpConfiguration: sourceAcpConfiguration(),
    }));
}

export function canonicalAgentExtensionYaml(indent = "    ", adapterType = "codex") {
  return [
    `${indent}adapterRevision:`,
    `${indent}  sourceRevisionId: "${SOURCE_ADAPTER_REVISION_ID}"`,
    `${indent}  acpConfiguration:`,
    `${indent}    contractVersion: "acpx-runtime/v1"`,
    `${indent}    launchProfile:`,
    `${indent}      registryName: "${adapterType}"`,
    `${indent}    sessionConfigSelections:`,
    `${indent}      - configId: "model"`,
    `${indent}        value: "gpt-5.6"`,
    `${indent}    model:`,
    `${indent}      value: "gpt-5.6"`,
    `${indent}      label: "GPT-5.6"`,
    `${indent}contextGrants:`,
    ...AGENT_CONTEXT_GRANT_KEYS.map((key) => `${indent}  ${key}: false`),
    `${indent}actionGrants:`,
    ...PAPERCLIP_ACTION_KEYS.map((key) => `${indent}  ${key}: false`),
    `${indent}mentionReachGrants:`,
    ...AGENT_MENTION_REACH_GRANT_KEYS.map((key) => `${indent}  ${key}: false`),
    `${indent}budgetMonthlyAmount: "0"`,
  ];
}

export function canonicalCompanyExtensionYaml(indent = "") {
  return [`${indent}company:`, `${indent}  budgetCurrency: "USD"`, `${indent}  budgetMonthlyAmount: "0"`];
}

export const AGENTS_ONLY_INCLUDE = {
  company: true,
  agents: true,
  projects: false,
  tasks: false,
};

export function inlineSource(exported: { rootPath: string; files: CompanyPortabilityFileEntry[] }) {
  return {
    type: "inline" as const,
    rootPath: exported.rootPath,
    files: exported.files,
  };
}

export function companyPortabilityService(
  db: Parameters<typeof createCompanyPortabilityService>[0],
  storage?: Parameters<typeof createCompanyPortabilityService>[1],
) {
  const effectiveDb =
    typeof (db as { select?: unknown })?.select === "function"
      ? db
      : ({
          select: (selection?: Record<string, unknown>) => ({
            from: () => ({
              where: async () => {
                if (selection && "principalId" in selection) return [];
                if (selection === undefined) {
                  return sourceAdapterRevisionRows();
                }
                return [{ id: FALLBACK_SELECTED_ID }];
              },
            }),
          }),
        } as unknown as Parameters<typeof createCompanyPortabilityService>[0]);
  const portability = createCompanyPortabilityService(
    effectiveDb,
    storage,
    ordinaryTaskRuntime as Parameters<typeof createCompanyPortabilityService>[2],
    testSecretsRuntimeConfig(),
  );
  return {
    ...portability,
    importBundle(
      input: Parameters<typeof portability.importBundle>[0],
      actorUserId: Parameters<typeof portability.importBundle>[1],
      options?: Parameters<typeof portability.importBundle>[2],
    ) {
      return portability.importBundle(input, actorUserId, {
        authorizationActor: testBoardAuthorization,
        secretMutationActor: actorUserId ? { type: "user", userId: actorUserId } : { type: "system" },
        ...options,
      });
    },
  };
}

export function asTextFile(entry: CompanyPortabilityFileEntry | undefined) {
  expect(typeof entry).toBe("string");
  return typeof entry === "string" ? entry : "";
}

export function fullFalseGrantMap(keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, false]));
}

export function codexTargetAdapter() {
  return {
    adapterType: "codex",
    adapterConfig: {
      model: "gpt-5.6",
    },
  };
}

export { beforeEach, describe, expect, it, vi, AGENT_CONTEXT_GRANT_KEYS };
export { AGENT_MENTION_REACH_GRANT_KEYS, PAPERCLIP_ACTION_KEYS, testBoardSessionActor };
export { testSecretsRuntimeConfig, createCompanyPortabilityService };
export type { CompanyPortabilityFileEntry };
