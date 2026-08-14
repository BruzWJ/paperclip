import { runInterfaceToolCalls, taskExecutionPromptCapabilities, type Db } from "@paperclipai/db";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  PromptCapabilityAuthorityError,
  type PromptCapabilityBinding,
  type PromptCapabilityIngressBinding,
} from "./prompt-capability-gateway.js";
import * as ledger from "./runtime-tool-call-ledger-part-1.js";

export function createRuntimeToolCallLedger(
  db: Db,
  options: {
    now?: () => Date;
  } = {},
): ledger.RuntimeToolCallLedger {
  const now = options.now ?? (() => new Date());
  async function lockCapability(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    capability: PromptCapabilityIngressBinding,
    allowPendingSetup = false,
  ): Promise<ledger.CapabilityRow> {
    const row = await tx
      .select()
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, capability.companyId),
          eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
          eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
        ),
      )
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !row ||
      (row.state !== "active" && !(allowPendingSetup && row.state === "pending_setup")) ||
      row.expiresAt <= now()
    ) {
      throw new PromptCapabilityAuthorityError("capability_generation_changed");
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
      .where(and(ledger.scopeWhere(capability), gt(runInterfaceToolCalls.ingressOrdinal, current)))
      .orderBy(asc(runInterfaceToolCalls.ingressOrdinal));
    let expected = current + 1;
    for (const row of rows) {
      if (row.ingressOrdinal !== expected) break;
      if (requireClassification && row.classification === "unclassified") {
        break;
      }
      expected += 1;
    }
    return expected - 1;
  }
  async function advanceHighWaters(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    capability: PromptCapabilityIngressBinding,
    lockedCapability: ledger.CapabilityRow,
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
      ingressHighWater === lockedCapability.ingressHighWater &&
      classificationHighWater === lockedCapability.classificationHighWater
    ) {
      return;
    }
    await tx
      .update(taskExecutionPromptCapabilities)
      .set({ ingressHighWater, classificationHighWater })
      .where(
        and(
          eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
          eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
        ),
      );
    lockedCapability.ingressHighWater = ingressHighWater;
    lockedCapability.classificationHighWater = classificationHighWater;
  }
  async function claimLocked(input: {
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0];
    capability: PromptCapabilityIngressBinding;
    lockedCapability: ledger.CapabilityRow;
    binding: ledger.RuntimeToolCallBinding;
    identity: ledger.RuntimeToolCallIdentityParts;
    ingressOrdinal: number;
    arguments: unknown;
    classification: ledger.RuntimeToolCallClaimClassification | null;
  }): Promise<ledger.RuntimeToolCallClaim> {
    const digest = ledger.argumentsDigest(input.arguments);
    const identityRow = await input.tx
      .select()
      .from(runInterfaceToolCalls)
      .where(
        and(
          ledger.scopeWhere(input.capability),
          eq(runInterfaceToolCalls.callIdentitySource, input.identity.source),
          eq(runInterfaceToolCalls.callIdentityType, input.identity.type),
          eq(runInterfaceToolCalls.callIdentityValue, input.identity.value),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const ordinalRow = await input.tx
      .select()
      .from(runInterfaceToolCalls)
      .where(
        and(
          ledger.scopeWhere(input.capability),
          eq(runInterfaceToolCalls.ingressOrdinal, input.ingressOrdinal),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (identityRow) {
      if (identityRow.ingressOrdinal !== input.ingressOrdinal) {
        throw new ledger.RuntimeToolCallIdentityConflict(
          "Tool call identity was replayed with a different ingress ordinal",
        );
      }
      if (ordinalRow && ordinalRow.id !== identityRow.id) {
        throw new ledger.RuntimeToolCallIdentityConflict(
          "Tool-call ingress ordinal belongs to a different call identity",
        );
      }
      if (!ledger.sameBinding(identityRow, input.binding, digest)) {
        throw new ledger.RuntimeToolCallIdentityConflict(
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
      throw new ledger.RuntimeToolCallIdentityConflict(
        "Tool-call ingress ordinal was reused by a different call identity",
      );
    }
    const classifiedAt = input.classification === null ? null : now();
    const inserted = await input.tx
      .insert(runInterfaceToolCalls)
      .values({
        companyId: input.capability.companyId,
        capabilityConnectionId: input.capability.capabilityConnectionId,
        capabilityGeneration: input.capability.capabilityGeneration,
        ingressOrdinal: input.ingressOrdinal,
        callIdentitySource: input.identity.source,
        callIdentityType: input.identity.type,
        callIdentityValue: input.identity.value,
        toolName: input.binding.name,
        pluginInstallationId: input.binding.pluginInstallationId ?? null,
        argumentsDigest: digest,
        ...(input.classification === null
          ? {}
          : input.classification.classification === "validated_mention"
            ? {
                classification: "validated_mention" as const,
                mentionTargetAgentId: input.classification.targetAgentId,
                classifiedAt,
              }
            : {
                classification: "non_mention" as const,
                mentionTargetAgentId: null,
                classifiedAt,
              }),
        status: "executing",
      })
      .returning({ id: runInterfaceToolCalls.id })
      .then((rows) => rows[0]!);
    await advanceHighWaters(input.tx, input.capability, input.lockedCapability);
    return { state: "claimed", id: inserted.id };
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
        .where(and(ledger.scopeWhere(input.capability), eq(runInterfaceToolCalls.id, input.id)))
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!row || row.status !== "executing") return;
      const at = now();
      const becomesTerminalInvalid =
        row.classification === "unclassified" || row.classification === "validated_mention";
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
          error: ledger.serializedError(input.error),
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
      ledger.assertIngressOrdinal(input.ingressOrdinal);
      if (
        input.classification.classification === "validated_mention" &&
        input.classification.targetAgentId.length === 0
      ) {
        throw new ledger.RuntimeToolCallIdentityConflict(
          "Validated mention classification requires its target agent",
        );
      }
      return db.transaction(async (tx) => {
        const lockedCapability = await lockCapability(tx, input.capability);
        return claimLocked({
          tx,
          capability: input.capability,
          lockedCapability,
          binding: input.descriptor,
          identity: ledger.promptIdentityParts(input.callIdentity),
          ingressOrdinal: input.ingressOrdinal,
          arguments: input.arguments,
          classification: input.classification,
        });
      });
    },
    async registerTerminalInvalid(input) {
      ledger.assertIngressOrdinal(input.ingressOrdinal);
      await db.transaction(async (tx) => {
        const lockedCapability = await lockCapability(tx, input.capability, true);
        const claim = await claimLocked({
          tx,
          capability: input.capability,
          lockedCapability,
          binding: input.descriptor,
          identity: input.callIdentity
            ? ledger.promptIdentityParts(input.callIdentity)
            : ledger.ingressIdentityParts(input.ingressOrdinal),
          ingressOrdinal: input.ingressOrdinal,
          arguments: input.arguments,
          classification: null,
        });
        if (claim.state === "failed") return;
        if (claim.state !== "claimed" && claim.state !== "executing") {
          throw new ledger.RuntimeToolCallIdentityConflict(
            "A completed tool call cannot be reclassified as terminal-invalid",
          );
        }
        const row = await tx
          .select()
          .from(runInterfaceToolCalls)
          .where(
            and(
              ledger.scopeWhere(input.capability),
              eq(runInterfaceToolCalls.ingressOrdinal, input.ingressOrdinal),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0]!);
        if (row.classification !== "unclassified" && row.classification !== "terminal_invalid") {
          throw new ledger.RuntimeToolCallIdentityConflict("Tool-call classification is immutable");
        }
        const at = now();
        await tx
          .update(runInterfaceToolCalls)
          .set({
            classification: "terminal_invalid",
            mentionTargetAgentId: null,
            classifiedAt: row.classifiedAt ?? at,
            status: "failed",
            error: ledger.serializedError(input.error),
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(runInterfaceToolCalls.id, row.id));
        await advanceHighWaters(tx, input.capability, lockedCapability);
      });
    },
    async commitMentionAction(input) {
      ledger.assertIngressOrdinal(input.ingressOrdinal);
      const tx = input.transaction;
      const lockedCapability = await lockCapability(tx, input.capability);
      const row = await tx
        .select()
        .from(runInterfaceToolCalls)
        .where(and(ledger.scopeWhere(input.capability), eq(runInterfaceToolCalls.id, input.id)))
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
          ? row.classification !== "validated_mention" || row.mentionTargetAgentId !== input.targetAgentId
          : row.classification !== "non_mention" || input.targetAgentId !== null)
      ) {
        throw new ledger.RuntimeToolCallIdentityConflict(
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
            ledger.scopeWhere(input.capability),
            eq(runInterfaceToolCalls.id, input.id),
            eq(runInterfaceToolCalls.status, "executing"),
          ),
        )
        .returning({ id: runInterfaceToolCalls.id });
      if (updated.length !== 1) {
        throw new ledger.RuntimeToolCallIdentityConflict(
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
          .where(and(ledger.scopeWhere(input.capability), eq(runInterfaceToolCalls.id, input.id)))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row || row.status !== "executing") return;
        if (row.classification !== "non_mention") {
          throw new ledger.RuntimeToolCallIdentityConflict(
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
