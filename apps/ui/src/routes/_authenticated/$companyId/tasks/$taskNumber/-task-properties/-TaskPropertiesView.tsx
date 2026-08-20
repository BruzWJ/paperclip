import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ListChecks, Workflow } from "lucide-react";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Accordion } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { taskValueLabel } from "@/lib/task-blockers";
import { cn } from "@/lib/utils";
import { TaskPropertiesRelationships } from "./-relation-controls";
import type { TaskPropertiesController } from "./-TaskProperties";
import { TaskPropertiesAbout } from "./-TaskPropertiesAbout";
import { TaskPropertiesSection, TaskPropertyPicker, TaskPropertyRow } from "./-TaskPropertyPrimitives";
import { TaskStatusUpdateDialog, type StatusRecipientOption } from "./-TaskStatusUpdateDialog";

export function taskCreatorStatusRecipientOption(
  task: Pick<TaskPropertiesController["task"], "creatorKind">,
): StatusRecipientOption {
  const available = task.creatorKind === "agent-execution";
  return {
    value: "creator",
    label: available ? "Task creator · agent" : "Task creator · unavailable",
    disabled: !available,
  };
}

function TaskLabels({ task }: Pick<TaskPropertiesController, "task">) {
  const labels = task.labels ?? [];
  if (labels.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <Badge
          key={label.id}
          variant="outline"
          title={label.name}
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
        >
          {label.name}
        </Badge>
      ))}
    </span>
  );
}

