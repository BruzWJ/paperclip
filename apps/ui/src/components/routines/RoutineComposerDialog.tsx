import { AgentIcon } from "@/components/AgentIconPicker";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { autoResizeTextarea } from "@/lib/textarea";
import {
  catchUpPolicies,
  catchUpPolicyDescriptions,
  concurrencyPolicies,
  concurrencyPolicyDescriptions,
} from "@/routes/_authenticated/$companyId/routines/-routines-list-data";
import type { RoutinesController } from "@/routes/_authenticated/$companyId/routines/-useRoutinesController";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";

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
                  <EntityCombobox
                    ref={assigneeSelectorRef}
                    value={draft.assigneeAgentId}
                    options={assigneeOptions}
                    type="responsible"
                    ariaLabel="Responsible"
                    placeholder="Responsible"
                    noneLabel="No responsible"
                    recentOptionIds={recentAssigneeIds}
                    onValueChange={(assigneeAgentId) => {
                      if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                      setDraft((current) => ({ ...current, assigneeAgentId }));
                    }}
                    onConfirm={() => {
                      if (draft.projectId) descriptionEditorRef.current?.focus();
                      else projectSelectorRef.current?.focus();
                    }}
                    searchPlaceholder="Search responsible..."
                    emptyMessage="No responsible found."
                    renderValue={(option) => (
                      <>
                        {currentAssignee ? (
                          <AgentIcon icon={currentAssignee.icon} className="size-3.5" />
                        ) : null}
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
                    value={draft.projectId}
                    options={projectOptions}
                    type="project"
                    ariaLabel="Project"
                    placeholder="Project"
                    noneLabel="No project"
                    recentOptionIds={recentProjectIds}
                    onValueChange={(projectId) => {
                      if (projectId) trackRecentProject(projectId);
                      setDraft((current) => ({ ...current, projectId }));
                    }}
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
                  <span>filed in</span>
                  <EntityCombobox
                    value={draft.folderId ?? ""}
                    options={(routineFolders?.folders ?? []).map((folder) => ({
                      id: folder.id,
                      label: folder.name,
                    }))}
                    onValueChange={(folderId) =>
                      setDraft((current) => ({ ...current, folderId: folderId || null }))
                    }
                    type="folder"
                    ariaLabel="Routine folder"
                    placeholder="Unfiled"
                    noneLabel="Unfiled"
                    searchPlaceholder="Search folders..."
                    emptyMessage="No folders found."
                    triggerClassName="h-8 w-auto min-w-32 border-0 bg-muted/50 px-2 shadow-none"
                  />
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
                    <LabeledFormField
                      label="Concurrency"
                      description={concurrencyPolicyDescriptions[draft.concurrencyPolicy]}
                    >
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
                    </LabeledFormField>
                    <LabeledFormField
                      label="Catch-up"
                      description={catchUpPolicyDescriptions[draft.catchUpPolicy]}
                    >
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
                    </LabeledFormField>
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
