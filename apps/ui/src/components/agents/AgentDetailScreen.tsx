import { AgentDetailView } from "@/components/agents/AgentDetailView";
import { useBreadcrumbs, type Breadcrumb } from "@/context/BreadcrumbContext";
import type { AgentDetailView as AgentDetailTab } from "@/lib/agent-detail-tabs";
import { useAgentDetailController } from "@/routes/_authenticated/$companyId/agents/$agentId/-useAgentDetailController";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

interface AgentDetailScreenProps {
  companyId: string;
  agentId: string;
  urlTab?: Exclude<AgentDetailTab, "dashboard">;
  urlRunId?: string;
}

export function AgentDetailScreen(props: AgentDetailScreenProps) {
  const controller = useAgentDetailController(props);
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyId, agentId, activeView, urlRunId, agentName } = controller;

  useEffect(() => {
    const crumbs: Breadcrumb[] = [
      {
        label: "Agents",
        renderLink: (content) => (
          <Link to="/$companyId/agents" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
    ];
    if (activeView === "dashboard" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({
        label: agentName,
        renderLink: (content) => (
          <Link
            to="/$companyId/agents/$agentId"
            params={{ companyId, agentId }}
          >
            {content}
          </Link>
        ),
      });
      if (urlRunId) {
        crumbs.push({
          label: "Runs",
          renderLink: (content) => (
            <Link
              to="/$companyId/agents/$agentId/$tab"
              params={{ companyId, agentId, tab: "runs" }}
            >
              {content}
            </Link>
          ),
        });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else {
        const labels = {
          configuration: "Configuration",
          runs: "Runs",
          budget: "Budget",
          dashboard: "Dashboard",
        } as const;
        crumbs.push({ label: labels[activeView] });
      }
    }
    setBreadcrumbs(crumbs);
  }, [activeView, agentId, agentName, companyId, setBreadcrumbs, urlRunId]);

  return <AgentDetailView controller={controller} />;
}
