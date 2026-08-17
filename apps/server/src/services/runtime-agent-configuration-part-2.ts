import {
  agentActionGrants,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
  runtimeAgentConfigurationAudits,
  type RuntimeAgentConfigurationSnapshot,
} from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  isCanonicalUuid,
  runtimeAgentHireConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  validationDetails,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import * as agentConfig from "./runtime-agent-configuration-part-1.js";

export { canonicalJson };

export function parseRuntimeAgentUpdateConfiguration(value: unknown): agentConfig.ParsedUpdateConfiguration {
  const record = agentConfig.parseConfigurationRecord(value);
  if (Object.keys(record).length === 0) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid(
      "At least one runtime-agent configuration field is required",
    );
  }
  const parsed: agentConfig.ParsedUpdateConfiguration = {};
  if (agentConfig.present(record, "name")) parsed.name = agentConfig.parseName(record.name);
  if (agentConfig.present(record, "title")) {
    parsed.title = agentConfig.parseNullableString(record.title, "title");
  }
  if (agentConfig.present(record, "capabilities")) {
    parsed.capabilities = agentConfig.parseNullableString(record.capabilities, "capabilities");
  }
  if (agentConfig.present(record, "reportsTo")) {
    parsed.reportsTo = agentConfig.parseNullableAgentId(record.reportsTo, "reportsTo");
  }
  if (agentConfig.present(record, "instruction")) {
    parsed.instruction = agentConfig.parseNullableString(record.instruction, "instruction");
  }
  if (agentConfig.present(record, "contextGrants")) {
    parsed.contextGrants = agentConfig.parseSparseGrantMap(
      record.contextGrants,
      AGENT_CONTEXT_GRANT_KEYS,
      "contextGrants",
    );
  }
  if (agentConfig.present(record, "actionGrants")) {
    parsed.actionGrants = agentConfig.parseSparseGrantMap(
      record.actionGrants,
      PAPERCLIP_ACTION_KEYS,
      "actionGrants",
    );
  }
  if (agentConfig.present(record, "mentionReachGrants")) {
    parsed.mentionReachGrants = agentConfig.parseSparseGrantMap(
      record.mentionReachGrants,
      AGENT_MENTION_REACH_GRANT_KEYS,
      "mentionReachGrants",
    );
  }
  return parsed;
}

export function canonicalValidationMessage(error: unknown): string {
  return validationDetails(error)
    .map((detail) => {
      const path = detail.path.length > 0 ? `${detail.path.join(".")}: ` : "";
      return `${path}${detail.message}`;
    })
    .join("; ");
}

/**
 * Provider-run hiring uses the complete canonical create contract with no
 * caller-controlled reporting edge. The service injects that edge only after
 * the run authority has been locked.
 */
export function parseRuntimeAgentHireConfiguration(value: unknown): agentConfig.ParsedCreateConfiguration {
  const parsed = runtimeAgentHireConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid(canonicalValidationMessage(parsed.error));
  }
  return agentConfig.parseRuntimeAgentCreateConfiguration({
    ...parsed.data,
    reportsTo: null,
  });
}

/** Provider-run configuration uses the same nonempty canonical patch. */
export function parseRuntimeAgentConfigureConfiguration(
  value: unknown,
): agentConfig.ParsedUpdateConfiguration {
  const parsed = runtimeAgentUpdateConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid(canonicalValidationMessage(parsed.error));
  }
  return parseRuntimeAgentUpdateConfiguration(parsed.data);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertNonempty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid(`${label} must not be empty`);
  }
  return normalized;
}

export function normalizedIdempotencyKey(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = assertNonempty(value, "idempotencyKey");
  if (normalized.length > 512) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("idempotencyKey must be at most 512 characters");
  }
  return normalized;
}

export function actorAuditColumns(actor: agentConfig.InternalActor): agentConfig.ActorAuditColumns {
  if (actor.kind === "agent") {
    return {
      actorKind: "agent",
      actorId: actor.actorId,
      actorAgentId: actor.actorId,
      actorUserId: null,
      actorPluginInstallationId: null,
      runId: actor.capability.runId,
      taskExecutionRefId: actor.capability.refId,
    };
  }
  if (actor.kind === "plugin") {
    return {
      actorKind: "plugin",
      actorId: actor.actorId,
      actorAgentId: null,
      actorUserId: null,
      actorPluginInstallationId: actor.pluginInstallationId,
      runId: null,
      taskExecutionRefId: null,
    };
  }
  return {
    actorKind: "board",
    actorId: actor.actorId,
    actorAgentId: null,
    actorUserId: actor.authorization.userId ?? actor.actorId,
    actorPluginInstallationId: null,
    runId: null,
    taskExecutionRefId: null,
  };
}

export function grantActorColumns(actor: agentConfig.InternalActor): {
  grantedByAgentId: string | null;
  grantedByUserId: string | null;
} {
  if (actor.kind === "agent") {
    return { grantedByAgentId: actor.actorId, grantedByUserId: null };
  }
  if (actor.kind === "board") {
    return { grantedByAgentId: null, grantedByUserId: actor.actorId };
  }
  // Plugin provenance is retained by the aggregate audit. Grant tables have
  // no polymorphic actor column and must not mislabel the plugin as a user.
  return { grantedByAgentId: null, grantedByUserId: null };
}

export function trueGrantMap<Key extends string>(
  keys: readonly Key[],
  rows: readonly { key: Key }[],
): Partial<Record<Key, true>> {
  const presentKeys = new Set(rows.map((row) => row.key));
  return Object.fromEntries(keys.filter((key) => presentKeys.has(key)).map((key) => [key, true])) as Partial<
    Record<Key, true>
  >;
}

