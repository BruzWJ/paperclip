import { BudgetPolicyCard } from "@/routes/_authenticated/$companyId/-BudgetPolicyCard";
import { InlineEditor } from "@/routes/_authenticated/$companyId/-markdown/-InlineEditor";
import { MembershipAction } from "@/routes/_authenticated/$companyId/-MembershipAction";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectProperties } from "@/routes/_authenticated/$companyId/projects/$projectId/-detail/-ProjectProperties";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "@/context/SidebarContext";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet } from "@/plugins/slots";

import {
  ProjectOverviewContent,
  ProjectPluginOperationsList,
  ProjectTasksList,
  ProjectTilePicker,
} from "@/routes/_authenticated/$companyId/projects/$projectId/-detail/-ProjectDetailSections";
import {
  useProjectDetailController,
  type ProjectDetailProps,
  type ProjectTab,
} from "@/routes/_authenticated/$companyId/projects/$projectId/-detail/-useProjectDetailController";
import { AlertTriangle, Star, X } from "lucide-react";

export function ProjectDetailScreen(props: ProjectDetailProps) {
  const model = useProjectDetailController(props);
  if (model.state === "not-found")
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Project not found</EmptyTitle>
          <EmptyDescription>This project does not exist or is unavailable.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (model.state === "loading") return <Skeleton className="h-32 w-full" />;
  if (model.state === "error")
    return (
      <Alert variant="destructive">
        <AlertTriangle  data-icon="inline-start"/>
        <AlertTitle>Could not load project</AlertTitle>
        <AlertDescription>{model.message}</AlertDescription>
      </Alert>
    );
  if (model.state === "empty") return null;
  return <ProjectDetailView model={model} />;
}

function ProjectDetailView({
  model,
}: {
  model: Extract<ReturnType<typeof useProjectDetailController>, { state: "ready" }>;
}) {
  const { isMobile } = useSidebar();
  const {
    companyId,
    project,
    showLeftProjectNotice,
    membershipMutation,
    setDismissedLeftProjectIds,
    updateProject,
    projectStarred,
    projectStarPending,
    pluginTabItems,
    activeTab,
    handleTabChange,
    uploadImage,
    fieldSaveStates,
    updateProjectField,
    archiveProject,
    projectBudgetSummary,
    budgetMutation,
    activePluginTab,
  } = model;
  const tabItems = [
    { value: "list", label: "Tasks" },
    { value: "overview", label: "Overview" },
    ...(project.managedByPlugin ? [{ value: "plugin-operations", label: "Plugin operations" }] : []),
    { value: "configuration", label: "Configuration" },
    { value: "budget", label: "Budget" },
    ...pluginTabItems.map((item) => ({
      value: item.value,
      label: item.label,
    })),
  ];
  return (
    <div className="space-y-6">
      {showLeftProjectNotice ? (
        <Alert>
          <AlertDescription className="flex items-center">
            <span className="min-w-0 flex-1">
              You left this project. It no longer appears in your sidebar.
            </span>
            <MembershipAction
              compact
              state="left"
              mutation={membershipMutation}
              resourceId={project.id}
              resourceName={project.name}
              resourceType="project"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss project membership notice"
              onClick={() => setDismissedLeftProjectIds((current) => new Set(current).add(project.id))}
            >
              <X  data-icon="inline-start"/>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ProjectTilePicker
            color={project.color ?? null}
            icon={project.icon ?? null}
            onSelectIcon={(icon) => updateProject.mutate({ icon })}
            onSelectColor={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <DomainStatus status="hard_stop">Paused by budget hard stop</DomainStatus>
          ) : null}
          {project.managedByPlugin ? (
            <Badge variant="secondary">Managed by {project.managedByPlugin.pluginDisplayName}</Badge>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Toggle
            size="sm"
            pressed={projectStarred}
            disabled={projectStarPending}
            aria-label={`${projectStarred ? "Unstar" : "Star"} ${project.name}`}
            onPressedChange={(next) =>
              membershipMutation.mutate({
                resourceType: "project",
                resourceId: project.id,
                resourceName: project.name,
                starred: next,
              })
            }
          >
            {projectStarPending ? <Spinner /> : <Star  data-icon="inline-start"/>}
          </Toggle>
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton"]}
        entityType="project"
        context={{
          companyId,
          projectId: project.id,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId,
          projectId: project.id,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        {isMobile ? (
          <Select value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
            <SelectTrigger className="h-9" aria-label="Page section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tabItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <TabsList variant="line" className="justify-start">
            {tabItems.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      </Tabs>

      {activeTab === "overview" && (
        <ProjectOverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && (
        <ProjectTasksList projectId={project.id} companyId={companyId} />
      )}

      {activeTab === "plugin-operations" && project?.id && project.managedByPlugin && (
        <ProjectPluginOperationsList
          projectId={project.id}
          companyId={companyId}
          pluginKey={project.managedByPlugin.pluginKey}
        />
      )}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" ? (
        <div className="max-w-3xl">
          {projectBudgetSummary ? (
            <BudgetPolicyCard
              summary={projectBudgetSummary}
              variant="plain"
              isSaving={budgetMutation.isPending}
              onSave={(amount) => budgetMutation.mutate(amount)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Budget data is unavailable.</p>
          )}
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId,
            projectId: project.id,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
