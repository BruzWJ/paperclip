import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentAdapterConfigRevisions,
  agents,
  companySkills,
  companySkillVersions,
} from "@paperclipai/db";
import {
  validationDetails,
  adapterConfigSchema,
  agentAdapterAcpConfigurationSchema,
  agentCompanySkillPinsUpdateSchema,
  agentAdapterRevisionConfigurationSchema,
  isAdapterImplementationIdentity,
  parseCompanySkillPins,
  type AdapterImplementationIdentity,
  type AgentAdapterAcpConfiguration,
  type AgentCompanySkillPinsResponse,
  type AgentCompanySkillPinsUpdate,
  type AgentAdapterRevisionConfigurationInput,
  type CompanySkillPin,
} from "@paperclipai/shared";
import {
  resolveAcpAdapterRevisionConfiguration,
  validateAdapterConfigSchema,
  validateServerAdapterModule,
  type AdapterConfigSchema,
  type AcpAdapterRevisionConfiguration,
  type AcpxAdapterDefinition,
  type ConfigFieldSchema,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { notFound, unprocessable } from "../errors.js";
import {
  requireSecretMutationActor,
  type SecretMutationActor,
} from "./secrets.js";

export const AGENT_ADAPTER_CONFIG_SCHEMA_VERSION =
  "paperclip.acp-adapter-config/v1";

type JsonRecord = Record<string, unknown>;

export type AgentAdapterConfigRevisionActor = SecretMutationActor;

export interface AgentAdapterConfigurationRevisionResult {
  revision: typeof agentAdapterConfigRevisions.$inferSelect;
  current: typeof agents.$inferSelect;
  appended: boolean;
}

export interface AgentCompanySkillPinsMutationResult
  extends AgentCompanySkillPinsResponse {
  revision: typeof agentAdapterConfigRevisions.$inferSelect;
  current: typeof agents.$inferSelect;
  appended: boolean;
}

export interface SelectAgentAdapterConfigRevisionInput {
  companyId: string;
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  companySkillPins: readonly CompanySkillPin[];
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export interface DerivedAgentAdapterConfigRevision {
  adapterType: string;
  implementationIdentity: AdapterImplementationIdentity;
  adapterConfigSchemaVersion: string;
  normalizedConfig: Record<string, unknown>;
  acpConfiguration: AgentAdapterAcpConfiguration;
  digest: string;
}

export interface AgentAdapterRuntimeMetadata {
  implementationIdentity: AdapterImplementationIdentity;
  definition: AcpxAdapterDefinition;
}

export interface DeriveRegisteredAgentAdapterConfigRevisionInput {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  companySkillPins: readonly CompanySkillPin[];
}

export interface ResolvedRegisteredAdapterRuntimeConfiguration {
  canonicalAdapterConfig: JsonRecord;
  runtimeMetadata: AgentAdapterRuntimeMetadata;
  acpConfiguration: AcpAdapterRevisionConfiguration;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unprocessable("Adapter configuration must contain only finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw unprocessable("Adapter configuration must contain only JSON values");
  }
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function normalizedJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unprocessable("Adapter configuration must contain only finite JSON numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (!isRecord(value)) {
    throw unprocessable("Adapter configuration must contain only JSON values");
  }
  const normalized: JsonRecord = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: normalizedJson(value[key]),
      });
    }
  }
  return normalized;
}

const PROTOTYPE_MUTATING_CONFIG_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function assertNoPrototypeMutatingConfigKeys(
  value: unknown,
  path = "adapterConfig",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoPrototypeMutatingConfigKeys(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw unprocessable(
      `Adapter configuration contains a non-plain object at '${path}'`,
      {
        code: "non_plain_adapter_config_object",
        path,
      },
    );
  }
  const record = value as JsonRecord;
  for (const key of Object.keys(record)) {
    if (PROTOTYPE_MUTATING_CONFIG_KEYS.has(key)) {
      throw unprocessable(
        `Adapter configuration contains prohibited key '${path}.${key}'`,
        {
          code: "prototype_mutating_adapter_config_key",
          path: `${path}.${key}`,
        },
      );
    }
    assertNoPrototypeMutatingConfigKeys(record[key], `${path}.${key}`);
  }
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  return value;
}

