import {
  type Db,
  agentActionGrants,
  agentContextGrants,
  agentMentionReachGrants,
  agents,
} from "@paperclipai/db";
import { createPostgresRuntimeTaskActionServicePart1 } from "./runtime-task-action-port-part-1.js";
import { createPostgresRuntimeTaskActionServicePart2 } from "./runtime-task-action-port-part-2.js";
import { createPostgresRuntimeTaskActionServicePart4 } from "./runtime-task-action-port-part-4.js";
import {
  type PostgresRuntimeTaskActionServiceOptions,
  type RuntimeTaskActionService,
  RuntimeTaskActionDenied,
  createTaskFormCommitRuntime,
  grantMap,
  lockRuntimeToolAuthority,
} from "./runtime-task-action-port-shared.js";

import { and, asc, eq, or } from "drizzle-orm";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";

export function createPostgresRuntimeTaskActionServicePart3(
  db: Db,
  options: PostgresRuntimeTaskActionServiceOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createTaskSessionAdmissionService(db, { clock });
  const taskForms = createTaskFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchPersistedRef,
    taskExecutionCancellation: options.taskExecutionCancellation,
  });

  return {
    async listAgents(input) {
      return db.transaction(async (tx) => {
        const now = clock();
        const authorized = await lockRuntimeToolAuthority(
          tx,
          input.capability,
          "list_agents",
          now,
        );
        const allRows = await tx
          .select({
            id: agents.id,
            name: agents.name,
            title: agents.title,
            capabilities: agents.capabilities,
            status: agents.status,
            reportsTo: agents.reportsTo,
          })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.capability.companyId),
              or(
                eq(agents.status, "idle"),
                eq(agents.status, "paused"),
                eq(agents.status, "pending_approval"),
              ),
            ),
          )
          .orderBy(asc(agents.name));
        const hasListAll = authorized.catalog.actionGrants.list_all_agents === true;

        const mapped = allRows.map((row) => ({
          id: row.id,
          name: row.name,
          title: row.title,
          capabilities: row.capabilities,
          status: row.status,
          reportsTo: row.reportsTo,
        }));

        const childrenByParent = new Map<string, typeof mapped>();
        for (const agent of mapped) {
          if (!agent.reportsTo) continue;
          const list = childrenByParent.get(agent.reportsTo);
          if (list) {
            list.push(agent);
          } else {
            childrenByParent.set(agent.reportsTo, [agent]);
          }
        }

        function collectDescendants(rootId: string): Set<string> {
          const ids = new Set<string>([rootId]);
          const stack = [rootId];
          while (stack.length > 0) {
            const parentId = stack.pop()!;
            for (const child of childrenByParent.get(parentId) ?? []) {
              if (!ids.has(child.id)) {
                ids.add(child.id);
                stack.push(child.id);
              }
            }
          }
          return ids;
        }

        if (hasListAll) {
          if (!input.agentId) {
            return { agents: mapped };
          }
          const root = mapped.find((a) => a.id === input.agentId);
          if (!root) {
            throw new RuntimeTaskActionDenied("Agent not found in this company", "agent_not_found");
          }
          const descendantIds = collectDescendants(root.id);
          return {
            agents: mapped.filter((a) => descendantIds.has(a.id)),
          };
        }

        const currentAgent = mapped.find((a) => a.id === input.capability.targetAgentId);
        if (!currentAgent?.reportsTo) {
          throw new RuntimeTaskActionDenied(
            "Current agent has no parent for team-scoped listing",
            "no_parent_agent",
          );
        }
        const parentAgentId = currentAgent.reportsTo;
        const teamIds = collectDescendants(parentAgentId);

        const effectiveAgentId = input.agentId ?? parentAgentId;
        if (!teamIds.has(effectiveAgentId)) {
          throw new RuntimeTaskActionDenied(
            "Agent is not within the current agent's parent team",
            "outside_team_scope",
          );
        }
        const descendantIds = collectDescendants(effectiveAgentId);
        return {
          agents: mapped.filter((a) => descendantIds.has(a.id) && teamIds.has(a.id)),
        };
      });
    },
    async agentRead(input) {
      return db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeToolAuthority(tx, input.capability, "agent_read", now);
        const [agentRow] = await tx
          .select({
            id: agents.id,
            name: agents.name,
            title: agents.title,
            capabilities: agents.capabilities,
            instruction: agents.instruction,
            status: agents.status,
            reportsTo: agents.reportsTo,
          })
          .from(agents)
          .where(and(eq(agents.companyId, input.capability.companyId), eq(agents.id, input.agentId)))
          .limit(1);
        if (!agentRow || agentRow.status === "terminated") {
          throw new RuntimeTaskActionDenied("Agent not found in this company", "agent_not_found");
        }
        const [contextRows, actionRows, mentionRows] = await Promise.all([
          tx
            .select({ key: agentContextGrants.key })
            .from(agentContextGrants)
            .where(
              and(
                eq(agentContextGrants.companyId, input.capability.companyId),
                eq(agentContextGrants.agentId, input.agentId),
              ),
            ),
          tx
            .select({ key: agentActionGrants.key })
            .from(agentActionGrants)
            .where(
              and(
                eq(agentActionGrants.companyId, input.capability.companyId),
                eq(agentActionGrants.agentId, input.agentId),
              ),
            ),
          tx
            .select({ key: agentMentionReachGrants.key })
            .from(agentMentionReachGrants)
            .where(
              and(
                eq(agentMentionReachGrants.companyId, input.capability.companyId),
                eq(agentMentionReachGrants.agentId, input.agentId),
              ),
            ),
        ]);
        return {
          id: agentRow.id,
          name: agentRow.name,
          title: agentRow.title,
          capabilities: agentRow.capabilities,
          instruction: agentRow.instruction,
          status: agentRow.status,
          reportsTo: agentRow.reportsTo,
          contextGrants: grantMap(contextRows),
          actionGrants: grantMap(actionRows),
          mentionReachGrants: grantMap(mentionRows),
        };
      });
    },
  } satisfies Partial<RuntimeTaskActionService>;
}

