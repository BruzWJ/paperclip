import { useState } from "react";
import type { Agent, Approval } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, CircleSlash2, ExternalLink, WalletCards, XCircle } from "lucide-react";

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  type ConfirmationProps,
} from "@/components/ai-elements/confirmation";
import {
  ApprovalPayloadRenderer,
  approvalSubject,
  typeIcon,
  typeLabel,
} from "@/features/approvals/ApprovalPayload";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deriveInitials } from "@/lib/identity";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";

interface TaskChatApprovalDecisionInput {
  approvalId: string;
  action: "approve" | "reject";
}

interface TaskChatConfirmationProps {
  approval: Approval;
  requesterAgent?: Agent | null;
  onDecision: (input: TaskChatApprovalDecisionInput) => void;
  isPending?: boolean;
  pendingAction?: TaskChatApprovalDecisionInput["action"] | null;
  className?: string;
}

type ConfirmationApproval = NonNullable<ConfirmationProps["approval"]>;

function confirmationPresentation(approval: Approval): {
  approval: ConfirmationApproval;
  state: ConfirmationProps["state"];
} {
  if (approval.status === "pending" || approval.status === "revision_requested") {
    return {
      approval: { id: approval.id },
      state: "approval-requested",
    };
  }

  return {
    approval: {
      id: approval.id,
      approved: approval.status === "approved",
      reason: approval.decisionNote ?? undefined,
    },
    state: "approval-responded",
  };
}

function hasBoardApprovalDetails(payload: Record<string, unknown>) {
  const textFields = [
    payload.summary,
    payload.recommendedAction,
    payload.nextActionOnApproval,
    payload.proposedComment,
  ];
  return (
    textFields.some((value) => typeof value === "string" && value.trim().length > 0) ||
    (Array.isArray(payload.risks) && payload.risks.some((value) => typeof value === "string" && value.trim()))
  );
}

/**
 * Adapts a durable Paperclip approval to AI Elements' confirmation language.
 * The component emits the task-detail approval mutation's exact input shape;
 * mutation ownership and cache invalidation remain with the route controller.
 */
