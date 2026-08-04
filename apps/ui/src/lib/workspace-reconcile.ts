import type { CurrentBoardAccess } from "../api/access";

/**
 * Best-effort client mirror of the backend `runtime:manage` gate that the break-glass override
 * reconcile (`POST /execution-workspaces/:id/reconcile-branch` in `override` mode) actually
 * enforces. The server re-checks `runtime:manage` for every reconcile and is authoritative, so
 * this is defense-in-depth: it hides the "reconcile anyway" affordance from viewers rather than
 * showing a button that always 403s. For human board members `runtime:manage` grants on the
 * same non-viewer, active-membership condition as recovery resolution (see
 * `apps/server/src/services/authorization.ts`), so the shape matches; per-permission-key overrides
 * are not surfaced to the client and remain the server's call.
 */
export function canBoardManageRuntime(
  companyId: string | null | undefined,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!companyId || !boardAccess) return false;
  if (boardAccess.isInstanceAdmin) return true;
  if (!boardAccess.memberships || boardAccess.memberships.length === 0) {
    return boardAccess.companyIds.includes(companyId);
  }

  const membership = boardAccess.memberships.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) return false;
  return membership.membershipRole !== "viewer" && membership.membershipRole !== null;
}
