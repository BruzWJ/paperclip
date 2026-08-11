import { createHash, randomUUID } from "node:crypto";
import {
  agentActionGrants,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
  companies,
  companyMemberships,
  tasks,
  approvals,
  plugins,
  principalPermissionGrants,
  runtimeAgentConfigurationAudits,
  type Db,
  type RuntimeAgentConfigurationSnapshot,
} from "@paperclipai/db";
import {
  validationDetails,
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  hireAgentApprovalPayloadSchema,
  isUuidLike,
  normalizeAgentUrlKey,
  runtimeAgentHireConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
  type HireAgentApprovalPayload,
  type RuntimeAgentHireConfigurationInput,
  type RuntimeAgentUpdateConfigurationInput,
} from "@paperclipai/shared";
import {
  and,
  asc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  authorizationService,
  type AuthorizationActor,
} from "./authorization.js";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { lockCompanyAgentGraph } from "./agent-org-graph-lock.js";
import {
  promptCapabilityGenerationIdentity,
  type PromptCapabilityBinding,
} from "./prompt-capability-gateway.js";
import { lockActivePromptCapabilityBinding } from "./prompt-capability-gateway-postgres.js";
import { budgetService } from "./budgets.js";

export type RuntimeAgentConfigurationTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

const CONFIGURATION_KEYS = [
  "name",
  "title",
  "capabilities",
  "reportsTo",
  "instruction",
  "contextGrants",
  "actionGrants",
  "mentionReachGrants",
] as const;

const PROTECTED_SELF_IDENTITY_KEYS = new Set([
  "name",
  "title",
  "capabilities",
  "instruction",
]);

type SparseGrantMap<Key extends string> = Partial<Record<Key, boolean>>;

export interface RuntimeAgentCreateConfiguration {
  name: string;
  title?: string | null;
  capabilities?: string | null;
  reportsTo?: string | null;
  instruction?: string | null;
  contextGrants?: SparseGrantMap<AgentContextGrantKey>;
  actionGrants?: SparseGrantMap<PaperclipActionKey>;
  mentionReachGrants?: SparseGrantMap<AgentMentionReachGrantKey>;
}

export interface RuntimeAgentUpdateConfiguration {
  name?: string;
  title?: string | null;
  capabilities?: string | null;
  reportsTo?: string | null;
  instruction?: string | null;
  contextGrants?: SparseGrantMap<AgentContextGrantKey>;
  actionGrants?: SparseGrantMap<PaperclipActionKey>;
  mentionReachGrants?: SparseGrantMap<AgentMentionReachGrantKey>;
}

export interface RuntimeAgentConfigurationBoardActor {
  kind: "board";
  /**
   * Stable user/system identity written to configuration audit. Board
   * authorization is still decided from `authorization`, never this string.
   */
  actorId: string;
  authorization: Extract<AuthorizationActor, { type: "board" }>;
}

export interface RuntimeAgentConfigurationPluginActor {
  kind: "plugin";
  actorId: string;
  pluginInstallationId: string;
}

export type RuntimeAgentConfigurationControlActor =
  | RuntimeAgentConfigurationBoardActor
  | RuntimeAgentConfigurationPluginActor;

export type RuntimeAgentConfigurationControlSource =
  | "board"
  | "onboarding"
  | "plugin_control";

export interface RuntimeAgentConfigurationResult {
  agentId: string;
  companyId: string;
  configuration: RuntimeAgentConfigurationSnapshot;
  auditId: string;
  approvalId: string | null;
  retried: boolean;
}

export interface RuntimeAgentConfigurationServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
  /**
   * Plugin-managed paths have no ambient authority. The host must prove the
   * exact installation capability and active target binding in this
   * transaction. Omitting this hook closes the plugin path.
   */
  assertPluginAuthority?: (
    transaction: RuntimeAgentConfigurationTransaction,
    input: {
      actor: RuntimeAgentConfigurationPluginActor;
      operation: "create" | "update";
      targetAgentId: string | null;
      changedKeys: readonly string[];
    },
  ) => Promise<void>;
  /**
   * Existing suggestion/consent remains the only alternative to a direct
   * agents:configure grant. The hook must verify the accepted, target-bound
   * consent in the same transaction; omission closes that path.
   */
  assertConsentedChange?: (
    transaction: RuntimeAgentConfigurationTransaction,
    input: {
      capability: PromptCapabilityBinding;
      targetAgentId: string;
      changedKeys: readonly string[];
      displayedDiff: string;
    },
  ) => Promise<void>;
}

interface InternalAgentActor {
  kind: "agent";
  actorId: string;
  capability: PromptCapabilityBinding;
  invocationId: string;
}

type InternalActor =
  | RuntimeAgentConfigurationControlActor
  | InternalAgentActor;

interface ParsedCreateConfiguration {
  name: string;
  title: string | null;
  capabilities: string | null;
  reportsTo: string | null;
  instruction: string | null;
  contextGrants: SparseGrantMap<AgentContextGrantKey>;
  actionGrants: SparseGrantMap<PaperclipActionKey>;
  mentionReachGrants: SparseGrantMap<AgentMentionReachGrantKey>;
}

interface ParsedUpdateConfiguration extends RuntimeAgentUpdateConfiguration {}

type CompanyRow = typeof companies.$inferSelect;
type AgentRow = Pick<
  typeof agents.$inferSelect,
  | "id"
  | "companyId"
  | "name"
  | "title"
  | "capabilities"
  | "reportsTo"
  | "status"
  | "pauseReason"
  | "pausedAt"
  | "currentAdapterConfigRevisionId"
>;

interface ActorAuditColumns {
  actorKind: "board" | "agent" | "plugin";
  actorId: string;
  actorAgentId: string | null;
  actorUserId: string | null;
  actorPluginInstallationId: string | null;
  runId: string | null;
  taskExecutionRefId: string | null;
}

export class RuntimeAgentConfigurationInvalid extends Error {
  readonly code = "runtime_agent_configuration_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeAgentConfigurationInvalid";
  }
}

export class RuntimeAgentConfigurationDenied extends Error {
  readonly code = "runtime_agent_configuration_denied";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "RuntimeAgentConfigurationDenied";
  }
}

export class RuntimeAgentConfigurationConsentRequired
  extends RuntimeAgentConfigurationDenied {
  constructor(
    message: string,
    readonly targetAgentId: string,
    readonly displayedDiff: string,
  ) {
    super(message, "change_consent_required");
    this.name = "RuntimeAgentConfigurationConsentRequired";
  }
}

