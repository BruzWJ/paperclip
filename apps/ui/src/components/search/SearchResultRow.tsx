import { memo, type ComponentType, type ReactNode, type SVGProps } from "react";
import { Bot, FileText, Hexagon, MessageSquare, Paperclip, Quote } from "lucide-react";
import type { Agent, CompanySearchHighlight, CompanySearchResult } from "@paperclipai/shared";
import { CompanyBoardLink } from "@/components/CompanyBoardLink";
import { cn } from "@/lib/utils";
import { taskValueLabel } from "@/lib/task-blockers";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { taskDisplayTitle } from "@/lib/task-display";
import { Badge } from "@/components/ui/badge";
import * as ItemUI from "@/components/ui/item";

export interface HighlightedTextProps {
  text: string;
  highlights?: readonly CompanySearchHighlight[] | null;
  className?: string;
  markClassName?: string;
}

function clampedRanges(text: string, highlights: readonly CompanySearchHighlight[]) {
  const ranges = highlights
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  return ranges.reduce<Array<{ start: number; end: number }>>((merged, range) => {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
    return merged;
  }, []);
}

export function HighlightedText({ text, highlights, className, markClassName }: HighlightedTextProps) {
  const ranges = highlights?.length ? clampedRanges(text, highlights) : [];
  if (ranges.length === 0) return <span className={className}>{text}</span>;
  let cursor = 0;
  return (
    <span className={className}>
      {ranges.flatMap((range, index) => {
        const before = text.slice(cursor, range.start);
        const match = text.slice(range.start, range.end);
        cursor = range.end;
        return [
          before ? <span key={`text-${index}`}>{before}</span> : null,
          <mark key={`mark-${index}`} className={cn("bg-accent text-accent-foreground", markClassName)}>
            {match}
          </mark>,
          index === ranges.length - 1 && cursor < text.length ? (
            <span key="text-end">{text.slice(cursor)}</span>
          ) : null,
        ];
      })}
    </span>
  );
}

type SnippetStyle = {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
};

const SNIPPET_STYLES: Record<string, SnippetStyle> = {
  comment: { Icon: MessageSquare, label: "Comment" },
  document: { Icon: FileText, label: "Doc" },
  artifact: { Icon: Paperclip, label: "Artifact" },
  request: { Icon: Quote, label: "Request" },
};

function snippetStyle(field: string, fallbackLabel: string): SnippetStyle {
  return SNIPPET_STYLES[field] ?? { Icon: Quote, label: fallbackLabel };
}

function formatRelativeTime(input: string | null): string {
  if (!input) return "";
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) return "";
  const diffMs = Date.now() - value.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.round(days / 365);
  return `${years}y`;
}

export interface SearchResultRowProps {
  result: CompanySearchResult;
  agentsById?: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
  isActive?: boolean;
  className?: string;
}

const ROW_BASE =
  "group items-start rounded-md border-0 transition-colors no-underline text-inherit hover:bg-muted/40";

function SearchResultTarget({
  result,
  className,
  children,
}: {
  result: CompanySearchResult;
  className: string;
  children: ReactNode;
}) {
  if (!result.routeTarget) {
    return (
      <ItemUI.Item size="sm" className={className}>
        {children}
      </ItemUI.Item>
    );
  }
  return (
    <ItemUI.Item asChild size="sm" className={className}>
      <CompanyBoardLink routeTarget={result.routeTarget}>{children}</CompanyBoardLink>
    </ItemUI.Item>
  );
}

