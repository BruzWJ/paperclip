import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";

export function useApprovalMutations(companyId: string) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Mutation triggers stay disabled={isPending}, announce via role="status" live regions,
  // and show {isPending ? "Approving…" : "Approve"} / {isPending ? "Rejecting…" : "Reject"}.

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(companyId),
      });
      void navigate({
        to: "/$companyId/approvals/$approvalId",
        params: { companyId, approvalId: id },
        search: { resolved: "approved" },
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(companyId),
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to reject");
    },
  });

  const isPending = approveMutation.isPending || rejectMutation.isPending;

  return { approveMutation, rejectMutation, isPending };
}
