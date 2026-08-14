import type { CompanyBoardRouteTarget } from "@paperclipai/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, type MouseEventHandler, type ReactNode } from "react";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import type { ProjectScope, RoutineScope } from "@/lib/presentation-contracts";

interface CompanyBoardLinkProps {
  routeTarget: CompanyBoardRouteTarget;
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

function assertNeverRouteTarget(target: never): never {
  throw new Error(`Unsupported company board route target: ${JSON.stringify(target)}`);
}

type CompanyBoardRouteOptions =
  | {
      to: "/$companyId/tasks/$taskNumber";
      params: { companyId: string; taskNumber: string };
      hash?: string;
    }
  | {
      to: "/$companyId/agents/$agentId";
      params: { companyId: string; agentId: string };
    }
  | {
      to: "/$companyId/projects/$projectId";
      params: ProjectScope;
    }
  | {
      to: "/$companyId/routines/$routineId";
      params: RoutineScope;
    }
  | {
      to: "/$companyId/approvals/$approvalId";
      params: { companyId: string; approvalId: string };
    }
  | {
      to: "/$companyId/inbox";
      params: { companyId: string };
    }
  | {
      to: "/$companyId/inbox/requests";
      params: { companyId: string };
    }
  | {
      to: "/$companyId/costs";
      params: { companyId: string };
    };

function companyBoardRouteOptions(
  routeTarget: CompanyBoardRouteTarget,
  companyId: string,
): CompanyBoardRouteOptions {
  switch (routeTarget.kind) {
    case "task":
      return {
        to: "/$companyId/tasks/$taskNumber",
        params: { companyId, taskNumber: String(routeTarget.taskNumber) },
        hash: routeTarget.hash ?? undefined,
      };
    case "agent":
      return {
        to: "/$companyId/agents/$agentId",
        params: { companyId, agentId: routeTarget.id },
      };
    case "project":
      return {
        to: "/$companyId/projects/$projectId",
        params: { companyId, projectId: routeTarget.id },
      };
    case "routine":
      return {
        to: "/$companyId/routines/$routineId",
        params: { companyId, routineId: routeTarget.id },
      };
    case "approval":
      return {
        to: "/$companyId/approvals/$approvalId",
        params: { companyId, approvalId: routeTarget.id },
      };
    case "inbox":
      return {
        to: "/$companyId/inbox",
        params: { companyId },
      };
    case "join_requests":
      return {
        to: "/$companyId/inbox/requests",
        params: { companyId },
      };
    case "costs":
      return {
        to: "/$companyId/costs",
        params: { companyId },
      };
    default:
      return assertNeverRouteTarget(routeTarget);
  }
}

export function useNavigateCompanyBoardTarget() {
  const companyId = useCompanyRouteId();
  const navigate = useNavigate();

  return useCallback(
    (routeTarget: CompanyBoardRouteTarget, options?: { replace?: boolean }) => {
      const routeOptions = companyBoardRouteOptions(routeTarget, companyId);
      void navigate({ ...routeOptions, replace: options?.replace });
    },
    [companyId, navigate],
  );
}

/** Renders a shared structured board target through native TanStack routes. */
export function CompanyBoardLink({ routeTarget, children, className, onClick }: CompanyBoardLinkProps) {
  const companyId = useCompanyRouteId();

  const routeOptions = companyBoardRouteOptions(routeTarget, companyId);
  return (
    <Link {...routeOptions} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}