function fieldIsVisible(
  field: ConfigFieldSchema,
  schema: AdapterConfigSchema,
  config: JsonRecord,
): boolean {
  const visibleWhen = field.meta?.visibleWhen;
  if (!isRecord(visibleWhen)) return true;
  const key =
    typeof visibleWhen.key === "string" ? visibleWhen.key : null;
  if (!key || !schema.fields.some((candidate) => candidate.key === key)) {
    return true;
  }
  const actual = String(config[key] ?? "");
  if (typeof visibleWhen.value === "string") {
    return actual === visibleWhen.value;
  }
  if (Array.isArray(visibleWhen.values)) {
    const values = visibleWhen.values.filter(
      (value): value is string => typeof value === "string",
    );
    return values.length > 0 && values.includes(actual);
  }
  if (Array.isArray(visibleWhen.notValues)) {
    const values = visibleWhen.notValues.filter(
      (value): value is string => typeof value === "string",
    );
    return !values.includes(actual);
  }
  return true;
}

function validateAdapterConfigField(
  adapterType: string,
  field: ConfigFieldSchema,
  value: unknown,
): string | null {
  if (value === undefined || value === null) return null;
  const prefix =
    `Adapter "${adapterType}" configuration field "${field.key}"`;
  if (
    (
      field.type === "text"
      || field.type === "textarea"
      || field.type === "select"
      || field.type === "combobox"
    )
    && typeof value !== "string"
  ) {
    return `${prefix} must be a string.`;
  }
  if (field.type === "toggle" && typeof value !== "boolean") {
    return `${prefix} must be a boolean.`;
  }
  if (
    field.type === "number"
    && (typeof value !== "number" || !Number.isFinite(value))
  ) {
    return `${prefix} must be a finite number.`;
  }
  if (
    field.type === "select"
    && typeof value === "string"
    && Array.isArray(field.options)
    && !field.options.some((option) => option.value === value)
  ) {
    return `${prefix} must select one of the adapter-owned options.`;
  }
  return null;
}

function validateAdapterConfiguration(
  adapterType: string,
  schema: AdapterConfigSchema,
  config: JsonRecord,
): void {
  const errors: string[] = [];
  for (const field of schema.fields) {
    if (!fieldIsVisible(field, schema, config)) continue;
    const value = config[field.key];
    if (
      field.required === true
      && (
        value === undefined
        || value === null
        || (typeof value === "string" && value.trim().length === 0)
      )
    ) {
      errors.push(
        `Adapter "${adapterType}" requires explicit configuration field "${field.key}" (${field.label}).`,
      );
      continue;
    }
    const fieldError = validateAdapterConfigField(
      adapterType,
      field,
      value,
    );
    if (fieldError) errors.push(fieldError);
  }
  if (errors.length > 0) {
    throw unprocessable(errors.join(" "), {
      code: "invalid_adapter_configuration",
      adapterType,
      errors,
    });
  }
}

function normalizeExplicitAdapterConfig(
  value: Record<string, unknown>,
): JsonRecord {
  assertNoPrototypeMutatingConfigKeys(value);
  const parsedConfig = adapterConfigSchema.safeParse(value);
  if (!parsedConfig.success) {
    throw unprocessable("Invalid adapter configuration", {
      code: "invalid_agent_adapter_config",
      diagnostics: validationDetails(parsedConfig.error),
    });
  }
  return normalizedJson(parsedConfig.data) as JsonRecord;
}

function companySkillPinsEqual(
  left: readonly CompanySkillPin[],
  right: readonly CompanySkillPin[],
): boolean {
  return left.length === right.length
    && left.every(
      (pin, index) =>
        pin.key === right[index]?.key
        && pin.versionId === right[index]?.versionId,
  );
}

function parsePersistedAcpConfiguration(
  value: unknown,
): AgentAdapterAcpConfiguration {
  const parsed = agentAdapterAcpConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw unprocessable(
      "Agent adapter revision has an invalid immutable ACP configuration",
      {
        code: "invalid_persisted_agent_adapter_acp_configuration",
        diagnostics: validationDetails(parsed.error),
      },
    );
  }
  return parsed.data;
}