export class RuntimeAgentConfigurationConflict extends Error {
  readonly code = "runtime_agent_configuration_conflict";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeAgentConfigurationConflict";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new RuntimeAgentConfigurationInvalid(
      `${label} contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
}

function present(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new RuntimeAgentConfigurationInvalid("name must be a string");
  }
  const name = value.trim();
  if (!name) {
    throw new RuntimeAgentConfigurationInvalid("name must not be empty");
  }
  if (name.length > 160) {
    throw new RuntimeAgentConfigurationInvalid(
      "name must be at most 160 characters",
    );
  }
  if (!normalizeAgentUrlKey(name)) {
    throw new RuntimeAgentConfigurationInvalid(
      "name must contain at least one letter or digit",
    );
  }
  return name;
}

function parseNullableString(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RuntimeAgentConfigurationInvalid(
      `${label} must be a string or null`,
    );
  }
  return value;
}

function parseNullableAgentId(
  value: unknown,
  label: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isUuidLike(value)) {
    throw new RuntimeAgentConfigurationInvalid(
      `${label} must be a UUID or null`,
    );
  }
  return value;
}

function parseSparseGrantMap<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): SparseGrantMap<Key> {
  if (!isPlainRecord(value)) {
    throw new RuntimeAgentConfigurationInvalid(
      `${label} must be an object`,
    );
  }
  exactKeys(value, keys, label);
  const parsed: SparseGrantMap<Key> = {};
  for (const [key, granted] of Object.entries(value)) {
    if (typeof granted !== "boolean") {
      throw new RuntimeAgentConfigurationInvalid(
        `${label}.${key} must be boolean`,
      );
    }
    parsed[key as Key] = granted;
  }
  return parsed;
}

function parseConfigurationRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new RuntimeAgentConfigurationInvalid(
      "Runtime-agent configuration must be an object",
    );
  }
  exactKeys(value, CONFIGURATION_KEYS, "Runtime-agent configuration");
  return value;
}

export function parseRuntimeAgentCreateConfiguration(
  value: unknown,
): ParsedCreateConfiguration {
  const record = parseConfigurationRecord(value);
  if (!present(record, "name")) {
    throw new RuntimeAgentConfigurationInvalid("name is required");
  }
  return {
    name: parseName(record.name),
    title: present(record, "title")
      ? parseNullableString(record.title, "title")
      : null,
    capabilities: present(record, "capabilities")
      ? parseNullableString(record.capabilities, "capabilities")
      : null,
    reportsTo: present(record, "reportsTo")
      ? parseNullableAgentId(record.reportsTo, "reportsTo")
      : null,
    instruction: present(record, "instruction")
      ? parseNullableString(record.instruction, "instruction")
      : null,
    contextGrants: present(record, "contextGrants")
      ? parseSparseGrantMap(
        record.contextGrants,
        AGENT_CONTEXT_GRANT_KEYS,
        "contextGrants",
      )
      : {},
    actionGrants: present(record, "actionGrants")
      ? parseSparseGrantMap(
        record.actionGrants,
        PAPERCLIP_ACTION_KEYS,
        "actionGrants",
      )
      : {},
    mentionReachGrants: present(record, "mentionReachGrants")
      ? parseSparseGrantMap(
        record.mentionReachGrants,
        AGENT_MENTION_REACH_GRANT_KEYS,
        "mentionReachGrants",
      )
      : {},
  };
}

export function parseRuntimeAgentUpdateConfiguration(
  value: unknown,
): ParsedUpdateConfiguration {
  const record = parseConfigurationRecord(value);
  if (Object.keys(record).length === 0) {
    throw new RuntimeAgentConfigurationInvalid(
      "At least one runtime-agent configuration field is required",
    );
  }
  const parsed: ParsedUpdateConfiguration = {};
  if (present(record, "name")) parsed.name = parseName(record.name);
  if (present(record, "title")) {
    parsed.title = parseNullableString(record.title, "title");
  }
  if (present(record, "capabilities")) {
    parsed.capabilities = parseNullableString(
      record.capabilities,
      "capabilities",
    );
  }
  if (present(record, "reportsTo")) {
    parsed.reportsTo = parseNullableAgentId(record.reportsTo, "reportsTo");
  }
  if (present(record, "instruction")) {
    parsed.instruction = parseNullableString(
      record.instruction,
      "instruction",
    );
  }
  if (present(record, "contextGrants")) {
    parsed.contextGrants = parseSparseGrantMap(
      record.contextGrants,
      AGENT_CONTEXT_GRANT_KEYS,
      "contextGrants",
    );
  }
  if (present(record, "actionGrants")) {
    parsed.actionGrants = parseSparseGrantMap(
      record.actionGrants,
      PAPERCLIP_ACTION_KEYS,
      "actionGrants",
    );
  }
  if (present(record, "mentionReachGrants")) {
    parsed.mentionReachGrants = parseSparseGrantMap(
      record.mentionReachGrants,
      AGENT_MENTION_REACH_GRANT_KEYS,
      "mentionReachGrants",
    );
  }
  return parsed;
}

function canonicalValidationMessage(error: unknown): string {
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
function parseRuntimeAgentHireConfiguration(
  value: unknown,
): ParsedCreateConfiguration {
  const parsed = runtimeAgentHireConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeAgentConfigurationInvalid(
      canonicalValidationMessage(parsed.error),
    );
  }
  return parseRuntimeAgentCreateConfiguration({
    ...parsed.data,
    reportsTo: null,
  });
}

/** Provider-run configuration uses the same nonempty canonical patch. */
function parseRuntimeAgentConfigureConfiguration(
  value: unknown,
): ParsedUpdateConfiguration {
  const parsed = runtimeAgentUpdateConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeAgentConfigurationInvalid(
      canonicalValidationMessage(parsed.error),
    );
  }
  return parseRuntimeAgentUpdateConfiguration(parsed.data);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function runtimeAgentConfigurationDisplayedDiff(
  targetAgentId: string,
  before: RuntimeAgentConfigurationSnapshot,
  configuration: RuntimeAgentUpdateConfiguration,
): string {
  const requested = configuration as Record<string, unknown>;
  const beforeValues: Record<string, unknown> = {};
  const afterValues: Record<string, unknown> = {};
  for (const key of CONFIGURATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(requested, key)) continue;
    beforeValues[key] =
      key === "name"
      || key === "title"
      || key === "capabilities"
      || key === "reportsTo"
      || key === "instruction"
        ? before.identity[key]
        : before[key];
    afterValues[key] = requested[key];
  }
  const target = `agent:${targetAgentId}:configuration`;
  return [
    `--- ${target}`,
    `+++ ${target}`,
    `-${canonicalJson(beforeValues)}`,
    `+${canonicalJson(afterValues)}`,
  ].join("\n");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertNonempty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new RuntimeAgentConfigurationInvalid(`${label} must not be empty`);
  }
  return normalized;
}

function normalizedIdempotencyKey(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = assertNonempty(value, "idempotencyKey");
  if (normalized.length > 512) {
    throw new RuntimeAgentConfigurationInvalid(
      "idempotencyKey must be at most 512 characters",
    );
  }
  return normalized;
}

function actorAuditColumns(actor: InternalActor): ActorAuditColumns {
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

function grantActorColumns(actor: InternalActor): {
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

function trueGrantMap<Key extends string>(
  keys: readonly Key[],
  rows: readonly { key: Key }[],
): Partial<Record<Key, true>> {
  const presentKeys = new Set(rows.map((row) => row.key));
  return Object.fromEntries(
    keys
      .filter((key) => presentKeys.has(key))
      .map((key) => [key, true]),
  ) as Partial<Record<Key, true>>;
}

async function loadSnapshot(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
): Promise<RuntimeAgentConfigurationSnapshot> {
  const [agentRows, contextRows, actionRows, mentionRows] =
    await Promise.all([
      tx
        .select({
          name: agents.name,
          title: agents.title,
          capabilities: agents.capabilities,
          reportsTo: agents.reportsTo,
          instruction: agents.instruction,
        })
        .from(agents)
        .where(
          and(eq(agents.companyId, companyId), eq(agents.id, agentId)),
        )
        .limit(1),
      tx
        .select({ key: agentContextGrants.key })
        .from(agentContextGrants)
        .where(
          and(
            eq(agentContextGrants.companyId, companyId),
            eq(agentContextGrants.agentId, agentId),
          ),
        ),
      tx
        .select({ key: agentActionGrants.key })
        .from(agentActionGrants)
        .where(
          and(
            eq(agentActionGrants.companyId, companyId),
            eq(agentActionGrants.agentId, agentId),
          ),
        ),
      tx
        .select({ key: agentMentionReachGrants.key })
        .from(agentMentionReachGrants)
        .where(
          and(
            eq(agentMentionReachGrants.companyId, companyId),
            eq(agentMentionReachGrants.agentId, agentId),
          ),
        ),
    ]);
  const agent = agentRows[0];
  if (!agent) {
    throw new RuntimeAgentConfigurationConflict(
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
    mentionReachGrants: trueGrantMap(
      AGENT_MENTION_REACH_GRANT_KEYS,
      mentionRows,
    ),
  };
}

/**
 * Verifies that a hire approval still names the exact immutable audit whose
 * after-snapshot is the pending agent's current runtime configuration. This is
 * deliberately transaction-scoped so approval resolution can lock and
 * transition the agent without replaying any configuration bytes.
 */
export async function assertCurrentRuntimeAgentConfigurationAudit(
  tx: RuntimeAgentConfigurationTransaction,
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
    throw new RuntimeAgentConfigurationConflict(
      "Hire approval runtime-agent audit link is missing or does not match its request digest",
    );
  }
  const current = await loadSnapshot(tx, input.companyId, input.agentId);
  if (canonicalJson(current) !== canonicalJson(audit.afterSnapshot)) {
    throw new RuntimeAgentConfigurationConflict(
      "Pending agent runtime configuration no longer matches the linked immutable audit",
    );
  }
  return audit;
}

function snapshotsChangedKeys(
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
      (before &&
        (before.contextGrants[key] === true) !==
          (after.contextGrants[key] === true))
    ) {
      changed.push(`contextGrants.${key}`);
    }
  }
  for (const key of PAPERCLIP_ACTION_KEYS) {
    if (
      (!before && after.actionGrants[key] === true) ||
      (before &&
        (before.actionGrants[key] === true) !==
          (after.actionGrants[key] === true))
    ) {
      changed.push(`actionGrants.${key}`);
    }
  }
  for (const key of AGENT_MENTION_REACH_GRANT_KEYS) {
    if (
      (!before && after.mentionReachGrants[key] === true) ||
      (before &&
        (before.mentionReachGrants[key] === true) !==
          (after.mentionReachGrants[key] === true))
    ) {
      changed.push(`mentionReachGrants.${key}`);
    }
  }
  return changed;
}

function assertActorSource(
  actor: RuntimeAgentConfigurationControlActor,
  source: RuntimeAgentConfigurationControlSource,
): void {
  if (actor.kind === "plugin" && source !== "plugin_control") {
    throw new RuntimeAgentConfigurationInvalid(
      "Plugin actors require plugin_control source",
    );
  }
  if (actor.kind === "board" && source === "plugin_control") {
    throw new RuntimeAgentConfigurationInvalid(
      "Board actors cannot use plugin_control source",
    );
  }
  assertNonempty(actor.actorId, "actorId");
  if (
    actor.kind === "plugin" &&
    !isUuidLike(actor.pluginInstallationId)
  ) {
    throw new RuntimeAgentConfigurationInvalid(
      "pluginInstallationId must be a UUID",
    );
  }
  if (
    actor.kind === "board" &&
    actor.authorization.type !== "board"
  ) {
    throw new RuntimeAgentConfigurationDenied(
      "A board authorization actor is required",
      "actor_type_mismatch",
    );
  }
}

function assertReportsTo(
  agentId: string,
  reportsTo: string | null,
  companyAgents: readonly AgentRow[],
): void {
  if (!reportsTo) return;
  if (reportsTo === agentId) {
    throw new RuntimeAgentConfigurationInvalid(
      "Agent cannot be its own manager",
    );
  }
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const manager = byId.get(reportsTo);
  if (!manager || manager.status === "terminated") {
    throw new RuntimeAgentConfigurationInvalid(
      "reportsTo must identify a non-terminated agent in the same company",
    );
  }
  const seen = new Set<string>([agentId]);
  let cursor: AgentRow | undefined = manager;
  while (cursor) {
    if (seen.has(cursor.id)) {
      throw new RuntimeAgentConfigurationInvalid(
        "Reporting relationship would create a cycle",
      );
    }
    seen.add(cursor.id);
    cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : undefined;
    if (cursor?.status === "terminated") {
      throw new RuntimeAgentConfigurationInvalid(
        "Reporting relationship cannot traverse a terminated manager",
      );
    }
  }
}

function assertUniqueName(
  name: string,
  companyAgents: readonly AgentRow[],
  excludeAgentId?: string,
): void {
  const candidate = normalizeAgentUrlKey(name);
  const collision = companyAgents.some(
    (agent) =>
      agent.id !== excludeAgentId &&
      agent.status !== "terminated" &&
      normalizeAgentUrlKey(agent.name) === candidate,
  );
  if (collision) {
    throw new RuntimeAgentConfigurationConflict(
      `Agent shortname '${candidate}' is already in use in this company`,
    );
  }
}

async function lockCompanyAndAgents(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
): Promise<{ company: CompanyRow; agents: AgentRow[] }> {
  if (!isUuidLike(companyId)) {
    throw new RuntimeAgentConfigurationInvalid("companyId must be a UUID");
  }
  const locked = await lockCompanyAgentGraph(tx, companyId);
  const company = locked.company;
  if (!company) {
    throw new RuntimeAgentConfigurationInvalid("Company does not exist");
  }
  if (company.status !== "active") {
    throw new RuntimeAgentConfigurationDenied(
      "Company is not active",
      "company_inactive",
    );
  }
  return { company, agents: locked.agents };
}

async function assertRunActionAuthority(
  tx: RuntimeAgentConfigurationTransaction,
  actor: InternalAgentActor,
  action: "agent_hire" | "agent_configure",
  now: Date,
  company: CompanyRow,
  companyAgents: readonly AgentRow[],
): Promise<{ responsibleUserId: string | null }> {
  const { capability } = actor;
  if (capability.companyId !== company.id) {
    throw new RuntimeAgentConfigurationDenied(
      "Prompt capability is bound to a different company",
      "binding_mismatch",
    );
  }

  try {
    await lockActivePromptCapabilityBinding(tx, capability, now);
  } catch {
    throw new RuntimeAgentConfigurationDenied(
      "Prompt capability is inactive, expired, or no longer exact",
      "prompt_capability_invalid",
    );
  }

  const task = await tx
    .select({
      companyId: tasks.companyId,
      ownerKind: tasks.ownerKind,
      ownerAgentId: tasks.ownerAgentId,
      ownershipEpoch: tasks.ownershipEpoch,
      responsibleUserId: tasks.responsibleUserId,
    })
    .from(tasks)
    .where(eq(tasks.id, capability.taskId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !task ||
    task.companyId !== capability.companyId ||
    task.ownershipEpoch !== capability.ownershipEpoch
  ) {
    throw new RuntimeAgentConfigurationDenied(
      "Task ownership epoch has changed",
      "ownership_epoch_changed",
    );
  }
  if (
    capability.executionMode === "owner" &&
    (task.ownerKind !== "agent" ||
      task.ownerAgentId !== capability.targetAgentId)
  ) {
    throw new RuntimeAgentConfigurationDenied(
      "Run no longer owns the task",
      "owner_changed",
    );
  }

  const caller = companyAgents.find(
    (candidate) => candidate.id === capability.targetAgentId,
  );
  if (!caller) {
    throw new RuntimeAgentConfigurationDenied(
      "Agent no longer exists",
      "agent_not_found",
    );
  }
  const invokability = evaluateAgentInvokability(caller, [...companyAgents]);
  if (!invokability.invokable) {
    throw new RuntimeAgentConfigurationDenied(
      invokability.message,
      `agent_not_invokable:${invokability.reason}`,
    );
  }

  const actionRows = await tx
    .select({ id: agentActionGrants.id })
    .from(agentActionGrants)
    .where(
      and(
        eq(agentActionGrants.companyId, capability.companyId),
        eq(agentActionGrants.agentId, capability.targetAgentId),
        eq(agentActionGrants.key, action),
      ),
    )
    .for("update");
  if (actionRows.length !== 1) {
    throw new RuntimeAgentConfigurationDenied(
      `Current run no longer has ${action}`,
      "action_grant_missing",
    );
  }
  return { responsibleUserId: task.responsibleUserId };
}
async function lockAuthorizationRows(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
  actor: AuthorizationActor,
): Promise<void> {
  if (actor.type === "agent" && actor.agentId) {
    await tx
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalAgentId, actor.agentId),
          inArray(principalPermissionGrants.permissionKey, [
            "agents:configure",
            "agents:suggest-changes",
          ]),
        ),
      )
      .for("update");
    await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalAgentId, actor.agentId),
        ),
      )
      .for("update");
  } else if (actor.type === "board" && actor.userId) {
    await tx
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalUserId, actor.userId),
          inArray(principalPermissionGrants.permissionKey, [
            "agents:create",
            "agents:configure",
            "agents:suggest-changes",
          ]),
        ),
      )
      .for("update");
    await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalUserId, actor.userId),
        ),
      )
      .for("update");
  }
}

async function assertBoardAuthority(
  tx: RuntimeAgentConfigurationTransaction,
  actor: RuntimeAgentConfigurationBoardActor,
  companyId: string,
  operation: "create" | "update",
  targetAgentId: string | null,
): Promise<void> {
  await lockAuthorizationRows(tx, companyId, actor.authorization);
  const decision = await authorizationService(tx as unknown as Db).decide({
    actor: actor.authorization,
    action: operation === "create" ? "agents:create" : "agent_config:update",
    resource:
      operation === "create"
        ? { type: "company", companyId }
        : { type: "agent", companyId, agentId: targetAgentId },
    scope:
      operation === "update"
        ? {
          requiresChangeGrant: true,
          targetAgentId,
        }
        : undefined,
  });
  if (!decision.allowed) {
    throw new RuntimeAgentConfigurationDenied(
      decision.explanation,
      decision.reason,
    );
  }
}

async function assertPluginAuthority(
  tx: RuntimeAgentConfigurationTransaction,
  actor: RuntimeAgentConfigurationPluginActor,
  operation: "create" | "update",
  targetAgentId: string | null,
  changedKeys: readonly string[],
  options: RuntimeAgentConfigurationServiceOptions,
): Promise<void> {
  await tx.execute(
    sql`select ${plugins.id} from ${plugins} where ${plugins.id} = ${actor.pluginInstallationId} for update`,
  );
  const plugin = await tx
    .select({ status: plugins.status })
    .from(plugins)
    .where(eq(plugins.id, actor.pluginInstallationId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!plugin || plugin.status !== "ready") {
    throw new RuntimeAgentConfigurationDenied(
      "Plugin installation is not ready",
      "plugin_inactive",
    );
  }
  if (!options.assertPluginAuthority) {
    throw new RuntimeAgentConfigurationDenied(
      "Plugin runtime-agent configuration authority is not installed",
      "plugin_authority_unavailable",
    );
  }
  await options.assertPluginAuthority(tx, {
    actor,
    operation,
    targetAgentId,
    changedKeys,
  });
}

async function assertAgentConfigureAuthority(
  tx: RuntimeAgentConfigurationTransaction,
  actor: InternalAgentActor,
  responsibleUserId: string | null,
  targetAgentId: string,
  changedKeys: readonly string[],
  requiresProtectedGrant: boolean,
  displayedDiff: string,
  options: RuntimeAgentConfigurationServiceOptions,
): Promise<void> {
  const authorizationActor: AuthorizationActor = {
    type: "agent",
    agentId: actor.actorId,
    companyId: actor.capability.companyId,
    runId: actor.capability.runId,
    source: "internal",
    onBehalfOfUserId: responsibleUserId,
  };
  await lockAuthorizationRows(
    tx,
    actor.capability.companyId,
    authorizationActor,
  );
  const authz = authorizationService(tx as unknown as Db);
  const input = {
    actor: authorizationActor,
    action: "agent_config:update" as const,
    resource: {
      type: "agent" as const,
      companyId: actor.capability.companyId,
      agentId: targetAgentId,
    },
  };
  let decision = await authz.decide({
    ...input,
    scope: {
      requiresChangeGrant: requiresProtectedGrant,
      targetAgentId,
    },
  });
  if (
    !decision.allowed &&
    decision.reason === "deny_missing_consent" &&
    requiresProtectedGrant
  ) {
    if (!options.assertConsentedChange) {
      throw new RuntimeAgentConfigurationDenied(
        decision.explanation,
        decision.reason,
      );
    }
    try {
      await options.assertConsentedChange(tx, {
        capability: actor.capability,
        targetAgentId,
        changedKeys,
        displayedDiff,
      });
    } catch (error) {
      if (error instanceof RuntimeAgentConfigurationDenied) {
        throw error;
      }
      throw new RuntimeAgentConfigurationConsentRequired(
        error instanceof Error
          ? error.message
          : "Accepted change consent is unavailable",
        targetAgentId,
        displayedDiff,
      );
    }
    decision = await authz.decide({
      ...input,
      scope: {
        requiresChangeGrant: true,
        consentedChange: true,
        targetAgentId,
      },
    });
  }
  if (!decision.allowed) {
    throw new RuntimeAgentConfigurationDenied(
      decision.explanation,
      decision.reason,
    );
  }
}

async function replaceContextGrants(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
  values: SparseGrantMap<AgentContextGrantKey>,
  actor: InternalActor,
  now: Date,
): Promise<void> {
  await tx
    .delete(agentContextGrants)
    .where(
      and(
        eq(agentContextGrants.companyId, companyId),
        eq(agentContextGrants.agentId, agentId),
      ),
    );
  const keys = AGENT_CONTEXT_GRANT_KEYS.filter((key) => values[key] === true);
  if (keys.length > 0) {
    const provenance = grantActorColumns(actor);
    await tx.insert(agentContextGrants).values(
      keys.map((key) => ({
        companyId,
        agentId,
        key,
        ...provenance,
        createdAt: now,
      })),
    );
  }
}

async function replaceActionGrants(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
  values: SparseGrantMap<PaperclipActionKey>,
  actor: InternalActor,
  now: Date,
): Promise<void> {
  await tx
    .delete(agentActionGrants)
    .where(
      and(
        eq(agentActionGrants.companyId, companyId),
        eq(agentActionGrants.agentId, agentId),
      ),
    );
  const keys = PAPERCLIP_ACTION_KEYS.filter((key) => values[key] === true);
  if (keys.length > 0) {
    const provenance = grantActorColumns(actor);
    await tx.insert(agentActionGrants).values(
      keys.map((key) => ({
        companyId,
        agentId,
        key,
        ...provenance,
        createdAt: now,
      })),
    );
  }
}

async function replaceMentionReachGrants(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
  agentId: string,
  values: SparseGrantMap<AgentMentionReachGrantKey>,
  actor: InternalActor,
  now: Date,
): Promise<void> {
  await tx
    .delete(agentMentionReachGrants)
    .where(
      and(
        eq(agentMentionReachGrants.companyId, companyId),
        eq(agentMentionReachGrants.agentId, agentId),
      ),
    );
  const keys = AGENT_MENTION_REACH_GRANT_KEYS.filter(
    (key) => values[key] === true,
  );
  if (keys.length > 0) {
    const provenance = grantActorColumns(actor);
    await tx.insert(agentMentionReachGrants).values(
      keys.map((key) => ({
        companyId,
        agentId,
        key,
        ...provenance,
        createdAt: now,
      })),
    );
  }
}

function updateChangedIdentityKeys(
  before: RuntimeAgentConfigurationSnapshot,
  configuration: ParsedUpdateConfiguration,
): string[] {
  const keys: string[] = [];
  if (
    configuration.name !== undefined &&
    configuration.name !== before.identity.name
  ) {
    keys.push("name");
  }
  if (
    configuration.title !== undefined &&
    configuration.title !== before.identity.title
  ) {
    keys.push("title");
  }
  if (
    configuration.capabilities !== undefined &&
    configuration.capabilities !== before.identity.capabilities
  ) {
    keys.push("capabilities");
  }
  if (
    configuration.reportsTo !== undefined &&
    configuration.reportsTo !== before.identity.reportsTo
  ) {
    keys.push("reportsTo");
  }
  return keys;
}

async function findIdempotentResult(
  tx: RuntimeAgentConfigurationTransaction,
  companyId: string,
  idempotencyKey: string | null,
  requestDigest: string,
): Promise<RuntimeAgentConfigurationResult | null> {
  if (!idempotencyKey) return null;
  const row = await tx
    .select({
      id: runtimeAgentConfigurationAudits.id,
      agentId: runtimeAgentConfigurationAudits.agentId,
      requestDigest: runtimeAgentConfigurationAudits.requestDigest,
      afterSnapshot: runtimeAgentConfigurationAudits.afterSnapshot,
    })
    .from(runtimeAgentConfigurationAudits)
    .where(
      and(
        eq(runtimeAgentConfigurationAudits.companyId, companyId),
        eq(
          runtimeAgentConfigurationAudits.idempotencyKey,
          idempotencyKey,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  if (row.requestDigest !== requestDigest) {
    throw new RuntimeAgentConfigurationConflict(
      "Idempotency key was already used for a different runtime-agent configuration request",
    );
  }
  const approvalId = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.type, "hire_agent"),
        sql`${approvals.payload} ->> 'runtimeAgentConfigurationAuditId' = ${row.id}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0]?.id ?? null);
  return {
    agentId: row.agentId,
    companyId,
    configuration: row.afterSnapshot,
    auditId: row.id,
    approvalId,
    retried: true,
  };
}

