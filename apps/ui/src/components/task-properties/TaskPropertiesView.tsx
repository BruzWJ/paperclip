import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldGroup, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TaskPropertiesRelationships } from "./relation-controls";
import type { TaskPropertiesController } from "./TaskProperties";
import { TaskPropertiesAbout } from "./TaskPropertiesAbout";

export function TaskPropertiesView(props: TaskPropertiesController) {
  const { task, onUpdate, inline, companyId } = props;
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
    <div>
      <FieldSet>
        <FieldLegend variant="label">Triage</FieldLegend>
        <FieldGroup>
          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Status" title="Status">
              Status
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row items-center">
              <Select value={task.boardPresentationStatus} onValueChange={(status) => onUpdate({ status })}>
                <SelectTrigger className="h-7 w-auto min-w-32 border-0 px-1 shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
                    (status) => (
                      <SelectItem key={status} value={status}>
                        {status.replaceAll("_", " ")}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </FieldContent>
          </Field>
          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Priority" title="Priority">
              Priority
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row items-center">
              <Select value={task.priority} onValueChange={(priority) => onUpdate({ priority })}>
                <SelectTrigger className="h-7 w-auto min-w-32 border-0 px-1 shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["critical", "high", "medium", "low"].map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {priority}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldContent>
          </Field>

          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Labels" title="Labels">
              Labels
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {inline ? (
                <Collapsible
                  className="contents"
                  open={s.labelsOpen}
                  onOpenChange={(open) => {
                    s.setLabelsOpen(open);
                    if (!open) s.setLabelSearch("");
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.labelsTrigger}
                    </Button>
                  </CollapsibleTrigger>
                  {props.labelsExtra}
                  <CollapsibleContent className="basis-full">
                    <Card className="mb-2 gap-0 p-1 shadow-none">{props.labelsContent}</Card>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <>
                  <Popover
                    open={s.labelsOpen}
                    onOpenChange={(open) => {
                      s.setLabelsOpen(open);
                      if (!open) s.setLabelSearch("");
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                        {props.labelsTrigger}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-1" align="end" collisionPadding={16}>
                      {props.labelsContent}
                    </PopoverContent>
                  </Popover>
                  {props.labelsExtra}
                </>
              )}
            </FieldContent>
          </Field>

          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Owner" title="Owner">
              Owner
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {inline ? (
                <Collapsible
                  className="contents"
                  open={s.ownerOpen}
                  onOpenChange={(open) => {
                    s.setOwnerOpen(open);
                    if (!open) {
                      s.setOwnerSearch("");
                      s.setPendingOwner(null);
                    }
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm">
                      {props.ownerTrigger}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="basis-full">
                    <Card className="mb-2 w-52 gap-0 p-1 shadow-none">{props.ownerContent}</Card>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <Popover
                  open={s.ownerOpen}
                  onOpenChange={(open) => {
                    s.setOwnerOpen(open);
                    if (!open) {
                      s.setOwnerSearch("");
                      s.setPendingOwner(null);
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm">
                      {props.ownerTrigger}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-1" align="end" collisionPadding={16}>
                    {props.ownerContent}
                  </PopoverContent>
                </Popover>
              )}
              {props.ownerAgent ? (
                <Button asChild type="button" variant="ghost" size="icon-xs">
                  <Link
                    to="/$companyId/agents/$agentId"
                    params={{ companyId, agentId: props.ownerAgent.id }}
                    aria-label={`Open ${props.ownerAgent.name} agent`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ArrowUpRight />
                  </Link>
                </Button>
              ) : null}
            </FieldContent>
          </Field>

          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Project" title="Project">
              Project
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {inline ? (
                <Collapsible
                  className="contents"
                  open={s.projectOpen}
                  onOpenChange={(open) => {
                    s.setProjectOpen(open);
                    if (!open) s.setProjectSearch("");
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.projectTrigger}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="basis-full">
                    <Card className="mb-2 w-fit min-w-(--sz-11rem) gap-0 p-1 shadow-none">
                      {props.projectContent}
                    </Card>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <Popover
                  open={s.projectOpen}
                  onOpenChange={(open) => {
                    s.setProjectOpen(open);
                    if (!open) s.setProjectSearch("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.projectTrigger}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-fit min-w-(--sz-11rem) p-1" align="end" collisionPadding={16}>
                    {props.projectContent}
                  </PopoverContent>
                </Popover>
              )}
              {props.selectedProject ? (
                <Button asChild type="button" variant="ghost" size="icon-xs">
                  <Link
                    to="/$companyId/projects/$projectId"
                    params={{ companyId, projectId: props.selectedProject.id }}
                    aria-label="Open project"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ArrowUpRight />
                  </Link>
                </Button>
              ) : null}
            </FieldContent>
          </Field>
        </FieldGroup>
      </FieldSet>

      <TaskPropertiesRelationships {...props} />

      <FieldSet>
        <FieldLegend variant="label">Execution</FieldLegend>
        <FieldGroup>
          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Reviewers" title="Reviewers">
              Reviewers
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {inline ? (
                <Collapsible
                  className="contents"
                  open={s.reviewersOpen}
                  onOpenChange={(open) => {
                    s.setReviewersOpen(open);
                    if (!open) s.setReviewerSearch("");
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.reviewerTrigger}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="basis-full">
                    <Card className="mb-2 w-56 gap-0 p-1 shadow-none">{reviewerContent}</Card>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <Popover
                  open={s.reviewersOpen}
                  onOpenChange={(open) => {
                    s.setReviewersOpen(open);
                    if (!open) s.setReviewerSearch("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.reviewerTrigger}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-1" align="end" collisionPadding={16}>
                    {reviewerContent}
                  </PopoverContent>
                </Popover>
              )}
            </FieldContent>
          </Field>

          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Approvers" title="Approvers">
              Approvers
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {inline ? (
                <Collapsible
                  className="contents"
                  open={s.approversOpen}
                  onOpenChange={(open) => {
                    s.setApproversOpen(open);
                    if (!open) s.setApproverSearch("");
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.approverTrigger}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="basis-full">
                    <Card className="mb-2 w-56 gap-0 p-1 shadow-none">{approverContent}</Card>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <Popover
                  open={s.approversOpen}
                  onOpenChange={(open) => {
                    s.setApproversOpen(open);
                    if (!open) s.setApproverSearch("");
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.approverTrigger}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-1" align="end" collisionPadding={16}>
                    {approverContent}
                  </PopoverContent>
                </Popover>
              )}
            </FieldContent>
          </Field>

          <Field orientation="responsive" data-property-row="true">
            <FieldTitle data-property-label="Monitor" title="Monitor">
              Monitor
            </FieldTitle>
            <FieldContent className="min-w-0 flex-row flex-wrap items-center">
              {inline ? (
                <Collapsible className="contents" open={s.monitorOpen} onOpenChange={s.setMonitorOpen}>
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.monitorTrigger}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="basis-full">
                    <Card className="mb-2 w-full gap-0 p-1 shadow-none">{props.monitorContent}</Card>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <Popover open={s.monitorOpen} onOpenChange={s.setMonitorOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="min-w-0 max-w-full">
                      {props.monitorTrigger}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-80 max-w-full p-1 sm:w-(--sz-32rem)"
                    align="end"
                    collisionPadding={16}
                  >
                    {props.monitorContent}
                  </PopoverContent>
                </Popover>
              )}
            </FieldContent>
          </Field>
          {props.currentExecutionLabel && (
            <Field orientation="responsive" data-property-row="true">
              <FieldTitle data-property-label="Execution" title="Execution">
                Execution
              </FieldTitle>
              <FieldContent className="min-w-0">
                <div className="flex min-w-0 flex-col items-start gap-1.5">
                  <span className="text-sm truncate min-w-0" title={props.currentExecutionLabel}>
                    {props.currentExecutionLabel}
                  </span>
                  {props.canCurrentUserDecideExecutionStage ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        className="h-7"
                        disabled={props.decideExecutionStage.isPending}
                        onClick={() => props.requestExecutionStageDecision("approved")}
                      >
                        Approve
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7"
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
              </FieldContent>
            </Field>
          )}
        </FieldGroup>
      </FieldSet>

      {props.executionDecisionDialog}
      <TaskPropertiesAbout {...props} />
    </div>
  );
}