export function deriveAgentAdapterConfigRevision(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  companySkillPins: readonly CompanySkillPin[];
  runtimeMetadata: AgentAdapterRuntimeMetadata;
}): DerivedAgentAdapterConfigRevision {
  if (!input.runtimeMetadata) {
    throw unprocessable(
      "Adapter configuration requires a registered runtime module",
      {
        code: "adapter_runtime_module_required",
        adapterType: input.adapterType,
      },
    );
  }
  if (
    !isAdapterImplementationIdentity(
      input.runtimeMetadata.implementationIdentity,
    ) ||
    input.runtimeMetadata.implementationIdentity.adapterType !==
      input.adapterType
  ) {
    throw unprocessable(
      "Adapter runtime implementation identity is missing or does not match its adapter type",
      {
        code: "invalid_adapter_implementation_identity",
        adapterType: input.adapterType,
      },
    );
  }
  const normalizedConfig =
    normalizeExplicitAdapterConfig(input.adapterConfig);
  let declarativeAcpConfiguration: AcpAdapterRevisionConfiguration;
  try {
    declarativeAcpConfiguration = resolveAcpAdapterRevisionConfiguration({
      adapter: {
        type: input.adapterType,
        definition: input.runtimeMetadata.definition,
      },
      config: normalizedConfig,
    });
  } catch (error) {
    throw unprocessable(
      error instanceof Error
        ? error.message
        : `Adapter "${input.adapterType}" ACP configuration is invalid.`,
      {
        code: "invalid_adapter_acp_configuration",
        adapterType: input.adapterType,
      },
    );
  }
  const companySkillPins = parseCompanySkillPins(input.companySkillPins);
  const parsedAcpConfiguration =
    agentAdapterAcpConfigurationSchema.safeParse({
      ...declarativeAcpConfiguration,
      workspaceSelector: {
        kind: "task_execution_workspace",
      },
      companySkillPins,
    });
  if (!parsedAcpConfiguration.success) {
    throw unprocessable(
      `Adapter "${input.adapterType}" immutable ACP revision configuration is invalid.`,
      {
        code: "invalid_adapter_acp_revision_configuration",
        adapterType: input.adapterType,
        diagnostics: validationDetails(parsedAcpConfiguration.error),
      },
    );
  }
  const acpConfiguration = deepFreezeJson(
    parsedAcpConfiguration.data,
  ) as AgentAdapterAcpConfiguration;
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        adapterType: input.adapterType,
        implementationIdentity: input.runtimeMetadata.implementationIdentity,
        adapterConfigSchemaVersion: AGENT_ADAPTER_CONFIG_SCHEMA_VERSION,
        normalizedConfig,
        acpConfiguration,
      }),
    )
    .digest("hex");

  return {
    adapterType: input.adapterType,
    implementationIdentity: input.runtimeMetadata.implementationIdentity,
    adapterConfigSchemaVersion: AGENT_ADAPTER_CONFIG_SCHEMA_VERSION,
    normalizedConfig,
    acpConfiguration,
    digest,
  };
}