export function TaskChatConfirmation({
  approval,
  requesterAgent = null,
  onDecision,
  isPending = false,
  pendingAction = null,
  className,
}: TaskChatConfirmationProps) {
  const [rejectConfirmationOpen, setRejectConfirmationOpen] = useState(false);
  const presentation = confirmationPresentation(approval);
  const payload = approval.payload as Record<string, unknown>;
  const Icon = typeIcon[approval.type] ?? CheckCircle2;
  const kindLabel = typeLabel[approval.type] ?? approval.type.replace(/_/g, " ");
  const subject = approvalSubject(payload) ?? kindLabel;
  const showPayload = approval.type !== "request_board_approval" || hasBoardApprovalDetails(payload);
  const isAwaitingDecision = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetStop = approval.type === "budget_override_required";
  const canResolveHere = isAwaitingDecision && !isBudgetStop;
  const detailsLink = (
    <Link
      to="/$companyId/approvals/$approvalId"
      params={{ companyId: approval.companyId, approvalId: approval.id }}
      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground")}
    >
      View details
      <ExternalLink aria-hidden="true" data-icon="inline-start" />
    </Link>
  );

  const submitDecision = (action: TaskChatApprovalDecisionInput["action"]) => {
    if (!canResolveHere || isPending) return;
    onDecision({ approvalId: approval.id, action });
  };

  return (
    <>
      <Confirmation
        approval={presentation.approval}
        state={presentation.state}
        aria-busy={isPending || undefined}
        className={cn("items-stretch gap-3 border-border/70 bg-muted/20 shadow-none", className)}
      >
        {isPending ? (
          <p className="sr-only" role="status">
            {pendingAction === "approve"
              ? "Approving request…"
              : pendingAction === "reject"
                ? "Rejecting request…"
                : "Updating approval…"}
          </p>
        ) : null}

        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{kindLabel}</Badge>
              <DomainStatus status={approval.status} />
            </div>
            <ConfirmationTitle className="font-medium text-foreground">{subject}</ConfirmationTitle>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {requesterAgent ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Avatar size="sm">
                    <AvatarFallback>{deriveInitials(requesterAgent.name)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">Requested by {requesterAgent.name}</span>
                </span>
              ) : (
                <span>Approval request</span>
              )}
              <span aria-hidden="true">·</span>
              <span>Created {timeAgo(approval.createdAt)}</span>
            </div>
          </div>
        </div>

        {showPayload ? (
          <div
            className="rounded-lg border bg-background px-3 py-2.5"
            data-testid="task-chat-approval-payload"
          >
            <ApprovalPayloadRenderer
              type={approval.type}
              payload={payload}
              hidePrimaryTitle={Boolean(approvalSubject(payload))}
            />
          </div>
        ) : null}

        <ConfirmationRequest>
          {isBudgetStop ? (
            <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <WalletCards className="mt-0.5 size-4 shrink-0" aria-hidden="true" data-icon="inline-start" />
              <p>
                This budget stop is governed by company budget controls. Review the request here, then resolve
                it from Costs.
              </p>
            </div>
          ) : approval.status === "revision_requested" ? (
            <p className="text-sm text-muted-foreground">
              A revision was requested. Review the latest proposal before recording a decision.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Review the request before recording a decision for the agent.
            </p>
          )}
        </ConfirmationRequest>

        <ConfirmationAccepted>
          <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
              data-icon="inline-start"
            />
            <div className="min-w-0">
              <p className="font-medium text-foreground">Request approved</p>
              <p className="text-muted-foreground">
                {approval.decisionNote ?? "The agent can continue with the approved action."}
              </p>
            </div>
          </div>
        </ConfirmationAccepted>

        <ConfirmationRejected>
          <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
            {approval.status === "cancelled" ? (
              <CircleSlash2
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
                data-icon="inline-start"
              />
            ) : (
              <XCircle
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
                data-icon="inline-start"
              />
            )}
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {approval.status === "cancelled" ? "Request cancelled" : "Request rejected"}
              </p>
              <p className="text-muted-foreground">
                {approval.decisionNote ??
                  (approval.status === "cancelled"
                    ? "This request no longer needs a decision."
                    : "The requested action was not approved.")}
              </p>
            </div>
          </div>
        </ConfirmationRejected>

        <ConfirmationActions className="w-full flex-wrap justify-between self-stretch border-t pt-3">
          {detailsLink}
          {isBudgetStop ? (
            <Link
              to="/$companyId/costs"
              params={{ companyId: approval.companyId }}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <WalletCards aria-hidden="true" data-icon="inline-start" />
              Open budget controls
            </Link>
          ) : (
            <div className="flex items-center gap-2">
              <ConfirmationAction
                variant="destructive"
                disabled={!canResolveHere || isPending}
                onClick={() => setRejectConfirmationOpen(true)}
              >
                {pendingAction === "reject" ? <Spinner /> : null}
                {pendingAction === "reject" ? "Rejecting…" : "Reject"}
              </ConfirmationAction>
              <ConfirmationAction
                disabled={!canResolveHere || isPending}
                onClick={() => submitDecision("approve")}
              >
                {pendingAction === "approve" ? <Spinner /> : null}
                {pendingAction === "approve" ? "Approving…" : "Approve"}
              </ConfirmationAction>
            </div>
          )}
        </ConfirmationActions>

        {!isAwaitingDecision ? <div className="flex justify-end border-t pt-3">{detailsLink}</div> : null}
      </Confirmation>

      <ConfirmActionDialog
        open={rejectConfirmationOpen}
        onOpenChange={setRejectConfirmationOpen}
        title="Reject this approval?"
        description="This records a rejection for this request. Review the approval details before continuing."
        confirmLabel="Reject approval"
        pendingLabel="Rejecting approval…"
        variant="destructive"
        pending={isPending && pendingAction === "reject"}
        disabled={!canResolveHere}
        onConfirm={() => submitDecision("reject")}
      />
    </>
  );
}
