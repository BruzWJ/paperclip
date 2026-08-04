import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SummarySlotDocument,
  SummarySlotIssueRef,
  SummarySlotKey,
  SummarySlotRevision,
  SummarySlotScopeKind,
} from "@paperclipai/shared";
import { History, Loader2, RefreshCw, Sparkles } from "lucide-react";

import { agentsApi } from "@/api/agents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { summarySlotsApi, type SummarySlotSelector } from "@/api/summarySlots";
import { MarkdownBody } from "@/components/MarkdownBody";
import { InlineBanner } from "@/components/InlineBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const LATEST_REVISION_SELECT_VALUE = "__latest__";
const MAX_REVISION_OPTIONS = 30;

export interface SummarySlotCardProps {
  companyId: string | null | undefined;
  scopeKind: SummarySlotScopeKind;
  scopeId?: string | null;
  slotKey?: SummarySlotKey;
  title: string;
  description?: string;
  className?: string;
}

function issueLabel(issue: SummarySlotIssueRef) {
  return issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
}

function revisionLabel(revision: SummarySlotRevision) {
  return `Rev ${revision.revisionNumber}`;
}

function formatRevisionTimestamp(date: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(date)).replace(",", "");
}

function revisionOptionLabel(revision: SummarySlotRevision) {
  return `${revisionLabel(revision)} - ${formatRevisionTimestamp(revision.createdAt)}`;
}

function latestRevisionOptionLabel(
  document: SummarySlotDocument,
  revision: SummarySlotRevision | null,
) {
  return `Latest (Rev ${document.latestRevisionNumber}) - ${
    formatRevisionTimestamp(revision?.createdAt ?? document.updatedAt)
  }`;
}

