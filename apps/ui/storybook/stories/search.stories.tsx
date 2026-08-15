import type { Meta, StoryObj } from "@storybook/react-vite";

import type { CompanySearchFilterOptionCounts, CompanySearchZeroResults } from "@paperclipai/shared";

import { SearchResultRow } from "@/routes/_authenticated/$companyId/search/-SearchResultRow";

import { ZeroResultsRecovery } from "@/routes/_authenticated/$companyId/search/-CompanySearchTabContent";
import {
  SearchFilterBar,
  SearchFilterChips,
  type SearchFilterDataProps,
} from "@/routes/_authenticated/$companyId/search/-SearchFilterBar";

import type { FilterChipLookups, SearchFilters } from "@/lib/search-filters";

import { storybookAgents, storybookProjects } from "../fixtures/paperclipData";

import { CommandPaletteWithSearchAll, SearchOperatorInputPreview } from "./search-command-story-support";
import { SearchPagePreview } from "./search-page-story-support";
import {
  agentsById,
  fixtureAgents,
  fixtureProjects,
  fixtureResponse,
  fixtureResults,
} from "./search-story-fixtures";

const noop = () => {};

const searchFilterCounts: CompanySearchFilterOptionCounts = {
  status: {
    in_progress: 4,
    todo: 3,
    backlog: 2,
    in_review: 1,
    blocked: 1,
    done: 8,
  },
  priority: { critical: 1, high: 3, medium: 5, low: 2 },
  ownerAgentId: storybookAgents[0]?.id ? { [storybookAgents[0].id]: 4 } : {},
  ownerUserId: {},
  projectId: storybookProjects[0]?.id ? { [storybookProjects[0].id]: 6 } : {},
  labelId: { "a1000000-0000-4000-8000-000000000006": 3 },
  updatedWithin: { "24h": 2, "7d": 5, "30d": 9, "90d": 11 },
};

const searchFilterData: SearchFilterDataProps = {
  counts: searchFilterCounts,
  agents: storybookAgents.map((agent) => ({ id: agent.id, name: agent.name })),
  projects: storybookProjects.map((project) => ({
    id: project.id,
    name: project.name,
  })),
  labels: [
    {
      id: "a1000000-0000-4000-8000-000000000006",
      name: "infra",
      color: "#a78bfa",
    },
    {
      id: "a1000000-0000-4000-8000-000000000005",
      name: "auth",
      color: "#34d399",
    },
  ],
  currentUserId: "a7000000-0000-4000-8000-000000000001",
};

const activeSearchFilters: SearchFilters = {
  status: ["in_progress", "todo"],
  priority: ["high"],
  projectId: storybookProjects[0]?.id,
  updatedWithin: "7d",
};

const searchFilterLookups: FilterChipLookups = {
  agentName: (id) => storybookAgents.find((agent) => agent.id === id)?.name,
  userName: () => "Me",
  projectName: (id) => storybookProjects.find((project) => project.id === id)?.name,
  labelName: (id) => searchFilterData.labels.find((label) => label.id === id)?.name,
  currentUserId: "a7000000-0000-4000-8000-000000000001",
};

const zeroResultsFixture: CompanySearchZeroResults = {
  unfilteredTotal: 42,
  loosenSuggestions: [
    {
      filter: "status",
      values: ["in_progress", "todo"],
      resultCount: 30,
      additionalCount: 30,
    },
    {
      filter: "priority",
      values: ["high"],
      resultCount: 12,
      additionalCount: 12,
    },
    {
      filter: "updatedWithin",
      values: ["7d"],
      resultCount: 6,
      additionalCount: 6,
    },
  ],
};

function SearchStories() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner max-w-[1320px] space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Search</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Full search page and Command K transition
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Snippet-forward results, scope tabs, match-source chips, and the supporting empty / loading /
            initial states. Cmd K palette renders the persistent &ldquo;Search all for…&rdquo; row when a
            query is non-empty.
          </p>
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">Results, query &ldquo;auth flake&rdquo;</h2>
          </div>
          <SearchPagePreview response={fixtureResponse} state="results" query="auth flake" />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search · screen 3</div>
            <h2 className="mt-1 text-lg font-semibold">Typed operators, pills &amp; autocomplete</h2>
          </div>
          <SearchOperatorInputPreview />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">Initial state — no query</h2>
          </div>
          <SearchPagePreview response={fixtureResponse} state="initial" query="" />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">Loading skeleton</h2>
          </div>
          <SearchPagePreview response={fixtureResponse} state="loading" query="auth flake" />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search</div>
            <h2 className="mt-1 text-lg font-semibold">No results state</h2>
          </div>
          <SearchPagePreview
            response={{
              ...fixtureResponse,
              results: [],
              countsByType: {
                task: 0,
                comment: 0,
                document: 0,
                artifact: 0,
                agent: 0,
                project: 0,
              },
            }}
            state="empty"
            query="ghostbuster"
          />
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search · screen 1</div>
            <h2 className="mt-1 text-lg font-semibold">Filter bar, active chips &amp; honest meta</h2>
          </div>
          <div className="flex flex-col gap-2 border-t border-border bg-background p-4">
            <SearchFilterBar
              filters={activeSearchFilters}
              onChange={noop}
              sort="relevance"
              onSortChange={noop}
              data={searchFilterData}
            />
            <SearchFilterChips
              filters={activeSearchFilters}
              lookups={searchFilterLookups}
              onChange={noop}
              onClearAll={noop}
            />
            <div className="py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              8 of 42 results · sorted by Relevance · 4 filters active
            </div>
          </div>
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">/search · screen 4</div>
            <h2 className="mt-1 text-lg font-semibold">Zero-results recovery</h2>
          </div>
          <div className="border-t border-border bg-background">
            <ZeroResultsRecovery
              query="auth flake"
              filters={activeSearchFilters}
              zeroResults={zeroResultsFixture}
              lookups={searchFilterLookups}
              onChange={noop}
              onClearAll={noop}
            />
          </div>
        </section>

        <section className="paperclip-story__frame overflow-hidden p-4">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">Cmd+K palette</div>
            <h2 className="mt-1 text-lg font-semibold">Search-all row with quick results</h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                With quick task matches
              </div>
              <CommandPaletteWithSearchAll query="auth flake" />
            </div>
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                Empty results — Enter routes to /search
              </div>
              <CommandPaletteWithSearchAll query="ghostbuster" emptyResults />
            </div>
          </div>
        </section>

        <section className="paperclip-story__frame overflow-hidden p-4">
          <div className="paperclip-story__title-block">
            <div className="paperclip-story__label">Search result row</div>
            <h2 className="mt-1 text-lg font-semibold">Task, agent, project rows</h2>
          </div>
          <div className="flex w-full max-w-[960px] flex-col gap-y-1">
            {fixtureResults.map((result) => (
              <SearchResultRow key={result.id} result={result} agentsById={agentsById} />
            ))}
            {fixtureAgents.map((result) => (
              <SearchResultRow key={result.id} result={result} />
            ))}
            {fixtureProjects.map((result) => (
              <SearchResultRow key={result.id} result={result} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Search & Command K",
  component: SearchStories,
  parameters: {
    docs: {
      description: {
        component:
          "Full search page surfaces and Command K Search-all transition. Reuses the shared task, identity, tab, and search-result primitives.",
      },
    },
  },
} satisfies Meta<typeof SearchStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SearchSurfaces: Story = {};
