import { useState, useEffect, useMemo } from "react";
import { useNavigate, type RegisteredRouter, type ValidateNavigateOptions } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { tasksApi } from "../api/tasks";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  CircleDot,
  Bot,
  Hexagon,
  Target,
  LayoutDashboard,
  Inbox,
  DollarSign,
  History,
  SquarePen,
  Plus,
  Search,
} from "lucide-react";
import { Identity } from "./Identity";
import {
  SEARCH_OPERATOR_QUICK_FILTERS,
  parseSearchQuery,
  type SearchQueryParserContext,
} from "../lib/search-query-parser";

const SEARCH_ALL_VALUE = "__paperclip-search-all__";

/** Max promoted project matches kept when typing in the palette. */
const MAX_MATCHED_PROJECTS = 5;
/** Task cap when projects are also promoted, so Tasks can't crowd them out. */
const TASK_LIMIT_WITH_PROJECTS = 6;
const TASK_LIMIT = 10;

/** True when every char of `needle` appears in `haystack` in order (fuzzy). */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Score a project against a lowercased query. Higher is a better match;
 * `null` means no match. Prefers name hits (exact > prefix > substring) over
 * description hits, with fuzzy subsequence as a last resort.
 */
function scoreProjectMatch(name: string, description: string, q: string): number | null {
  if (name === q) return 1000;
  // Shorter names rank first, but clamp the length penalty so a prefix match can
  // never sink below the substring band (max 699) for unusually long names —
  // keeps the prefix > substring > description > fuzzy ordering invariant.
  if (name.startsWith(q)) return Math.max(700, 900 - name.length);
  const nameIdx = name.indexOf(q);
  if (nameIdx >= 0) return 700 - nameIdx;
  if (description.includes(q)) return 400;
  if (isSubsequence(q, name)) return 200;
  return null;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();
  const { openNewTask, openNewAgent } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: open,
  });
  const projects = useMemo(() => allProjects.filter((p) => !p.archivedAt), [allProjects]);

  const { data: labels = [] } = useQuery({
    queryKey: queryKeys.tasks.labels(companyId),
    queryFn: () => tasksApi.listLabels(companyId),
    enabled: open,
  });

  const parserContext = useMemo<SearchQueryParserContext>(
    () => ({
      agents,
      projects,
      labels,
    }),
    [agents, labels, projects],
  );
  const parsedQuery = useMemo(() => parseSearchQuery(query, parserContext), [parserContext, query]);
  const quickSearchQuery = parsedQuery.query.trim();

  const { data: tasks = [] } = useQuery({
    queryKey: queryKeys.tasks.list(companyId),
    queryFn: () => tasksApi.list(companyId),
    enabled: open && searchQuery.length === 0,
  });

  const { data: searchedTasks = [] } = useQuery({
    queryKey: queryKeys.tasks.search(companyId, quickSearchQuery, undefined, 10),
    queryFn: () => tasksApi.list(companyId, { q: quickSearchQuery, limit: 10 }),
    enabled: open && quickSearchQuery.length > 0,
  });

  function go<TRouter extends RegisteredRouter = RegisteredRouter, TOptions = unknown>(
    options: ValidateNavigateOptions<TRouter, TOptions>,
  ): void;
  function go(options: ValidateNavigateOptions) {
    setOpen(false);
    void navigate(options);
  }

  function goFullSearch() {
    const parsed = parseSearchQuery(searchQuery, parserContext);
    go({
      to: "/$companyId/search",
      params: { companyId },
      search: {
        q: parsed.query || undefined,
        status: parsed.filters.status,
        priority: parsed.filters.priority,
        ownerAgentId: parsed.filters.ownerAgentId,
        ownerUserId: parsed.filters.ownerUserId,
        projectId: parsed.filters.projectId,
        labelId: parsed.filters.labelId,
        updatedWithin: parsed.filters.updatedWithin,
        updatedAfter: parsed.filters.updatedAfter,
      },
    });
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleTasks = useMemo(
    () => (quickSearchQuery.length > 0 ? searchedTasks : tasks),
    [tasks, searchedTasks, quickSearchQuery],
  );

  // Client-side typeahead ranking over the already-loaded projects. cmdk ranks
  // items by their `value` (which defaults to the rendered name) and would bury
  // or drop description-only matches, so we rank in JS and force-match below.
  const matchedProjects = useMemo(() => {
    if (quickSearchQuery.length === 0) return [];
    const q = quickSearchQuery.toLowerCase();
    return projects
      .map((project) => ({
        project,
        score: scoreProjectMatch(project.name.toLowerCase(), (project.description ?? "").toLowerCase(), q),
      }))
      .filter((entry): entry is { project: (typeof projects)[number]; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_PROJECTS)
      .map((entry) => entry.project);
  }, [projects, quickSearchQuery]);

  const showSearchAll = searchQuery.length > 0;
  const showPromotedProjects = showSearchAll && matchedProjects.length > 0;
  const taskLimit = showPromotedProjects ? TASK_LIMIT_WITH_PROJECTS : TASK_LIMIT;
  const showEmptyHint = showSearchAll && visibleTasks.length === 0 && matchedProjects.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}
    >
      <CommandInput
        placeholder="Search tasks, agents, projects..."
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            goFullSearch();
            return;
          }
          if (event.key === "Enter" && showEmptyHint) {
            event.preventDefault();
            goFullSearch();
          }
        }}
      />
      <CommandList>
        <CommandEmpty>
          {showSearchAll ? (
            <span>
              No quick task matches. Press{" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-(length:--text-nano)">↵</kbd> to{" "}
              <span className="font-medium">search all</span> or keep typing to refine.
            </span>
          ) : (
            "No results found."
          )}
        </CommandEmpty>

        {showSearchAll ? (
          <CommandGroup heading="Search">
            <CommandItem
              value={`${SEARCH_ALL_VALUE} ${searchQuery}`}
              onSelect={goFullSearch}
              className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
              data-testid="command-search-all"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="flex-1 truncate">
                Search all for <span className="font-semibold">&ldquo;{searchQuery}&rdquo;</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span>open full search</span>
                <kbd className="rounded border border-border bg-background px-1 py-0.5 text-(length:--text-nano)">
                  ↵
                </kbd>
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {showSearchAll ? <CommandSeparator /> : null}

        <CommandGroup heading="Quick filters">
          {SEARCH_OPERATOR_QUICK_FILTERS.map((chip) => (
            <CommandItem
              key={chip}
              value={`quick-filter ${chip}`}
              onSelect={() => setQuery((current) => (current.trim() ? `${current.trim()} ${chip}` : chip))}
              data-testid="command-filter-chip"
            >
              <Search className="mr-2 h-4 w-4" />
              <span className="font-mono text-xs">{chip}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {showPromotedProjects && (
          <>
            <CommandGroup heading="Projects">
              {matchedProjects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${searchQuery} ${project.name}`}
                  onSelect={() =>
                    go({
                      to: "/$companyId/projects/$projectId",
                      params: {
                        companyId,
                        projectId: project.id,
                      },
                    })
                  }
                  data-testid="command-project-match"
                >
                  <Hexagon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{project.name}</span>
                  {project.description ? (
                    <span className="ml-2 hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:inline">
                      {project.description}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewTask();
            }}
          >
            <SquarePen className="mr-2 h-4 w-4" />
            Create new task
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setOpen(false);
              openNewAgent();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create new agent
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/projects", params: { companyId } })}>
            <Plus className="mr-2 h-4 w-4" />
            Create new project
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go({ to: "/$companyId/dashboard", params: { companyId } })}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/inbox", params: { companyId } })}>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/tasks", params: { companyId } })}>
            <CircleDot className="mr-2 h-4 w-4" />
            Tasks
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/projects", params: { companyId } })}>
            <Hexagon className="mr-2 h-4 w-4" />
            Projects
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/goals", params: { companyId } })}>
            <Target className="mr-2 h-4 w-4" />
            Goals
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/agents", params: { companyId } })}>
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/costs", params: { companyId } })}>
            <DollarSign className="mr-2 h-4 w-4" />
            Costs
          </CommandItem>
          <CommandItem onSelect={() => go({ to: "/$companyId/activity", params: { companyId } })}>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
        </CommandGroup>

        {visibleTasks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {visibleTasks.slice(0, taskLimit).map((task) => {
                const taskIdentifier = task.identifier;

                return (
                  <CommandItem
                    key={task.id}
                    value={searchQuery.length > 0 ? `${searchQuery} ${taskIdentifier} ${task.title}` : undefined}
                    onSelect={() =>
                      go({
                        to: "/$companyId/tasks/$taskNumber",
                        params: {
                          companyId,
                          taskNumber: String(task.taskNumber),
                        },
                      })
                    }
                  >
                    <CircleDot className="mr-2 h-4 w-4" />
                    <span className="text-muted-foreground mr-2 font-mono text-xs">{taskIdentifier}</span>
                    <span className="flex-1 truncate">{task.title}</span>
                    {task.ownerAgentId &&
                      (() => {
                        const name = agentName(task.ownerAgentId);
                        return name ? <Identity name={name} size="sm" className="ml-2 hidden sm:inline-flex" /> : null;
                      })()}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 10).map((agent) => (
                <CommandItem
                  key={agent.id}
                  onSelect={() =>
                    go({
                      to: "/$companyId/agents/$agentId",
                      params: { companyId, agentId: agent.id },
                    })
                  }
                >
                  <Bot className="mr-2 h-4 w-4" />
                  {agent.name}
                  {agent.title ? <span className="text-xs text-muted-foreground ml-2">{agent.title}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projects.length > 0 && !showSearchAll && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projects.slice(0, 10).map((project) => (
                <CommandItem
                  key={project.id}
                  onSelect={() =>
                    go({
                      to: "/$companyId/projects/$projectId",
                      params: {
                        companyId,
                        projectId: project.id,
                      },
                    })
                  }
                >
                  <Hexagon className="mr-2 h-4 w-4" />
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