export async function resolveRegisteredAdapterRuntimeConfiguration(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}): Promise<ResolvedRegisteredAdapterRuntimeConfiguration> {
  const canonicalAdapterConfig =
    deepFreezeJson(normalizeExplicitAdapterConfig(input.adapterConfig));
  let adapter: ServerAdapterModule | null;
  let implementationIdentity: AdapterImplementationIdentity | null = null;
  try {
    const registry = await import("../adapters/registry.js");
    // A direct API caller may not have opened the adapter picker first. Refresh
    // the ACPX snapshot here as well so configuration never relies on a
    // Paperclip-maintained agent list.
    await registry.refreshAcpxAdapters();
    const implementation =
      registry.findServerAdapterImplementation(input.adapterType);
    adapter = implementation?.adapter ?? null;
    implementationIdentity = implementation?.identity ?? null;
  } catch (error) {
    throw unprocessable(
      "Adapter runtime registry could not be resolved",
      {
        code: "adapter_runtime_registry_unavailable",
        adapterType: input.adapterType,
      },
    );
  }
  if (!adapter || !implementationIdentity) {
    throw unprocessable(
      "Adapter type is not registered with an executable runtime module",
      {
        code: "adapter_runtime_module_not_registered",
        adapterType: input.adapterType,
      },
    );
  }
  try {
    validateServerAdapterModule(adapter);
  } catch (error) {
    throw unprocessable(
      "Registered adapter does not satisfy the declarative ACP contract",
      {
        code: "adapter_runtime_module_incapable",
        adapterType: input.adapterType,
      },
    );
  }
  const parsedSchema = validateAdapterConfigSchema(
    adapter.definition.configSchema,
  );
  if (!parsedSchema.success) {
    throw unprocessable(
      `Adapter "${input.adapterType}" returned an invalid configuration schema.`,
      {
        code: "invalid_adapter_configuration_schema",
        adapterType: input.adapterType,
        errors: parsedSchema.errors,
      },
    );
  }
  validateAdapterConfiguration(
    input.adapterType,
    parsedSchema.data,
    canonicalAdapterConfig,
  );
  let acpConfiguration: AcpAdapterRevisionConfiguration;
  try {
    acpConfiguration = resolveAcpAdapterRevisionConfiguration({
      adapter,
      config: canonicalAdapterConfig,
    });
  } catch (error) {
    throw unprocessable(
      error instanceof Error
        ? error.message
        : `Adapter "${input.adapterType}" ACP configuration could not be resolved.`,
      {
        code: "adapter_acp_configuration_invalid",
        adapterType: input.adapterType,
      },
    );
  }
  return {
    canonicalAdapterConfig,
    runtimeMetadata: {
      implementationIdentity,
      definition: adapter.definition,
    },
    acpConfiguration,
  };
}

/**
 * Validate one explicit draft/import configuration against the exact active
 * adapter-owned schema and immutable ACP selection. This is structural
 * validation only: it makes no runtime-readiness claim and starts no process.
 */
export async function validateRegisteredAdapterRuntimeConfiguration(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}): Promise<void> {
  await resolveRegisteredAdapterRuntimeConfiguration(input);
}

/**
 * Resolve one active adapter runtime and derive its immutable control-plane
 * configuration without reading or writing an agent row. Callers use this for
 * fail-closed configuration preflight; persistence selection reuses the exact
 * same registered-runtime path below.
 */
export async function deriveRegisteredAgentAdapterConfigRevision(
  input: DeriveRegisteredAgentAdapterConfigRevisionInput,
): Promise<DerivedAgentAdapterConfigRevision> {
  const resolved = await resolveRegisteredAdapterRuntimeConfiguration(input);
  const derived = deriveAgentAdapterConfigRevision({
    adapterType: input.adapterType,
    adapterConfig: resolved.canonicalAdapterConfig,
    companySkillPins: input.companySkillPins,
    runtimeMetadata: resolved.runtimeMetadata,
  });
  return derived;
}

async function assertCompanySkillRevisionPins(
  db: Db,
  companyId: string,
  pins: readonly CompanySkillPin[],
): Promise<void> {
  if (pins.length === 0) return;

  const keys = pins.map((pin) => pin.key);
  const versionIds = pins.map((pin) => pin.versionId);
  const [skillRows, versionRows] = await Promise.all([
    db
      .select({
        id: companySkills.id,
        key: companySkills.key,
      })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          inArray(companySkills.key, keys),
        ),
      )
      .for("share"),
    db
      .select({
        id: companySkillVersions.id,
        companySkillId: companySkillVersions.companySkillId,
      })
      .from(companySkillVersions)
      .where(
        and(
          eq(companySkillVersions.companyId, companyId),
          inArray(companySkillVersions.id, versionIds),
        ),
      )
      .for("share"),
  ]);
  const skillByKey = new Map(skillRows.map((skill) => [skill.key, skill]));
  const versionById = new Map(
    versionRows.map((version) => [version.id, version]),
  );
  for (const pin of pins) {
    const skill = skillByKey.get(pin.key);
    const version = versionById.get(pin.versionId);
    if (!skill) {
      throw unprocessable(`Unknown company skill revision pin: ${pin.key}`, {
        code: "unknown_company_skill_revision_pin",
        key: pin.key,
      });
    }
    if (!version || version.companySkillId !== skill.id) {
      throw unprocessable(
        `Pinned version ${pin.versionId} does not belong to company skill ${pin.key}`,
        {
          code: "company_skill_revision_pin_mismatch",
          key: pin.key,
          versionId: pin.versionId,
        },
      );
    }
  }
}

