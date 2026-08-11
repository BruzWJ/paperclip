import { z } from "zod";
import { addValidationDetail } from "../validation-details.js";
import { INBOX_MINE_TASK_STATUS_FILTER } from "../constants.js";
import { envConfigSchema } from "./secret.js";
import { isProviderChildReservedEnvironmentKey } from "../provider-child-boundary.js";

const FORBIDDEN_ADAPTER_BRIDGE_KEYS = new Set([
  "codexhome",
  "cwd",
  "homedir",
  "homedirectory",
  "paperclipagentid",
  "paperclipapikey",
  "paperclipapiurl",
  "paperclipbridge",
  "paperclipcompanyid",
  "papercliprunid",
  "paperclipruntime",
  "paperclipruntimeconfig",
  "paperclipruntimeskills",
  "paperclipruntimeservice",
  "runtimeservice",
  "runtimeservices",
  "runtimeservicesjson",
  "workspaceruntime",
  "workingdirectory",
]);

function normalizedAdapterConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rejectCompanySkillRevisionFields(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectCompanySkillRevisionFields(entry, ctx, [...path, index]),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (
      normalizedAdapterConfigKey(key) === "paperclipskillsync" ||
      normalizedAdapterConfigKey(key) === "companyskillpins"
    ) {
      addValidationDetail(ctx, {
        message: "Company skill pins belong only to the immutable ACP revision",
        path: entryPath,
      });
      continue;
    }
    rejectCompanySkillRevisionFields(entry, ctx, entryPath);
  }
}

function rejectAdapterBridgeFields(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectAdapterBridgeFields(entry, ctx, [...path, index]),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const record = value as Record<string, unknown>;
  const parentKey = typeof path.at(-1) === "string" ? String(path.at(-1)) : "";
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = normalizedAdapterConfigKey(key);
    const isEnvironmentEntry = parentKey.toLowerCase() === "env";
    if (
      (FORBIDDEN_ADAPTER_BRIDGE_KEYS.has(normalizedKey) &&
        !(isEnvironmentEntry && key === "CODEX_HOME")) ||
      /^paperclip(?:api|bridge|runtime)/.test(normalizedKey) ||
      /^(?:agent|managed)home(?:dir|directory|path)?$/.test(normalizedKey)
    ) {
      addValidationDetail(ctx, {
        message: `Adapter configuration field is server-owned or forbidden: ${key}`,
        path: [...path, key],
      });
      continue;
    }
    if (isEnvironmentEntry && isProviderChildReservedEnvironmentKey(key)) {
      addValidationDetail(ctx, {
        message: `Adapter environment cannot contain control-plane state: ${key}`,
        path: [...path, key],
      });
      continue;
    }
    rejectAdapterBridgeFields(entry, ctx, [...path, key]);
  }
}

const providerAdapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue !== undefined) {
    const parsed = envConfigSchema.safeParse(envValue);
    if (!parsed.success) {
      addValidationDetail(ctx, {
        message: "adapterConfig.env must be a map of valid env bindings",
        path: ["env"],
      });
    }
  }
  rejectAdapterBridgeFields(value, ctx);
});

export const adapterConfigSchema = providerAdapterConfigSchema.superRefine((value, ctx) => {
  rejectCompanySkillRevisionFields(value, ctx);
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: providerAdapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  /**
   * Raw runtime transport limits. These are not model capabilities and remain
   * separate from the immutable catalog descriptor captured in a revision.
   */
  runtimeFlags: z.object({
    outputTokenMax: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  rejectCompanySkillRevisionFields(value, ctx);
});

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_TASK_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;
