import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { SEARCH_OPERATOR_QUICK_FILTERS, searchOperatorSuggestions } from "@/lib/search-query-parser";
import { statusBadgeVariant } from "@/lib/status-variant";
import {
  Bot,
  CircleDot,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  Plus,
  Search as SearchIcon,
  SquarePen,
  Target,
} from "lucide-react";

import { storybookProjects, storybookTasks } from "../fixtures/paperclipData";

export function SearchOperatorInputPreview() {
  const suggestions = searchOperatorSuggestions("auth sta", 4);
  return (
    <div className="border-t border-border bg-background p-4">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value="auth status:blocked updated:>7d" readOnly className="h-10 pl-9 pr-4 text-sm" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="px-1.5 py-0 text-(length:--text-micro) font-normal normal-case">
            status:blocked
          </Badge>
          <Badge variant="outline" className="px-1.5 py-0 text-(length:--text-micro) font-normal normal-case">
            updated:&gt;7d
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {suggestions.map((suggestion) => (
            <span
              key={suggestion.token}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5"
            >
              <span className="font-mono text-(length:--text-micro)">{suggestion.token}</span>
              <span className="hidden text-(length:--text-micro) sm:inline">{suggestion.description}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CommandPaletteWithSearchAll({
  query,
  emptyResults = false,
}: {
  query: string;
  emptyResults?: boolean;
}) {
  return (
    <Command className="rounded-md border border-border bg-popover shadow-lg">
      <CommandInput value={query} readOnly placeholder="Search tasks, agents, projects..." />
      <CommandList className="max-h-none">
        {emptyResults ? (
          <CommandEmpty>
            <span>
              No quick task matches. Press{" "}
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 text-[10px]">↵</kbd> to{" "}
              <span className="font-medium">search all</span> or keep typing to refine.
            </span>
          </CommandEmpty>
        ) : null}
        <CommandGroup heading="Search">
          <CommandItem
            value="search-all"
            className="bg-accent/40 border border-accent data-[selected=true]:bg-accent/60"
          >
            <SearchIcon className="mr-2 h-4 w-4" />
            <span className="flex-1 truncate">
              Search all for <span className="font-semibold">&ldquo;{query}&rdquo;</span>
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>open full search</span>
              <kbd className="rounded border border-border bg-background px-1 py-0.5 text-[10px]">↵</kbd>
            </span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick filters">
          {SEARCH_OPERATOR_QUICK_FILTERS.map((chip) => (
            <CommandItem key={chip} value={`quick-filter ${chip}`}>
              <SearchIcon className="mr-2 h-4 w-4" />
              <span className="font-mono text-xs">{chip}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem>
            <SquarePen className="mr-2 h-4 w-4" />
            Create new task
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
          <CommandItem>
            <Plus className="mr-2 h-4 w-4" />
            Create new agent
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Pages">
          <CommandItem>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </CommandItem>
          <CommandItem>
            <CircleDot className="mr-2 h-4 w-4" />
            Tasks
          </CommandItem>
          <CommandItem>
            <Target className="mr-2 h-4 w-4" />
            Goals
          </CommandItem>
          <CommandItem>
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem>
            <DollarSign className="mr-2 h-4 w-4" />
            Costs
          </CommandItem>
          <CommandItem>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
        </CommandGroup>
        {!emptyResults ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tasks">
              {storybookTasks.slice(0, 3).map((task) => (
                <CommandItem key={task.id}>
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{task.identifier}</span>
                  <span className="flex-1 truncate">{task.title}</span>
                  <Badge variant={statusBadgeVariant(task.boardPresentationStatus)}>
                    {task.boardPresentationStatus}
                  </Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
        <CommandSeparator />
        <CommandGroup heading="Projects">
          {storybookProjects.slice(0, 2).map((project) => (
            <CommandItem key={project.id}>
              <Hexagon className="mr-2 h-4 w-4" />
              {project.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
