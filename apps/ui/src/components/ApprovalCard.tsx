import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { deriveInitials } from "@/lib/identity";
import { approvalSubject, typeIcon, ApprovalPayloadRenderer, typeLabel } from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { DomainStatus } from "@/components/patterns/DomainStatus";

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  linkToDetails,
  isPending = false,
  pendingAction = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: () => void;
  onReject?: () => void;
  onOpen?: () => void;
  linkToDetails?: boolean;
  isPending?: boolean;
  pendingAction?: "approve" | "reject" | null;
}) {
  const companyId = useCompanyRouteId();
  const [rejectConfirmationOpen, setRejectConfirmationOpen] = useState(false);
  const payload = approval.payload as Record<string, unknown> | null;
  const Icon = typeIcon[approval.type] ?? ShieldCheck;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalSubject(payload);
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const hasFooter = showResolutionButtons || Boolean(linkToDetails || onOpen);

  return (
    <Card aria-busy={isPending}>
      {isPending ? (
        <p className="sr-only" role="status">
          {pendingAction === "approve"
            ? "Approving request…"
            : pendingAction === "reject"
              ? "Rejecting request…"
              : "Updating approval…"}
        </p>
      ) : null}
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <Icon className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{kindLabel}</Badge>
                {requesterAgent && (
                  <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Requested by</span>
                    <span className="inline-flex min-w-0 items-center gap-1.5" title={requesterAgent.name}>
                      <Avatar size="sm">
                        <AvatarFallback>{deriveInitials(requesterAgent.name)}</AvatarFallback>
                      </Avatar>
                      <span className="truncate text-xs">{requesterAgent.name}</span>
                    </span>
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold leading-6 text-foreground">{subject ?? kindLabel}</h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  Approval request created {timeAgo(approval.createdAt)}
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <DomainStatus status={approval.status}>{approval.status.replace(/_/g, " ")}</DomainStatus>
        </div>
      </CardHeader>

      <CardContent>
        <ApprovalPayloadRenderer
          type={approval.type}
          payload={approval.payload}
          hidePrimaryTitle={Boolean(subject)}
        />
      </CardContent>

      {approval.decisionNote && (
        <CardContent>
          <Alert>
            <AlertTitle>Decision note</AlertTitle>
            <AlertDescription>{approval.decisionNote}</AlertDescription>
          </Alert>
        </CardContent>
      )}

      {hasFooter ? (
        <CardFooter className="flex-wrap justify-between gap-3 border-t">
          <div className="flex flex-wrap items-center gap-2">
            {showResolutionButtons && (
              <>
                <Button size="sm" onClick={onApprove} disabled={isPending}>
                  {pendingAction === "approve" ? "Approving..." : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  type="button"
                  onClick={() => setRejectConfirmationOpen(true)}
                  disabled={isPending}
                >
                  {pendingAction === "reject" ? "Rejecting..." : "Reject"}
                </Button>
              </>
            )}
          </div>
          {linkToDetails || onOpen ? (
            linkToDetails ? (
              <Link
                to="/$companyId/approvals/$approvalId"
                params={{ companyId, approvalId: approval.id }}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "h-auto px-2 text-xs text-muted-foreground",
                )}
              >
                View details
              </Link>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto px-2 text-xs text-muted-foreground"
                onClick={onOpen}
              >
                View details
              </Button>
            )
          ) : null}
        </CardFooter>
      ) : null}
      <ConfirmActionDialog
        open={rejectConfirmationOpen}
        onOpenChange={setRejectConfirmationOpen}
        title="Reject this approval?"
        description="This records a rejection for this request. Review the approval details before continuing."
        confirmLabel="Reject approval"
        pendingLabel={pendingAction === "reject" ? "Rejecting..." : "Reject approval"}
        variant="destructive"
        pending={isPending}
        onConfirm={() => onReject?.()}
      />
    </Card>
  );
}
