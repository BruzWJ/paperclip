import { TASK_PRIORITIES, TASK_STATUSES } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ListChecks, Workflow } from "lucide-react";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { taskValueLabel } from "@/lib/task-blockers";
import { cn } from "@/lib/utils";
import { TaskPropertiesRelationships } from "./-relation-controls";
import type { TaskPropertiesController } from "./-TaskProperties";
import { TaskPropertiesAbout } from "./-TaskPropertiesAbout";
import { TaskPropertiesSection, TaskPropertyPicker, TaskPropertyRow } from "./-TaskPropertyPrimitives";

export function TaskPropertiesView(props: TaskPropertiesController) {
  const { task, onUpdate, inline = false, companyId } = props;
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
              <Select value={task.boardPresentationStatus} onValueChange={(status) => onUpdate({ status })}>
                <SelectTrigger
                  size={inline ? "default" : "sm"}
                  className={cn("w-full min-w-0 shadow-none", inline && "min-h-11")}
                  aria-label="Status"
                >
                  <SelectValue>
                    <DomainStatus status={task.boardPresentationStatus}>
                      {taskValueLabel(task.boardPresentationStatus)}
                    </DomainStatus>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {TASK_STATUSES.map((status) => (
                    <SelectItem
                      key={status}
                      value={status}
                      textValue={taskValueLabel(status)}
                      className={inline ? "min-h-11" : undefined}
                    >
                      <DomainStatus status={status}>{taskValueLabel(status)}</DomainStatus>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </TaskPropertyRow>

            <TaskPropertyRow label="Priority">
              <Select value={task.priority} onValueChange={(priority) => onUpdate({ priority })}>
                <SelectTrigger
                  size={inline ? "default" : "sm"}
                  className={cn("w-full min-w-0 shadow-none", inline && "min-h-11")}
                  aria-label="Priority"
                >
                  <SelectValue>{taskValueLabel(task.priority)}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {TASK_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority} className={inline ? "min-h-11" : undefined}>
                      {taskValueLabel(priority)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                trailing={
                  props.ownerAgent ? (
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
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ArrowUpRight  data-icon="inline-end"/>
                      </Link>
                    </Button>
                  ) : null
                }
                popoverClassName="w-64"
              >
                {props.ownerContent}
              </TaskPropertyPicker>
            </TaskPropertyRow>

            <TaskPropertyRow label="Project">
              <TaskPropertyPicker
                inline={inline}
                open={s.projectOpen}
                onOpenChange={(open) => {
                  s.setProjectOpen(open);
                  if (!open) s.setProjectSearch("");
                }}
                ariaLabel="Change task project"
                trigger={props.projectTrigger}
                trailing={
                  props.selectedProject ? (
                    <Button
                      asChild
                      type="button"
                      variant="ghost"
                      size={inline ? "icon-lg" : "icon-sm"}
                      className={inline ? "size-11!" : undefined}
                      aria-label={`Open ${props.selectedProject.name} project`}
                    >
                      <Link
                        to="/$companyId/projects/$projectId"
                        params={{ companyId, projectId: props.selectedProject.id }}
                        aria-label={`Open ${props.selectedProject.name} project`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ArrowUpRight  data-icon="inline-end"/>
                      </Link>
                    </Button>
                  ) : null
                }
                popoverClassName="w-64"
              >
                {props.projectContent}
              </TaskPropertyPicker>
            </TaskPropertyRow>

            <TaskPropertyRow label="Labels">
              <TaskPropertyPicker
                inline={inline}
                open={s.labelsOpen}
                onOpenChange={(open) => {
                  s.setLabelsOpen(open);
                  if (!open) s.setLabelSearch("");
                }}
                ariaLabel="Edit task labels"
                trigger={props.labelsTrigger}
                trailing={props.labelsExtra}
                popoverClassName="w-72"
              >
                {props.labelsContent}
              </TaskPropertyPicker>
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
