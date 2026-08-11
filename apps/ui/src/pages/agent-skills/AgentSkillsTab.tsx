import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, Search, Store } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";
import { queryKeys } from "../../lib/queryKeys";
import { resolveSkillSummaryText } from "../../lib/company-skill-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageSkeleton } from "../../components/PageSkeleton";
import {
  applyAgentCompanySkillPins,
  sameSkillSelection,
  shouldScheduleSkillAutosave,
} from "../../lib/agent-skills-state";
import { AgentSkillRow, type AgentSkillRowData } from "./AgentSkillRow";
import { filterAgentSkills } from "./agent-skill-filter";
import { buildAgentSkillSourceMeta } from "./agent-skill-source";

const MATERIALIZATION_NOTE =
  "Selected company skill pins apply to the next task execution. The local CLI owns native skill discovery; selections grant no runtime authority.";

export function AgentSkillsTab({ agent, companyId }: { agent: Agent; companyId?: string }) {
  const queryClient = useQueryClient();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const skipNextSkillAutosaveRef = useRef(true);
  // The exact draft of a save that failed, so we don't re-fire the identical
  // payload on every `isPending` flip (that was an infinite 422 retry storm).
  const failedSkillDraftRef = useRef<string[] | null>(null);

  const { data: skillSelection, isLoading } = useQuery({
    queryKey: queryKeys.agents.companySkillPins(agent.id),
    queryFn: () => agentsApi.companySkillPins(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId ?? ""),
    queryFn: () => companySkillsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const saveSelection = useMutation({
    mutationFn: (selectedKeys: string[]) => {
      const selectedByKey = new Map(
        (skillSelection?.entries ?? []).map((entry) => [entry.key, entry]),
      );
      const availableByKey = new Map(
        (companySkills ?? []).map((skill) => [skill.key, skill]),
      );
      return agentsApi.replaceCompanySkillPins(
        agent.id,
        selectedKeys.map((key) => {
          const existing = selectedByKey.get(key);
          if (existing) return existing;
          const versionId = availableByKey.get(key)?.currentVersionId;
          if (!versionId) {
            throw new Error(
              `Company skill ${key} has no immutable version to pin.`,
            );
          }
          return { key, versionId };
        }),
        companyId,
      );
    },
    onSuccess: (selection) => {
      queryClient.setQueryData(
        queryKeys.agents.companySkillPins(agent.id),
        selection,
      );
      const selectedKeys = selection.entries.map((entry) => entry.key);
      lastSavedSkillsRef.current = selectedKeys;
      setLastSavedSkills(selectedKeys);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
    onError: (_error, attemptedSelection) => {
      // Remember the payload that failed so the autosave effect stops retrying
      // it until the user edits the draft again.
      failedSkillDraftRef.current = attemptedSelection;
    },
  });

  useEffect(() => {
    setSkillDraft([]);
    setLastSavedSkills([]);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
    skipNextSkillAutosaveRef.current = true;
    failedSkillDraftRef.current = null;
  }, [agent.id]);

  useEffect(() => {
    if (!skillSelection) return;
    const nextState = applyAgentCompanySkillPins(
      {
        draft: skillDraft,
        lastSaved: lastSavedSkillsRef.current,
        hasHydratedSnapshot: hasHydratedSkillSnapshotRef.current,
      },
      skillSelection.entries.map((entry) => entry.key),
    );
    skipNextSkillAutosaveRef.current = nextState.shouldSkipAutosave;
    hasHydratedSkillSnapshotRef.current = nextState.hasHydratedSnapshot;
    setSkillDraft(nextState.draft);
    lastSavedSkillsRef.current = nextState.lastSaved;
    setLastSavedSkills(nextState.lastSaved);
  }, [skillDraft, skillSelection]);

  useEffect(() => {
    if (!skillSelection) return;
    if (skipNextSkillAutosaveRef.current) {
      skipNextSkillAutosaveRef.current = false;
      return;
    }
    if (saveSelection.isPending) return;
    if (
      !shouldScheduleSkillAutosave({
        draft: skillDraft,
        lastSaved: lastSavedSkillsRef.current,
        failedDraft: failedSkillDraftRef.current,
      })
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      if (
        shouldScheduleSkillAutosave({
          draft: skillDraft,
          lastSaved: lastSavedSkillsRef.current,
          failedDraft: failedSkillDraftRef.current,
        })
      ) {
        saveSelection.mutate(skillDraft);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [
    skillDraft,
    skillSelection,
    saveSelection.isPending,
    saveSelection.isError,
    saveSelection.mutate,
  ]);

  // Library skills → row models (the store's visual language, tuned for rows).
  const libraryRows = useMemo<AgentSkillRowData[]>(
    () =>
      (companySkills ?? []).map((skill) => ({
        key: skill.key,
        name: skill.name,
        icon: {
          key: skill.key,
          name: skill.name,
          slug: skill.slug,
          iconUrl: skill.iconUrl,
          color: skill.color,
        },
        summary: resolveSkillSummaryText(skill, { fallbackKey: true }),
        chip: skill.categories[0] ?? null,
        sourceMeta: buildAgentSkillSourceMeta(skill),
        linkTo: `/skills/${skill.id}`,
        // search haystack (mirrors the store's discoveryMatchesSearch fields)
        slug: skill.slug,
        author: skill.authorName ?? skill.sourceLabel,
        tagline: skill.tagline,
        description: skill.description,
        categories: skill.categories,
      })),
    [companySkills],
  );

  const enabledRows = useMemo(
    () => libraryRows.filter((row) => skillDraft.includes(row.key)),
    [libraryRows, skillDraft],
  );
  const availableRows = useMemo(
    () => libraryRows.filter((row) => !skillDraft.includes(row.key)),
    [libraryRows, skillDraft],
  );

  const filteredEnabled = useMemo(() => filterAgentSkills(enabledRows, search), [enabledRows, search]);
  const filteredAvailable = useMemo(() => filterAgentSkills(availableRows, search), [availableRows, search]);

  const isPending = saveSelection.isPending;
  const hasUnsavedChanges = !sameSkillSelection(skillDraft, lastSavedSkills);

  const toggleSkill = (key: string, next: boolean) => {
    if (isPending) {
      return;
    }

    setSkillDraft((current) =>
      next
        ? Array.from(new Set([...current, key]))
        : current.filter((value) => value !== key),
    );
  };

  const renderRow = (row: AgentSkillRowData, variant: "enabled" | "available") => (
    <AgentSkillRow
      key={row.key}
      variant={variant}
      data={row}
      checked={variant === "enabled"}
      onCheckedChange={(next) => toggleSkill(row.key, next)}
    />
  );

  const libraryEmpty = libraryRows.length === 0;
  const selectionStatus = isPending ? "Saving skill selection…" : null;

  return (
    <div className="max-w-4xl space-y-4" aria-busy={isPending}>
      {selectionStatus ? <p className="sr-only" role="status">{selectionStatus}</p> : null}
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {enabledRows.length} of {libraryRows.length} enabled
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-default items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                Applied on next task execution
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {MATERIALIZATION_NOTE}
            </TooltipContent>
          </Tooltip>
          <SaveStatusChip
            pending={isPending}
            unsaved={hasUnsavedChanges}
            error={saveSelection.isError && hasUnsavedChanges}
          />
          <div className="ml-auto flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search skills"
                className="h-8 w-full pl-8 sm:w-56"
                aria-label="Search skills"
              />
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to="/skills" className="no-underline">
                <Store data-icon="inline-start" className="h-3.5 w-3.5" />
                Browse skills store
              </Link>
            </Button>
          </div>
        </div>

        {saveSelection.isError ? (
          <p className="text-xs text-destructive" role="alert">
            {saveSelection.error instanceof Error
              ? saveSelection.error.message
              : "Failed to update company-skill selection"}
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <div role="status">
          <span className="sr-only">Loading company skills…</span>
          <PageSkeleton variant="list" />
        </div>
      ) : libraryEmpty ? (
        <EmptyLibraryCard />
      ) : (
        <fieldset
          aria-label="Agent skill selection"
          className="contents"
          disabled={isPending}
        >
          {selectionStatus ? (
            <p className="text-xs text-muted-foreground" role="status">
              {selectionStatus} Skill changes are temporarily locked.
            </p>
          ) : null}
          <div className="space-y-4">
            <SkillSection title="Enabled on this agent" count={filteredEnabled.length}>
              {filteredEnabled.length > 0 ? (
                filteredEnabled.map((row) => renderRow(row, "enabled"))
              ) : (
                <SectionEmpty>
                  {search ? "No enabled skills match your search." : "No skills enabled on this agent yet."}
                </SectionEmpty>
              )}
            </SkillSection>

            <SkillSection title="Available from the library" count={filteredAvailable.length}>
              {filteredAvailable.length > 0 ? (
                filteredAvailable.map((row) => renderRow(row, "available"))
              ) : (
                <SectionEmpty>
                  {search
                    ? "No available skills match your search."
                    : libraryEmpty
                      ? "Import skills into the company library to enable them here."
                      : "Every library skill is enabled on this agent."}
                </SectionEmpty>
              )}
            </SkillSection>
          </div>
        </fieldset>
      )}
    </div>
  );
}

function SaveStatusChip({
  pending,
  unsaved,
  error,
}: {
  pending: boolean;
  unsaved: boolean;
  error: boolean;
}) {
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving…
      </span>
    );
  }
  if (error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-destructive" role="alert">
        <AlertCircle className="h-3.5 w-3.5" />
        Couldn’t save
      </span>
    );
  }
  if (unsaved) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving soon…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-(--status-task-done)">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Saved
    </span>
  );
}

function SkillSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 bg-muted/50 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="text-xs text-muted-foreground/70">{count}</span>
      </div>
      <div>{children}</div>
    </section>
  );
}

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-4 text-xs text-muted-foreground">{children}</div>;
}

function EmptyLibraryCard() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Store className="h-8 w-8 text-muted-foreground/60" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No skills in the company library</p>
        <p className="text-xs text-muted-foreground">
          Install skills to the company, then enable them on this agent.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/skills" className="no-underline">
          <Store data-icon="inline-start" className="h-3.5 w-3.5" />
          Browse skills store
        </Link>
      </Button>
    </div>
  );
}
