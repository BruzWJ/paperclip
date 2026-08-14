import type { KeyboardEvent } from "react";
import { Check, ChevronsUpDown, Eye, MoreHorizontal, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ENTITY_NONE_VALUE, entityOptionMatchesSearch, useEntitySelectorState } from "@/lib/entity-selector";
import { trackRecentAssignee } from "@/lib/recent-assignees";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import { useNewTaskDialogViewModel } from "./context";
import { participantAgentId } from "./model";

const SELECTOR_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]);

function stopSelectorKeyPropagation(event: KeyboardEvent) {
  if (SELECTOR_KEYS.has(event.key)) event.stopPropagation();
}

const selectorPopoverContentProps = {
  align: "start" as const,
  collisionPadding: 16,
  className: "w-72 max-w-(--sz-calc-23) p-0",
  onKeyDown: stopSelectorKeyPropagation,
};

export function NewTaskAssignmentSelectors() {
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

  const ownerSelector = useEntitySelectorState({
    value: ownerAgentId,
    options: ownerOptions,
    noneLabel: "Choose owner",
    recentOptionIds: recentOwnerOptionIds,
    onChange: (value) => {
      if (value) trackRecentAssignee(value);
      setOwnerAgentId(value);
      if (value && status === "backlog") setStatus("todo");
    },
    onConfirm: () => {
      if (projectId) requestEditorRef.current?.focus();
      else projectSelectorRef.current?.focus();
    },
  });
  const projectSelector = useEntitySelectorState({
    value: projectId,
    options: projectOptions,
    noneLabel: "No project",
    recentOptionIds: recentProjectIds,
    onChange: handleProjectChange,
    onConfirm: () => requestEditorRef.current?.focus(),
  });
  const participantRecentOptionIds = recentOwnerOptionIds.map((id) => `agent:${id}`);
  const reviewerSelector = useEntitySelectorState({
    value: reviewerValue,
    options: participantOptions,
    noneLabel: "No reviewer",
    recentOptionIds: participantRecentOptionIds,
    onChange: setReviewerValue,
  });
  const approverSelector = useEntitySelectorState({
    value: approverValue,
    options: participantOptions,
    noneLabel: "No approver",
    recentOptionIds: participantRecentOptionIds,
    onChange: setApproverValue,
  });
  const reviewerId = participantAgentId(reviewerSelector.currentOption?.id ?? "");
  const reviewer = reviewerId ? (agents ?? []).find((agent) => agent.id === reviewerId) : null;
  const approverId = participantAgentId(approverSelector.currentOption?.id ?? "");
  const approver = approverId ? (agents ?? []).find((agent) => agent.id === approverId) : null;

  return (
    <div className="px-4 pb-2">
      <div className="overflow-x-auto overscroll-x-contain">
        <div className="inline-flex flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
          <span className="w-6 shrink-0 text-center">For</span>
          <Popover open={ownerSelector.open} onOpenChange={ownerSelector.setOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={ownerSelectorRef}
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={ownerSelector.open}
                aria-label="Owner"
                className="w-full justify-between overflow-hidden"
                onPointerDown={() => {
                  ownerSelector.pointerFocusRef.current = true;
                }}
                onFocus={() => {
                  if (ownerSelector.pointerFocusRef.current) ownerSelector.pointerFocusRef.current = false;
                  else ownerSelector.setOpen(true);
                }}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !ownerSelector.currentOption && "text-muted-foreground",
                  )}
                >
                  {ownerSelector.currentOption ? (
                    currentOwner ? (
                      <>
                        <AgentIcon
                          icon={currentOwner.icon}
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate">{ownerSelector.currentOption.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{ownerSelector.currentOption.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">Owner</span>
                  )}
                </span>
                <ChevronsUpDown className="ml-2 size-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent {...selectorPopoverContentProps}>
              <Command
                filter={(optionValue, search) =>
                  entityOptionMatchesSearch(
                    ownerSelector.orderedOptions.find(
                      (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                    ),
                    search,
                  )
                }
              >
                <CommandInput autoFocus placeholder="Search owners..." />
                <CommandList>
                  <CommandEmpty>No available agents found.</CommandEmpty>
                  {ownerSelector.orderedOptions.map((option) => {
                    const owner = option.id ? (agents ?? []).find((agent) => agent.id === option.id) : null;
                    const selected = option.id === ownerAgentId;
                    return (
                      <CommandItem
                        key={option.id || ENTITY_NONE_VALUE}
                        value={option.id || ENTITY_NONE_VALUE}
                        keywords={[option.label, option.searchText ?? ""]}
                        onSelect={() => ownerSelector.select(option)}
                      >
                        {owner ? (
                          <AgentIcon
                            icon={owner.icon}
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        <span className="truncate">{option.label}</span>
                        <Check className={cn("ml-auto size-4", selected ? "opacity-100" : "opacity-0")} />
                      </CommandItem>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <span>in</span>
          <Popover open={projectSelector.open} onOpenChange={projectSelector.setOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={projectSelectorRef}
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={projectSelector.open}
                aria-label="Project"
                className="w-full justify-between overflow-hidden"
                onPointerDown={() => {
                  projectSelector.pointerFocusRef.current = true;
                }}
                onFocus={() => {
                  if (projectSelector.pointerFocusRef.current)
                    projectSelector.pointerFocusRef.current = false;
                  else projectSelector.setOpen(true);
                }}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !projectSelector.currentOption && "text-muted-foreground",
                  )}
                >
                  {projectSelector.currentOption && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "var(--project-seed)" }}
                      />
                      <span className="truncate">{projectSelector.currentOption.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Project</span>
                  )}
                </span>
                <ChevronsUpDown className="ml-2 size-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent {...selectorPopoverContentProps}>
              <Command
                filter={(optionValue, search) =>
                  entityOptionMatchesSearch(
                    projectSelector.orderedOptions.find(
                      (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                    ),
                    search,
                  )
                }
              >
                <CommandInput autoFocus placeholder="Search projects..." />
                <CommandList>
                  <CommandEmpty>No projects found.</CommandEmpty>
                  {projectSelector.orderedOptions.map((option) => {
                    const project = option.id ? orderedProjects.find((item) => item.id === option.id) : null;
                    const selected = option.id === projectId;
                    return (
                      <CommandItem
                        key={option.id || ENTITY_NONE_VALUE}
                        value={option.id || ENTITY_NONE_VALUE}
                        keywords={[option.label, option.searchText ?? ""]}
                        onSelect={() => projectSelector.select(option)}
                      >
                        {option.id ? (
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: project?.color ?? "var(--project-seed)" }}
                          />
                        ) : null}
                        <span className="truncate">{option.label}</span>
                        <Check className={cn("ml-auto size-4", selected ? "opacity-100" : "opacity-0")} />
                      </CommandItem>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" title="Add reviewer or approver">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-44" align="start">
              <DropdownMenuItem
                className={cn("text-xs", showReviewerRow && "bg-accent")}
                onClick={() => {
                  setShowReviewerRow((visible) => !visible);
                  if (showReviewerRow) {
                    setReviewerValue("");
                    reviewerSelector.setOpen(false);
                  }
                }}
              >
                <Eye className="h-3 w-3" />
                Reviewer
              </DropdownMenuItem>
              <DropdownMenuItem
                className={cn("text-xs", showApproverRow && "bg-accent")}
                onClick={() => {
                  setShowApproverRow((visible) => !visible);
                  if (showApproverRow) {
                    setApproverValue("");
                    approverSelector.setOpen(false);
                  }
                }}
              >
                <ShieldCheck className="h-3 w-3" />
                Approver
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {showReviewerRow ? (
        <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex w-6 shrink-0 items-center justify-center">
            <Eye className="h-3.5 w-3.5" />
          </span>
          <Popover open={reviewerSelector.open} onOpenChange={reviewerSelector.setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={reviewerSelector.open}
                aria-label="Reviewer"
                className="w-full justify-between overflow-hidden"
                onPointerDown={() => {
                  reviewerSelector.pointerFocusRef.current = true;
                }}
                onFocus={() => {
                  if (reviewerSelector.pointerFocusRef.current)
                    reviewerSelector.pointerFocusRef.current = false;
                  else reviewerSelector.setOpen(true);
                }}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !reviewerSelector.currentOption && "text-muted-foreground",
                  )}
                >
                  {reviewerSelector.currentOption ? (
                    <>
                      {reviewer ? (
                        <AgentIcon
                          icon={reviewer.icon}
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                      <span className="truncate">{reviewerSelector.currentOption.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Reviewer</span>
                  )}
                </span>
                <ChevronsUpDown className="ml-2 size-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent {...selectorPopoverContentProps}>
              <Command
                filter={(optionValue, search) =>
                  entityOptionMatchesSearch(
                    reviewerSelector.orderedOptions.find(
                      (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                    ),
                    search,
                  )
                }
              >
                <CommandInput autoFocus placeholder="Search reviewers..." />
                <CommandList>
                  <CommandEmpty>No reviewers found.</CommandEmpty>
                  {reviewerSelector.orderedOptions.map((option) => {
                    const reviewerOptionId = participantAgentId(option.id);
                    const reviewerOption = reviewerOptionId
                      ? (agents ?? []).find((agent) => agent.id === reviewerOptionId)
                      : null;
                    const selected = option.id === reviewerValue;
                    return (
                      <CommandItem
                        key={option.id || ENTITY_NONE_VALUE}
                        value={option.id || ENTITY_NONE_VALUE}
                        keywords={[option.label, option.searchText ?? ""]}
                        onSelect={() => reviewerSelector.select(option)}
                      >
                        {reviewerOption ? (
                          <AgentIcon
                            icon={reviewerOption.icon}
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        <span className="truncate">{option.label}</span>
                        <Check className={cn("ml-auto size-4", selected ? "opacity-100" : "opacity-0")} />
                      </CommandItem>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}

      {showApproverRow ? (
        <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex w-6 shrink-0 items-center justify-center">
            <ShieldCheck className="h-3.5 w-3.5" />
          </span>
          <Popover open={approverSelector.open} onOpenChange={approverSelector.setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={approverSelector.open}
                aria-label="Approver"
                className="w-full justify-between overflow-hidden"
                onPointerDown={() => {
                  approverSelector.pointerFocusRef.current = true;
                }}
                onFocus={() => {
                  if (approverSelector.pointerFocusRef.current)
                    approverSelector.pointerFocusRef.current = false;
                  else approverSelector.setOpen(true);
                }}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !approverSelector.currentOption && "text-muted-foreground",
                  )}
                >
                  {approverSelector.currentOption ? (
                    <>
                      {approver ? (
                        <AgentIcon
                          icon={approver.icon}
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                      <span className="truncate">{approverSelector.currentOption.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Approver</span>
                  )}
                </span>
                <ChevronsUpDown className="ml-2 size-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent {...selectorPopoverContentProps}>
              <Command
                filter={(optionValue, search) =>
                  entityOptionMatchesSearch(
                    approverSelector.orderedOptions.find(
                      (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                    ),
                    search,
                  )
                }
              >
                <CommandInput autoFocus placeholder="Search approvers..." />
                <CommandList>
                  <CommandEmpty>No approvers found.</CommandEmpty>
                  {approverSelector.orderedOptions.map((option) => {
                    const approverOptionId = participantAgentId(option.id);
                    const approverOption = approverOptionId
                      ? (agents ?? []).find((agent) => agent.id === approverOptionId)
                      : null;
                    const selected = option.id === approverValue;
                    return (
                      <CommandItem
                        key={option.id || ENTITY_NONE_VALUE}
                        value={option.id || ENTITY_NONE_VALUE}
                        keywords={[option.label, option.searchText ?? ""]}
                        onSelect={() => approverSelector.select(option)}
                      >
                        {approverOption ? (
                          <AgentIcon
                            icon={approverOption.icon}
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        <span className="truncate">{option.label}</span>
                        <Check className={cn("ml-auto size-4", selected ? "opacity-100" : "opacity-0")} />
                      </CommandItem>
                    );
                  })}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
    </div>
  );
}
