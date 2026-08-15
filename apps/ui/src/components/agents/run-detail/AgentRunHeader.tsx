import type { TaskExecutionRunJoinedDetail } from "@/api/runs";
import {
  Agent as AgentConfiguration,
  AgentContent,
  AgentHeader,
  AgentInstructions,
} from "@/components/ai-elements/agent";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  Snippet,
  SnippetAddon,
  SnippetCopyButton,
  SnippetInput,
  SnippetText,
} from "@/components/ai-elements/snippet";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task as AgentTask, TaskContent, TaskTrigger } from "@/components/ai-elements/task";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatDurationMs, formatMoneyAmount, formatNumber } from "@/lib/utils";
import type { Agent, Task } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import {
  humanizeRunValue,
  latestAccountingRecord,
  runDurationMs,
  summarizeRunCost,
} from "./agent-run-detail-model";

function IdentitySnippet({ label, value }: { label: string; value: string }) {
  return (
    <Snippet code={value}>
      <SnippetAddon>
        <SnippetText>{label}</SnippetText>
      </SnippetAddon>
      <SnippetInput aria-label={`${label} identifier`} />
      <SnippetAddon align="inline-end">
        <SnippetCopyButton aria-label={`Copy ${label.toLowerCase()} identifier`} />
      </SnippetAddon>
    </Snippet>
  );
}

export function AgentRunHeader({
  detail,
  task,
  agent,
  companyId,
  taskLoading,
}: {
  detail: TaskExecutionRunJoinedDetail;
  task: Task | undefined;
  agent: Agent;
  companyId: string;
  taskLoading: boolean;
}) {
  const { run } = detail;
  const duration = runDurationMs(run);
  const accounting = latestAccountingRecord(detail.accounting.items);
  const cost = summarizeRunCost(detail.costs.items);
  const accountingObservationLabel = detail.accounting.truncated
    ? "Latest loaded prompt"
    : "Latest settled prompt";
  const costLabel = detail.costs.truncated ? "Known cost in loaded records" : "Known prompt cost";
  const configurationMatchesRun = agent.currentAdapterConfigRevisionId === run.adapterConfigRevisionId;
  return (
    <header className="space-y-4 border-b pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <DomainStatus status={run.status} />
        <Badge variant="outline" className="capitalize">
          {run.kind}
        </Badge>
        <Badge variant="outline" className="capitalize">
          {run.executionMode}
        </Badge>
        {detail.finalization ? (
          <Badge variant="secondary" className="capitalize">
            {humanizeRunValue(detail.finalization.record.action)}
          </Badge>
        ) : null}
        {accounting ? (
          <Context usedTokens={accounting.contextUsedTokens} maxTokens={accounting.contextWindowTokens}>
            <ContextTrigger aria-label={`View ${accountingObservationLabel.toLowerCase()} context usage`} />
            <ContextContent align="end">
              <ContextContentHeader />
              <ContextContentBody className="space-y-1 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Observation</span>
                  <span>{accountingObservationLabel}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Prompt</span>
                  <span className="capitalize">{accounting.promptKind}</span>
                </div>
                {accounting.selectedModelId ? (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Model</span>
                    <span className="max-w-48 truncate font-mono">{accounting.selectedModelId}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Used</span>
                  <span className="font-mono">{formatNumber(accounting.contextUsedTokens)} tokens</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Window</span>
                  <span className="font-mono">{formatNumber(accounting.contextWindowTokens)} tokens</span>
                </div>
              </ContextContentBody>
            </ContextContent>
          </Context>
        ) : null}
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{task ? `${task.identifier} execution` : "Agent execution"}</h2>
        {task ? (
          <p className="text-sm text-muted-foreground">
            <Link
              to="/$companyId/tasks/$taskNumber"
              params={{ companyId, taskNumber: String(task.taskNumber) }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {task.title || task.request}
            </Link>
          </p>
        ) : taskLoading ? (
          <Shimmer className="text-sm">Loading task context…</Shimmer>
        ) : (
          <p className="text-sm text-muted-foreground">Task details are unavailable.</p>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <IdentitySnippet label="Run" value={run.id} />
          <IdentitySnippet label="Session" value={run.sessionId} />
          <IdentitySnippet label="Pinned revision" value={run.adapterConfigRevisionId} />
          <dl className="grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Created</dt>
              <dd className="mt-1">{formatDateTime(run.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="mt-1">{duration === null ? "Not started" : formatDurationMs(duration)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{costLabel}</dt>
              <dd className="mt-1">
                {cost
                  ? formatMoneyAmount(cost.amount, cost.currency)
                  : detail.costs.truncated
                    ? "No known cost loaded"
                    : "Unavailable"}
                {cost?.unavailableCount ? (
                  <span className="ml-1 text-muted-foreground">
                    · {cost.unavailableCount} unpriced prompt{cost.unavailableCount === 1 ? "" : "s"}
                  </span>
                ) : null}
                {detail.costs.truncated ? (
                  <span className="ml-1 text-muted-foreground">· partial</span>
                ) : null}
              </dd>
            </div>
          </dl>
        </div>

        <AgentConfiguration>
          <AgentHeader
            name={agent.name}
            model={!detail.accounting.truncated ? (accounting?.selectedModelId ?? undefined) : undefined}
          />
          {configurationMatchesRun && (agent.instruction || agent.capabilities) ? (
            <AgentContent>
              <AgentTask defaultOpen={false}>
                <TaskTrigger title="Pinned agent configuration" />
                <TaskContent>
                  {agent.instruction ? (
                    <AgentInstructions className="break-words">{agent.instruction}</AgentInstructions>
                  ) : null}
                  {agent.capabilities ? (
                    <div className="space-y-2">
                      <span className="font-medium text-muted-foreground text-sm">Capabilities</span>
                      <p className="break-words rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                        {agent.capabilities}
                      </p>
                    </div>
                  ) : null}
                </TaskContent>
              </AgentTask>
            </AgentContent>
          ) : !configurationMatchesRun ? (
            <AgentContent>
              <p className="text-sm text-muted-foreground">
                This run used a pinned configuration that is not the agent&apos;s current revision. Current
                instructions and capabilities are not presented as historical run data.
              </p>
            </AgentContent>
          ) : null}
        </AgentConfiguration>
      </div>
    </header>
  );
}
