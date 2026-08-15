import { Skeleton } from "@/components/ui/skeleton";
import { RoutineRunVariablesDialog } from "@/routes/_authenticated/$companyId/routines/-RoutineRunVariablesDialog";
import { RoutineSaveBar } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineSaveBar";
import { RoutineSectionPicker, RoutineSubSidebar } from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-RoutineSubSidebar";
import { RoutineDetailContext, type RoutineSectionKey } from "@/routes/_authenticated/$companyId/routines/$routineId/-sections/-context";
import {
  DeliverySection,
  OverviewSection,
  SecretsSection,
  TriggersSection,
  VariablesSection,
} from "@/routes/_authenticated/$companyId/routines/$routineId/-sections/-editable-sections";
import { ActivitySection, HistorySection, RunsSection } from "@/routes/_authenticated/$companyId/routines/$routineId/-sections/-operate-sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { SettingsSwitchField } from "@/components/patterns/FormPatterns";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Repeat, Sparkles } from "lucide-react";
import { useEffect } from "react";

import {
  useRoutineDetailController,
  type RoutineDetailControllerOptions,
} from "@/routes/_authenticated/$companyId/routines/$routineId/-detail/-useRoutineDetailController";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { autoResizeTextarea } from "@/lib/textarea";

const SECTION_TITLES: Record<RoutineSectionKey, string> = {
  overview: "Overview",
  triggers: "Triggers",
  variables: "Variables",
  secrets: "Secrets",
  delivery: "Delivery",
  runs: "Runs",
  activity: "Activity",
  history: "History",
};

export function RoutineDetailScreen(props: RoutineDetailControllerOptions) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const model = useRoutineDetailController(props);
  if (model.state === "loading") return <Skeleton className="h-32 w-full" />;
  if (model.state === "error")
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircle  data-icon="inline-start"/>
          </EmptyMedia>
          <EmptyTitle>Couldn’t load routine</EmptyTitle>
          <EmptyDescription>{model.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return <RoutineDetailReady model={model} />;
}

function RoutineDetailReady({
  model,
}: {
  model: Extract<ReturnType<typeof useRoutineDetailController>, { state: "ready" }>;
}) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
    contextValue,
    runRoutine,
    titleInputRef,
    editDraft,
    setEditDraft,
    section,
    descriptionEditorRef,
    navigateToSection,
    routine,
    setRunVariablesOpen,
    automationEnabled,
    automationToggleDisabled,
    automationLabel,
    isSectionDirty,
    companyId,
    routineId,
    hasLiveRun,
    isEditableSection,
    sectionDirtyFields,
    saveRoutine,
    saveConflict,
    discardSection,
    reloadLatest,
    runVariablesOpen,
    agents,
    projects,
  } = model;
  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Routines",
        renderLink: (content) => (
          <Link to="/$companyId/routines" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: routine.title },
    ]);
  }, [companyId, routine.title, setBreadcrumbs]);
  return (
    <RoutineDetailContext.Provider value={contextValue}>
      {runRoutine.isPending ? (
        <p className="sr-only" role="status">
          Starting routine run.
        </p>
      ) : null}
      <a
        href="#routine-section"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm"
      >
        Skip to section
      </a>

      {/* Bounded to the main scroll area's height so the header + sub-nav stay
          fixed and only the section content below scrolls (no page-level
          scroll, no competing sticky points). */}
      <div className="-m-4 flex h-full min-h-0 flex-col overflow-hidden md:-m-6">
        {/* Slim page header — fixed at the top of the routine layout. */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Textarea
              aria-label="Routine title"
              ref={titleInputRef}
              data-autosize-title
              className="min-h-0 min-w-0 flex-1 resize-none overflow-hidden border-0 text-base font-semibold leading-7 shadow-none focus-visible:ring-0"
              placeholder="Routine title"
              rows={1}
              value={editDraft.title}
              onChange={(event) => {
                setEditDraft((current) => ({
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
                  if (section === "overview") {
                    descriptionEditorRef.current?.focus();
                  } else {
                    navigateToSection("overview");
                  }
                }
              }}
            />
            {routine.managedByPlugin ? (
              <Badge
                variant="outline"
                className="hidden shrink-0 gap-1.5 text-xs text-muted-foreground sm:inline-flex"
              >
                <Sparkles className="h-3 w-3"  data-icon="inline-start"/>
                {routine.managedByPlugin.pluginDisplayName}
                <span className="font-mono text-(length:--text-nano)">
                  {routine.managedByPlugin.resourceKey}
                </span>
              </Badge>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <Button size="sm" onClick={() => setRunVariablesOpen(true)} disabled={runRoutine.isPending}>
              <Repeat className="h-3.5 w-3.5 sm:mr-1"  data-icon="inline-start"/>
              <span className="hidden sm:inline">{runRoutine.isPending ? "Starting…" : "Run routine"}</span>
            </Button>
            <SettingsSwitchField
              id="routine-automation"
              fieldClassName="w-auto gap-2"
              label={automationLabel}
              size="default"
              checked={automationEnabled}
              onCheckedChange={contextValue.onToggleAutomation}
              disabled={automationToggleDisabled}
              aria-label={automationEnabled ? "Pause automatic triggers" : "Enable automatic triggers"}
            />
          </div>
        </header>

        {/* Mobile section picker */}
        <RoutineSectionPicker
          activeSection={section}
          onNavigate={navigateToSection}
          isSectionDirty={isSectionDirty}
        />

        <div className="flex min-h-0 flex-1">
          <RoutineSubSidebar
            activeSection={section}
            companyId={companyId}
            routineId={routineId}
            isSectionDirty={isSectionDirty}
            hasLiveRun={hasLiveRun}
          />

          <main
            id="routine-section"
            role="main"
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-6 pt-10 md:px-8"
          >
            <section
              aria-labelledby="routine-section-title"
              className={isEditableSection ? "mx-auto w-full max-w-3xl" : "w-full"}
            >
              <h2 id="routine-section-title" className="mb-4 text-lg font-semibold">
                {SECTION_TITLES[section]}
              </h2>

              {section === "overview" && <OverviewSection />}
              {section === "triggers" && <TriggersSection />}
              {section === "variables" && <VariablesSection />}
              {section === "secrets" && <SecretsSection />}
              {section === "delivery" && <DeliverySection />}
              {section === "runs" && <RunsSection />}
              {section === "activity" && <ActivitySection />}
              {section === "history" && <HistorySection />}

              {isEditableSection ? (
                <RoutineSaveBar
                  dirtyFields={sectionDirtyFields(section)}
                  isSaving={saveRoutine.isPending}
                  saveConflict={saveConflict}
                  onSave={() => {
                    if (!saveRoutine.isPending && editDraft.title.trim()) saveRoutine.mutate();
                  }}
                  onDiscard={() => discardSection(section)}
                  onReload={reloadLatest}
                />
              ) : null}
            </section>
          </main>
        </div>
      </div>

      <RoutineRunVariablesDialog
        open={runVariablesOpen}
        onOpenChange={setRunVariablesOpen}
        routineName={routine.title}
        agents={agents ?? []}
        projects={projects ?? []}
        defaultProjectId={routine.projectId}
        defaultAssigneeAgentId={routine.assigneeAgentId}
        variables={routine.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => runRoutine.mutate(data)}
      />
    </RoutineDetailContext.Provider>
  );
}
