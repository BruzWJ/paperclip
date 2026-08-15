import type { TaskBlockerAttention, TaskRelationTaskSummary } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, Circle, Flag } from "lucide-react";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";
import { isAssignedBacklogBlocker, taskValueLabel } from "@/lib/task-blockers";
import { Progress } from "@/components/ui/progress";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>();

type WaitingStepStatus = "done" | "running" | "queued";

function classifyWaitingStep(
  blocker: TaskRelationTaskSummary,
  liveIds: ReadonlySet<string>,
): WaitingStepStatus {
  // A resolved blocker (done/cancelled) is a completed step; a blocker with a
  // live run is the one currently being worked; everything else is queued.
  if (blocker.boardPresentationStatus === "done" || blocker.boardPresentationStatus === "cancelled")
    return "done";
  if (liveIds.has(blocker.id)) return "running";
  return "queued";
}

// Ordering heuristic (plan §3): done → running → queued, tie-break by identifier
// (P1…Pn plan naming). The payload doesn't carry explicit chain order.
const WAITING_STEP_RANK: Record<WaitingStepStatus, number> = {
  done: 0,
  running: 1,
  queued: 2,
};

function BlockerChip({ blocker, running = false }: { blocker: TaskRelationTaskSummary; running?: boolean }) {
  return (
    <TaskLinkQuicklook
      taskId={blocker.id}
      taskNumber={blocker.taskNumber}
      className="inline-flex max-w-full items-center gap-1 hover:underline"
    >
      <DomainStatus status={blocker.boardPresentationStatus}>
        {taskValueLabel(blocker.boardPresentationStatus)}
      </DomainStatus>
      <span>{blocker.identifier}</span>
      <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) text-muted-foreground">
        {blocker.title}
      </span>
      {running ? <DomainStatus status="running" /> : null}
    </TaskLinkQuicklook>
  );
}

function WaitingStepGlyph({ status }: { status: WaitingStepStatus }) {
  if (status === "done") {
    return <CheckCircle2 aria-hidden />;
  }
  if (status === "running") {
    return <Spinner aria-hidden />;
  }
  return <Circle aria-hidden />;
}