export {
  admitCounterpartTaskUpdate,
  createRuntimeTaskActionPort,
  createTaskFormCommitRuntime,
  lockAgentCounterpartTarget,
  lockTaskMentionRecipient,
  lockTaskUpdateTarget,
  admitManagedAgentMessageInTransaction,
  mentionBoardInTransaction,
  revokeOutgoingOwnershipEpoch,
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
  type AgentCounterpartTarget,
  type CanonicalCreatorFormAuthority,
  type CanonicalCreatorFormUpdate,
  type CanonicalOwnerFormAuthority,
  type CanonicalOwnerFormUpdate,
  type OutgoingOwnershipEpochRevocation,
  type PostgresRuntimeTaskActionServiceOptions,
  type RuntimeTaskActionService,
  type RuntimeTaskOwnerChoice,
  type RuntimeTaskScopeCancellationPort,
  type RuntimeTaskUpdateInput,
  type TaskFormCommitRuntimeOptions,
  type TaskMentionRecipient,
  type TaskUpdateTarget,
} from "./runtime-task-action-port-shared.js";
export function createPostgresRuntimeTaskActionService(
  db: Db,
  options: PostgresRuntimeTaskActionServiceOptions,
): RuntimeTaskActionService {
  return {
    ...createPostgresRuntimeTaskActionServicePart1(db, options),
    ...createPostgresRuntimeTaskActionServicePart2(db, options),
    ...createPostgresRuntimeTaskActionServicePart3(db, options),
    ...createPostgresRuntimeTaskActionServicePart4(db, options),
  } as RuntimeTaskActionService;
}

export type CreatePostgresRuntimeTaskActionServiceResult = RuntimeTaskActionService;
