import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Db, agentAdapterConfigRevisions, agents } from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  agentAdapterRevisionConfigurationSchema,
  validationDetails,
  type AgentAdapterAcpConfiguration,
  type AgentAdapterRevisionConfigurationInput,
} from "@paperclipai/shared";
import {
  resolveAcpAdapterRevisionConfiguration,
  validateServerAdapterModule,
  type AcpAdapterRevisionConfiguration,
} from "@paperclipai/adapter-utils";
import { notFound, unprocessable } from "../errors.js";
import { requireSecretMutationActor, type SecretMutationActor } from "./secrets.js";

type JsonRecord = Record<string, unknown>;

export interface AgentAdapterConfigurationRevisionResult {
  revision: typeof agentAdapterConfigRevisions.$inferSelect;
  current: typeof agents.$inferSelect;
  appended: boolean;
}

export interface SelectAgentAdapterConfigRevisionInput {
  companyId: string;
  agentId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export interface DerivedAgentAdapterConfigRevision {
  acpConfiguration: AgentAdapterAcpConfiguration;
  digest: string;
}

export interface DeriveRegisteredAgentAdapterConfigRevisionInput {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface ResolvedRegisteredAdapterRuntimeConfiguration {
  acpConfiguration: AcpAdapterRevisionConfiguration;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw unprocessable("Adapter configuration must contain only finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) {
    throw unprocessable("Adapter configuration must contain only JSON values");
  }
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
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

/**
 * Derives the only persisted adapter payload from an already resolved ACPX
 * session configuration. No editor map or discovery identity is retained.
 */
export function deriveAgentAdapterConfigRevision(input: {
  acpConfiguration: AcpAdapterRevisionConfiguration;
}): DerivedAgentAdapterConfigRevision {
  const parsed = agentAdapterAcpConfigurationSchema.safeParse(input.acpConfiguration);
  if (!parsed.success) {
    throw unprocessable("Invalid immutable ACPX adapter configuration", {
      code: "invalid_adapter_acp_revision_configuration",
      diagnostics: validationDetails(parsed.error),
    });
  }
  const acpConfiguration = deepFreezeJson(parsed.data) as AgentAdapterAcpConfiguration;
  const digest = createHash("sha256").update(canonicalJson(acpConfiguration)).digest("hex");
  return { acpConfiguration, digest };
}

/** Resolve one exact, currently discovered ACPX agent and its native options. */
export async function resolveRegisteredAdapterRuntimeConfiguration(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}): Promise<ResolvedRegisteredAdapterRuntimeConfiguration> {
  let adapter;
  try {
    const registry = await import("../adapters/registry.js");
    await registry.refreshAcpxAdapters();
    adapter = registry.findServerAdapter(input.adapterType);
  } catch {
    throw unprocessable("ACPX runtime registry could not be resolved", {
      code: "adapter_runtime_registry_unavailable",
      adapterType: input.adapterType,
    });
  }
  if (!adapter) {
    throw unprocessable("ACPX agent is not currently available", {
      code: "adapter_runtime_module_not_registered",
      adapterType: input.adapterType,
    });
  }
  try {
    validateServerAdapterModule(adapter);
    return {
      acpConfiguration: resolveAcpAdapterRevisionConfiguration({
        adapter,
        config: input.adapterConfig,
      }),
    };
  } catch (error) {
    throw unprocessable(
      error instanceof Error ? error.message : `ACPX agent "${input.adapterType}" configuration is invalid.`,
      {
        code: "adapter_acp_configuration_invalid",
        adapterType: input.adapterType,
      },
    );
  }
}

export async function validateRegisteredAdapterRuntimeConfiguration(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}): Promise<void> {
  await resolveRegisteredAdapterRuntimeConfiguration(input);
}

export async function deriveRegisteredAgentAdapterConfigRevision(
  input: DeriveRegisteredAgentAdapterConfigRevisionInput,
): Promise<DerivedAgentAdapterConfigRevision> {
  return deriveAgentAdapterConfigRevision(await resolveRegisteredAdapterRuntimeConfiguration(input));
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
            eq(agentAdapterConfigRevisions.id, agent.currentAdapterConfigRevisionId),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null)
    : null;
  if (agent.currentAdapterConfigRevisionId && !current) {
    throw unprocessable("Agent current adapter configuration revision is invalid");
  }

  const derived = await deriveRegisteredAgentAdapterConfigRevision({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig,
  });
  let selected = current?.digest === derived.digest ? current : null;

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
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
      .returning({ id: agents.id })
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Agent not found");
  }
  return selected;
}

/** Board owner for immutable ACPX configuration revisions. */
export function createAgentAdapterConfigurationService(db: Db) {
  return {
    async listRevisions(input: { companyId: string; agentId: string }) {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      return db
        .select()
        .from(agentAdapterConfigRevisions)
        .where(
          and(
            eq(agentAdapterConfigRevisions.companyId, input.companyId),
            eq(agentAdapterConfigRevisions.agentId, input.agentId),
          ),
        )
        .orderBy(
          desc(agentAdapterConfigRevisions.revisionNumber),
          desc(agentAdapterConfigRevisions.createdAt),
        );
    },

    async getCurrentRevision(input: { companyId: string; agentId: string }) {
      const agent = await db
        .select({
          currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
        })
        .from(agents)
        .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      if (!agent.currentAdapterConfigRevisionId) return null;
      return db
        .select()
        .from(agentAdapterConfigRevisions)
        .where(
          and(
            eq(agentAdapterConfigRevisions.companyId, input.companyId),
            eq(agentAdapterConfigRevisions.agentId, input.agentId),
            eq(agentAdapterConfigRevisions.id, agent.currentAdapterConfigRevisionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    async createRevision(input: {
      companyId: string;
      agentId: string;
      configuration: AgentAdapterRevisionConfigurationInput | unknown;
      actor: SecretMutationActor;
    }): Promise<AgentAdapterConfigurationRevisionResult> {
      const attribution = requireSecretMutationActor(input.actor);
      const parsed = agentAdapterRevisionConfigurationSchema.safeParse(input.configuration);
      if (!parsed.success) {
        throw unprocessable("Invalid agent adapter revision configuration", {
          code: "invalid_agent_adapter_revision_configuration",
          diagnostics: validationDetails(parsed.error),
        });
      }

      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(agents)
          .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Agent not found");
        if (locked.status === "terminated") {
          throw unprocessable("Terminated agents cannot receive adapter configuration revisions", {
            code: "terminated_agent_adapter_configuration",
          });
        }

        const previousRevisionId = locked.currentAdapterConfigRevisionId;
        const revision = await selectAgentAdapterConfigRevision(tx as unknown as Db, {
          companyId: input.companyId,
          agentId: input.agentId,
          adapterType: parsed.data.adapterType,
          adapterConfig: parsed.data.adapterConfig,
          createdByAgentId: attribution.agentId,
          createdByUserId: attribution.userId,
        });
        const current = await tx
          .select()
          .from(agents)
          .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)))
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
