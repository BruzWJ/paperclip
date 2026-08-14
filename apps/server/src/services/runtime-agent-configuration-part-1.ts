import { agents, companies, type Db, type RuntimeAgentConfigurationSnapshot } from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  isCanonicalUuid,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { type AuthorizationActor } from "./authorization.js";
import { type PromptCapabilityBinding } from "./prompt-capability-gateway.js";

export type RuntimeAgentConfigurationTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CONFIGURATION_KEYS = [
  "name",
  "title",
  "capabilities",
  "reportsTo",
  "instruction",
  "contextGrants",
  "actionGrants",
  "mentionReachGrants",
] as const;

export const PROTECTED_SELF_IDENTITY_KEYS = new Set(["name", "title", "capabilities", "instruction"]);

export type SparseGrantMap<Key extends string> = Partial<Record<Key, boolean>>;

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
  RuntimeAgentConfigurationBoardActor | RuntimeAgentConfigurationPluginActor;

export type RuntimeAgentConfigurationControlSource = "board" | "onboarding" | "plugin_control";

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

export interface InternalAgentActor {
  kind: "agent";
  actorId: string;
  capability: PromptCapabilityBinding;
  invocationId: string;
}

export type InternalActor = RuntimeAgentConfigurationControlActor | InternalAgentActor;

export interface ParsedCreateConfiguration {
  name: string;
  title: string | null;
  capabilities: string | null;
  reportsTo: string | null;
  instruction: string | null;
  contextGrants: SparseGrantMap<AgentContextGrantKey>;
  actionGrants: SparseGrantMap<PaperclipActionKey>;
  mentionReachGrants: SparseGrantMap<AgentMentionReachGrantKey>;
}

export interface ParsedUpdateConfiguration extends RuntimeAgentUpdateConfiguration {}

export type CompanyRow = typeof companies.$inferSelect;

export type AgentRow = Pick<
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

export interface ActorAuditColumns {
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

export class RuntimeAgentConfigurationConsentRequired extends RuntimeAgentConfigurationDenied {
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

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new RuntimeAgentConfigurationInvalid(
      `${label} contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
}

export function present(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new RuntimeAgentConfigurationInvalid("name must be a string");
  }
  const name = value.trim();
  if (!name) {
    throw new RuntimeAgentConfigurationInvalid("name must not be empty");
  }
  if (name.length > 160) {
    throw new RuntimeAgentConfigurationInvalid("name must be at most 160 characters");
  }
  return name;
}

export function parseNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RuntimeAgentConfigurationInvalid(`${label} must be a string or null`);
  }
  return value;
}

export function parseNullableAgentId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isCanonicalUuid(value)) {
    throw new RuntimeAgentConfigurationInvalid(`${label} must be a UUID or null`);
  }
  return value;
}

export function parseSparseGrantMap<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): SparseGrantMap<Key> {
  if (!isPlainRecord(value)) {
    throw new RuntimeAgentConfigurationInvalid(`${label} must be an object`);
  }
  exactKeys(value, keys, label);
  const parsed: SparseGrantMap<Key> = {};
  for (const [key, granted] of Object.entries(value)) {
    if (typeof granted !== "boolean") {
      throw new RuntimeAgentConfigurationInvalid(`${label}.${key} must be boolean`);
    }
    parsed[key as Key] = granted;
  }
  return parsed;
}

export function parseConfigurationRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new RuntimeAgentConfigurationInvalid("Runtime-agent configuration must be an object");
  }
  exactKeys(value, CONFIGURATION_KEYS, "Runtime-agent configuration");
  return value;
}

export function parseRuntimeAgentCreateConfiguration(value: unknown): ParsedCreateConfiguration {
  const record = parseConfigurationRecord(value);
  if (!present(record, "name")) {
    throw new RuntimeAgentConfigurationInvalid("name is required");
  }
  return {
    name: parseName(record.name),
    title: present(record, "title") ? parseNullableString(record.title, "title") : null,
    capabilities: present(record, "capabilities")
      ? parseNullableString(record.capabilities, "capabilities")
      : null,
    reportsTo: present(record, "reportsTo") ? parseNullableAgentId(record.reportsTo, "reportsTo") : null,
    instruction: present(record, "instruction")
      ? parseNullableString(record.instruction, "instruction")
      : null,
    contextGrants: present(record, "contextGrants")
      ? parseSparseGrantMap(record.contextGrants, AGENT_CONTEXT_GRANT_KEYS, "contextGrants")
      : {},
    actionGrants: present(record, "actionGrants")
      ? parseSparseGrantMap(record.actionGrants, PAPERCLIP_ACTION_KEYS, "actionGrants")
      : {},
    mentionReachGrants: present(record, "mentionReachGrants")
      ? parseSparseGrantMap(record.mentionReachGrants, AGENT_MENTION_REACH_GRANT_KEYS, "mentionReachGrants")
      : {},
  };
}