export function SummarySlotCard({
  companyId,
  scopeKind,
  scopeId = null,
  slotKey = "header",
  title,
  description,
  className,
}: SummarySlotCardProps) {
  const queryClient = useQueryClient();
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [ownerAgentId, setOwnerAgentId] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const selector: SummarySlotSelector | null = companyId
    ? { companyId, scopeKind, scopeId, slotKey }
    : null;

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const summariesEnabled = experimentalQuery.data?.enableSummaries === true;

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? "__none__"),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId && summariesEnabled),
    retry: false,
  });
  const eligibleOwners = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => (
      agent.status === "active" || agent.status === "idle" || agent.status === "running"
    )),
    [agentsQuery.data],
  );
  const slotQueryKey = selector
    ? queryKeys.summarySlots.detail(selector.companyId, selector.scopeKind, selector.slotKey, selector.scopeId)
    : queryKeys.summarySlots.detail("__none__", scopeKind, slotKey, scopeId);
  const revisionsQueryKey = selector
    ? queryKeys.summarySlots.revisions(selector.companyId, selector.scopeKind, selector.slotKey, selector.scopeId)
    : queryKeys.summarySlots.revisions("__none__", scopeKind, slotKey, scopeId);

  const slotQuery = useQuery({
    queryKey: slotQueryKey,
    queryFn: () => summarySlotsApi.get(selector!),
    enabled: Boolean(selector && summariesEnabled),
    retry: false,
    refetchInterval: (query) => query.state.data?.slot?.status === "generating" ? 3_000 : false,
  });

  const revisionsQuery = useQuery({
    queryKey: revisionsQueryKey,
    queryFn: () => summarySlotsApi.revisions(selector!),
    enabled: Boolean(selector && summariesEnabled && slotQuery.data?.document),
    retry: false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => summarySlotsApi.refresh(
      selector!,
      slotQuery.data?.slot?.routineId ? undefined : ownerAgentId,
    ),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      setSelectedRevisionId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: slotQueryKey }),
        queryClient.invalidateQueries({ queryKey: revisionsQueryKey }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Summary generation could not be started.");
    },
  });

  const revisions = revisionsQuery.data?.revisions ?? [];
  const latestDocument = slotQuery.data?.document ?? null;
  const selectedRevision = useMemo(
    () => revisions.find((revision) => revision.id === selectedRevisionId) ?? null,
    [revisions, selectedRevisionId],
  );
  const latestRevision = latestDocument
    ? revisions.find((revision) => revision.id === latestDocument.latestRevisionId) ?? null
    : null;
  const historicalRevision = selectedRevision && selectedRevision.id !== latestDocument?.latestRevisionId
    ? selectedRevision
    : null;
  const displayedBody = historicalRevision?.body ?? latestDocument?.body ?? "";
  const displayingHistoricalRevision = Boolean(historicalRevision);
  const historicalRevisionOptions = (latestDocument
    ? revisions.filter((revision) => revision.id !== latestDocument.latestRevisionId)
    : revisions)
    .toSorted((left, right) => right.revisionNumber - left.revisionNumber)
    .slice(0, MAX_REVISION_OPTIONS - (latestDocument ? 1 : 0));
  const revisionSelectValue = historicalRevision?.id ?? LATEST_REVISION_SELECT_VALUE;
  const latestSelectLabel = latestDocument ? latestRevisionOptionLabel(latestDocument, latestRevision) : "Latest";
  const generatingIssue = slotQuery.data?.generatingIssue ?? null;
  const configuredRoutineId = slotQuery.data?.slot?.routineId ?? null;
  const isGenerating = slotQuery.data?.slot?.status === "generating"
    && generatingIssue
    && !TERMINAL_ISSUE_STATUSES.has(generatingIssue.boardPresentationStatus);
  const generationFailed = slotQuery.data?.slot?.status === "failed";
  const canGenerate = Boolean(configuredRoutineId || ownerAgentId);

  if (experimentalQuery.isLoading || !summariesEnabled) return null;

  const startRefresh = () => {
    if (!selector || !canGenerate || refreshMutation.isPending) return;
    refreshMutation.mutate();
  };

  return (
    <section className={cn("space-y-4", className)}>
      {refreshMutation.isPending ? (
        <p role="status" className="sr-only">Requesting summary generation…</p>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{title}</h2>
            {isGenerating ? <Badge variant="secondary">Generating</Badge> : null}
            {displayingHistoricalRevision ? <Badge variant="outline">Historical revision</Badge> : null}
            {latestDocument && !displayingHistoricalRevision ? <Badge variant="outline">Latest revision</Badge> : null}
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {displayingHistoricalRevision ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSelectedRevisionId(null)}
            >
              Latest
            </Button>
          ) : null}
          {latestDocument && !generationFailed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={startRefresh}
              disabled={!selector || !canGenerate || refreshMutation.isPending || Boolean(isGenerating)}
            >
              {refreshMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          ) : null}
        </div>
      </div>

      {configuredRoutineId ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Summary routine</span>
          <Link className="underline" to={`/routines/${configuredRoutineId}`}>
            Configure owner and schedule
          </Link>
        </div>
      ) : eligibleOwners.length > 0 ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Choose summary owner</span>
          <Select value={ownerAgentId} onValueChange={setOwnerAgentId}>
            <SelectTrigger size="sm" className="w-56" aria-label="Select summary owner">
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              {eligibleOwners.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <InlineBanner tone="warning" title="No summary owner configured">
          Add or resume an ordinary agent before generating a summary.
        </InlineBanner>
      )}

      {actionError ? (
        <div role="alert">
          <InlineBanner tone="warning" title="Summary request failed">
            {actionError}
          </InlineBanner>
        </div>
      ) : null}

      {slotQuery.isError ? (
        <div role="alert">
          <InlineBanner
            tone="warning"
            title="Summary could not be loaded"
            actions={
              <Button type="button" size="sm" variant="outline" onClick={() => void slotQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {slotQuery.error instanceof Error ? slotQuery.error.message : "Try loading the summary again."}
          </InlineBanner>
        </div>
      ) : null}

      {!slotQuery.isError && generationFailed ? (
        <InlineBanner
          tone="danger"
          title="Summary generation failed"
          actions={
            <Button
              type="button"
              size="sm"
              onClick={startRefresh}
              disabled={!selector || !canGenerate || refreshMutation.isPending}
            >
              {refreshMutation.isPending ? "Retrying..." : "Retry"}
            </Button>
          }
        >
          {slotQuery.data?.slot?.failureReason ?? "The generation task ended before writing a summary."}
        </InlineBanner>
      ) : null}

      {!slotQuery.isError && isGenerating && generatingIssue ? (
        <div className="flex items-start gap-3 text-sm">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-foreground">Generating summary</p>
            <p className="text-muted-foreground">
              The selected agent is working in{" "}
              <Link className="underline" to={`/issues/${generatingIssue.identifier ?? generatingIssue.id}`}>
                {issueLabel(generatingIssue)}
              </Link>
              .
            </p>
          </div>
        </div>
      ) : null}

      {!slotQuery.isError && !latestDocument && !isGenerating && !generationFailed && canGenerate ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">No summary yet</p>
            <p className="text-muted-foreground">Generate a concise status snapshot for this surface.</p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={startRefresh}
            disabled={!selector || !canGenerate || refreshMutation.isPending}
          >
            {refreshMutation.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {refreshMutation.isPending ? "Starting..." : "Create summary"}
          </Button>
        </div>
      ) : null}

      {latestDocument ? (
        <div className="space-y-4">
          <MarkdownBody className="text-sm leading-7 text-foreground">
            {displayedBody}
          </MarkdownBody>

          <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span title={formatDateTime(historicalRevision?.createdAt ?? latestRevision?.createdAt ?? latestDocument.updatedAt)}>
              Updated {relativeTime(historicalRevision?.createdAt ?? latestRevision?.createdAt ?? latestDocument.updatedAt)}
            </span>

            {revisions.length > 1 ? (
              <Select
                value={revisionSelectValue}
                onValueChange={(value) => {
                  setSelectedRevisionId(value === LATEST_REVISION_SELECT_VALUE ? null : value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="h-auto border-0 bg-transparent p-0 text-xs shadow-none hover:text-foreground focus-visible:ring-0"
                  aria-label="Select summary revision"
                  title={historicalRevision ? revisionOptionLabel(historicalRevision) : latestSelectLabel}
                >
                  <SelectValue>
                    <History className="size-3.5" aria-hidden="true" />
                    <span>{revisions.length} revisions</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end" position="popper">
                  <SelectItem value={LATEST_REVISION_SELECT_VALUE} className="text-xs">
                    {latestSelectLabel}
                  </SelectItem>
                  {historicalRevisionOptions.length > 0 ? <SelectSeparator /> : null}
                  {historicalRevisionOptions.map((revision) => (
                    <SelectItem
                      key={revision.id}
                      value={revision.id}
                      className="text-xs"
                      title={formatDateTime(revision.createdAt)}
                    >
                      {revisionOptionLabel(revision)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
