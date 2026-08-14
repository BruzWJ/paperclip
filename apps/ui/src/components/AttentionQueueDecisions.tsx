import { Spinner } from "@/components/ui/spinner";
import type { AttentionItem } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { toast } from "sonner";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ButtonGroup } from "./ui/button-group";
import { Textarea } from "./ui/textarea";
import { FieldLegend, FieldSet } from "./ui/field";
import { ConfirmActionDialog } from "./patterns/ConfirmActionDialog";

// Decision-action buttons: a comfortable tap target when the row is narrow
// (h-9 / text-sm), shrinking back to the dense pill (h-6 / text-xs) once the
// row's own container is wide enough (`@xl` ≈ 576px). Container-query driven so
// the row also reflows correctly inside narrow side panels, not just on phones.
const ACTION_BTN = "h-9 gap-1.5 px-3 text-sm @xl:h-6 @xl:gap-1 @xl:px-2 @xl:text-xs";

type CompactDecisionAction = "approve" | "reject" | "request_revision";

interface AttentionDecisionProps {
  item: AttentionItem;
  companyId: string;
}

export function compactDecisionAction(item: AttentionItem, verbId: string): CompactDecisionAction | null {
  if (
    item.sourceKind === "approval" &&
    (verbId === "approve" || verbId === "reject" || verbId === "request_revision")
  ) {
    return verbId;
  }
  if (item.sourceKind === "join_request" && (verbId === "approve" || verbId === "reject")) {
    return verbId;
  }
  return null;
}

/** The compact accept/reject verbs a collapsed row can resolve in place. */
export function collectCompactActions(
  item: AttentionItem,
): Array<{ action: CompactDecisionAction; label: string; id: string }> {
  return item.decisionVerbs.slice(0, 3).flatMap((verb) => {
    const action = compactDecisionAction(item, verb.id);
    return action ? [{ action, label: verb.label, id: verb.id }] : [];
  });
}

export function CompactDecisionActions({ item, companyId }: AttentionDecisionProps) {
  const queryClient = useQueryClient();
  const actions = collectCompactActions(item);

  const decision = useMutation<unknown, Error, CompactDecisionAction>({
    mutationFn: (action: CompactDecisionAction) => {
      if (item.sourceKind === "approval") {
        if (action === "approve") return approvalsApi.approve(item.subject.id);
        if (action === "reject") return approvalsApi.reject(item.subject.id);
        return approvalsApi.requestRevision(item.subject.id);
      }
      if (item.sourceKind === "join_request") {
        return action === "approve"
          ? accessApi.approveJoinRequest(companyId, item.subject.id)
          : accessApi.rejectJoinRequest(companyId, item.subject.id);
      }
      throw new Error("This decision must be completed from its detail view.");
    },
    onSuccess: (_result, action) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.attention(companyId),
      });
      if (item.sourceKind === "approval") {
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(companyId),
        });
      } else {
        queryClient.invalidateQueries({
          queryKey: queryKeys.access.joinRequests(companyId),
        });
      }
      toast.success(compactDecisionSuccessLabel(item.sourceKind, action));
    },
    onError: (error, action) => {
      toast.error(`Could not ${decisionLabel(action)}`, {
        description: error instanceof Error ? error.message : "Please try again.",
      });
    },
  });

  if (actions.length === 0) return null;

  return (
    <ButtonGroup
      className="flex w-full flex-wrap items-center gap-2 @xl:w-auto @xl:justify-end @xl:gap-1"
      aria-label="Decision actions"
    >
      {actions.map(({ action, id, label }) => (
        <Button
          key={id}
          type="button"
          variant={decisionVerbVariant({ id, label, description: "" })}
          size="xs"
          className={cn(ACTION_BTN, "min-w-0 flex-1 @xl:flex-none")}
          disabled={decision.isPending}
          onClick={(event) => {
            event.stopPropagation();
            decision.mutate(action);
          }}
        >
          {decision.isPending && decision.variables === action && <Spinner className="h-3 w-3" />}
          {label}
        </Button>
      ))}
    </ButtonGroup>
  );
}

export function decisionLabel(action: CompactDecisionAction): string {
  if (action === "request_revision") return "sent for revision";
  if (action === "approve") return "approved";
  return "rejected";
}

