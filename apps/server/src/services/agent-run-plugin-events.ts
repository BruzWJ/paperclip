import { randomUUID } from "node:crypto";
import type { TaskExecutionTerminal } from "./task-execution-dispatcher.js";
import type { PluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";

export interface AgentRunTerminalPluginEventInput {
  companyId: string;
  taskId: string;
  runId: string;
  agentId: string;
  outcome: TaskExecutionTerminal["outcome"];
  reason: string | null;
  occurredAt: Date;
}

/**
 * Publishes the canonical post-commit plugin event for a terminal agent run.
 * Callers must invoke this only after the transaction that terminalized the
 * run has committed, so plugins can immediately read its stable projection.
 */
export async function publishAgentRunTerminalEvent(
  publisher: PluginDomainEventPublisher,
  input: AgentRunTerminalPluginEventInput,
): Promise<void> {
  const eventType =
    input.outcome === "succeeded"
      ? ("agent.run.finished" as const)
      : input.outcome === "cancelled"
        ? ("agent.run.cancelled" as const)
        : ("agent.run.failed" as const);
  await publisher.publish({
    eventId: randomUUID(),
    eventType,
    occurredAt: input.occurredAt.toISOString(),
    actorId: input.agentId,
    actorType: "agent",
    entityId: input.runId,
    entityType: "agent_run",
    companyId: input.companyId,
    payload: {
      companyId: input.companyId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      outcome: input.outcome,
      reason: input.reason,
    },
  });
}
