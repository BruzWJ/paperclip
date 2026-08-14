import { AgentIcon } from "@/components/AgentIconPicker";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { autoResizeTextarea } from "@/lib/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  catchUpPolicies,
  catchUpPolicyDescriptions,
  concurrencyPolicies,
  concurrencyPolicyDescriptions,
} from "@/routes/_authenticated/$companyId/routines/-routines-list-data";
import type { RoutinesController } from "@/routes/_authenticated/$companyId/routines/-useRoutinesController";
import { Check, ChevronsUpDown, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { ENTITY_NONE_VALUE, entityOptionMatchesSearch, useEntitySelectorState } from "@/lib/entity-selector";
import { cn } from "@/lib/utils";

interface RoutineComposerDialogProps {
  controller: RoutinesController;
}

export function RoutineComposerDialog({ controller }: RoutineComposerDialogProps) {
  if (controller.status !== "ready") return null;
  return <ReadyRoutineComposerDialog controller={controller} />;
}

function ReadyRoutineComposerDialog({
  controller,
}: {
  controller: Extract<RoutinesController, { status: "ready" }>;
}) {
  const {
    advancedOpen,
    agentById,
    assigneeOptions,
    assigneeSelectorRef,
    composerOpen,
    createRoutine,
    currentAssignee,
    currentProject,
    descriptionEditorRef,
    draft,
    mentionOptions,
    recentAssigneeIds,
    recentProjectIds,
    routineFolders,
    projectOptions,
    projectById,
    projectSelectorRef,
    setAdvancedOpen,
    setComposerOpen,
    setDraft,
    titleInputRef,
    trackRecentAssignee,
    trackRecentProject,
  } = controller;

  const Root = controller.isMobile ? Drawer : Dialog;
  const Content = controller.isMobile ? DrawerContent : DialogContent;
  const Header = controller.isMobile ? DrawerHeader : DialogHeader;
  const Title = controller.isMobile ? DrawerTitle : DialogTitle;
  const Description = controller.isMobile ? DrawerDescription : DialogDescription;
  const Footer = controller.isMobile ? DrawerFooter : DialogFooter;
  const assigneeSelector = useEntitySelectorState({
    value: draft.assigneeAgentId,
    options: assigneeOptions,
    noneLabel: "No responsible",
    recentOptionIds: recentAssigneeIds,
    onChange: (assigneeAgentId) => {
      if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
      setDraft((current) => ({ ...current, assigneeAgentId }));
    },
    onConfirm: () => {
      if (draft.projectId) descriptionEditorRef.current?.focus();
      else projectSelectorRef.current?.focus();
    },
  });
  const projectSelector = useEntitySelectorState({
    value: draft.projectId,
    options: projectOptions,
    noneLabel: "No project",
    recentOptionIds: recentProjectIds,
    onChange: (projectId) => {
      if (projectId) trackRecentProject(projectId);
      setDraft((current) => ({ ...current, projectId }));
    },
    onConfirm: () => descriptionEditorRef.current?.focus(),
  });

  return (
    <>
      <Root
        open={composerOpen}
        onOpenChange={(open) => {
          if (!createRoutine.isPending) {
            setComposerOpen(open);
          }
        }}
      >
        <Content className="flex max-h-(--sz-calc-18) max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <Header className="border-b px-5 py-4">
            <Title>Create routine</Title>
            <Description>Define recurring work. Project and agent are optional for drafts.</Description>
          </Header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 pt-5 pb-3">
              <Textarea
                aria-label="Routine title"
                ref={titleInputRef}
                className="min-h-0 resize-none overflow-hidden border-0 text-xl font-semibold shadow-none focus-visible:ring-0"
                placeholder="Routine title"
                rows={1}
                value={draft.title}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }));
                  autoResizeTextarea(event.target);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    descriptionEditorRef.current?.focus();
                    return;
                  }
                  if (event.key === "Tab" && !event.shiftKey) {
                    event.preventDefault();
                    if (draft.assigneeAgentId) {
                      if (draft.projectId) {
                        descriptionEditorRef.current?.focus();
                      } else {
                        projectSelectorRef.current?.focus();
                      }
                    } else {
                      assigneeSelectorRef.current?.focus();
                    }
                  }
                }}
                autoFocus
              />
            </div>

            <div className="px-5 pb-3">
              <div className="overflow-x-auto overscroll-x-contain">
                <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
                  <span>For</span>
                  <Popover open={assigneeSelector.open} onOpenChange={assigneeSelector.setOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        ref={assigneeSelectorRef}
                        type="button"
                        variant="outline"
                        role="combobox"
                        aria-expanded={assigneeSelector.open}
                        aria-label="Responsible"
                        className="w-full justify-between overflow-hidden"
                        onPointerDown={() => {
                          assigneeSelector.pointerFocusRef.current = true;
                        }}
                        onFocus={() => {
                          if (assigneeSelector.pointerFocusRef.current) {
                            assigneeSelector.pointerFocusRef.current = false;
                          } else assigneeSelector.setOpen(true);
                        }}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
                          {currentAssignee ? (
                            <AgentIcon icon={currentAssignee.icon} className="size-3.5" />
                          ) : null}
                          {assigneeSelector.currentOption?.label ?? "Responsible"}
                        </span>
                        <ChevronsUpDown className="size-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-72 p-0">
                      <Command
                        filter={(optionValue, search) =>
                          entityOptionMatchesSearch(
                            assigneeSelector.orderedOptions.find(
                              (option) => (option.id || ENTITY_NONE_VALUE) === optionValue,
                            ),
                            search,
                          )
                        }
                      >
                        <CommandInput autoFocus placeholder="Search responsible..." />
                        <CommandList>
                          <CommandEmpty>No responsible found.</CommandEmpty>
                          {assigneeSelector.orderedOptions.map((option) => {
                            const assignee = agentById.get(option.id);
                            return (
                              <CommandItem
                                key={option.id || ENTITY_NONE_VALUE}
                                value={option.id || ENTITY_NONE_VALUE}
                                onSelect={() => assigneeSelector.select(option)}
                              >
                                {assignee ? <AgentIcon icon={assignee.icon} className="size-3.5" /> : null}
                                <span className="truncate">{option.label}</span>
                                <Check
                                  className={cn(
                                    "ml-auto size-4",
                                    option.id === draft.assigneeAgentId ? "opacity-100" : "opacity-0",
                                  )}
                                />
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
                        <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-left">
                          {currentProject ? (
                            <span
                              className="size-3.5 shrink-0 rounded-sm"
                              style={{ backgroundColor: currentProject.color ?? "var(--project-none)" }}
                            />
                          ) : null}
                          {projectSelector.currentOption?.label ?? "Project"}
                        </span>
                        <ChevronsUpDown className="size-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-72 p-0">
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
                            const project = projectById.get(option.id);
                            return (
                              <CommandItem
                                key={option.id || ENTITY_NONE_VALUE}
                                value={option.id || ENTITY_NONE_VALUE}
                                onSelect={() => projectSelector.select(option)}
                              >
                                {option.id ? (
                                  <span
                                    className="size-3.5 shrink-0 rounded-sm"
                                    style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                                  />
                                ) : null}
                                <span className="truncate">{option.label}</span>
                                <Check
                                  className={cn(
                                    "ml-auto size-4",
                                    option.id === draft.projectId ? "opacity-100" : "opacity-0",
                                  )}
                                />
                              </CommandItem>
                            );
                          })}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <span>filed in</span>
                  <Select
                    value={draft.folderId ?? "__unfiled"}
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        folderId: value === "__unfiled" ? null : value,
                      }))
                    }
                  >
                    <SelectTrigger
                      aria-label="Routine folder"
                      className="h-8 w-auto min-w-32 border-0 bg-muted/50 px-2 shadow-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unfiled">Unfiled</SelectItem>
                      {(routineFolders?.folders ?? []).map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {folder.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="border-t border-border/60 px-5 py-4">
              <MarkdownEditor
                ref={descriptionEditorRef}
                value={draft.description}
                onChange={(description) => setDraft((current) => ({ ...current, description }))}
                placeholder="Add instructions..."
                bordered={false}
                contentClassName="min-h-(--sz-160px) text-sm text-muted-foreground"
                mentions={mentionOptions}
                onSubmit={() => {
                  if (
                    !createRoutine.isPending &&
                    draft.title.trim() &&
                    draft.projectId &&
                    draft.assigneeAgentId
                  ) {
                    createRoutine.mutate();
                  }
                }}
              />
            </div>

            <div className="border-t border-border/60 px-5 py-3">
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                  <div>
                    <p className="text-sm font-medium">Advanced delivery settings</p>
                    <p className="text-sm text-muted-foreground">
                      Keep policy controls secondary to the work definition.
                    </p>
                  </div>
                  {advancedOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field>
                      <FieldLabel>Concurrency</FieldLabel>
                      <Select
                        value={draft.concurrencyPolicy}
                        onValueChange={(concurrencyPolicy) =>
                          setDraft((current) => ({
                            ...current,
                            concurrencyPolicy,
                          }))
                        }
                      >
                        <SelectTrigger aria-label="Concurrency policy">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {concurrencyPolicies.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value.replaceAll("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {concurrencyPolicyDescriptions[draft.concurrencyPolicy]}
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel>Catch-up</FieldLabel>
                      <Select
                        value={draft.catchUpPolicy}
                        onValueChange={(catchUpPolicy) =>
                          setDraft((current) => ({ ...current, catchUpPolicy }))
                        }
                      >
                        <SelectTrigger aria-label="Catch-up policy">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {catchUpPolicies.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value.replaceAll("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldDescription>{catchUpPolicyDescriptions[draft.catchUpPolicy]}</FieldDescription>
                    </Field>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>

          <Footer className="shrink-0 border-t px-5 py-4 sm:items-center sm:justify-between">
            {createRoutine.isPending ? (
              <p className="sr-only" role="status">
                Creating routine.
              </p>
            ) : null}
            <div className="text-sm text-muted-foreground">
              After creation, Paperclip takes you straight to trigger setup. Draft routines stay paused until
              you add a default agent.
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                onClick={() => createRoutine.mutate()}
                disabled={createRoutine.isPending || !draft.title.trim()}
              >
                <Plus className="mr-2 h-4 w-4" />
                {createRoutine.isPending ? "Creating..." : "Create routine"}
              </Button>
              {createRoutine.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {createRoutine.error instanceof Error
                      ? createRoutine.error.message
                      : "Failed to create routine"}
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          </Footer>
        </Content>
      </Root>
    </>
  );
}
