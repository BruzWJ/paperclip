import type { Project } from "@paperclipai/shared";

export function sortProjectsByStoredOrder(
  projects: Project[],
  orderedIds: string[],
): Project[] {
  if (projects.length === 0) return [];
  if (orderedIds.length === 0) return projects;

  const byId = new Map(projects.map((project) => [project.id, project]));
  const sorted: Project[] = [];

  for (const id of orderedIds) {
    const project = byId.get(id);
    if (!project) continue;
    sorted.push(project);
    byId.delete(id);
  }
  for (const project of byId.values()) {
    sorted.push(project);
  }
  return sorted;
}