export async function selectAgentAdapterConfigRevision(
  db: Db,
  input: SelectAgentAdapterConfigRevisionInput,
): Promise<typeof agentAdapterConfigRevisions.$inferSelect> {
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
    })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!agent) throw notFound("Agent not found");

  const current = agent.currentAdapterConfigRevisionId
    ? await db
        .select()
        .from(agentAdapterConfigRevisions)
        .where(
          and(
            eq(agentAdapterConfigRevisions.companyId, input.companyId),
            eq(agentAdapterConfigRevisions.agentId, input.agentId),
            eq(
              agentAdapterConfigRevisions.id,
              agent.currentAdapterConfigRevisionId,
            ),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null)
    : null;
  if (agent.currentAdapterConfigRevisionId && !current) {
    throw unprocessable("Agent current adapter configuration revision is invalid");
  }

  // Resolve the current ACPX-admitted definition before stamping the
  // immutable adapter revision.
  const resolvedRuntime = await resolveRegisteredAdapterRuntimeConfiguration({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
  });
  const runtimeConfig = deepFreezeJson(
    normalizedJson(input.runtimeConfig) as Record<string, unknown>,
  );
  const companySkillPins = parseCompanySkillPins(
    input.companySkillPins,
  );
  await assertCompanySkillRevisionPins(
    db,
    input.companyId,
    companySkillPins,
  );
  const derived = deriveAgentAdapterConfigRevision({
    adapterType: input.adapterType,
    adapterConfig: resolvedRuntime.canonicalAdapterConfig,
    companySkillPins,
    runtimeMetadata: resolvedRuntime.runtimeMetadata,
  });
  const digest = createHash("sha256")
    .update(canonicalJson({
      adapterConfigurationDigest: derived.digest,
      runtimeConfig,
    }))
    .digest("hex");

  // Reuse is valid only when the current immutable identity already describes
  // the requested ACP configuration. A repeated historical digest still
  // appends a new lineage identity instead of moving the current pointer back.
  let selected =
    current?.digest === digest
      ? current
      : null;

  if (!selected) {
    const nextRevisionNumber = await db
      .select({
        value: sql<number>`coalesce(max(${agentAdapterConfigRevisions.revisionNumber}), 0)::int + 1`,
      })
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.companyId, input.companyId),
          eq(agentAdapterConfigRevisions.agentId, input.agentId),
        ),
      )
      .then((rows) => Number(rows[0]?.value ?? 1));
    selected = await db
      .insert(agentAdapterConfigRevisions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        revisionNumber: nextRevisionNumber,
        ...derived,
        runtimeConfig,
        digest,
        parentRevisionId: current?.id ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }
  if (!selected) {
    throw unprocessable("Failed to persist agent adapter configuration revision");
  }

  if (agent.currentAdapterConfigRevisionId !== selected.id) {
    const updated = await db
      .update(agents)
      .set({
        currentAdapterConfigRevisionId: selected.id,
        updatedAt: new Date(),
      })
      .where(
        and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)),
      )
      .returning({ id: agents.id })
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Agent not found");
  }
  return selected;
}

function normalizeRuntimeConfiguration(
  value: AgentAdapterRevisionConfigurationInput["runtimeConfig"],
): Record<string, unknown> {
  assertNoPrototypeMutatingConfigKeys(value, "runtimeConfig");
  return normalizedJson(value) as Record<string, unknown>;
}

/**
 * Board control-plane owner for adapter/execution configuration.
 *
 * The agent row lock, declarative ACP preflight, immutable revision append,
 * current pointer, and runtime policy commit in one transaction. Active
 * executions retain their already snapshotted revision; this service never
 * rolls a current pointer back to an historical identity.
 */