function WaitingOnLiveWorkNotice({
  blockerAttentionState,
  chainBlockers,
  terminalBlockers,
  liveIds,
  parkedBlockers,
}: {
  blockerAttentionState?: string;
  chainBlockers: TaskRelationTaskSummary[];
  terminalBlockers: TaskRelationTaskSummary[];
  liveIds: ReadonlySet<string>;
  parkedBlockers: TaskRelationTaskSummary[];
}) {
  const steps = chainBlockers
    .map((blocker) => ({
      blocker,
      status: classifyWaitingStep(blocker, liveIds),
    }))
    .sort((a, b) => {
      const rank = WAITING_STEP_RANK[a.status] - WAITING_STEP_RANK[b.status];
      if (rank !== 0) return rank;
      const numberRank = a.blocker.taskNumber - b.blocker.taskNumber;
      if (numberRank !== 0) return numberRank;
      return a.blocker.identifier.localeCompare(b.blocker.identifier, undefined, { numeric: true });
    });
  const total = steps.length;
  const doneCount = steps.filter((step) => step.status === "done").length;
  const runningCount = steps.filter((step) => step.status === "running").length;

  // "Now running" replaces "Ultimately waiting on": prefer live terminal
  // leaves that are not already shown in the ordered queue list.
  const stepIds = new Set(steps.map((step) => step.blocker.id));
  const nowRunningSeen = new Set<string>();
  const nowRunning: TaskRelationTaskSummary[] = [];
  for (const blocker of [...terminalBlockers, ...chainBlockers]) {
    if (!liveIds.has(blocker.id)) continue;
    if (stepIds.has(blocker.id)) continue;
    if (nowRunningSeen.has(blocker.id)) continue;
    nowRunningSeen.add(blocker.id);
    nowRunning.push(blocker);
  }

  const queuedNoun = total === 1 ? "task" : "tasks";

  return (
    <Alert
      role="note"
      data-blocker-attention-state={blockerAttentionState}
      data-testid="task-blocked-notice-live"
      className="mb-3"
    >
      <Circle className="animate-pulse fill-current" aria-hidden="true" />
      <AlertTitle>Waiting on live work</AlertTitle>
      <AlertDescription className="gap-2">
        <p>
          Queued behind {total} {queuedNoun} being worked in order. This task resumes automatically when the
          chain is done. An explicit @mention can queue the responsible agent for questions or triage.
        </p>

        <div className="w-full space-y-1" data-testid="task-blocked-notice-progress">
          <div className="text-xs font-medium">
            {doneCount} of {total} done
            {runningCount > 0 ? ` · ${runningCount} running` : null}
          </div>
          <Progress aria-label="Blocker chain progress" value={total === 0 ? 0 : (doneCount / total) * 100} />
        </div>

        <ItemGroup data-testid="task-blocked-notice-steps">
          {steps.map(({ blocker, status }) => (
            <Item key={blocker.id} size="sm">
              <ItemMedia variant="icon">
                <WaitingStepGlyph status={status} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <BlockerChip blocker={blocker} running={status === "running"} />
                </ItemTitle>
              </ItemContent>
            </Item>
          ))}
          <Item size="sm" variant="muted">
            <ItemMedia variant="icon">
              <Circle aria-hidden />
            </ItemMedia>
            <ItemContent>
              <ItemDescription>This task — resumes automatically when the chain is done</ItemDescription>
            </ItemContent>
          </Item>
        </ItemGroup>

        {nowRunning.length > 0 ? (
          <div data-testid="task-blocked-notice-now-running" className="space-y-1">
            <div className="text-xs font-medium">Now running</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {nowRunning.map((blocker) => (
                <BlockerChip key={blocker.id} blocker={blocker} running />
              ))}
            </div>
          </div>
        ) : null}

        {parkedBlockers.length > 0 ? (
          <div data-testid="task-blocked-notice-parked-row" className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-xs font-medium">
              <Flag className="h-3 w-3" aria-hidden />
              Blocked by parked work
            </span>
            {parkedBlockers.map((blocker) => (
              <BlockerChip key={blocker.id} blocker={blocker} />
            ))}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function TaskBlockedNotice({
  taskStatus,
  blockers,
  allBlockers,
  liveTaskIds,
  blockerAttention,
  agentName,
}: {
  taskStatus?: string;
  blockers: TaskRelationTaskSummary[];
  allBlockers?: TaskRelationTaskSummary[];
  liveTaskIds?: ReadonlySet<string>;
  blockerAttention?: TaskBlockerAttention | null;
  agentName?: string | null;
}) {
  if (taskStatus === "done" || taskStatus === "cancelled") return null;
  if (blockers.length === 0 && taskStatus !== "blocked") return null;

  const blockerLabel = blockers.length === 1 ? "the linked task" : "the linked tasks";
  const terminalBlockers = blockers
    .flatMap((blocker) => blocker.terminalBlockers ?? [])
    .filter((blocker, index, all) => all.findIndex((candidate) => candidate.id === blocker.id) === index);

  const isStalled = blockerAttention?.state === "stalled";
  const parkedBlockers = (() => {
    const seen = new Set<string>();
    const collected: TaskRelationTaskSummary[] = [];
    const sources: TaskRelationTaskSummary[] = [...blockers];
    for (const blocker of blockers) {
      for (const terminal of blocker.terminalBlockers ?? []) {
        sources.push(terminal);
      }
    }
    for (const blocker of sources) {
      if (!isAssignedBacklogBlocker(blocker)) continue;
      if (seen.has(blocker.id)) continue;
      seen.add(blocker.id);
      collected.push(blocker);
    }
    return collected;
  })();
  const showParkedRow = parkedBlockers.length > 0;
  const stalledLeafIdentifier =
    blockerAttention?.sampleStalledBlockerIdentifier ?? blockerAttention?.sampleBlockerIdentifier ?? null;
  const stalledLeafBlockers = (() => {
    const candidates: TaskRelationTaskSummary[] = [];
    for (const blocker of [...blockers, ...terminalBlockers]) {
      if (blocker.boardPresentationStatus !== "in_review") continue;
      if (candidates.some((existing) => existing.id === blocker.id)) continue;
      candidates.push(blocker);
    }
    if (stalledLeafIdentifier) {
      const preferred = candidates.find((blocker) => blocker.identifier === stalledLeafIdentifier);
      if (preferred) {
        return [preferred, ...candidates.filter((blocker) => blocker.id !== preferred.id)];
      }
    }
    return candidates;
  })();
  const showStalledRow = isStalled && stalledLeafBlockers.length > 0;

  const responsibleName = agentName ?? "the responsible agent";
  const reopenSuppressed = taskStatus === "blocked" && !isStalled && blockers.length > 0;
  const unresolvedLeafBlockers = (() => {
    if (!reopenSuppressed) return [] as TaskRelationTaskSummary[];
    const seen = new Set<string>();
    const collected: TaskRelationTaskSummary[] = [];
    for (const blocker of blockers) {
      const terminals = (blocker.terminalBlockers ?? []).filter(
        (leaf) => leaf.boardPresentationStatus !== "done" && leaf.boardPresentationStatus !== "cancelled",
      );
      const leaves = terminals.length > 0 ? terminals : [blocker];
      for (const leaf of leaves) {
        if (seen.has(leaf.id)) continue;
        seen.add(leaf.id);
        collected.push(leaf);
      }
    }
    return collected;
  })();
  const reopenSuppressedLeaf = unresolvedLeafBlockers[0] ?? null;
  const reopenSuppressedLeafId = reopenSuppressedLeaf ? reopenSuppressedLeaf.identifier : null;
  const reopenSuppressedLeafStatus = reopenSuppressedLeaf
    ? reopenSuppressedLeaf.boardPresentationStatus.replace(/_/g, " ")
    : null;
  const reopenSuppressedOtherCount = Math.max(unresolvedLeafBlockers.length - 1, 0);

  const liveIds = liveTaskIds ?? EMPTY_LIVE_IDS;
  const chainBlockers = allBlockers ?? blockers;
  const hasLiveWaitingBlocker = [...chainBlockers, ...terminalBlockers].some((blocker) =>
    liveIds.has(blocker.id),
  );
  const waitingOnLiveWork =
    blockerAttention?.state === "covered" && chainBlockers.length > 0 && hasLiveWaitingBlocker;

  if (waitingOnLiveWork) {
    return (
      <WaitingOnLiveWorkNotice
        blockerAttentionState={blockerAttention?.state}
        chainBlockers={chainBlockers}
        terminalBlockers={terminalBlockers}
        liveIds={liveIds}
        parkedBlockers={showParkedRow ? parkedBlockers : []}
      />
    );
  }

  return (
    <Alert role="note" data-blocker-attention-state={blockerAttention?.state} className="mb-3">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Blocked</AlertTitle>
      <AlertDescription className="gap-1.5">
        {blockers.length > 0 || taskStatus === "blocked" ? (
          <>
            <p className="leading-5">
              {blockers.length > 0 ? (
                isStalled ? (
                  stalledLeafBlockers.length > 1 ? (
                    <>
                      Work on this task is blocked by {blockerLabel}, but the chain is stalled in review
                      without a clear next step. Resolve the stalled reviews below or remove them as blockers.
                    </>
                  ) : (
                    <>
                      Work on this task is blocked by {blockerLabel}, but the chain is stalled in review
                      without a clear next step. Resolve the stalled review below or remove it as a blocker.
                    </>
                  )
                ) : reopenSuppressed ? (
                  <>
                    A message won&rsquo;t move this back to todo yet — it stays blocked by {blockerLabel}{" "}
                    until {blockers.length === 1 ? "it is" : "they are"} done, then it reopens automatically.
                    An explicit @mention can queue {responsibleName} for questions or triage in the meantime.
                  </>
                ) : (
                  <>
                    Work on this task is blocked by {blockerLabel} until{" "}
                    {blockers.length === 1 ? "it is" : "they are"} complete. An explicit @mention can queue
                    the responsible agent for questions or triage.
                  </>
                )
              ) : (
                <>
                  Work on this task is blocked until it is moved back to todo. An explicit @mention can queue
                  the responsible agent for questions or triage.
                </>
              )}
            </p>
            {reopenSuppressed && reopenSuppressedLeafId ? (
              <p
                data-testid="task-blocked-notice-reopen-suppressed"
                className="text-xs font-medium leading-5"
              >
                Still blocked by <span className="font-mono">{reopenSuppressedLeafId}</span>
                {reopenSuppressedLeafStatus ? <> ({reopenSuppressedLeafStatus})</> : null}
                {reopenSuppressedOtherCount > 0
                  ? ` and ${reopenSuppressedOtherCount} other ${
                      reopenSuppressedOtherCount === 1 ? "task" : "tasks"
                    }`
                  : null}
                .
              </p>
            ) : null}
            {blockers.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {blockers.map((blocker) => (
                  <BlockerChip key={blocker.id} blocker={blocker} />
                ))}
              </div>
            ) : null}
            {showStalledRow ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-xs font-medium">Stalled in review</span>
                {stalledLeafBlockers.map((blocker) => (
                  <BlockerChip key={blocker.id} blocker={blocker} />
                ))}
              </div>
            ) : terminalBlockers.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-xs font-medium">Ultimately waiting on</span>
                {terminalBlockers.map((blocker) => (
                  <BlockerChip key={blocker.id} blocker={blocker} />
                ))}
              </div>
            ) : null}
            {showParkedRow ? (
              <div
                data-testid="task-blocked-notice-parked-row"
                className="flex flex-wrap items-center gap-1.5 pt-0.5"
              >
                <span className="inline-flex items-center gap-1 text-xs font-medium">
                  <Flag className="h-3 w-3" aria-hidden />
                  Blocked by parked work
                </span>
                {parkedBlockers.map((blocker) => (
                  <BlockerChip key={blocker.id} blocker={blocker} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
