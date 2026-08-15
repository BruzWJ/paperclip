import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { FieldSet } from "@/components/ui/field";
import { Item, ItemGroup } from "@/components/ui/item";
import { ArrowRight, Clock3, KeyRound, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { timeAgo } from "@/lib/timeAgo";
import { AgentIcon } from "../../../../../../features/agents/AgentIconPicker";
import { MarkdownEditor } from "../../../../../../features/markdown/MarkdownEditor";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../-detail/-RoutineVariablesEditor";
import { DocumentAnnotationsCountChip, TaskDocumentAnnotations } from "../../../../../../features/document-annotations/TaskDocumentAnnotations";
import { useRoutineDetail } from "./-context";

export function OverviewSection({
  defaultDescriptionAnnotationsOpen = false,
}: {
  defaultDescriptionAnnotationsOpen?: boolean;
} = {}) {
  const ctx = useRoutineDetail();
  const {
    routine,
    editDraft,
    setEditDraft,
    assigneeOptions,
    projectOptions,
    recentAssigneeIds,
    recentProjectIds,
    agentById,
    projectById,
    currentAssignee,
    currentProject,
    mentionOptions,
    assigneeSelectorRef,
    projectSelectorRef,
    descriptionEditorRef,
    routineRuns,
    activity,
    saveRoutine,
    saveConflict,
    isSectionDirty,
    navigateToSection,
  } = ctx;
  const [descriptionAnnotationsOpen, setDescriptionAnnotationsOpen] = useState(
    defaultDescriptionAnnotationsOpen,
  );

  const activeTriggers = routine.triggers.length;
  const nextFire = useMemo(() => {
    const upcoming = routine.triggers
      .filter((trigger) => trigger.kind === "schedule" && trigger.nextRunAt)
      .map((trigger) => new Date(trigger.nextRunAt as Date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return upcoming ? upcoming.toLocaleString() : null;
  }, [routine.triggers]);
  const boundSecrets = editDraft.env ? Object.keys(editDraft.env).length : 0;
  const lastRun = (routineRuns ?? [])[0] ?? null;
  const recentActivity = (activity ?? []).slice(0, 5);
  const summaries = [
    {
      icon: Clock3,
      label: "Triggers",
      value: activeTriggers === 0 ? "None" : `${activeTriggers} active`,
      hint: nextFire ? `Next fire ${nextFire}` : "No schedule",
      section: "triggers" as const,
      ariaLabel: `${activeTriggers} triggers. Open triggers.`,
    },
    {
      icon: KeyRound,
      label: "Secrets",
      value: boundSecrets === 0 ? "None" : `${boundSecrets} bound`,
      hint: "Manage bound secrets",
      section: "secrets" as const,
      ariaLabel: `${boundSecrets} secrets bound. Open secrets.`,
    },
    {
      icon: Play,
      label: "Last run",
      value: lastRun ? lastRun.status.replaceAll("_", " ") : "No runs",
      hint: lastRun ? timeAgo(lastRun.triggeredAt) : "Trigger a run",
      section: "runs" as const,
      ariaLabel: lastRun ? `Last run ${lastRun.status}. Open runs.` : "No runs. Open runs.",
    },
  ];
  const descriptionEditor = (
    <MarkdownEditor
      ref={descriptionEditorRef}
      value={editDraft.description}
      onChange={(description) => setEditDraft((current) => ({ ...current, description }))}
      placeholder="Add instructions..."
      bordered={false}
      contentClassName="min-h-(--sz-120px) text-sm leading-7"
      mentions={mentionOptions}
      readOnly={saveRoutine.isPending}
      onSubmit={() => {
        if (!saveRoutine.isPending && editDraft.title.trim()) saveRoutine.mutate();
      }}
    />
  );

  return (
    <div className="space-y-6">
      {/* Assignment row */}
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
          <span>For</span>
          <EntityCombobox
            ref={assigneeSelectorRef}
            value={editDraft.assigneeAgentId}
            options={assigneeOptions}
            type="responsible"
            ariaLabel="Responsible"
            placeholder="Responsible"
            noneLabel="No responsible"
            recentOptionIds={recentAssigneeIds}
            onValueChange={(assigneeAgentId) => setEditDraft((current) => ({ ...current, assigneeAgentId }))}
            onConfirm={() => {
              if (editDraft.projectId) descriptionEditorRef.current?.focus();
              else projectSelectorRef.current?.focus();
            }}
            searchPlaceholder="Search responsible..."
            emptyMessage="No responsible found."
            renderValue={(option) => (
              <>
                {currentAssignee ? <AgentIcon icon={currentAssignee.icon} className="size-3.5" /> : null}
                {option?.label ?? "Responsible"}
              </>
            )}
            renderOption={(option) => {
              const assignee = agentById.get(option.id);
              return (
                <>
                  {assignee ? <AgentIcon icon={assignee.icon} className="size-3.5" /> : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
          <span>in</span>
          <EntityCombobox
            ref={projectSelectorRef}
            value={editDraft.projectId}
            options={projectOptions}
            type="project"
            ariaLabel="Project"
            placeholder="Project"
            noneLabel="No project"
            recentOptionIds={recentProjectIds}
            onValueChange={(projectId) => setEditDraft((current) => ({ ...current, projectId }))}
            onConfirm={() => descriptionEditorRef.current?.focus()}
            searchPlaceholder="Search projects..."
            emptyMessage="No projects found."
            renderValue={(option) => (
              <>
                {currentProject ? (
                  <span
                    className="size-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: currentProject.color ?? "var(--project-none)" }}
                  />
                ) : null}
                {option?.label ?? "Project"}
              </>
            )}
            renderOption={(option) => {
              const project = projectById.get(option.id);
              return (
                <>
                  {option.id ? (
                    <span
                      className="size-3.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        </div>
      </div>

      {!routine.assigneeAgentId ? (
        <Alert>
          <AlertDescription>
            Default agent required. This routine can stay as a draft and still run manually, but automation
            stays paused until you assign a default agent.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Instructions */}
      <div className="space-y-2">
        <div className="flex items-center justify-end">
          {routine.descriptionDocument ? (
            <DocumentAnnotationsCountChip
              target={{
                kind: "routine",
                routineId: routine.id,
                documentKey: "description",
              }}
              panelOpen={descriptionAnnotationsOpen}
              onToggle={() => setDescriptionAnnotationsOpen((open) => !open)}
            />
          ) : null}
        </div>
        <FieldSet
          aria-busy={saveRoutine.isPending}
          aria-label="Routine instructions"
          className="m-0 min-w-0 border-0 p-0"
          disabled={saveRoutine.isPending}
        >
          {routine.descriptionDocument ? (
            <TaskDocumentAnnotations
              doc={routine.descriptionDocument}
              target={{
                kind: "routine",
                routineId: routine.id,
                documentKey: "description",
              }}
              bodyMarkdown={editDraft.description}
              draftDirty={isSectionDirty("overview") || saveRoutine.isPending}
              draftConflicted={saveConflict}
              historicalPreview={false}
              locationHash={typeof window === "undefined" ? "" : window.location.hash}
              panelOpen={descriptionAnnotationsOpen}
              onPanelOpenChange={setDescriptionAnnotationsOpen}
            >
              {descriptionEditor}
            </TaskDocumentAnnotations>
          ) : (
            descriptionEditor
          )}
        </FieldSet>
        {saveRoutine.isPending ? (
          <p aria-live="polite" role="status" className="text-xs text-muted-foreground">
            Saving routine instructions…
          </p>
        ) : null}
      </div>

      {/* Variables peek */}
      <div className="space-y-3">
        <RoutineVariablesHint />
        <RoutineVariablesEditor
          title={editDraft.title}
          description={editDraft.description}
          value={editDraft.variables}
          onChange={(variables) => setEditDraft((current) => ({ ...current, variables }))}
        />
      </div>

      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {summaries.map((summary) => (
          <Button
            key={summary.label}
            variant="outline"
            onClick={() => navigateToSection(summary.section)}
            aria-label={summary.ariaLabel}
            className="h-auto w-full justify-start whitespace-normal p-4 text-left"
          >
            <div className="w-full space-y-1">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                <summary.icon className="h-3.5 w-3.5" />
                {summary.label}
                <ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/60" />
              </div>
              <p className="text-lg font-semibold">{summary.value}</p>
              <p className="text-xs text-muted-foreground">{summary.hint}</p>
            </div>
          </Button>
        ))}
      </div>

      {/* Recent activity */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent activity</p>
        {recentActivity.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <ItemGroup>
            {recentActivity.map((event) => (
              <Item key={event.id} size="sm">
                <Badge variant="outline" className="shrink-0 font-mono">
                  {event.action}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {event.details && Object.keys(event.details).length > 0
                    ? Object.keys(event.details).slice(0, 3).join(" · ")
                    : ""}
                </span>
                <span className="shrink-0 text-muted-foreground/60">{timeAgo(event.createdAt)}</span>
              </Item>
            ))}
            <Button variant="ghost" size="sm" onClick={() => navigateToSection("activity")}>
              View all activity <ArrowRight className="h-3 w-3" />
            </Button>
          </ItemGroup>
        )}
      </div>
    </div>
  );
}
