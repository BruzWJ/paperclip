import { runInterfaceToolCalls, taskExecutionPromptCapabilities, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  type PromptCapabilityBinding,
  type PromptCapabilityCallIdentity,
  type PromptCapabilityIngressBinding,
} from "./prompt-capability-gateway.js";
import type { CompiledRunToolDescriptor } from "./runtime-interface-compiler.js";

export type ToolCallRow = typeof runInterfaceToolCalls.$inferSelect;

export type CapabilityRow = typeof taskExecutionPromptCapabilities.$inferSelect;

export type RuntimeToolCallTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Tool arguments contain a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Tool arguments must contain only JSON values");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function argumentsDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value === undefined ? null : value))
    .digest("hex");
}

export function assertIngressOrdinal(ingressOrdinal: number): void {
  if (!Number.isSafeInteger(ingressOrdinal) || ingressOrdinal < 0) {
    throw new RuntimeToolCallIdentityConflict("Tool-call ingress ordinal must be a nonnegative safe integer");
  }
}

export function serializedError(error: unknown): NonNullable<ToolCallRow["error"]> {
  const source = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
    reasonCode?: unknown;
    details?: unknown;
  };
  return {
    name: typeof source?.name === "string" ? source.name : "Error",
    message: typeof source?.message === "string" ? source.message : String(error),
    ...(typeof source?.code === "string" ? { code: source.code } : {}),
    ...(typeof source?.status === "number" ? { status: source.status } : {}),
    ...(typeof source?.reasonCode === "string" ? { reasonCode: source.reasonCode } : {}),
    ...(source?.details && typeof source.details === "object" && !Array.isArray(source.details)
      ? {
          details: source.details as Record<string, unknown>,
        }
      : {}),
  };
}

export class RuntimeToolCallIdentityConflict extends Error {
  readonly code = "runtime_tool_call_identity_conflict";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeToolCallIdentityConflict";
  }
}

export class RuntimeToolCallInProgress extends Error {
  readonly code = "runtime_tool_call_in_progress";

  constructor() {
    super("This exact tool call is already executing");
    this.name = "RuntimeToolCallInProgress";
  }
}

export interface RuntimeToolCallBinding {
  readonly name: string;
  readonly pluginInstallationId?: string;
}

export interface RuntimeToolCallIdentityParts {
  readonly source: ToolCallRow["callIdentitySource"];
  readonly type: ToolCallRow["callIdentityType"];
  readonly value: string;
}

export type RuntimeToolCallClaim =
  | { state: "claimed"; id: string }
  | { state: "completed"; result: unknown }
  | {
      state: "failed";
      error: NonNullable<ToolCallRow["error"]>;
    }
  | { state: "executing" };

export type RuntimeToolCallClaimClassification =
  | { readonly classification: "non_mention" }
  | {
      readonly classification: "validated_mention";
      readonly targetAgentId: string;
    };

export function promptIdentityParts(
  callIdentity: PromptCapabilityCallIdentity,
): RuntimeToolCallIdentityParts {
  const type = typeof callIdentity.id;
  if (type !== "string" && type !== "number") {
    throw new RuntimeToolCallIdentityConflict("Tool call identity must be a string or number");
  }
  return {
    source: callIdentity.source,
    type,
    value: String(callIdentity.id),
  };
}

export function ingressIdentityParts(ingressOrdinal: number): RuntimeToolCallIdentityParts {
  return {
    source: "ingress",
    type: "ordinal",
    value: String(ingressOrdinal),
  };
}

export function sameBinding(row: ToolCallRow, binding: RuntimeToolCallBinding, digest: string): boolean {
  return (
    row.toolName === binding.name &&
    row.pluginInstallationId === (binding.pluginInstallationId ?? null) &&
    row.argumentsDigest === digest
  );
}

export function scopeWhere(capability: PromptCapabilityIngressBinding) {
  return and(
    eq(runInterfaceToolCalls.companyId, capability.companyId),
    eq(runInterfaceToolCalls.capabilityConnectionId, capability.capabilityConnectionId),
    eq(runInterfaceToolCalls.capabilityGeneration, capability.capabilityGeneration),
  );
}

export interface RuntimeToolCallLedger {
  claim(input: {
    capability: PromptCapabilityBinding;
    descriptor: CompiledRunToolDescriptor;
    callIdentity: PromptCapabilityCallIdentity;
    ingressOrdinal: number;
    arguments: unknown;
    classification: RuntimeToolCallClaimClassification;
  }): Promise<RuntimeToolCallClaim>;
  registerTerminalInvalid(input: {
    capability: PromptCapabilityIngressBinding;
    descriptor: RuntimeToolCallBinding;
    callIdentity: PromptCapabilityCallIdentity | null;
    ingressOrdinal: number;
    arguments: unknown;
    error: unknown;
  }): Promise<void>;
  commitMentionAction<T>(input: {
    transaction: RuntimeToolCallTransaction;
    capability: PromptCapabilityBinding;
    id: string;
    ingressOrdinal: number;
    toolName: "mention_agent" | "mention_board";
    targetAgentId: string | null;
    result: T;
  }): Promise<T>;
  complete(input: { capability: PromptCapabilityBinding; id: string; result: unknown }): Promise<void>;
  fail(input: { capability: PromptCapabilityBinding; id: string; error: unknown }): Promise<void>;
}
