import { Check, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { trackRecentAssignee } from "../../lib/recent-assignees";
import { AgentIcon } from "../AgentIconPicker";
import { InterruptOwnerChangeConfirm, OwnerRunningBanner } from "../owner-transition/OwnerTransitionViews";
import type { TaskPropertiesData } from "./useTaskPropertiesData";
import type { TaskPropertiesState } from "./useTaskPropertiesState";

interface UseTaskPropertiesOwnershipOptions {
  hasActiveRun: boolean;
  inline?: boolean;
  state: TaskPropertiesState;
  data: TaskPropertiesData;
}

function ownerInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function useTaskPropertiesOwnership({
  hasActiveRun,
  inline,
  state,
  data,
}: UseTaskPropertiesOwnershipOptions) {
  const {
    ownerAgent,
    ownerUserLabel,
    sortedTaskOwners,
    sortedAgents,
    selectedOwnerAgentId,
    selectOwner,
    ownerChangeInterruptCopy,
    ownerResolvers,
    applyOwner,
    currentUserId,
    creatorUserId,
    creatorUserLabel,
    otherUserOptions,
    toggleExecutionParticipant,
  } = data;
  const { ownerSearch, setOwnerSearch, pendingOwner, setPendingOwner } = state;
  const ownerTrigger = ownerAgent ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar className="size-5">
        <AvatarFallback>{ownerInitials(ownerAgent.name)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate text-sm">{ownerAgent.name}</span>
    </span>
  ) : ownerUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm" title={ownerUserLabel}>
        {ownerUserLabel}
      </span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">Board escalation</span>
  );

  const agentOwnerOptions = sortedTaskOwners.map((agent) => ({
    value: agent.id,
    agent,
    label: agent.name,
    searchText: `${agent.name} ${agent.title ?? ""}`,
  }));
  const visibleOwnerOptions = agentOwnerOptions.filter((option) => {
    if (!ownerSearch.trim()) return true;
    return `${option.label} ${option.searchText}`.toLowerCase().includes(ownerSearch.toLowerCase());
  });

  const ownerContent = pendingOwner ? (
    <div className="space-y-2 p-1">
      <InterruptOwnerChangeConfirm
        copy={ownerChangeInterruptCopy}
        to={{
          ownerKind: "agent",
          ownerAgentId: pendingOwner.ownerAgentId,
          ownerUserId: null,
        }}
        resolvers={ownerResolvers}
        onConfirm={() => applyOwner(pendingOwner.ownerAgentId, pendingOwner.track)}
        onCancel={() => setPendingOwner(null)}
        compact
      />
    </div>
  ) : (
    <>
      {hasActiveRun ? (
        <div className="px-1 pt-1">
          <OwnerRunningBanner copy={ownerChangeInterruptCopy} compact />
        </div>
      ) : null}
      <Input
        aria-label="Search owners"
        className={cn("mb-1 text-xs", inline ? "min-h-11" : "h-8")}
        placeholder="Search owners..."
        value={ownerSearch}
        onChange={(event) => setOwnerSearch(event.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-56 overflow-y-auto overscroll-contain">
        {visibleOwnerOptions.map((option) => (
          <Button
            type="button"
            key={option.value}
            variant={option.value === selectedOwnerAgentId ? "secondary" : "ghost"}
            size={inline ? "default" : "sm"}
            className={cn("w-full justify-start text-xs", inline && "min-h-11")}
            onClick={() =>
              selectOwner(option.agent.id, option.label, () => trackRecentAssignee(option.agent.id))
            }
          >
            <AgentIcon icon={option.agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
            {option.value === selectedOwnerAgentId ? (
              <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
            ) : null}
          </Button>
        ))}
        {visibleOwnerOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No invokable agent matches.</div>
        ) : null}
      </div>
    </>
  );

  const executionParticipantsContent = (
    stageType: "review" | "approval",
    values: string[],
    search: string,
    setSearch: (value: string) => void,
    onClear: () => void,
  ) => (
    <>
      <Input
        aria-label="Search reviewers or approvers"
        className={cn("mb-1 text-xs", inline ? "min-h-11" : "h-8")}
        placeholder={`Search ${stageType === "review" ? "reviewers" : "approvers"}...`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <Button
          type="button"
          variant={values.length === 0 ? "secondary" : "ghost"}
          size={inline ? "default" : "sm"}
          className={cn("w-full justify-start text-xs", inline && "min-h-11")}
          onClick={onClear}
        >
          No {stageType === "review" ? "reviewers" : "approvers"}
        </Button>
        {currentUserId && (
          <Button
            type="button"
            variant={values.includes(`user:${currentUserId}`) ? "secondary" : "ghost"}
            size={inline ? "default" : "sm"}
            className={cn("w-full justify-start text-xs", inline && "min-h-11")}
            onClick={() => toggleExecutionParticipant(stageType, `user:${currentUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            Assign to me
          </Button>
        )}
        {creatorUserId && creatorUserId !== currentUserId && (
          <Button
            type="button"
            variant={values.includes(`user:${creatorUserId}`) ? "secondary" : "ghost"}
            size={inline ? "default" : "sm"}
            className={cn("w-full justify-start text-xs", inline && "min-h-11")}
            onClick={() => toggleExecutionParticipant(stageType, `user:${creatorUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            {creatorUserLabel || "Requester"}
          </Button>
        )}
        {otherUserOptions
          .filter((option) => {
            if (!search.trim()) return true;
            return `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(search.toLowerCase());
          })
          .map((option) => (
            <Button
              type="button"
              key={`${stageType}:${option.id}`}
              variant={values.includes(option.id) ? "secondary" : "ghost"}
              size={inline ? "default" : "sm"}
              className={cn("w-full justify-start text-xs", inline && "min-h-11")}
              onClick={() => toggleExecutionParticipant(stageType, option.id)}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              {option.label}
            </Button>
          ))}
        {sortedAgents
          .filter((agent) => {
            if (!search.trim()) return true;
            return agent.name.toLowerCase().includes(search.toLowerCase());
          })
          .map((agent) => {
            const encoded = `agent:${agent.id}`;
            return (
              <Button
                type="button"
                key={`${stageType}:${agent.id}`}
                variant={values.includes(encoded) ? "secondary" : "ghost"}
                size={inline ? "default" : "sm"}
                className={cn("w-full justify-start text-xs", inline && "min-h-11")}
                onClick={() => toggleExecutionParticipant(stageType, encoded)}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                {agent.name}
              </Button>
            );
          })}
      </div>
    </>
  );

  return { ownerTrigger, ownerContent, executionParticipantsContent };
}
