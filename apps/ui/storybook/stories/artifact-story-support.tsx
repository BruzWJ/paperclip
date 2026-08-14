import type { CompanyArtifact } from "@/api/artifacts";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ARTIFACT_GROUP_OPTIONS,
  ARTIFACT_KIND_FILTERS,
  artifactGroupByLabel,
} from "@/routes/_authenticated/$companyId/artifacts";
import { Check, Layers, Search, X } from "lucide-react";

export type StoryArtifactKindFilter = (typeof ARTIFACT_KIND_FILTERS)[number]["value"];
export type StoryArtifactGroupBy = (typeof ARTIFACT_GROUP_OPTIONS)[number]["value"];

function sampleImage(label: string, start: string, end: string, size: number) {
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${start}'/><stop offset='1' stop-color='${end}'/></linearGradient></defs><rect width='480' height='270' fill='url(#g)'/><text x='50%' y='52%' font-family='sans-serif' font-size='${size}' fill='white' text-anchor='middle'>${label}</text></svg>`,
    )
  );
}

export const SAMPLE_IMAGE = sampleImage("Hero render.png", "#6366f1", "#22d3ee", 28);
export const SAMPLE_IMAGE_TEAL = sampleImage("nav-revised.png", "#0ea5e9", "#14b8a6", 24);
export const SAMPLE_IMAGE_AMBER = sampleImage("hero-warm.png", "#f59e0b", "#ef4444", 22);

export function makeArtifact(overrides: Partial<CompanyArtifact>): CompanyArtifact {
  return {
    id: "b6000000-0000-4000-8000-000000000001",
    source: "attachment",
    mediaKind: "image",
    title: "Artifact",
    previewText: null,
    contentType: null,
    contentPath: null,
    openPath: null,
    downloadPath: null,
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd009",
      taskNumber: 10306,
      identifier: "PAP-10306",
      title: "Landing visuals refresh",
    },
    project: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7",
      name: "Paperclip App",
    },
    createdByAgent: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      name: "ClaudeCoder",
    },
    updatedAt: new Date("2026-06-04T12:00:00Z").toISOString(),
    taskFragment: "attachment-art",
    ...overrides,
  };
}

export function ArtifactsGrid({ artifacts }: { artifacts: CompanyArtifact[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {artifacts.map((artifact) => (
        <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
      ))}
    </div>
  );
}

export function ArtifactsToolbar({
  query,
  onQueryChange,
  kind,
  onKindChange,
  groupBy,
  onGroupByChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  kind: StoryArtifactKindFilter;
  onKindChange: (value: StoryArtifactKindFilter) => void;
  groupBy: StoryArtifactGroupBy;
  onGroupByChange: (value: StoryArtifactGroupBy) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search artifacts..."
          aria-label="Search artifacts"
          className="h-9 pl-9 pr-9 text-sm"
        />
        {query.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onQueryChange("")}
            aria-label="Clear artifact search"
            className="absolute right-2 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn("h-8 w-8 shrink-0", groupBy !== "none" && "bg-accent")}
              title="Group artifacts"
              aria-label={`Group artifacts (currently ${artifactGroupByLabel(groupBy)})`}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Group by</DropdownMenuLabel>
            {ARTIFACT_GROUP_OPTIONS.map(({ value, label }) => (
              <DropdownMenuItem
                key={value}
                aria-selected={groupBy === value}
                onSelect={() => onGroupByChange(value)}
                className="justify-between"
              >
                {label}
                {groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div
          className="flex flex-wrap items-center gap-1.5"
          role="tablist"
          aria-label="Filter artifacts by type"
        >
          {ARTIFACT_KIND_FILTERS.map((filter) => (
            <Button
              key={filter.value}
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={kind === filter.value}
              onClick={() => onKindChange(filter.value)}
              className={cn(
                "h-auto rounded-md px-2.5 py-1 text-xs",
                kind === filter.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