function hireApprovalPayload(
  actor: Exclude<InternalActor, RuntimeAgentConfigurationBoardActor>,
  agentId: string,
  auditId: string,
  requestDigest: string,
): HireAgentApprovalPayload {
  return {
    contract: "paperclip.hire-approval/v1",
    agentId,
    runtimeAgentConfigurationAuditId: auditId,
    runtimeAgentConfigurationRequestDigest: requestDigest,
    source:
      actor.kind === "agent"
        ? {
            kind: "agent_run",
            taskId: actor.capability.taskId,
            runId: actor.capability.runId,
            taskExecutionRefId: actor.capability.refId,
          }
        : {
            kind: "plugin_control",
            pluginInstallationId: actor.pluginInstallationId,
          },
  };
}

function sourceForActor(
  actor: InternalActor,
  controlSource?: RuntimeAgentConfigurationControlSource,
): "board" | "onboarding" | "agent_hire" | "agent_configure" | "plugin_control" {
  if (actor.kind === "agent") {
    return controlSource === undefined
      ? "agent_configure"
      : (() => {
        throw new RuntimeAgentConfigurationInvalid(
          "Agent run cannot choose a control-plane source",
        );
      })();
  }
  if (!controlSource) {
    throw new RuntimeAgentConfigurationInvalid(
      "Control-plane source is required",
    );
  }
  return controlSource;
}

