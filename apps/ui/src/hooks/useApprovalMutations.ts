import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";

export function useApprovalMutations(
  companyId: string,
  setActionError: (error: string | null) => void,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
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
      setActionError(
        error instanceof Error ? error.message : "Failed to approve",
      );
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(companyId),
      });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : "Failed to reject",
      );
    },
  });

  return { approveMutation, rejectMutation };
}
