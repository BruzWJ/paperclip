import type { CompanySearchResponse } from "@paperclipai/shared";

import { Badge } from "@/components/ui/badge";

import { Input } from "@/components/ui/input";

import { SearchResultRow } from "@/routes/_authenticated/$companyId/search/-SearchResultRow";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Search as SearchIcon } from "lucide-react";

import { agentsById, fixtureAgents, fixtureProjects, fixtureResults } from "./search-story-fixtures";

export function ScopeTabsPreview({
  active,
  response,
}: {
  active: "all" | "tasks" | "comments" | "documents" | "artifacts" | "agents" | "projects";
  response: CompanySearchResponse;
}) {
  const total =
    (response.countsByType.task ?? 0) +
    (response.countsByType.artifact ?? 0) +
    (response.countsByType.agent ?? 0) +
    (response.countsByType.project ?? 0);
  const items = [
    { value: "all", label: <ScopeTabLabel label="All" count={total} /> },
    {
      value: "tasks",
      label: <ScopeTabLabel label="Tasks" count={response.countsByType.task} />,
    },
    {
      value: "comments",
      label: (
        <ScopeTabLabel
          label="Comments"
          count={response.results.filter((result) => result.matchedFields.includes("comment")).length}
        />
      ),
    },
    {
      value: "documents",
      label: (
        <ScopeTabLabel
          label="Documents"
          count={response.results.filter((result) => result.matchedFields.includes("document")).length}
        />
      ),
    },
    {
      value: "artifacts",
      label: <ScopeTabLabel label="Artifacts" count={response.countsByType.artifact} />,
    },
    {
      value: "agents",
      label: <ScopeTabLabel label="Agents" count={response.countsByType.agent} />,
    },
    {
      value: "projects",
      label: <ScopeTabLabel label="Projects" count={response.countsByType.project} />,
    },
  ];
  return (
    <Tabs value={active}>
      <TabsList variant="line" className="justify-start">
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function ScopeTabLabel({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex items-center">
      {label}
      <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px] tabular-nums font-normal">
        {count}
      </Badge>
    </span>
  );
}

export function SearchPagePreview({
  response,
  state,
  query,
}: {
  response: CompanySearchResponse;
  state: "results" | "empty" | "loading" | "initial";
  query: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            readOnly
            placeholder="Search tasks, comments, documents, agents, projects…"
            className="h-10 pl-9 pr-20 text-sm"
            aria-label="Search query"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </div>
      </div>
      <div className="border-b border-border px-2 sm:px-4">
        <ScopeTabsPreview active="all" response={response} />
      </div>

      {state === "results" ? (
        <div className="flex w-full max-w-[960px] flex-col px-2 sm:px-4">
          <div className="flex items-center justify-between py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>{response.results.length} results · sorted by relevance</span>
          </div>
          <section aria-label="Tasks" className="flex flex-col">
            <div className="flex items-center justify-between pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground">
              <span>Tasks</span>
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {fixtureResults.length}
              </span>
            </div>
            <div className="flex flex-col gap-y-1">
              {fixtureResults.map((result) => (
                <SearchResultRow key={result.id} result={result} agentsById={agentsById} />
              ))}
            </div>
          </section>
          <section aria-label="Agents" className="mt-6 flex flex-col">
            <div className="flex items-center justify-between pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground">
              <span>Agents</span>
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {fixtureAgents.length}
              </span>
            </div>
            <div className="flex flex-col gap-y-1">
              {fixtureAgents.map((result) => (
                <SearchResultRow key={result.id} result={result} />
              ))}
            </div>
          </section>
          <section aria-label="Projects" className="mt-6 flex flex-col">
            <div className="flex items-center justify-between pt-2 pb-1 text-[11px] tracking-wider text-muted-foreground">
              <span>Projects</span>
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {fixtureProjects.length}
              </span>
            </div>
            <div className="flex flex-col gap-y-1">
              {fixtureProjects.map((result) => (
                <SearchResultRow key={result.id} result={result} />
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {state === "empty" ? (
        <div className="mx-auto flex w-full max-w-xl flex-col items-center justify-center gap-3 px-4 py-12 text-center">
          <div className="text-base font-semibold">No results for &ldquo;{query}&rdquo;</div>
          <p className="text-sm text-muted-foreground">
            We couldn&rsquo;t find a match in all scopes. Try widening the scope or rephrasing your query.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <li>Try fewer tokens or a single distinctive term.</li>
            <li>
              Use an identifier shortcut like <code className="rounded bg-muted px-1 py-0.5">PAP-123</code>.
            </li>
          </ul>
        </div>
      ) : null}

      {state === "loading" ? (
        <div className="flex flex-col gap-2 px-2 py-3 sm:px-4">
          <div className="px-3 text-xs text-muted-foreground">Searching for &ldquo;{query}&rdquo;…</div>
          <div className="flex flex-col">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-start gap-3 px-3 py-2">
                <div className="mt-1 h-4 w-4 rounded-full bg-muted" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-3 w-3/4 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted/60" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {state === "initial" ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold">Type to search company memory.</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Tasks, comments, plan documents, agents, projects — same surface, ranked by relevance.
            </p>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Identifier lookup:</span> type{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">PAP-123</code> to jump straight to a
              task.
            </li>
            <li>
              <span className="font-medium text-foreground">Quoted phrases:</span> wrap a phrase in quotes to
              match the exact sequence.
            </li>
            <li>
              <span className="font-medium text-foreground">⌘K:</span> reopens the command palette pre-seeded
              with your current query.
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
