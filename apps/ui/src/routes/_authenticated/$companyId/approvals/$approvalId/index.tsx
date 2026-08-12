import { createFileRoute } from "@tanstack/react-router";
import { assertOnlySearchKeys, optionalSearchEnum } from "@/routes/-search";
import { loadCompanyApproval } from "@/routes/-company-entity-loader";
import { useEffect, useMemo, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "@/api/approvals";
import { agentsApi } from "@/api/agents";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { StatusBadge } from "@/components/StatusBadge";
import { Identity } from "@/components/Identity";
import {
  approvalLabel,
  typeIcon,
  ApprovalPayloadRenderer,
} from "@/components/ApprovalPayload";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2,
  ChevronRight,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type ApprovalComment,
} from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";

export function validateApprovalDetailSearch(search: Record<string, unknown>): {
  resolved?: "approved";
} {
  assertOnlySearchKeys(search, ["resolved"]);
  return {
    resolved: optionalSearchEnum(
      search.resolved,
      ["approved"] as const,
      "resolved",
    ),
  };
}

export const Route = createFileRoute(
  "/_authenticated/$companyId/approvals/$approvalId/",
)({
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

function completeBooleanGrantMap<Key extends string>(
  keys: readonly Key[],
  values: Partial<Record<Key, boolean>>,
): Record<Key, boolean> {
  return Object.fromEntries(
    keys.map((key) => [key, values[key] === true]),
  ) as Record<Key, boolean>;
}

function ApprovalDetail() {
  const route = getRouteApi(
    "/_authenticated/$companyId/approvals/$approvalId/",
  );
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
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

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
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: async () => {
      if (!approval || approval.type !== "hire_agent") {
        return approvalsApi.resubmit(approvalId!);
      }

      const hirePayload = approval.payload as Record<string, unknown>;
      const agentId = hirePayload.agentId;
      const runtimeAgentConfigurationAuditId =
        hirePayload.runtimeAgentConfigurationAuditId;
      const runtimeAgentConfigurationRequestDigest =
        hirePayload.runtimeAgentConfigurationRequestDigest;
      if (
        typeof agentId !== "string" ||
        typeof runtimeAgentConfigurationAuditId !== "string" ||
        typeof runtimeAgentConfigurationRequestDigest !== "string"
      ) {
        throw new Error(
          "Hire approval is missing its audited runtime-configuration contract",
        );
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
          contextGrants: completeBooleanGrantMap(
            AGENT_CONTEXT_GRANT_KEYS,
            current.contextGrants,
          ),
          actionGrants: completeBooleanGrantMap(
            PAPERCLIP_ACTION_KEYS,
            current.actionGrants,
          ),
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
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Comment failed"),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval)
    return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId =
    typeof payload.agentId === "string" ? payload.agentId : null;
  const linkedAgent = linkedAgentId
    ? (agents?.find((agent) => agent.id === linkedAgentId) ?? null)
    : null;
  const isActionable =
    approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const TypeIcon = typeIcon[approval.type] ?? ShieldCheck;
  const showApprovedBanner =
    search.resolved === "approved" && approval.status === "approved";
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
        <div
          role="status"
          className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">
                  Approval confirmed
                </p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  Requesting agent was notified to review this approval and
                  linked tasks.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={() => void navigateToResolvedEntity()}
            >
              {resolvedCtaLabel}
            </Button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h2 className="text-lg font-semibold">
                {approvalLabel(
                  approval.type,
                  approval.payload as Record<string, unknown> | null,
                )}
              </h2>
              <p className="text-xs text-muted-foreground font-mono">
                {approval.id}
              </p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                Requested by
              </span>
              <Identity
                name={
                  agentNameById.get(approval.requestedByAgentId) ??
                  approval.requestedByAgentId.slice(0, 8)
                }
                size="sm"
              />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`}
            />
            See full request
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">
              Decision note: {approval.decisionNote}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {linkedTasks && linkedTasks.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">Linked Tasks</p>
            <div className="space-y-1.5">
              {linkedTasks.map((task) => {
                const content = (
                  <>
                    <span className="font-mono text-muted-foreground mr-2">
                      {task.identifier}
                    </span>
                    <span>{task.title}</span>
                  </>
                );
                const className =
                  "block rounded border border-border/70 px-2 py-1.5 text-xs";
                return (
                  <Link
                    key={task.id}
                    to="/$companyId/tasks/$taskNumber"
                    params={{ companyId, taskNumber: String(task.taskNumber) }}
                    className={`${className} hover:bg-accent/20`}
                  >
                    {content}
                  </Link>
                );
              })}
            </div>
            <p className="text-(length:--text-micro) text-muted-foreground mt-2">
              Linked tasks remain open until the requesting agent follows up and
              closes them.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isBudgetApproval && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
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
              <Link
                to="/$companyId/costs"
                params={{ companyId }}
                className="underline underline-offset-2"
              >
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
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">
          Comments ({comments?.length ?? 0})
        </h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div
              key={comment.id}
              className="border border-border/60 rounded-md p-3"
            >
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId &&
                agentById.has(comment.authorAgentId) ? (
                  <Link
                    to="/$companyId/agents/$agentId"
                    params={{
                      companyId,
                      agentId: agentById.get(comment.authorAgentId)!.id,
                    }}
                    className="hover:underline"
                  >
                    <Identity
                      name={
                        agentNameById.get(comment.authorAgentId) ??
                        comment.authorAgentId.slice(0, 8)
                      }
                      size="sm"
                    />
                    <span className="sr-only">View agent profile</span>
                  </Link>
                ) : (
                  <Identity
                    name={
                      comment.authorAgentId
                        ? (agentNameById.get(comment.authorAgentId) ??
                          comment.authorAgentId.slice(0, 8))
                        : "Board"
                    }
                    size="sm"
                  />
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          aria-label="Approval comment"
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