export function TaskPropertiesView(props: TaskPropertiesController) {
  const { task, inline = false, companyId } = props;
  const s = props.state;
  const reviewerContent = props.executionParticipantsContent(
    "review",
    props.reviewerValues,
    s.reviewerSearch,
    s.setReviewerSearch,
    () => props.updateExecutionPolicy([], props.approverValues),
  );
  const approverContent = props.executionParticipantsContent(
    "approval",
    props.approverValues,
    s.approverSearch,
    s.setApproverSearch,
    () => props.updateExecutionPolicy(props.reviewerValues, []),
  );
  const staticValueClass = cn(
    "flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-sm",
    inline && "min-h-11",
  );
  const invokableOwner =
    task.ownerKind === "agent"
      ? (props.sortedTaskOwners.find((owner) => owner.id === task.ownerAgentId) ?? null)
      : null;
  const ownerAvailable = invokableOwner !== null;
  const statusRecipients: readonly StatusRecipientOption[] = [
    {
      value: "owner",
      label: invokableOwner
        ? `Task owner · ${invokableOwner.name}`
        : task.ownerKind === "agent"
          ? `Task owner · ${props.ownerAgent?.name ?? "unavailable agent"} (unavailable)`
          : "Task owner · Board/user (unavailable)",
      disabled: !ownerAvailable,
    },
    taskCreatorStatusRecipientOption(task),
  ];

  return (
    <>
      <Accordion
        type="multiple"
        defaultValue={inline ? ["triage"] : ["triage", "execution", "relationships"]}
        className="w-full"
        aria-label="Task properties"
      >
        <TaskPropertiesSection
          value="triage"
          title="Triage"
          description="Workflow, ownership, and organization"
          icon={ListChecks}
        >
          <FieldGroup className="gap-0">
            <TaskPropertyRow label="Status">
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2">
                <DomainStatus status={task.boardPresentationStatus}>
                  {taskValueLabel(task.boardPresentationStatus)}
                </DomainStatus>
                <TaskStatusUpdateDialog
                  task={task}
                  recipients={statusRecipients}
                  pending={props.statusUpdatePending}
                  onSubmit={props.onStatusUpdate}
                />
              </div>
            </TaskPropertyRow>

            <TaskPropertyRow label="Priority">
              <div className={staticValueClass}>{taskValueLabel(task.priority)}</div>
            </TaskPropertyRow>

            <TaskPropertyRow label="Owner">
              <TaskPropertyPicker
                inline={inline}
                open={s.ownerOpen}
                onOpenChange={(open) => {
                  s.setOwnerOpen(open);
                  if (!open) {
                    s.setOwnerSearch("");
                    s.setPendingOwner(null);
                  }
                }}
                ariaLabel="Change task owner"
                trigger={props.ownerTrigger}
                popoverClassName="w-64"
              >
                {props.ownerContent}
              </TaskPropertyPicker>
              {props.ownerAgent ? (
                <Button
                  asChild
                  type="button"
                  variant="ghost"
                  size={inline ? "icon-lg" : "icon-sm"}
                  className={inline ? "size-11!" : undefined}
                  aria-label={`Open ${props.ownerAgent.name} agent`}
                >
                  <Link
                    to="/$companyId/agents/$agentId"
                    params={{ companyId, agentId: props.ownerAgent.id }}
                    aria-label={`Open ${props.ownerAgent.name} agent`}
                  >
                    <ArrowUpRight data-icon="inline-end" />
                  </Link>
                </Button>
              ) : null}
            </TaskPropertyRow>

            <TaskPropertyRow label="Project">
              <div className={staticValueClass}>
                {task.project ? (
                  <>
                    <span
                      className="size-3 shrink-0 rounded-sm"
                      style={{ backgroundColor: task.project.color ?? "var(--project-seed)" }}
                    />
                    <span className="min-w-0 truncate" title={task.project.name}>
                      {task.project.name}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </div>
              {task.project ? (
                <Button
                  asChild
                  type="button"
                  variant="ghost"
                  size={inline ? "icon-lg" : "icon-sm"}
                  className={inline ? "size-11!" : undefined}
                  aria-label={`Open ${task.project.name} project`}
                >
                  <Link
                    to="/$companyId/projects/$projectId"
                    params={{ companyId, projectId: task.project.id }}
                    aria-label={`Open ${task.project.name} project`}
                  >
                    <ArrowUpRight data-icon="inline-end" />
                  </Link>
                </Button>
              ) : null}
            </TaskPropertyRow>

            <TaskPropertyRow label="Labels">
              <div className={staticValueClass}>
                <TaskLabels task={task} />
              </div>
            </TaskPropertyRow>
          </FieldGroup>
        </TaskPropertiesSection>

        <TaskPropertiesSection
          value="execution"
          title="Execution"
          description="Review, approval, and follow-up"
          icon={Workflow}
        >
          <FieldGroup className="gap-0">
            {props.currentExecutionLabel ? (
              <TaskPropertyRow label="Stage" contentClassName="items-start">
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 pt-1.5">
                  <span className="min-w-0 truncate text-sm" title={props.currentExecutionLabel}>
                    {props.currentExecutionLabel}
                  </span>
                  {props.canCurrentUserDecideExecutionStage ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        size={inline ? "default" : "sm"}
                        className={inline ? "min-h-11" : undefined}
                        disabled={props.decideExecutionStage.isPending}
                        onClick={() => props.requestExecutionStageDecision("approved")}
                      >
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size={inline ? "default" : "sm"}
                        variant="outline"
                        className={inline ? "min-h-11" : undefined}
                        disabled={props.decideExecutionStage.isPending}
                        onClick={() => props.requestExecutionStageDecision("changes_requested")}
                      >
                        Request changes
                      </Button>
                    </div>
                  ) : null}
                  {props.decideExecutionStage.error instanceof Error ? (
                    <span className="text-xs text-destructive" role="alert">
                      {props.decideExecutionStage.error.message}
                    </span>
                  ) : null}
                </div>
              </TaskPropertyRow>
            ) : null}

            <TaskPropertyRow label="Reviewers">
              <TaskPropertyPicker
                inline={inline}
                open={s.reviewersOpen}
                onOpenChange={(open) => {
                  s.setReviewersOpen(open);
                  if (!open) s.setReviewerSearch("");
                }}
                ariaLabel="Edit task reviewers"
                trigger={props.reviewerTrigger}
                popoverClassName="w-64"
              >
                {reviewerContent}
              </TaskPropertyPicker>
            </TaskPropertyRow>

            <TaskPropertyRow label="Approvers">
              <TaskPropertyPicker
                inline={inline}
                open={s.approversOpen}
                onOpenChange={(open) => {
                  s.setApproversOpen(open);
                  if (!open) s.setApproverSearch("");
                }}
                ariaLabel="Edit task approvers"
                trigger={props.approverTrigger}
                popoverClassName="w-64"
              >
                {approverContent}
              </TaskPropertyPicker>
            </TaskPropertyRow>

            <TaskPropertyRow label="Monitor">
              <TaskPropertyPicker
                inline={inline}
                open={s.monitorOpen}
                onOpenChange={(open) => {
                  s.setMonitorOpen(open);
                  if (open) s.setMonitorDetailsOpen(false);
                }}
                ariaLabel="Edit task monitor"
                trigger={props.monitorTrigger}
                popoverClassName="w-80 max-w-full sm:w-(--sz-32rem)"
              >
                {props.monitorContent}
              </TaskPropertyPicker>
            </TaskPropertyRow>
          </FieldGroup>
        </TaskPropertiesSection>

        <TaskPropertiesRelationships {...props} />
        <TaskPropertiesAbout {...props} />
      </Accordion>

      {props.executionDecisionDialog}
    </>
  );
}