export function compactDecisionSuccessLabel(
  sourceKind: AttentionItem["sourceKind"],
  action: CompactDecisionAction,
): string {
  if (sourceKind === "approval") return `Approval ${decisionLabel(action)}`;
  if (sourceKind === "join_request") return `Join request ${decisionLabel(action)}`;
  return `Decision ${decisionLabel(action)}`;
}

export function decisionVerbVariant(
  verb: AttentionItem["decisionVerbs"][number],
): "default" | "outline" | "destructive" {
  const text = `${verb.label} ${verb.description ?? ""}`.toLowerCase();
  if (/\b(reject|decline|deny|delete|remove)\b/.test(text)) return "destructive";
  if (/\b(accept|approve|confirm|apply)\b/.test(text)) return "default";
  return "outline";
}

export function InlineResolver({ item, companyId }: AttentionDecisionProps) {
  if (item.sourceKind === "approval") {
    return <ApprovalResolver item={item} companyId={companyId} />;
  }

  if (item.sourceKind === "join_request") {
    return <JoinRequestResolver item={item} companyId={companyId} />;
  }

  return null;
}

export function ApprovalResolver({ item, companyId }: AttentionDecisionProps) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [rejectConfirmationOpen, setRejectConfirmationOpen] = useState(false);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.approvals.list(companyId),
    });
  };
  const approve = useMutation({
    mutationFn: () => approvalsApi.approve(item.subject.id, note.trim() || undefined),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: () => approvalsApi.reject(item.subject.id, note.trim() || undefined),
    onSuccess: invalidate,
  });
  const revise = useMutation({
    mutationFn: () => approvalsApi.requestRevision(item.subject.id, note.trim() || undefined),
    onSuccess: invalidate,
  });
  const pending = approve.isPending || reject.isPending || revise.isPending;

  return (
    <div className="space-y-3">
      <Textarea
        aria-label="Optional decision note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional decision note…"
        className="min-h-16 text-sm"
      />
      <ButtonGroup className="flex-wrap gap-2">
        <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
          {approve.isPending && <Spinner className="h-3.5 w-3.5" />}
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => revise.mutate()} disabled={pending}>
          {revise.isPending && <Spinner className="h-3.5 w-3.5" />}
          Request revision
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setRejectConfirmationOpen(true)}
          disabled={pending}
        >
          {reject.isPending && <Spinner className="h-3.5 w-3.5" />}
          Reject
        </Button>
      </ButtonGroup>
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          {approve.isPending
            ? "Approving request…"
            : revise.isPending
              ? "Requesting revision…"
              : "Rejecting request…"}
        </p>
      ) : null}
      <ConfirmActionDialog
        open={rejectConfirmationOpen}
        onOpenChange={setRejectConfirmationOpen}
        title="Reject this approval?"
        description="This records a rejection for this request. Review the approval details before continuing."
        confirmLabel="Reject approval"
        pendingLabel={reject.isPending ? "Rejecting…" : "Reject approval"}
        variant="destructive"
        pending={pending}
        onConfirm={() => reject.mutate()}
      />
    </div>
  );
}

export function JoinRequestResolver({ item, companyId }: AttentionDecisionProps) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.access.joinRequests(companyId),
    });
  };
  const approve = useMutation({
    mutationFn: () => accessApi.approveJoinRequest(companyId, item.subject.id),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: () => accessApi.rejectJoinRequest(companyId, item.subject.id),
    onSuccess: invalidate,
  });
  const pending = approve.isPending || reject.isPending;

  return (
    <>
      <div aria-busy={pending}>
        <FieldSet disabled={pending} className="min-w-0 gap-0">
          <FieldLegend className="sr-only">Join request actions</FieldLegend>
          <ButtonGroup>
            <Button size="sm" onClick={() => approve.mutate()} disabled={pending}>
              Approve
            </Button>
            <Button variant="destructive" size="sm" onClick={() => reject.mutate()} disabled={pending}>
              Reject
            </Button>
          </ButtonGroup>
        </FieldSet>
      </div>
      {pending ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Updating join request…
        </p>
      ) : null}
    </>
  );
}
