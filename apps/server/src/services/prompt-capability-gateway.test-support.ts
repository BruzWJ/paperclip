import { createHash } from "node:crypto";
import {
  agents,
  companies,
  taskExecutionAttempts,
  taskExecutionAuthorities,
  taskExecutionLeases,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRefs,
  taskExecutionRunControls,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskExecutionWorkspaceBindings,
  tasks,
  type Db,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { resolveContextDial } from "./context-dial-resolver.js";
import {
  createPromptCapabilityGateway,
  mintPromptCapabilityBearer,
  PromptCapabilityAuthenticationError,
  PromptCapabilityAuthorityError,
  type PromptCapabilityBinding,
  type PromptCapabilityGatewayRepository,
  type PromptCapabilityIngressBinding,
  type PromptCapabilityToolExecutor,
} from "./prompt-capability-gateway.js";
import {
  createPostgresPromptCapabilityGatewayRepository,
  lockActivePromptCapabilityBinding,
} from "./prompt-capability-gateway-postgres.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import type { PaperclipManagedToolCommand } from "./paperclip-managed-tool-registry.js";
import type { PaperclipManagedToolRouteContext } from "./paperclip-managed-tool-router.js";
import type { RuntimeInterfaceCompileInput } from "./runtime-interface-compiler.js";
import { createRuntimePluginToolPort, createRuntimeToolGateway } from "./runtime-tool-gateway.js";
import { capability, now } from "./prompt-capability-gateway.test-fixtures.js";
import { compileInput, composedPluginToolRuntime } from "./prompt-capability-gateway.test-plugin-runtime.js";
export function capabilityLockTransaction(row: unknown, databaseTime = now) {
  const selectedTables: unknown[] = [];
  const lockedTables: unknown[] = [];
  const transaction = {
    async execute() {
      return [{ timestampMs: databaseTime.getTime() }];
    },
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          selectedTables.push(value);
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          lockedTables.push(table);
          return Promise.resolve([row]);
        },
      };
      return builder;
    },
  } as unknown as TaskSessionDbTransaction;
  return { transaction, selectedTables, lockedTables };
}

export function persistedCapabilityRow(input: {
  expiresAt: Date;
  state?: "pending_setup" | "active" | "revoked";
}) {
  const state = input.state ?? "active";
  return {
    ...capability,
    state,
    targetSessionCorrelationId: state === "pending_setup" ? null : capability.targetSessionCorrelationId,
    expiresAt: input.expiresAt,
    activatedAt: state === "pending_setup" ? null : capability.activatedAt,
    bearerHash: "d".repeat(64),
    revocationReason: state === "revoked" ? "fixture" : null,
    revokedAt: state === "revoked" ? now : null,
  };
}

function gatewayAuthorityRows(
  row: ReturnType<typeof persistedCapabilityRow>,
  taskState: {
    lifecycleStatus?: "open" | "blocked" | "done" | "cancelled";
    executionPaused?: boolean;
  } = {},
) {
  return new Map<unknown, readonly unknown[]>([
    [taskExecutionPromptCapabilities, [row]],
    [companies, [{ status: "active", integrity: "ready" }]],
    [
      tasks,
      [
        {
          companyId: row.companyId,
          ownershipEpoch: row.ownershipEpoch,
          lifecycleStatus: taskState.lifecycleStatus ?? "open",
          ownerKind: "agent",
          ownerAgentId: row.targetAgentId,
          executionPaused: taskState.executionPaused ?? false,
        },
      ],
    ],
    [
      agents,
      [
        {
          companyId: row.companyId,
          status: "active",
          currentAdapterConfigRevisionId: row.adapterConfigIdentity,
        },
      ],
    ],
    [
      taskExecutionRefs,
      [
        {
          companyId: row.companyId,
          taskId: row.taskId,
          sessionId: capability.sessionId,
          ownershipEpoch: row.ownershipEpoch,
          mode: row.executionMode,
          targetAgentId: row.targetAgentId,
          taskExecutionAuthorityId: row.taskExecutionAuthorityId,
          consultExecutionId: row.consultExecutionId,
          adapterConfigRevisionId: row.adapterConfigIdentity,
          disposition: "active",
        },
      ],
    ],
    [
      taskExecutionRunRefs,
      [
        {
          companyId: row.companyId,
          taskId: row.taskId,
          sessionId: capability.sessionId,
          batchDigest: row.runBatchDigest,
          attemptId: row.attemptId,
          protocolSettlementState: null,
          capabilityConnectionId: row.capabilityConnectionId,
          capabilityGeneration: row.capabilityGeneration,
        },
      ],
    ],
    ...(row.segmentOrdinal === 0
      ? []
      : ([
          [
            taskExecutionPromptSegments,
            [
              {
                companyId: row.companyId,
                taskId: row.taskId,
                sessionId: capability.sessionId,
                attemptId: row.attemptId,
                capabilityConnectionId: row.capabilityConnectionId,
                capabilityGeneration: row.capabilityGeneration,
                protocolSettlementState: null,
                steeringState: "resumed",
              },
            ],
          ],
        ] as const)),
    [
      taskExecutionRunControls,
      [
        {
          currentRefId: row.refId,
          currentOrdinal: row.refOrdinal,
          currentSegmentOrdinal: row.segmentOrdinal,
        },
      ],
    ],
    [
      taskExecutionAttempts,
      [
        {
          companyId: row.companyId,
          taskId: row.taskId,
          sessionId: capability.sessionId,
          runId: row.runId,
          runKind: "productive",
          promptKind: row.segmentOrdinal === 0 ? "base" : "steering",
          refId: row.refId,
          refOrdinal: row.refOrdinal,
          segmentOrdinal: row.segmentOrdinal,
          state: "running",
        },
      ],
    ],
    [
      taskExecutionLeases,
      [
        {
          companyId: row.companyId,
          taskId: row.taskId,
          runId: row.runId,
          attemptId: row.attemptId,
          leaseGeneration: row.leaseGeneration,
          state: "active",
          expiresAt: row.expiresAt,
        },
      ],
    ],
    [
      taskExecutionSessions,
      [
        {
          taskId: row.taskId,
          ownershipEpoch: row.ownershipEpoch,
          targetAgentId: row.targetAgentId,
          adapterConfigIdentity: row.adapterConfigIdentity,
          workspaceIdentity: row.workspaceIdentity,
          purpose: "active_run_steering",
          state: "current",
          runId: row.runId,
          currentRefId: row.refId,
          currentRefOrdinal: row.refOrdinal,
          currentSegmentOrdinal: row.segmentOrdinal,
        },
      ],
    ],
    [
      taskExecutionWorkspaceBindings,
      [
        {
          companyId: row.companyId,
          taskId: row.taskId,
          sessionId: capability.sessionId,
          ownershipEpoch: row.ownershipEpoch,
        },
      ],
    ],
    [
      taskExecutionAuthorities,
      [
        {
          companyId: row.companyId,
          taskId: row.taskId,
          sessionId: capability.sessionId,
          ownershipEpoch: row.ownershipEpoch,
          agentId: row.targetAgentId,
          state: "current",
        },
      ],
    ],
  ]);
}

