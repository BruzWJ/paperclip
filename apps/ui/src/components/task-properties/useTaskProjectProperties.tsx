import type { Task } from "@paperclipai/shared";
import { orderItemsBySelectedAndRecent } from "../../lib/recent-selections";
import { trackRecentProject } from "../../lib/recent-projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TaskPropertiesData } from "./useTaskPropertiesData";
import type { TaskPropertiesState } from "./useTaskPropertiesState";

interface UseTaskProjectPropertiesOptions {
  task: Task;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  state: TaskPropertiesState;
  data: TaskPropertiesData;
}

export function useTaskProjectProperties({
  task,
  onUpdate,
  inline,
  state,
  data,
}: UseTaskProjectPropertiesOptions) {
  const projectTrigger = task.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={{
          backgroundColor:
            data.orderedProjects.find((project) => project.id === task.projectId)?.color ??
            "var(--project-seed)",
        }}
      />
      <span className="text-sm truncate min-w-0" title={data.projectName(task.projectId)}>
        {data.projectName(task.projectId)}
      </span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const projectPickerOptions = orderItemsBySelectedAndRecent(
    [
      {
        id: "",
        kind: "none" as const,
        name: "No project",
        color: null as string | null,
      },
      ...data.orderedProjects.map((project) => ({
        id: project.id,
        kind: "project" as const,
        project,
        name: project.name,
        color: project.color ?? null,
      })),
    ],
    task.projectId ?? "",
    data.recentProjectIds,
  );

  const projectContent = (
    <>
      <Input
        aria-label="Search projects"
        className="mb-1 h-8 text-xs"
        placeholder="Search projects..."
        value={state.projectSearch}
        onChange={(event) => state.setProjectSearch(event.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        {projectPickerOptions
          .filter((option) => {
            if (!state.projectSearch.trim()) return true;
            const query = state.projectSearch.toLowerCase();
            return option.name.toLowerCase().includes(query);
          })
          .map((option) => (
            <Button
              type="button"
              key={option.id || "__none__"}
              variant={option.id === (task.projectId ?? "") ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start whitespace-nowrap text-xs"
              onClick={() => {
                if (option.kind === "project") {
                  trackRecentProject(option.project.id);
                  onUpdate({ projectId: option.project.id });
                } else {
                  onUpdate({ projectId: null });
                }
                state.setProjectOpen(false);
              }}
            >
              {option.kind === "project" ? (
                <span
                  className="shrink-0 h-3 w-3 rounded-sm"
                  style={{
                    backgroundColor: option.color ?? "var(--project-seed)",
                  }}
                />
              ) : null}
              {option.name}
            </Button>
          ))}
      </div>
    </>
  );

  return { projectTrigger, projectContent };
}
