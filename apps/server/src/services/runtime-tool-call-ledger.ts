import { createHash } from "node:crypto";
import {
  issueExecutionPromptCapabilities,
  runInterfaceToolCalls,
  type Db,
} from "@paperclipai/db";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  PromptCapabilityAuthorityError,
  type PromptCapabilityBinding,
  type PromptCapabilityCallIdentity,
  type PromptCapabilityIngressBinding,
} from "./prompt-capability-gateway.js";
import type {
  CompiledRunToolDescriptor,
} from "./runtime-interface-compiler.js";

type ToolCallRow = typeof runInterfaceToolCalls.$inferSelect;
type CapabilityRow =
  typeof issueExecutionPromptCapabilities.$inferSelect;
export type RuntimeToolCallTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string"
    || typeof value === "boolean"
  ) {
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

function argumentsDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value === undefined ? null : value))
    .digest("hex");
}

function assertIngressOrdinal(ingressOrdinal: number): void {
  if (!Number.isSafeInteger(ingressOrdinal) || ingressOrdinal < 0) {
    throw new RuntimeToolCallIdentityConflict(
      "Tool-call ingress ordinal must be a nonnegative safe integer",
    );
  }
}

function serializedError(error: unknown): NonNullable<ToolCallRow["error"]> {
  const source = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
    reasonCode?: unknown;
    details?: unknown;
  };
  return {
    name:
      typeof source?.name === "string"
        ? source.name
        : "Error",
    message:
      typeof source?.message === "string"
        ? source.message
        : String(error),
    ...(typeof source?.code === "string"
      ? { code: source.code }
      : {}),
    ...(typeof source?.status === "number"
      ? { status: source.status }
      : {}),
    ...(typeof source?.reasonCode === "string"
      ? { reasonCode: source.reasonCode }
      : {}),
    ...(source?.details &&
    typeof source.details === "object" &&
    !Array.isArray(source.details)
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

interface RuntimeToolCallBinding {
  readonly name: string;
  readonly pluginInstallationId?: string;
}

interface RuntimeToolCallIdentityParts {
  readonly source: ToolCallRow["callIdentitySource"];
  readonly type: ToolCallRow["callIdentityType"];
  readonly value: string;
}

type RuntimeToolCallClaim =
  | { state: "claimed"; id: string }
  | { state: "completed"; result: unknown }
  | {
      state: "failed";
      error: NonNullable<ToolCallRow["error"]>;
    }
  | { state: "executing" };

function promptIdentityParts(
  callIdentity: PromptCapabilityCallIdentity,
): RuntimeToolCallIdentityParts {
  const type = typeof callIdentity.id;
  if (type !== "string" && type !== "number") {
    throw new RuntimeToolCallIdentityConflict(
      "Tool call identity must be a string or number",
    );
  }
  return {
    source: callIdentity.source,
    type,
    value: String(callIdentity.id),
  };
}

function ingressIdentityParts(
  ingressOrdinal: number,
): RuntimeToolCallIdentityParts {
  return {
    source: "ingress",
    type: "ordinal",
    value: String(ingressOrdinal),
  };
}

function sameBinding(
  row: ToolCallRow,
  binding: RuntimeToolCallBinding,
  digest: string,
): boolean {
  return row.toolName === binding.name
    && row.pluginInstallationId ===
      (binding.pluginInstallationId ?? null)
    && row.argumentsDigest === digest;
}

function scopeWhere(capability: PromptCapabilityIngressBinding) {
  return and(
    eq(runInterfaceToolCalls.companyId, capability.companyId),
    eq(
      runInterfaceToolCalls.capabilityConnectionId,
      capability.capabilityConnectionId,
    ),
    eq(
      runInterfaceToolCalls.capabilityGeneration,
      capability.capabilityGeneration,
    ),
  );
}

export interface RuntimeToolCallLedger {
  claim(input: {
    capability: PromptCapabilityBinding;
    descriptor: CompiledRunToolDescriptor;
    callIdentity: PromptCapabilityCallIdentity;
    ingressOrdinal: number;
    arguments: unknown;
  }): Promise<RuntimeToolCallClaim>;
  registerTerminalInvalid(input: {
    capability: PromptCapabilityIngressBinding;
    descriptor: RuntimeToolCallBinding;
    callIdentity: PromptCapabilityCallIdentity | null;
    ingressOrdinal: number;
    arguments: unknown;
    error: unknown;
  }): Promise<void>;
  classify(input:
    | {
        capability: PromptCapabilityBinding;
        id: string;
        ingressOrdinal: number;
        classification: "non_mention";
      }
    | {
        capability: PromptCapabilityBinding;
        id: string;
        ingressOrdinal: number;
        classification: "validated_mention";
        targetAgentId: string;
      }
  ): Promise<void>;
  commitMentionAction<T>(input: {
    transaction: RuntimeToolCallTransaction;
    capability: PromptCapabilityBinding;
    id: string;
    ingressOrdinal: number;
    toolName: "mention_agent" | "mention_board";
    targetAgentId: string | null;
    result: T;
  }): Promise<T>;
  complete(input: {
    capability: PromptCapabilityBinding;
    id: string;
    result: unknown;
  }): Promise<void>;
  fail(input: {
    capability: PromptCapabilityBinding;
    id: string;
    error: unknown;
  }): Promise<void>;
}

export function createRuntimeToolCallLedger(
  db: Db,
  options: {
    now?: () => Date;
  } = {},
): RuntimeToolCallLedger {
  const now = options.now ?? (() => new Date());

  async function lockCapability(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    capability: PromptCapabilityIngressBinding,
    allowPendingSetup = false,
  ): Promise<CapabilityRow> {
    const row = await tx
      .select()
      .from(issueExecutionPromptCapabilities)
      .where(
        and(
          eq(
            issueExecutionPromptCapabilities.companyId,
            capability.companyId,
          ),
          eq(
            issueExecutionPromptCapabilities.capabilityConnectionId,
            capability.capabilityConnectionId,
          ),
          eq(
            issueExecutionPromptCapabilities.capabilityGeneration,
            capability.capabilityGeneration,
          ),
        ),
      )
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !row
      || (
        row.state !== "active"
        && !(allowPendingSetup && row.state === "pending_setup")
      )
      || row.expiresAt <= now()
    ) {
      throw new PromptCapabilityAuthorityError(
        "capability_generation_changed",
      );
    }
    return row;
  }

  async function contiguousHighWater(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    capability: PromptCapabilityIngressBinding,
    current: number,
    requireClassification: boolean,
  ): Promise<number> {
    const rows = await tx
      .select({
        ingressOrdinal: runInterfaceToolCalls.ingressOrdinal,
        classification: runInterfaceToolCalls.classification,
      })
      .from(runInterfaceToolCalls)
      .where(
        and(
          scopeWhere(capability),
          gt(runInterfaceToolCalls.ingressOrdinal, current),
        ),
      )
      .orderBy(asc(runInterfaceToolCalls.ingressOrdinal));
    let expected = current + 1;
    for (const row of rows) {
      if (row.ingressOrdinal !== expected) break;
      if (
        requireClassification
        && row.classification === "unclassified"
      ) {
        break;
      }
      expected += 1;
    }
    return expected - 1;
  }

  async function advanceHighWaters(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    capability: PromptCapabilityIngressBinding,
    lockedCapability: CapabilityRow,
  ): Promise<void> {
    const ingressHighWater = await contiguousHighWater(
      tx,
      capability,
      lockedCapability.ingressHighWater,
      false,
    );
    const classificationHighWater = await contiguousHighWater(
      tx,
      capability,
      lockedCapability.classificationHighWater,
      true,
    );
    if (
      ingressHighWater === lockedCapability.ingressHighWater
      && classificationHighWater ===
        lockedCapability.classificationHighWater
    ) {
      return;
    }
    await tx
      .update(issueExecutionPromptCapabilities)
      .set({ ingressHighWater, classificationHighWater })
      .where(
        and(
          eq(
            issueExecutionPromptCapabilities.capabilityConnectionId,
            capability.capabilityConnectionId,
          ),
          eq(
            issueExecutionPromptCapabilities.capabilityGeneration,
            capability.capabilityGeneration,
          ),
        ),
      );
    lockedCapability.ingressHighWater = ingressHighWater;
    lockedCapability.classificationHighWater = classificationHighWater;
  }

  async function claimLocked(input: {
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0];
    capability: PromptCapabilityIngressBinding;
    lockedCapability: CapabilityRow;
    binding: RuntimeToolCallBinding;
    identity: RuntimeToolCallIdentityParts;
    ingressOrdinal: number;
    arguments: unknown;
  }): Promise<RuntimeToolCallClaim> {
    const digest = argumentsDigest(input.arguments);
    const identityRow = await input.tx
      .select()
      .from(runInterfaceToolCalls)
      .where(
        and(
          scopeWhere(input.capability),
          eq(
            runInterfaceToolCalls.callIdentitySource,
            input.identity.source,
          ),
          eq(
            runInterfaceToolCalls.callIdentityType,
            input.identity.type,
          ),
          eq(
            runInterfaceToolCalls.callIdentityValue,
            input.identity.value,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const ordinalRow = await input.tx
      .select()
      .from(runInterfaceToolCalls)
      .where(
        and(
          scopeWhere(input.capability),
          eq(
            runInterfaceToolCalls.ingressOrdinal,
            input.ingressOrdinal,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (identityRow) {
      if (identityRow.ingressOrdinal !== input.ingressOrdinal) {
        throw new RuntimeToolCallIdentityConflict(
          "Tool call identity was replayed with a different ingress ordinal",
        );
      }
      if (ordinalRow && ordinalRow.id !== identityRow.id) {
        throw new RuntimeToolCallIdentityConflict(
          "Tool-call ingress ordinal belongs to a different call identity",
        );
      }
      if (!sameBinding(identityRow, input.binding, digest)) {
        throw new RuntimeToolCallIdentityConflict(
          "Tool call identity was reused with a different tool, binding, or argument payload",
        );
      }
      if (identityRow.status === "completed") {
        return { state: "completed", result: identityRow.result };
      }
      if (identityRow.status === "failed") {
        return {
          state: "failed",
          error: identityRow.error ?? {
            name: "Error",
            message: "The previous tool call failed",
          },
        };
      }
      return { state: "executing" };
    }
    if (ordinalRow) {
      throw new RuntimeToolCallIdentityConflict(
        "Tool-call ingress ordinal was reused by a different call identity",
      );
    }

    const inserted = await input.tx
      .insert(runInterfaceToolCalls)
      .values({
        companyId: input.capability.companyId,
        capabilityConnectionId:
          input.capability.capabilityConnectionId,
        capabilityGeneration:
          input.capability.capabilityGeneration,
        ingressOrdinal: input.ingressOrdinal,
        callIdentitySource: input.identity.source,
        callIdentityType: input.identity.type,
        callIdentityValue: input.identity.value,
        toolName: input.binding.name,
        pluginInstallationId:
          input.binding.pluginInstallationId ?? null,
        argumentsDigest: digest,
        status: "executing",
      })
      .returning({ id: runInterfaceToolCalls.id })
      .then((rows) => rows[0]!);
    await advanceHighWaters(
      input.tx,
      input.capability,
      input.lockedCapability,
    );
    return { state: "claimed", id: inserted.id };
  }

  async function markClassification(input:
    | {
        capability: PromptCapabilityBinding;
        id: string;
        ingressOrdinal: number;
        classification: "non_mention";
      }
    | {
        capability: PromptCapabilityBinding;
        id: string;
        ingressOrdinal: number;
        classification: "validated_mention";
        targetAgentId: string;
      }
  ): Promise<void> {
    assertIngressOrdinal(input.ingressOrdinal);
    if (
      input.classification === "validated_mention"
      && input.targetAgentId.length === 0
    ) {
      throw new RuntimeToolCallIdentityConflict(
        "Validated mention classification requires its target agent",
      );
    }
    await db.transaction(async (tx) => {
      const lockedCapability = await lockCapability(tx, input.capability);
      const row = await tx
        .select()
        .from(runInterfaceToolCalls)
        .where(
          and(
            scopeWhere(input.capability),
            eq(runInterfaceToolCalls.id, input.id),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!row || row.ingressOrdinal !== input.ingressOrdinal) {
        throw new RuntimeToolCallIdentityConflict(
          "Tool-call classification did not match its immutable ledger identity",
        );
      }
      if (row.classification !== "unclassified") {
        const same = row.classification === input.classification
          && (
            input.classification === "non_mention"
            || row.mentionTargetAgentId === input.targetAgentId
          );
        if (!same) {
          throw new RuntimeToolCallIdentityConflict(
            "Tool-call classification is immutable",
          );
        }
        return;
      }
      const at = now();
      await tx
        .update(runInterfaceToolCalls)
        .set(
          input.classification === "validated_mention"
            ? {
                classification: "validated_mention",
                mentionTargetAgentId: input.targetAgentId,
                classifiedAt: at,
                updatedAt: at,
              }
            : {
                classification: "non_mention",
                classifiedAt: at,
                updatedAt: at,
              },
        )
        .where(eq(runInterfaceToolCalls.id, row.id));
      await advanceHighWaters(tx, input.capability, lockedCapability);
    });
  }

  async function failCall(input: {
    capability: PromptCapabilityBinding;
    id: string;
    error: unknown;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      const lockedCapability = await lockCapability(tx, input.capability);
      const row = await tx
        .select()
        .from(runInterfaceToolCalls)
        .where(
          and(
            scopeWhere(input.capability),
            eq(runInterfaceToolCalls.id, input.id),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!row || row.status !== "executing") return;
      const at = now();
      const becomesTerminalInvalid =
        row.classification === "unclassified"
        || row.classification === "validated_mention";
      await tx
        .update(runInterfaceToolCalls)
        .set({
          ...(becomesTerminalInvalid
            ? {
                classification: "terminal_invalid" as const,
                mentionTargetAgentId: null,
                classifiedAt: row.classifiedAt ?? at,
              }
            : {}),
          status: "failed",
          error: serializedError(input.error),
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(runInterfaceToolCalls.id, row.id));
      if (becomesTerminalInvalid) {
        await advanceHighWaters(tx, input.capability, lockedCapability);
      }
    });
  }

  return {
    async claim(input) {
      assertIngressOrdinal(input.ingressOrdinal);
      return db.transaction(async (tx) => {
        const lockedCapability = await lockCapability(tx, input.capability);
        return claimLocked({
          tx,
          capability: input.capability,
          lockedCapability,
          binding: input.descriptor,
          identity: promptIdentityParts(input.callIdentity),
          ingressOrdinal: input.ingressOrdinal,
          arguments: input.arguments,
        });
      });
    },

    async registerTerminalInvalid(input) {
      assertIngressOrdinal(input.ingressOrdinal);
      await db.transaction(async (tx) => {
        const lockedCapability = await lockCapability(
          tx,
          input.capability,
          true,
        );
        const claim = await claimLocked({
          tx,
          capability: input.capability,
          lockedCapability,
          binding: input.descriptor,
          identity: input.callIdentity
            ? promptIdentityParts(input.callIdentity)
            : ingressIdentityParts(input.ingressOrdinal),
          ingressOrdinal: input.ingressOrdinal,
          arguments: input.arguments,
        });
        if (claim.state === "failed") return;
        if (claim.state !== "claimed" && claim.state !== "executing") {
          throw new RuntimeToolCallIdentityConflict(
            "A completed tool call cannot be reclassified as terminal-invalid",
          );
        }
        const row = await tx
          .select()
          .from(runInterfaceToolCalls)
          .where(
            and(
              scopeWhere(input.capability),
              eq(
                runInterfaceToolCalls.ingressOrdinal,
                input.ingressOrdinal,
              ),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0]!);
        if (
          row.classification !== "unclassified"
          && row.classification !== "terminal_invalid"
        ) {
          throw new RuntimeToolCallIdentityConflict(
            "Tool-call classification is immutable",
          );
        }
        const at = now();
        await tx
          .update(runInterfaceToolCalls)
          .set({
            classification: "terminal_invalid",
            mentionTargetAgentId: null,
            classifiedAt: row.classifiedAt ?? at,
            status: "failed",
            error: serializedError(input.error),
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(runInterfaceToolCalls.id, row.id));
        await advanceHighWaters(tx, input.capability, lockedCapability);
      });
    },

    classify: markClassification,

    async commitMentionAction(input) {
      assertIngressOrdinal(input.ingressOrdinal);
      const tx = input.transaction;
      const lockedCapability = await lockCapability(tx, input.capability);
      const row = await tx
        .select()
        .from(runInterfaceToolCalls)
        .where(
          and(
            scopeWhere(input.capability),
            eq(runInterfaceToolCalls.id, input.id),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      const mentionAgent = input.toolName === "mention_agent";
      if (
        !row ||
        row.ingressOrdinal !== input.ingressOrdinal ||
        row.toolName !== input.toolName ||
        row.status !== "executing" ||
        lockedCapability.classificationHighWater < input.ingressOrdinal ||
        (mentionAgent
          ? row.classification !== "validated_mention" ||
            row.mentionTargetAgentId !== input.targetAgentId
          : row.classification !== "non_mention" ||
            input.targetAgentId !== null)
      ) {
        throw new RuntimeToolCallIdentityConflict(
          "Mention action did not match its immutable classified ledger row",
        );
      }
      const at = now();
      const updated = await tx
        .update(runInterfaceToolCalls)
        .set({
          status: "completed",
          result: input.result,
          completedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            scopeWhere(input.capability),
            eq(runInterfaceToolCalls.id, input.id),
            eq(runInterfaceToolCalls.status, "executing"),
          ),
        )
        .returning({ id: runInterfaceToolCalls.id });
      if (updated.length !== 1) {
        throw new RuntimeToolCallIdentityConflict(
          "Mention action ledger commitment lost its executing call",
        );
      }
      return input.result;
    },

    async complete(input) {
      await db.transaction(async (tx) => {
        await lockCapability(tx, input.capability);
        const row = await tx
          .select()
          .from(runInterfaceToolCalls)
          .where(
            and(
              scopeWhere(input.capability),
              eq(runInterfaceToolCalls.id, input.id),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row || row.status !== "executing") return;
        if (row.classification !== "non_mention") {
          throw new RuntimeToolCallIdentityConflict(
            "A mention must commit through its canonical action transaction",
          );
        }
        const at = now();
        await tx
          .update(runInterfaceToolCalls)
          .set({
            status: "completed",
            result: input.result === undefined ? null : input.result,
            error: null,
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(runInterfaceToolCalls.id, row.id));
      });
    },

    fail: failCall,
  };
}