export async function loadSnapshot(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
): Promise<RuntimeAgentConfigurationSnapshot> {
  const [agentRows, contextRows, actionRows, mentionRows] = await Promise.all([
    tx
      .select({
        name: agents.name,
        title: agents.title,
        capabilities: agents.capabilities,
        reportsTo: agents.reportsTo,
        instruction: agents.instruction,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .limit(1),
    tx
      .select({ key: agentContextGrants.key })
      .from(agentContextGrants)
      .where(and(eq(agentContextGrants.companyId, companyId), eq(agentContextGrants.agentId, agentId))),
    tx
      .select({ key: agentActionGrants.key })
      .from(agentActionGrants)
      .where(and(eq(agentActionGrants.companyId, companyId), eq(agentActionGrants.agentId, agentId))),
    tx
      .select({ key: agentMentionReachGrants.key })
      .from(agentMentionReachGrants)
      .where(
        and(eq(agentMentionReachGrants.companyId, companyId), eq(agentMentionReachGrants.agentId, agentId)),
      ),
  ]);
  const agent = agentRows[0];
  if (!agent) {
    throw new agentConfig.RuntimeAgentConfigurationConflict(
      "Runtime-agent configuration target no longer exists",
    );
  }
  return {
    identity: {
      name: agent.name,
      title: agent.title,
      capabilities: agent.capabilities,
      reportsTo: agent.reportsTo,
      instruction: agent.instruction,
    },
    contextGrants: trueGrantMap(AGENT_CONTEXT_GRANT_KEYS, contextRows),
    actionGrants: trueGrantMap(PAPERCLIP_ACTION_KEYS, actionRows),
    mentionReachGrants: trueGrantMap(AGENT_MENTION_REACH_GRANT_KEYS, mentionRows),
  };
}

/**
 * Verifies that a hire approval still names the exact immutable audit whose
 * after-snapshot is the pending agent's current runtime configuration. This is
 * deliberately transaction-scoped so approval resolution can lock and
 * transition the agent without replaying any configuration bytes.
 */
export async function assertCurrentRuntimeAgentConfigurationAudit(
  tx: agentConfig.RuntimeAgentConfigurationTransaction,
  input: {
    companyId: string;
    agentId: string;
    auditId: string;
    requestDigest: string;
  },
) {
  const audit = await tx
    .select()
    .from(runtimeAgentConfigurationAudits)
    .where(
      and(
        eq(runtimeAgentConfigurationAudits.id, input.auditId),
        eq(runtimeAgentConfigurationAudits.companyId, input.companyId),
        eq(runtimeAgentConfigurationAudits.agentId, input.agentId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!audit || audit.requestDigest !== input.requestDigest) {
    throw new agentConfig.RuntimeAgentConfigurationConflict(
      "Hire approval runtime-agent audit link is missing or does not match its request digest",
    );
  }
  const current = await loadSnapshot(tx, input.companyId, input.agentId);
  if (canonicalJson(current) !== canonicalJson(audit.afterSnapshot)) {
    throw new agentConfig.RuntimeAgentConfigurationConflict(
      "Pending agent runtime configuration no longer matches the linked immutable audit",
    );
  }
  return audit;
}

export function snapshotsChangedKeys(
  before: RuntimeAgentConfigurationSnapshot | null,
  after: RuntimeAgentConfigurationSnapshot,
): string[] {
  const changed: string[] = [];
  for (const key of ["name", "title", "capabilities", "reportsTo", "instruction"] as const) {
    if (!before || before.identity[key] !== after.identity[key]) {
      changed.push(`identity.${key}`);
    }
  }
  for (const key of AGENT_CONTEXT_GRANT_KEYS) {
    if (
      (!before && after.contextGrants[key] === true) ||
      (before && (before.contextGrants[key] === true) !== (after.contextGrants[key] === true))
    ) {
      changed.push(`contextGrants.${key}`);
    }
  }
  for (const key of PAPERCLIP_ACTION_KEYS) {
    if (
      (!before && after.actionGrants[key] === true) ||
      (before && (before.actionGrants[key] === true) !== (after.actionGrants[key] === true))
    ) {
      changed.push(`actionGrants.${key}`);
    }
  }
  for (const key of AGENT_MENTION_REACH_GRANT_KEYS) {
    if (
      (!before && after.mentionReachGrants[key] === true) ||
      (before && (before.mentionReachGrants[key] === true) !== (after.mentionReachGrants[key] === true))
    ) {
      changed.push(`mentionReachGrants.${key}`);
    }
  }
  return changed;
}

export function assertActorSource(
  actor: agentConfig.RuntimeAgentConfigurationControlActor,
  source: agentConfig.RuntimeAgentConfigurationControlSource,
): void {
  if (actor.kind === "plugin" && source !== "plugin_control") {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("Plugin actors require plugin_control source");
  }
  if (actor.kind === "board" && source === "plugin_control") {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("Board actors cannot use plugin_control source");
  }
  assertNonempty(actor.actorId, "actorId");
  if (actor.kind === "plugin" && !isCanonicalUuid(actor.pluginInstallationId)) {
    throw new agentConfig.RuntimeAgentConfigurationInvalid("pluginInstallationId must be a UUID");
  }
  if (actor.kind === "board" && actor.authorization.type !== "board") {
    throw new agentConfig.RuntimeAgentConfigurationDenied(
      "A board authorization actor is required",
      "actor_type_mismatch",
    );
  }
}