function SearchResultRowImpl({ result, agentsById, isActive, className }: SearchResultRowProps) {
  if (result.type === "agent") {
    return (
      <SearchResultTarget result={result} className={cn(ROW_BASE, isActive && "bg-muted/40", className)}>
        <ItemUI.ItemMedia variant="icon">
          <Bot className="h-3 w-3" />
        </ItemUI.ItemMedia>
        <ItemUI.ItemContent className="min-w-0">
          <ItemUI.ItemTitle className="max-w-full truncate">{result.title}</ItemUI.ItemTitle>
          {result.snippet ? (
            <SnippetLine
              text={result.snippets[0]?.text ?? result.snippet}
              highlights={result.snippets[0]?.highlights}
              field="agent"
              fallbackLabel={result.sourceLabel ?? "Agent"}
            />
          ) : null}
        </ItemUI.ItemContent>
      </SearchResultTarget>
    );
  }

  if (result.type === "project") {
    return (
      <SearchResultTarget result={result} className={cn(ROW_BASE, isActive && "bg-muted/40", className)}>
        <ItemUI.ItemMedia>
          <Hexagon className="h-4 w-4 text-muted-foreground" />
        </ItemUI.ItemMedia>
        <ItemUI.ItemContent className="min-w-0">
          <ItemUI.ItemTitle className="max-w-full truncate">{result.title}</ItemUI.ItemTitle>
          {result.snippet ? (
            <SnippetLine
              text={result.snippets[0]?.text ?? result.snippet}
              highlights={result.snippets[0]?.highlights}
              field="project"
              fallbackLabel={result.sourceLabel ?? "Project"}
            />
          ) : null}
        </ItemUI.ItemContent>
      </SearchResultTarget>
    );
  }

  if (result.type === "artifact") {
    const artifact = result.artifact;
    if (!artifact) return null;
    const updated = formatRelativeTime(result.updatedAt ?? artifact.updatedAt);
    return (
      <SearchResultTarget result={result} className={cn(ROW_BASE, isActive && "bg-muted/40", className)}>
        <ItemUI.ItemMedia>
          <Paperclip className="h-4 w-4 text-muted-foreground" />
        </ItemUI.ItemMedia>
        <ItemUI.ItemContent className="min-w-0">
          <ItemUI.ItemTitle className="w-full flex-wrap">
            <span className="truncate text-sm font-medium text-foreground">{result.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{artifact.taskIdentifier}</span>
          </ItemUI.ItemTitle>
          {result.snippet ? (
            <SnippetLine
              text={result.snippets[0]?.text ?? result.snippet}
              highlights={result.snippets[0]?.highlights}
              field="artifact"
              fallbackLabel={result.sourceLabel ?? "Artifact"}
              multiline
            />
          ) : null}
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
            <span className="truncate">{artifact.taskTitle}</span>
            {updated ? <span className="ml-auto shrink-0 tabular-nums">{updated}</span> : null}
          </div>
        </ItemUI.ItemContent>
        <ItemUI.ItemActions className="ml-2 hidden flex-col items-end gap-2 sm:flex">
          {updated ? <span className="text-xs tabular-nums text-muted-foreground">{updated}</span> : null}
          {result.previewImageUrl ? (
            <img
              src={result.previewImageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-(--sz-88px) w-(--sz-88px) shrink-0 rounded-md border border-border bg-muted object-cover"
            />
          ) : null}
        </ItemUI.ItemActions>
      </SearchResultTarget>
    );
  }

  const task = result.task;
  if (!task) return null;
  const ownerName = task.ownerAgentId ? (agentsById?.get(task.ownerAgentId)?.name ?? null) : null;
  const updated = formatRelativeTime(result.updatedAt ?? task.updatedAt);
  const titleHighlights = result.snippets.find((snippet) => snippet.field === "title")?.highlights;
  const bodySnippets = result.snippets.filter((snippet) => snippet.field !== "title").slice(0, 2);
  const previewImageUrl = result.previewImageUrl;
  const hasRightRail = previewImageUrl || ownerName || updated;

  return (
    <SearchResultTarget result={result} className={cn(ROW_BASE, isActive && "bg-muted/40", className)}>
      <ItemUI.ItemMedia>
        <Badge variant="secondary">{taskValueLabel(task.boardPresentationStatus)}</Badge>
      </ItemUI.ItemMedia>
      <ItemUI.ItemContent className="min-w-0">
        <ItemUI.ItemTitle className="w-full flex-wrap">
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {task.identifier}
          </span>
          <HighlightedText
            text={taskDisplayTitle(task)}
            highlights={titleHighlights}
            className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground"
          />
        </ItemUI.ItemTitle>
        {bodySnippets.map((snippet, index) => (
          <SnippetLine
            key={`${snippet.field}-${index}`}
            text={snippet.text}
            highlights={snippet.highlights}
            field={snippet.field}
            fallbackLabel={snippet.label}
            multiline
          />
        ))}
        {hasRightRail ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground sm:hidden">
            {ownerName ? <span className="truncate">{ownerName}</span> : null}
            {updated ? <span className="ml-auto tabular-nums">{updated}</span> : null}
          </div>
        ) : null}
      </ItemUI.ItemContent>
      {hasRightRail ? (
        <ItemUI.ItemActions className="ml-2 hidden flex-col items-end gap-2 sm:flex">
          {ownerName || updated ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {ownerName ? (
                <span className="inline-flex min-w-0 items-center gap-1.5" title={ownerName}>
                  <Avatar size="sm">
                    <AvatarFallback>{deriveInitials(ownerName)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{ownerName}</span>
                </span>
              ) : null}
              {updated ? <span className="tabular-nums">{updated}</span> : null}
            </div>
          ) : null}
          {previewImageUrl ? (
            <img
              src={previewImageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-(--sz-88px) w-(--sz-88px) shrink-0 rounded-md border border-border bg-muted object-cover"
            />
          ) : null}
        </ItemUI.ItemActions>
      ) : null}
    </SearchResultTarget>
  );
}

export const SearchResultRow = memo(SearchResultRowImpl);

interface SnippetLineProps {
  text: string;
  highlights?: HighlightedTextProps["highlights"];
  field: string;
  fallbackLabel: string;
  multiline?: boolean;
}

function SnippetLine({ text, highlights, field, fallbackLabel, multiline = false }: SnippetLineProps) {
  const { Icon, label } = snippetStyle(field, fallbackLabel);
  return (
    <ItemUI.ItemDescription
      className={cn(
        "mt-2.5 flex min-w-0 gap-1.5 text-xs text-muted-foreground",
        multiline ? "items-start" : "items-center",
      )}
    >
      <Icon
        className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/60", multiline && "mt-0.5")}
        aria-hidden
      />
      <Badge
        variant="outline"
        className="shrink-0 bg-muted px-1.5 py-0.5 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </Badge>
      <HighlightedText
        text={text}
        highlights={highlights}
        className={multiline ? "line-clamp-2 leading-relaxed" : "line-clamp-1 truncate"}
      />
    </ItemUI.ItemDescription>
  );
}
