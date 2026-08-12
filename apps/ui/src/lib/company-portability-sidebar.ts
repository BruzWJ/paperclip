import type { Agent, CompanyPortabilitySidebarOrder, Project } from "@paperclipai/shared";

export function buildPortableSidebarOrder(input: {
  orderedAgents: Agent[];
  orderedProjects: Project[];
}): CompanyPortabilitySidebarOrder | undefined {
  const sidebar = {
    agents: input.orderedAgents.map((agent) => agent.id),
    projects: input.orderedProjects.map((project) => project.id),
  };

  return sidebar.agents.length > 0 || sidebar.projects.length > 0 ? sidebar : undefined;
}