export function createAgentAdapterConfigurationService(
  db: Db,
) {
  return {
    async listRevisions(input: {
      companyId: string;
      agentId: string;
    }) {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, input.companyId),
            eq(agents.id, input.agentId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentAdapterConfigRevisions)
        .where(
          and(
            eq(
              agentAdapterConfigRevisions.companyId,
              input.companyId,
            ),
            eq(agentAdapterConfigRevisions.agentId, input.agentId),
          ),
        )
        .orderBy(
          desc(agentAdapterConfigRevisions.revisionNumber),
          desc(agentAdapterConfigRevisions.createdAt),
        );
    },

    async getCurrentRevision(input: {
      companyId: string;
      agentId: string;
    }) {
      const agent = await db
        .select({
          currentAdapterConfigRevisionId:
            agents.currentAdapterConfigRevisionId,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, input.companyId),
            eq(agents.id, input.agentId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      if (!agent.currentAdapterConfigRevisionId) return null;

      return db
        .select()
        .from(agentAdapterConfigRevisions)
        .where(
          and(
            eq(
              agentAdapterConfigRevisions.companyId,
              input.companyId,
            ),
            eq(agentAdapterConfigRevisions.agentId, input.agentId),
            eq(
              agentAdapterConfigRevisions.id,
              agent.currentAdapterConfigRevisionId,
            ),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    async getCompanySkillPins(input: {
      companyId: string;
      agentId: string;
    }): Promise<AgentCompanySkillPinsResponse> {
      const current = await db
        .select({
          currentAdapterConfigRevisionId:
            agents.currentAdapterConfigRevisionId,
          revisionId: agentAdapterConfigRevisions.id,
          acpConfiguration:
            agentAdapterConfigRevisions.acpConfiguration,
        })
        .from(agents)
        .leftJoin(
          agentAdapterConfigRevisions,
          and(
            eq(
              agentAdapterConfigRevisions.id,
              agents.currentAdapterConfigRevisionId,
            ),
            eq(agentAdapterConfigRevisions.companyId, agents.companyId),
            eq(agentAdapterConfigRevisions.agentId, agents.id),
          ),
        )
        .where(
          and(
            eq(agents.companyId, input.companyId),
            eq(agents.id, input.agentId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Agent not found");
      if (!current.currentAdapterConfigRevisionId) {
        throw unprocessable(
          "Agent has no current adapter configuration revision",
          { code: "agent_adapter_configuration_required" },
        );
      }
      if (
        current.revisionId
        !== current.currentAdapterConfigRevisionId
      ) {
        throw unprocessable(
          "Agent current adapter configuration revision is invalid",
          { code: "invalid_current_agent_adapter_config_revision" },
        );
      }
      const acpConfiguration = parsePersistedAcpConfiguration(
        current.acpConfiguration,
      );
      return {
        entries: [...acpConfiguration.companySkillPins],
      };
    },

    async replaceCompanySkillPins(input: {
      companyId: string;
      agentId: string;
      update: AgentCompanySkillPinsUpdate | unknown;
      actor: AgentAdapterConfigRevisionActor;
    }): Promise<AgentCompanySkillPinsMutationResult> {
      const attribution = requireSecretMutationActor(input.actor);
      const parsed = agentCompanySkillPinsUpdateSchema.safeParse(
        input.update,
      );
      if (!parsed.success) {
        throw unprocessable("Invalid agent company skill pins", {
          code: "invalid_agent_company_skill_pins",
          diagnostics: validationDetails(parsed.error),
        });
      }
      const requestedPins = parseCompanySkillPins(parsed.data.entries);

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const locked = await tx
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Agent not found");
        if (locked.status === "terminated") {
          throw unprocessable(
            "Terminated agents cannot receive company skill pins",
            { code: "terminated_agent_adapter_configuration" },
          );
        }
        if (!locked.currentAdapterConfigRevisionId) {
          throw unprocessable(
            "Agent has no current adapter configuration revision",
            { code: "agent_adapter_configuration_required" },
          );
        }

        const currentRevision = await tx
          .select()
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(
                agentAdapterConfigRevisions.companyId,
                input.companyId,
              ),
              eq(
                agentAdapterConfigRevisions.agentId,
                input.agentId,
              ),
              eq(
                agentAdapterConfigRevisions.id,
                locked.currentAdapterConfigRevisionId,
              ),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!currentRevision) {
          throw unprocessable(
            "Agent current adapter configuration revision is invalid",
            { code: "invalid_current_agent_adapter_config_revision" },
          );
        }
        const currentAcpConfiguration =
          parsePersistedAcpConfiguration(
            currentRevision.acpConfiguration,
          );
        const currentPins = currentAcpConfiguration.companySkillPins;
        if (
          typeof locked.adapterType !== "string"
          || !isRecord(locked.adapterConfig)
          || !isRecord(locked.runtimeConfig)
        ) {
          throw unprocessable(
            "Agent adapter configuration is incomplete",
            { code: "agent_adapter_configuration_required" },
          );
        }

        await assertCompanySkillRevisionPins(
          txDb,
          input.companyId,
          requestedPins,
        );
        if (companySkillPinsEqual(currentPins, requestedPins)) {
          return {
            entries: [...currentPins],
            revision: currentRevision,
            current: locked,
            appended: false,
          };
        }

        const revision = await selectAgentAdapterConfigRevision(txDb, {
          companyId: input.companyId,
          agentId: input.agentId,
          adapterType: locked.adapterType,
          adapterConfig: locked.adapterConfig,
          runtimeConfig: locked.runtimeConfig,
          companySkillPins: requestedPins,
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        });

        const current = await tx
          .update(agents)
          .set({
            adapterType: revision.adapterType,
            adapterConfig: revision.normalizedConfig,
            runtimeConfig: locked.runtimeConfig,
            currentAdapterConfigRevisionId: revision.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Agent not found");

        return {
          entries: requestedPins,
          revision,
          current,
          appended:
            revision.id !== locked.currentAdapterConfigRevisionId,
        };
      });
    },

    async createRevision(input: {
      companyId: string;
      agentId: string;
      configuration: AgentAdapterRevisionConfigurationInput | unknown;
      actor: AgentAdapterConfigRevisionActor;
    }): Promise<AgentAdapterConfigurationRevisionResult> {
      const attribution = requireSecretMutationActor(input.actor);
      const parsed =
        agentAdapterRevisionConfigurationSchema.safeParse(
          input.configuration,
        );
      if (!parsed.success) {
        throw unprocessable("Invalid agent adapter revision configuration", {
          code: "invalid_agent_adapter_revision_configuration",
          diagnostics: validationDetails(parsed.error),
        });
      }

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const locked = await tx
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Agent not found");
        if (locked.status === "terminated") {
          throw unprocessable(
            "Terminated agents cannot receive adapter configuration revisions",
            { code: "terminated_agent_adapter_configuration" },
          );
        }

        const normalizedAdapterConfig = normalizedJson(
          parsed.data.adapterConfig,
        ) as Record<string, unknown>;
        const normalizedRuntimeConfig =
          normalizeRuntimeConfiguration(parsed.data.runtimeConfig);
        const previousRevisionId =
          locked.currentAdapterConfigRevisionId;
        const revision = await selectAgentAdapterConfigRevision(txDb, {
          companyId: input.companyId,
          agentId: input.agentId,
          adapterType: parsed.data.adapterType,
          adapterConfig: normalizedAdapterConfig,
          runtimeConfig: normalizedRuntimeConfig,
          companySkillPins: parsed.data.companySkillPins,
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        });

        const current = await tx
          .update(agents)
          .set({
            adapterType: revision.adapterType,
            adapterConfig: revision.normalizedConfig,
            runtimeConfig: normalizedRuntimeConfig,
            currentAdapterConfigRevisionId: revision.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agents.companyId, input.companyId),
              eq(agents.id, input.agentId),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Agent not found");

        return {
          revision,
          current,
          appended: revision.id !== previousRevisionId,
        };
      });
    },
  };
}

export type AgentAdapterConfigurationService = ReturnType<
  typeof createAgentAdapterConfigurationService
>;
