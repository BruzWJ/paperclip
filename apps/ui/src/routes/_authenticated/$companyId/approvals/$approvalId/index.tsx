import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { approvalLabel, ApprovalPayloadRenderer, typeIcon } from "@/components/ApprovalPayload";
import { ApprovalComments } from "@/components/approvals/ApprovalComments";
import { JsonCodeBlock } from "@/components/patterns/JsonCodeBlock";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { loadCompanyApproval } from "@/routes/-company-entity-loader";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, ChevronRight, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { completeBooleanGrantMap } from "./-approval-grants";
import { validateApprovalDetailSearch } from "./-approval-search";

export { validateApprovalDetailSearch } from "./-approval-search";

export const Route = createFileRoute("/_authenticated/$companyId/approvals/$approvalId/")({
  validateSearch: validateApprovalDetailSearch,
  loader: ({ abortController, context, params }) =>
    loadCompanyApproval({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.approvalId,
      signal: abortController.signal,
    }),
  component: ApprovalDetail,
});

function ApprovalDetail() {
  const route = getRouteApi("/_authenticated/$companyId/approvals/$approvalId/");
  const { approvalId, companyId } = route.useParams();
  const search = route.useSearch();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const { data: linkedTasks } = useQuery({
    queryKey: queryKeys.approvals.tasks(approvalId!),
    queryFn: () => approvalsApi.listTasks(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Approvals",
        renderLink: (content) => (
          <Link to="/$companyId/approvals" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? "Approval" },
    ]);
  }, [companyId, setBreadcrumbs, approval, approvalId]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.detail(approvalId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.comments(approvalId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.tasks(approvalId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.list(companyId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.list(companyId, "pending"),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.agents.list(companyId),
    });
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
      void navigate({
        to: "/$companyId/approvals/$approvalId",
        params: { companyId, approvalId },
        search: { resolved: "approved" },
        replace: true,
      });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: async () => {
      if (!approval || approval.type !== "hire_agent") {
        return approvalsApi.resubmit(approvalId!);
      }

      const hirePayload = approval.payload as Record<string, unknown>;
      const agentId = hirePayload.agentId;
      const runtimeAgentConfigurationAuditId = hirePayload.runtimeAgentConfigurationAuditId;
      const runtimeAgentConfigurationRequestDigest = hirePayload.runtimeAgentConfigurationRequestDigest;
      if (
        typeof agentId !== "string" ||
        typeof runtimeAgentConfigurationAuditId !== "string" ||
        typeof runtimeAgentConfigurationRequestDigest !== "string"
      ) {
        throw new Error("Hire approval is missing its audited runtime-configuration contract");
      }

      const current = await agentsApi.getRuntimeConfiguration(agentId);
      return approvalsApi.resubmitHire(approvalId!, {
        agentId,
        runtimeAgentConfigurationAuditId,
        runtimeAgentConfigurationRequestDigest,
        configuration: {
          name: current.identity.name,
          title: current.identity.title,
          capabilities: current.identity.capabilities,
          reportsTo: current.identity.reportsTo,
          instruction: current.identity.instruction,
          contextGrants: completeBooleanGrantMap(AGENT_CONTEXT_GRANT_KEYS, current.contextGrants),
          actionGrants: completeBooleanGrantMap(PAPERCLIP_ACTION_KEYS, current.actionGrants),
          mentionReachGrants: completeBooleanGrantMap(
            AGENT_MENTION_REACH_GRANT_KEYS,
            current.mentionReachGrants,
          ),
        },
      });
    },
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const linkedAgent = linkedAgentId ? (agents?.find((agent) => agent.id === linkedAgentId) ?? null) : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const TypeIcon = typeIcon[approval.type] ?? ShieldCheck;
  const requesterName = approval.requestedByAgentId
    ? (agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8))
    : null;
  const showApprovedBanner = search.resolved === "approved" && approval.status === "approved";
  const primaryLinkedTask = linkedTasks?.[0] ?? null;
  const resolvedCtaLabel = primaryLinkedTask
    ? (linkedTasks?.length ?? 0) > 1
      ? "Review linked tasks"
      : "Review linked task"
    : linkedAgent
      ? "Open hired agent"
      : "Back to approvals";
  const navigateToResolvedEntity = () => {
    if (primaryLinkedTask) {
      return navigate({
        to: "/$companyId/tasks/$taskNumber",
        params: {
          companyId,
          taskNumber: String(primaryLinkedTask.taskNumber),
        },
      });
    }
    if (linkedAgent) {
      return navigate({
        to: "/$companyId/agents/$agentId",
        params: { companyId, agentId: linkedAgent.id },
      });
    }
    return navigate({
      to: "/$companyId/approvals",
      params: { companyId },
    });
  };
  const pendingActionStatus = approveMutation.isPending
    ? "Approving request…"
    : rejectMutation.isPending
      ? "Rejecting request…"
      : revisionMutation.isPending
        ? "Requesting revision…"
        : resubmitMutation.isPending
          ? "Marking request resubmitted…"
          : addCommentMutation.isPending
            ? "Posting comment…"
            : null;

  return (
    <div className="space-y-6 max-w-3xl">
      {pendingActionStatus ? (
        <p role="status" className="sr-only">
          {pendingActionStatus}
        </p>
      ) : null}
      {showApprovedBanner && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>Approval confirmed</AlertTitle>
          <AlertDescription>
            <p>Requesting agent was notified to review this approval and linked tasks.</p>
            <Button size="sm" variant="outline" onClick={() => void navigateToResolvedEntity()}>
              {resolvedCtaLabel}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <CardTitle>
                {approvalLabel(approval.type, approval.payload as Record<string, unknown> | null)}
              </CardTitle>
              <CardTitle className="font-mono text-xs font-normal text-muted-foreground">
                {approval.id}
              </CardTitle>
            </div>
          </div>
          <DomainStatus status={approval.status} />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1 text-sm">
            {requesterName && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">Requested by</span>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Avatar size="sm">
                    <AvatarFallback>{deriveInitials(requesterName)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate text-xs">{requesterName}</span>
                </span>
              </div>
            )}
            <ApprovalPayloadRenderer type={approval.type} payload={payload} />
            <Collapsible open={showRawPayload} onOpenChange={setShowRawPayload}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  <ChevronRight className={showRawPayload ? "rotate-90" : undefined} />
                  See full request
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <JsonCodeBlock filename="approval-request.json" value={payload} />
              </CollapsibleContent>
            </Collapsible>
            {approval.decisionNote && (
              <p className="text-xs text-muted-foreground">Decision note: {approval.decisionNote}</p>
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {linkedTasks && linkedTasks.length > 0 && (
            <div className="pt-2 border-t border-border/60">
              <p className="text-xs text-muted-foreground mb-1.5">Linked Tasks</p>
              <div className="space-y-1.5">
                {linkedTasks.map((task) => {
                  return (
                    <Item key={task.id} asChild variant="outline" size="sm">
                      <Link
                        to="/$companyId/tasks/$taskNumber"
                        params={{
                          companyId,
                          taskNumber: String(task.taskNumber),
                        }}
                      >
                        <ItemContent>
                          <ItemTitle>{task.title}</ItemTitle>
                          <ItemDescription>{task.identifier}</ItemDescription>
                        </ItemContent>
                      </Link>
                    </Item>
                  );
                })}
              </div>
              <p className="text-(length:--text-micro) text-muted-foreground mt-2">
                Linked tasks remain open until the requesting agent follows up and closes them.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {isActionable && !isBudgetApproval && (
              <>
                <Button
                  size="sm"
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending}
                >
                  Approve
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => rejectMutation.mutate()}
                  disabled={rejectMutation.isPending}
                >
                  Reject
                </Button>
              </>
            )}
            {isBudgetApproval && approval.status === "pending" && (
              <p className="text-sm text-muted-foreground">
                Resolve this budget stop from the budget controls on{" "}
                <Link to="/$companyId/costs" params={{ companyId }} className="underline underline-offset-2">
                  /costs
                </Link>
                .
              </p>
            )}
            {approval.status === "pending" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => revisionMutation.mutate()}
                disabled={revisionMutation.isPending}
              >
                Request revision
              </Button>
            )}
            {approval.status === "revision_requested" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => resubmitMutation.mutate()}
                disabled={resubmitMutation.isPending}
              >
                Mark resubmitted
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <ApprovalComments
        comments={comments ?? []}
        agentsById={agentById}
        agentNamesById={agentNameById}
        companyId={companyId}
        body={commentBody}
        isPosting={addCommentMutation.isPending}
        onBodyChange={setCommentBody}
        onSubmit={() => addCommentMutation.mutate()}
      />
    </div>
  );
}