export function createRuntimeAgentConfigurationService(
  db: Db,
  options: RuntimeAgentConfigurationServiceOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  async function createInTransactionInternal(
    tx: RuntimeAgentConfigurationTransaction,
    input: {
      companyId: string;
      actor: InternalActor;
      source:
        | "board"
        | "onboarding"
        | "agent_hire"
        | "plugin_control";
      configuration: ParsedCreateConfiguration;
      idempotencyKey: string | null;
    },
  ): Promise<RuntimeAgentConfigurationResult> {
    const requestDigest = sha256({
      operation: "create",
      companyId: input.companyId,
      source: input.source,
      actor: actorAuditColumns(input.actor),
      configuration: input.configuration,
    });
    const now = clock();
    const locked = await lockCompanyAndAgents(tx, input.companyId);
    let responsibleUserId: string | null = null;
    if (input.actor.kind === "agent") {
      responsibleUserId = (
        await assertRunActionAuthority(
          tx,
          input.actor,
          "agent_hire",
          now,
          locked.company,
          locked.agents,
        )
      ).responsibleUserId;
    }
    if (input.actor.kind === "board") {
      await assertBoardAuthority(
        tx,
        input.actor,
        input.companyId,
        "create",
        null,
      );
    } else if (input.actor.kind === "plugin") {
      await assertPluginAuthority(
        tx,
        input.actor,
        "create",
        null,
        CONFIGURATION_KEYS,
        options,
      );
    } else if (responsibleUserId) {
      // The run-bound hire action itself is the creation authority. The
      // responsible-user intersection is applied to protected configure
      // operations, not used to invent a second agents:create requirement.
    }

    const retry = await findIdempotentResult(
      tx,
      input.companyId,
      input.idempotencyKey,
      requestDigest,
    );
    if (retry) return retry;

    const agentId = idFactory();
    if (!isUuidLike(agentId)) {
      throw new RuntimeAgentConfigurationInvalid(
        "idFactory must produce UUIDs",
      );
    }
    const reportsTo =
      input.actor.kind === "agent"
        ? input.actor.actorId
        : input.configuration.reportsTo;
    assertUniqueName(input.configuration.name, locked.agents);
    assertReportsTo(agentId, reportsTo, locked.agents);

    const requiresApproval =
      input.actor.kind !== "board" &&
      locked.company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    await budgetService(tx as unknown as Db).createAgentInTransaction({
      id: agentId,
      companyId: input.companyId,
      name: input.configuration.name,
      title: input.configuration.title,
      capabilities: input.configuration.capabilities,
      reportsTo,
      status,
      createdAt: now,
      updatedAt: now,
    }, actorAuditColumns(input.actor).actorUserId);
    await replaceContextGrants(
      tx,
      input.companyId,
      agentId,
      input.configuration.contextGrants,
      input.actor,
      now,
    );
    await replaceActionGrants(
      tx,
      input.companyId,
      agentId,
      input.configuration.actionGrants,
      input.actor,
      now,
    );
    await replaceMentionReachGrants(
      tx,
      input.companyId,
      agentId,
      input.configuration.mentionReachGrants,
      input.actor,
      now,
    );
    const after = await loadSnapshot(tx, input.companyId, agentId);
    const auditId = idFactory();
    const actorColumns = actorAuditColumns(input.actor);
    await tx.insert(runtimeAgentConfigurationAudits).values({
      id: auditId,
      companyId: input.companyId,
      agentId,
      operation: "create",
      source: input.source,
      ...actorColumns,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      changedKeys: snapshotsChangedKeys(null, after),
      beforeSnapshot: null,
      afterSnapshot: after,
      createdAt: now,
    });
    let approvalId: string | null = null;
    if (requiresApproval) {
      approvalId = idFactory();
      if (!isUuidLike(approvalId)) {
        throw new RuntimeAgentConfigurationInvalid(
          "idFactory must produce UUIDs",
        );
      }
      const actor = input.actor as Exclude<
        InternalActor,
        RuntimeAgentConfigurationBoardActor
      >;
      await tx.insert(approvals).values({
        id: approvalId,
        companyId: input.companyId,
        type: "hire_agent",
        requestedByAgentId:
          actor.kind === "agent" ? actor.actorId : null,
        requestedByUserId: null,
        status: "pending",
        payload: hireApprovalPayload(
          actor,
          agentId,
          auditId,
          requestDigest,
        ),
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      agentId,
      companyId: input.companyId,
      configuration: after,
      auditId,
      approvalId,
      retried: false,
    };
  }

  async function createInternal(input: {
    companyId: string;
    actor: InternalActor;
    source:
      | "board"
      | "onboarding"
      | "agent_hire"
      | "plugin_control";
    configuration: ParsedCreateConfiguration;
    idempotencyKey: string | null;
  }): Promise<RuntimeAgentConfigurationResult> {
    return db.transaction((tx) => createInTransactionInternal(tx, input));
  }

  async function updateInternal(input: {
    companyId: string;
    targetAgentId: string;
    actor: InternalActor;
    source: "board" | "onboarding" | "agent_configure" | "plugin_control";
    configuration: ParsedUpdateConfiguration;
    idempotencyKey: string | null;
  }): Promise<RuntimeAgentConfigurationResult> {
    if (!isUuidLike(input.targetAgentId)) {
      throw new RuntimeAgentConfigurationInvalid(
        "targetAgentId must be a UUID",
      );
    }
    const requestDigest = sha256({
      operation: "update",
      companyId: input.companyId,
      targetAgentId: input.targetAgentId,
      source: input.source,
      actor: actorAuditColumns(input.actor),
      configuration: input.configuration,
    });
    return db.transaction(async (tx) => {
      const now = clock();
      const locked = await lockCompanyAndAgents(tx, input.companyId);
      let responsibleUserId: string | null = null;
      if (input.actor.kind === "agent") {
        responsibleUserId = (
          await assertRunActionAuthority(
            tx,
            input.actor,
            "agent_configure",
            now,
            locked.company,
            locked.agents,
          )
        ).responsibleUserId;
      }

      const retry = await findIdempotentResult(
        tx,
        input.companyId,
        input.idempotencyKey,
        requestDigest,
      );
      if (retry) return retry;

      const target = locked.agents.find(
        (candidate) => candidate.id === input.targetAgentId,
      );
      if (!target || target.status === "terminated") {
        throw new RuntimeAgentConfigurationInvalid(
          "Runtime-agent configuration target must be a non-terminated agent in the same company",
        );
      }
      const openHireApproval =
        target.status === "paused" &&
        target.pauseReason === "system"
          ? await tx
              .select({ id: approvals.id })
              .from(approvals)
              .where(
                and(
                  eq(approvals.companyId, input.companyId),
                  eq(approvals.type, "hire_agent"),
                  inArray(approvals.status, [
                    "pending",
                    "revision_requested",
                  ]),
                  sql`${approvals.payload} ->> 'agentId' = ${target.id}`,
                ),
              )
              .orderBy(asc(approvals.id))
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      if (target.status === "pending_approval" || openHireApproval) {
        throw new RuntimeAgentConfigurationConflict(
          "Pending hire configuration can be changed only through its exact linked approval resubmission",
        );
      }
      const before = await loadSnapshot(
        tx,
        input.companyId,
        input.targetAgentId,
      );
      const changedIdentityKeys = updateChangedIdentityKeys(
        before,
        input.configuration,
      );
      const requestedKeys = Object.keys(input.configuration).sort();
      const displayedDiff = runtimeAgentConfigurationDisplayedDiff(
        input.targetAgentId,
        before,
        input.configuration,
      );

      if (input.actor.kind === "board") {
        await assertBoardAuthority(
          tx,
          input.actor,
          input.companyId,
          "update",
          input.targetAgentId,
        );
      } else if (input.actor.kind === "plugin") {
        await assertPluginAuthority(
          tx,
          input.actor,
          "update",
          input.targetAgentId,
          requestedKeys,
          options,
        );
      } else {
        const isSelf = input.targetAgentId === input.actor.actorId;
        const requiresProtectedGrant =
          !isSelf ||
          changedIdentityKeys.some((key) =>
            PROTECTED_SELF_IDENTITY_KEYS.has(key)
          );
        await assertAgentConfigureAuthority(
          tx,
          input.actor,
          responsibleUserId,
          input.targetAgentId,
          requestedKeys,
          requiresProtectedGrant,
          displayedDiff,
          options,
        );
      }

      if (input.configuration.name !== undefined) {
        assertUniqueName(
          input.configuration.name,
          locked.agents,
          input.targetAgentId,
        );
      }
      if (input.configuration.reportsTo !== undefined) {
        assertReportsTo(
          input.targetAgentId,
          input.configuration.reportsTo,
          locked.agents,
        );
      }

      const identityPatch: Partial<typeof agents.$inferInsert> = {
        updatedAt: now,
      };
      if (input.configuration.name !== undefined) {
        identityPatch.name = input.configuration.name;
      }
      if (input.configuration.title !== undefined) {
        identityPatch.title = input.configuration.title;
      }
      if (input.configuration.capabilities !== undefined) {
        identityPatch.capabilities = input.configuration.capabilities;
      }
      if (input.configuration.reportsTo !== undefined) {
        identityPatch.reportsTo = input.configuration.reportsTo;
      }
      if (input.configuration.instruction !== undefined) {
        identityPatch.instruction = input.configuration.instruction;
      }
      await tx
        .update(agents)
        .set(identityPatch)
        .where(
          and(
            eq(agents.companyId, input.companyId),
            eq(agents.id, input.targetAgentId),
          ),
        );
      if (input.configuration.contextGrants !== undefined) {
        await replaceContextGrants(
          tx,
          input.companyId,
          input.targetAgentId,
          input.configuration.contextGrants,
          input.actor,
          now,
        );
      }
      if (input.configuration.actionGrants !== undefined) {
        await replaceActionGrants(
          tx,
          input.companyId,
          input.targetAgentId,
          input.configuration.actionGrants,
          input.actor,
          now,
        );
      }
      if (input.configuration.mentionReachGrants !== undefined) {
        await replaceMentionReachGrants(
          tx,
          input.companyId,
          input.targetAgentId,
          input.configuration.mentionReachGrants,
          input.actor,
          now,
        );
      }
      const after = await loadSnapshot(
        tx,
        input.companyId,
        input.targetAgentId,
      );
      const auditId = idFactory();
      const actorColumns = actorAuditColumns(input.actor);
      await tx.insert(runtimeAgentConfigurationAudits).values({
        id: auditId,
        companyId: input.companyId,
        agentId: input.targetAgentId,
        operation: "update",
        source: input.source,
        ...actorColumns,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        changedKeys: snapshotsChangedKeys(before, after),
        beforeSnapshot: before,
        afterSnapshot: after,
        createdAt: now,
      });
      return {
        agentId: input.targetAgentId,
        companyId: input.companyId,
        configuration: after,
        auditId,
        approvalId: null,
        retried: false,
      };
    });
  }

  async function resubmitHireApprovalInternal(input: {
    approvalId: string;
    actor: RuntimeAgentConfigurationBoardActor;
    expectedAgentId: string;
    expectedAuditId: string;
    expectedRequestDigest: string;
    configuration: ParsedCreateConfiguration;
  }) {
    if (
      !isUuidLike(input.approvalId) ||
      !isUuidLike(input.expectedAgentId) ||
      !isUuidLike(input.expectedAuditId) ||
      !/^[a-f0-9]{64}$/.test(input.expectedRequestDigest)
    ) {
      throw new RuntimeAgentConfigurationInvalid(
        "Hire approval resubmission identifiers are invalid",
      );
    }
    const idempotencyKey =
      `hire_approval_resubmit:${input.approvalId}:${input.expectedAuditId}`;
    return db.transaction(async (tx) => {
      const candidateApproval = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, input.approvalId))
        .then((rows) => rows[0] ?? null);
      if (!candidateApproval || candidateApproval.type !== "hire_agent") {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission target does not exist",
        );
      }
      const locked = await lockCompanyAndAgents(
        tx,
        candidateApproval.companyId,
      );
      const existingApproval = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, input.approvalId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existingApproval || existingApproval.type !== "hire_agent") {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission target does not exist",
        );
      }
      const existingPayload = hireAgentApprovalPayloadSchema.safeParse(
        existingApproval.payload,
      );
      if (!existingPayload.success) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval is missing its canonical runtime-agent link",
        );
      }
      await assertBoardAuthority(
        tx,
        input.actor,
        existingApproval.companyId,
        "update",
        existingPayload.data.agentId,
      );

      const requestDigest = sha256({
        operation: "update",
        companyId: existingApproval.companyId,
        targetAgentId: existingPayload.data.agentId,
        source: "agent_hire",
        actor: actorAuditColumns(input.actor),
        approvalId: existingApproval.id,
        expectedAgentId: input.expectedAgentId,
        supersededAuditId: input.expectedAuditId,
        supersededRequestDigest: input.expectedRequestDigest,
        configuration: input.configuration,
      });
      const retry = await findIdempotentResult(
        tx,
        existingApproval.companyId,
        idempotencyKey,
        requestDigest,
      );
      if (
        retry &&
        existingPayload.data.runtimeAgentConfigurationAuditId ===
          retry.auditId
      ) {
        return {
          ...retry,
          approvalId: existingApproval.id,
        };
      }

      if (existingApproval.status !== "revision_requested") {
        throw new RuntimeAgentConfigurationConflict(
          "Only a revision-requested hire approval can be resubmitted",
        );
      }
      if (
        existingPayload.data.agentId !== input.expectedAgentId ||
        existingPayload.data.runtimeAgentConfigurationAuditId !==
          input.expectedAuditId ||
        existingPayload.data.runtimeAgentConfigurationRequestDigest !==
          input.expectedRequestDigest
      ) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission does not match the current immutable audit/digest",
        );
      }

      const target = locked.agents.find(
        (candidate) => candidate.id === input.expectedAgentId,
      );
      if (
        !target ||
        (
          target.status !== "pending_approval" &&
          !(
            target.status === "paused" &&
            target.pauseReason === "system"
          )
        )
      ) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission requires its existing pending or system-paused agent",
        );
      }
      if (input.configuration.reportsTo !== target.reportsTo) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission cannot change the creation-time reporting edge",
        );
      }
      const supersededAudit =
        await assertCurrentRuntimeAgentConfigurationAudit(tx, {
          companyId: existingApproval.companyId,
          agentId: target.id,
          auditId: input.expectedAuditId,
          requestDigest: input.expectedRequestDigest,
        });
      const before = supersededAudit.afterSnapshot;

      assertUniqueName(
        input.configuration.name,
        locked.agents,
        target.id,
      );
      assertReportsTo(
        target.id,
        input.configuration.reportsTo,
        locked.agents,
      );
      const now = clock();
      const updatedTarget = await tx
        .update(agents)
        .set({
          name: input.configuration.name,
          title: input.configuration.title,
          capabilities: input.configuration.capabilities,
          reportsTo: target.reportsTo,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.companyId, existingApproval.companyId),
            eq(agents.id, target.id),
            eq(agents.status, target.status),
            target.status === "paused"
              ? eq(agents.pauseReason, "system")
              : undefined,
          ),
        )
        .returning({ id: agents.id })
        .then((rows) => rows[0] ?? null);
      if (!updatedTarget) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission lost its locked agent transition",
        );
      }
      await replaceContextGrants(
        tx,
        existingApproval.companyId,
        target.id,
        input.configuration.contextGrants,
        input.actor,
        now,
      );
      await replaceActionGrants(
        tx,
        existingApproval.companyId,
        target.id,
        input.configuration.actionGrants,
        input.actor,
        now,
      );
      await replaceMentionReachGrants(
        tx,
        existingApproval.companyId,
        target.id,
        input.configuration.mentionReachGrants,
        input.actor,
        now,
      );

      const after = await loadSnapshot(
        tx,
        existingApproval.companyId,
        target.id,
      );
      const auditId = idFactory();
      if (!isUuidLike(auditId)) {
        throw new RuntimeAgentConfigurationInvalid(
          "idFactory must produce UUIDs",
        );
      }
      await tx.insert(runtimeAgentConfigurationAudits).values({
        id: auditId,
        companyId: existingApproval.companyId,
        agentId: target.id,
        operation: "update",
        source: "agent_hire",
        ...actorAuditColumns(input.actor),
        idempotencyKey,
        requestDigest,
        changedKeys: snapshotsChangedKeys(before, after),
        beforeSnapshot: before,
        afterSnapshot: after,
        createdAt: now,
      });
      const nextPayload: HireAgentApprovalPayload = {
        ...existingPayload.data,
        runtimeAgentConfigurationAuditId: auditId,
        runtimeAgentConfigurationRequestDigest: requestDigest,
      };
      const updatedApproval = await tx
        .update(approvals)
        .set({
          status: "pending",
          payload: nextPayload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, existingApproval.id),
            eq(approvals.status, "revision_requested"),
          ),
        )
        .returning({ id: approvals.id })
        .then((rows) => rows[0] ?? null);
      if (!updatedApproval) {
        throw new RuntimeAgentConfigurationConflict(
          "Hire approval resubmission lost its locked transition",
        );
      }
      return {
        agentId: target.id,
        companyId: existingApproval.companyId,
        configuration: after,
        auditId,
        approvalId: existingApproval.id,
        retried: false,
      } satisfies RuntimeAgentConfigurationResult;
    });
  }

  return {
    async get(input: {
      companyId: string;
      targetAgentId: string;
    }): Promise<RuntimeAgentConfigurationSnapshot> {
      if (!isUuidLike(input.targetAgentId)) {
        throw new RuntimeAgentConfigurationInvalid(
          "targetAgentId must be a UUID",
        );
      }
      return db.transaction((tx) =>
        loadSnapshot(tx, input.companyId, input.targetAgentId),
      );
    },

    async create(input: {
      companyId: string;
      actor: RuntimeAgentConfigurationControlActor;
      source: RuntimeAgentConfigurationControlSource;
      configuration: RuntimeAgentCreateConfiguration | unknown;
      idempotencyKey?: string | null;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, input.source);
      return createInternal({
        companyId: input.companyId,
        actor: input.actor,
        source: input.source,
        configuration: parseRuntimeAgentCreateConfiguration(
          input.configuration,
        ),
        idempotencyKey: normalizedIdempotencyKey(input.idempotencyKey),
      });
    },

    /**
     * Canonical create path for a larger atomic control-plane transition.
     * Callers own the surrounding transaction; this method owns the same
     * locks, authorization, grants, selections, audit, and approval record as
     * `create` without opening a nested transaction.
     */
    async createInTransaction(input: {
      transaction: RuntimeAgentConfigurationTransaction;
      companyId: string;
      actor: RuntimeAgentConfigurationControlActor;
      source: RuntimeAgentConfigurationControlSource;
      configuration: RuntimeAgentCreateConfiguration | unknown;
      idempotencyKey?: string | null;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, input.source);
      return createInTransactionInternal(input.transaction, {
        companyId: input.companyId,
        actor: input.actor,
        source: input.source,
        configuration: parseRuntimeAgentCreateConfiguration(
          input.configuration,
        ),
        idempotencyKey: normalizedIdempotencyKey(input.idempotencyKey),
      });
    },

    async update(input: {
      companyId: string;
      targetAgentId: string;
      actor: RuntimeAgentConfigurationControlActor;
      source: RuntimeAgentConfigurationControlSource;
      configuration: RuntimeAgentUpdateConfiguration | unknown;
      idempotencyKey?: string | null;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, input.source);
      return updateInternal({
        companyId: input.companyId,
        targetAgentId: input.targetAgentId,
        actor: input.actor,
        source: input.source,
        configuration: parseRuntimeAgentUpdateConfiguration(
          input.configuration,
        ),
        idempotencyKey: normalizedIdempotencyKey(input.idempotencyKey),
      });
    },

    async hireFromRun(input: {
      capability: PromptCapabilityBinding;
      invocationId: string;
      configuration: RuntimeAgentHireConfigurationInput;
    }): Promise<RuntimeAgentConfigurationResult> {
      const invocationId = assertNonempty(
        input.invocationId,
        "invocationId",
      );
      const parsed = parseRuntimeAgentHireConfiguration(input.configuration);
      return createInternal({
        companyId: input.capability.companyId,
        actor: {
          kind: "agent",
          actorId: input.capability.targetAgentId,
          capability: input.capability,
          invocationId,
        },
        source: "agent_hire",
        configuration: {
          ...parsed,
          reportsTo: input.capability.targetAgentId,
        },
        idempotencyKey: `agent_hire:${promptCapabilityGenerationIdentity(input.capability)}:${invocationId}`,
      });
    },

    async configureFromRun(input: {
      capability: PromptCapabilityBinding;
      invocationId: string;
      targetAgentId: string;
      configuration: RuntimeAgentUpdateConfigurationInput;
    }): Promise<RuntimeAgentConfigurationResult> {
      const invocationId = assertNonempty(
        input.invocationId,
        "invocationId",
      );
      return updateInternal({
        companyId: input.capability.companyId,
        targetAgentId: input.targetAgentId,
        actor: {
          kind: "agent",
          actorId: input.capability.targetAgentId,
          capability: input.capability,
          invocationId,
        },
        source: "agent_configure",
        configuration: parseRuntimeAgentConfigureConfiguration(
          input.configuration,
        ),
        idempotencyKey: `agent_configure:${promptCapabilityGenerationIdentity(input.capability)}:${invocationId}`,
      });
    },

    async resubmitHireApproval(input: {
      approvalId: string;
      actor: RuntimeAgentConfigurationBoardActor;
      expectedAgentId: string;
      expectedAuditId: string;
      expectedRequestDigest: string;
      configuration: RuntimeAgentCreateConfiguration | unknown;
    }): Promise<RuntimeAgentConfigurationResult> {
      assertActorSource(input.actor, "board");
      return resubmitHireApprovalInternal({
        ...input,
        configuration: parseRuntimeAgentCreateConfiguration(
          input.configuration,
        ),
      });
    },
  };
}

export type RuntimeAgentConfigurationService = ReturnType<
  typeof createRuntimeAgentConfigurationService
>;