export function postgresGatewayRepository(
  row: ReturnType<typeof persistedCapabilityRow>,
  databaseTime = now,
  taskState: Parameters<typeof gatewayAuthorityRows>[1] = {},
) {
  const rowsByTable = gatewayAuthorityRows(row, taskState);
  const database: Record<string, unknown> = {
    async execute() {
      return [{ timestampMs: databaseTime.getTime() }];
    },
    select() {
      let table: unknown;
      const builder = {
        from(value: unknown) {
          table = value;
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return builder;
        },
        for() {
          return builder;
        },
        then<TResult1 = readonly unknown[], TResult2 = never>(
          onFulfilled?: ((value: readonly unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(rowsByTable.get(table) ?? []).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  database.transaction = vi.fn(async (work: (transaction: unknown) => unknown) => work(database));
  return createPostgresPromptCapabilityGatewayRepository(
    database as unknown as Db,
    {
      resolve: vi.fn(async () => compileInput()),
    },
    {
      readRun: vi.fn(async () => ({
        kind: "productive",
        status: "running",
        sessionId: capability.sessionId,
        ownershipEpoch: row.ownershipEpoch,
        targetAgentId: row.targetAgentId,
        executionMode: row.executionMode,
        taskExecutionAuthorityId: row.taskExecutionAuthorityId,
        consultExecutionId: row.consultExecutionId,
        adapterConfigRevisionId: row.adapterConfigIdentity,
        executionWorkspaceBindingId: row.workspaceIdentity,
        currentAttemptId: row.attemptId,
        currentLeaseId: row.leaseId,
        cancellationIntentId: null,
        terminalFinalizationId: null,
      })),
    } as never,
  );
}

export function setup(compile = compileInput(), binding: PromptCapabilityIngressBinding = capability) {
  const authenticateBearerHash = vi.fn(async () => ({
    kind: "authenticated" as const,
    capability: binding,
  }));
  const revalidate = vi.fn(async () => ({
    kind: "authenticated" as const,
    capability: binding,
  }));
  const repository: PromptCapabilityGatewayRepository = {
    authenticateBearerHash,
    revalidate,
    resolveCompileInput: vi.fn(async () => compile),
    createPluginRunContext: vi.fn(async () => undefined),
    resolvePluginRunContextHash: vi.fn(async () => null),
  };
  const registerTerminalInvalid = vi.fn(async () => undefined);
  const execute = vi.fn(async (_input: Parameters<PromptCapabilityToolExecutor["execute"]>[0]) => ({
    source: "paperclip" as const,
    value: { accepted: true },
  }));
  return {
    authenticateBearerHash,
    execute,
    registerTerminalInvalid,
    revalidate,
    gateway: createPromptCapabilityGateway({
      repository,
      executor: { execute, registerTerminalInvalid },
      now: () => now,
    }),
  };
}

export { createHash, taskExecutionPromptCapabilities, describe, expect, it, vi };
export { resolveContextDial, createPromptCapabilityGateway };
export { mintPromptCapabilityBearer, PromptCapabilityAuthenticationError };
export { lockActivePromptCapabilityBinding, createRuntimePluginToolPort };
export { createRuntimeToolGateway, now, capability, compileInput };
export { composedPluginToolRuntime };
export type { PromptCapabilityBinding, PromptCapabilityGatewayRepository };
export type { PaperclipManagedToolCommand, PaperclipManagedToolRouteContext };
export type { RuntimeInterfaceCompileInput };
