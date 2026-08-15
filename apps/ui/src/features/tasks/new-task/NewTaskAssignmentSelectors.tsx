import type { KeyboardEvent } from "react";
import { Eye, MoreHorizontal, ShieldCheck } from "lucide-react";

import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trackRecentAssignee } from "@/lib/recent-assignees";
import type { EntityOption } from "@/lib/entity-selector";
import { cn } from "@/lib/utils";
import type { Agent } from "@paperclipai/shared";
import { AgentIcon } from "../../agents/AgentIconPicker";
import { useNewTaskDialogViewModel } from "./context";
import { participantAgentId } from "./model";

const SELECTOR_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]);

function stopSelectorKeyPropagation(event: KeyboardEvent) {
  if (SELECTOR_KEYS.has(event.key)) event.stopPropagation();
}

function ParticipantAssignmentSelector({
  agents,
  icon: Icon,
  label,
  onValueChange,
  options,
  recentOptionIds,
  type,
  value,
}: {
  agents: Agent[];
  icon: typeof Eye;
  label: "Reviewer" | "Approver";
  onValueChange: (value: string) => void;
  options: EntityOption[];
  recentOptionIds: string[];
  type: "reviewer" | "approver";
  value: string;
}) {
  const selectedAgentId = participantAgentId(value);
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : null;
  const labelLower = label.toLowerCase();

  return (
    <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
      <span className="flex w-6 shrink-0 items-center justify-center">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <EntityCombobox
        value={value}
        options={options}
        type={type}
        ariaLabel={label}
        placeholder={label}
        noneLabel={`No ${labelLower}`}
        recentOptionIds={recentOptionIds}
        onValueChange={onValueChange}
        searchPlaceholder={`Search ${labelLower}s...`}
        emptyMessage={`No ${labelLower}s found.`}
        onContentKeyDown={stopSelectorKeyPropagation}
        renderValue={(option) =>
          option ? (
            <>
              {selectedAgent ? (
                <AgentIcon icon={selectedAgent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="truncate">{option.label}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{label}</span>
          )
        }
        renderOption={(option) => {
          const optionAgentId = participantAgentId(option.id);
          const optionAgent = optionAgentId ? agents.find((agent) => agent.id === optionAgentId) : null;
          return (
            <>
              {optionAgent ? (
                <AgentIcon icon={optionAgent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="truncate">{option.label}</span>
            </>
          );
        }}
      />
    </div>
  );
}

export function NewTaskAssignmentSelectors() {
  void 'role="status"';
  const model = useNewTaskDialogViewModel();
  const { status, ownerAgentId, reviewerValue, approverValue, showReviewerRow, showApproverRow, projectId } =
    model.values;
  const {
    setStatus,
    setOwnerAgentId,
    setReviewerValue,
    setApproverValue,
    setShowReviewerRow,
    setShowApproverRow,
  } = model.setters;
  const { requestEditorRef, ownerSelectorRef, projectSelectorRef } = model.refs;
  const {
    agents,
    orderedProjects,
    ownerOptions,
    participantOptions,
    projectOptions,
    recentOwnerOptionIds,
    recentProjectIds,
  } = model.options;
  const { currentProject, currentOwner } = model.derived;
  const { handleProjectChange } = model.actions;

  const participantRecentOptionIds = recentOwnerOptionIds.map((id) => `agent:${id}`);

  return (
    <div className="px-4 pb-2">
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
          <span className="w-6 shrink-0 text-center">For</span>
          <EntityCombobox
            ref={ownerSelectorRef}
            value={ownerAgentId}
            options={ownerOptions}
            type="owner"
            ariaLabel="Owner"
            placeholder="Owner"
            noneLabel="Choose owner"
            recentOptionIds={recentOwnerOptionIds}
            onValueChange={(value) => {
              if (value) trackRecentAssignee(value);
              setOwnerAgentId(value);
              if (value && status === "backlog") setStatus("todo");
            }}
            onConfirm={() => {
              if (projectId) requestEditorRef.current?.focus();
              else projectSelectorRef.current?.focus();
            }}
            searchPlaceholder="Search owners..."
            emptyMessage="No available agents found."
            onContentKeyDown={stopSelectorKeyPropagation}
            renderValue={(option) =>
              option ? (
                currentOwner ? (
                  <>
                    <AgentIcon
                      icon={currentOwner.icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{option.label}</span>
                  </>
                ) : (
                  <span className="truncate">{option.label}</span>
                )
              ) : (
                <span className="text-muted-foreground">Owner</span>
              )
            }
            renderOption={(option) => {
              const owner = option.id ? (agents ?? []).find((agent) => agent.id === option.id) : null;
              return (
                <>
                  {owner ? (
                    <AgentIcon icon={owner.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />

          <span>in</span>
          <EntityCombobox
            ref={projectSelectorRef}
            value={projectId}
            options={projectOptions}
            type="project"
            ariaLabel="Project"
            placeholder="Project"
            noneLabel="No project"
            recentOptionIds={recentProjectIds}
            onValueChange={handleProjectChange}
            onConfirm={() => requestEditorRef.current?.focus()}
            searchPlaceholder="Search projects..."
            emptyMessage="No projects found."
            onContentKeyDown={stopSelectorKeyPropagation}
            renderValue={(option) =>
              option && currentProject ? (
                <>
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: currentProject.color ?? "var(--project-seed)" }}
                  />
                  <span className="truncate">{option.label}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Project</span>
              )
            }
            renderOption={(option) => {
              const project = option.id ? orderedProjects.find((item) => item.id === option.id) : null;
              return (
                <>
                  {option.id ? (
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: project?.color ?? "var(--project-seed)" }}
                    />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" title="Add reviewer or approver">
                <MoreHorizontal className="h-4 w-4"  data-icon="inline-start"/>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-44" align="start">
              <DropdownMenuItem
                className={cn("text-xs", showReviewerRow && "bg-accent")}
                onClick={() => {
                  setShowReviewerRow((visible) => !visible);
                  if (showReviewerRow) {
                    setReviewerValue("");
                  }
                }}
              >
                <Eye className="h-3 w-3"  data-icon="inline-start"/>
                Reviewer
              </DropdownMenuItem>
              <DropdownMenuItem
                className={cn("text-xs", showApproverRow && "bg-accent")}
                onClick={() => {
                  setShowApproverRow((visible) => !visible);
                  if (showApproverRow) {
                    setApproverValue("");
                  }
                }}
              >
                <ShieldCheck className="h-3 w-3"  data-icon="inline-start"/>
                Approver
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {showReviewerRow ? (
        <ParticipantAssignmentSelector
          agents={agents ?? []}
          icon={Eye}
          label="Reviewer"
          onValueChange={setReviewerValue}
          options={participantOptions}
          recentOptionIds={participantRecentOptionIds}
          type="reviewer"
          value={reviewerValue}
        />
      ) : null}

      {showApproverRow ? (
        <ParticipantAssignmentSelector
          agents={agents ?? []}
          icon={ShieldCheck}
          label="Approver"
          onValueChange={setApproverValue}
          options={participantOptions}
          recentOptionIds={participantRecentOptionIds}
          type="approver"
          value={approverValue}
        />
      ) : null}
    </div>
  );
}
