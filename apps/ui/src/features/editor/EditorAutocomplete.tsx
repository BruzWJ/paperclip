import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  findSuggestionMatch,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildTaskReferenceHref,
  buildUserMentionHref,
} from "@paperclipai/shared";
import Fuse from "fuse.js";
import {
  BotIcon,
  CalendarClockIcon,
  FolderKanbanIcon,
  ListTodoIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

import {
  defaultSlashSuggestions,
  type SlashFindSuggestionMatch,
  type SlashSuggestions,
  type SuggestionItem as KiboSuggestionItem,
} from "@/components/kibo-ui/editor";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command";
import type { RoutineCommandOption } from "@/context/EditorAutocompleteContext";

import type { MentionOption } from "../markdown/MarkdownEditorTypes";

const MAX_SUGGESTIONS = 50;
const mentionPluginKey = new PluginKey("paperclipMentionSuggestions");

interface EditorSuggestionItem {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  searchTerms: string[];
  execute: (props: { editor: Editor; range: Range }) => void;
}

interface EditorSuggestionMenuProps extends SuggestionProps<EditorSuggestionItem, EditorSuggestionItem> {
  ariaLabel: string;
  testId: string;
}

interface EditorSuggestionMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

function mentionMarkdown(mention: MentionOption) {
  if (mention.kind === "task") {
    return `[${mention.taskIdentifier}](${buildTaskReferenceHref(mention.taskId)}) `;
  }
  if (mention.kind === "project") {
    return `[@${mention.name}](${buildProjectMentionHref(mention.projectId, mention.projectColor ?? null)}) `;
  }
  if (mention.kind === "user") {
    return `[@${mention.name}](${buildUserMentionHref(mention.userId)}) `;
  }
  return `[@${mention.name}](${buildAgentMentionHref(mention.agentId, mention.agentIcon ?? null)}) `;
}

function mentionIcon(kind: MentionOption["kind"]) {
  if (kind === "agent") return BotIcon;
  if (kind === "project") return FolderKanbanIcon;
  if (kind === "task") return ListTodoIcon;
  return UserIcon;
}

export function buildMentionSuggestionItems(mentions: MentionOption[]): EditorSuggestionItem[] {
  return mentions.map((mention) => ({
    id: mention.id,
    title: mention.kind === "task" ? mention.taskIdentifier : `@${mention.name}`,
    description: `${mention.kind} mention`,
    icon: mentionIcon(mention.kind),
    searchTerms: [mention.name, mention.id, mention.kind],
    execute: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent(mentionMarkdown(mention), { contentType: "markdown" })
        .run();
    },
  }));
}

export function buildRoutineSuggestionItems(routines: RoutineCommandOption[]): EditorSuggestionItem[] {
  return routines.map((routine) => ({
    id: routine.id,
    title: `/routine:${routine.name}`,
    description: `${routine.status} routine`,
    icon: CalendarClockIcon,
    searchTerms: routine.aliases,
    execute: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent(`[/routine:${routine.name}](${routine.href}) `, {
          contentType: "markdown",
        })
        .run();
    },
  }));
}

function filterSuggestions(items: EditorSuggestionItem[], query: string) {
  if (!query.trim()) return items.slice(0, MAX_SUGGESTIONS);
  return new Fuse(items, {
    keys: ["title", "description", "searchTerms"],
    threshold: 0.25,
    minMatchCharLength: 1,
  })
    .search(query)
    .map((result) => result.item)
    .slice(0, MAX_SUGGESTIONS);
}

const EditorSuggestionMenu = forwardRef<EditorSuggestionMenuHandle, EditorSuggestionMenuProps>(
  function EditorSuggestionMenu({ items, command, ariaLabel, testId }, forwardedRef) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
    }, [items.length]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        onKeyDown: (event) => {
          if (event.key === "ArrowDown") {
            setSelectedIndex((current) => Math.min(current + 1, items.length - 1));
            return true;
          }
          if (event.key === "ArrowUp") {
            setSelectedIndex((current) => Math.max(current - 1, 0));
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const selected = items[selectedIndex];
            if (!selected) return false;
            command(selected);
            return true;
          }
          return false;
        },
      }),
      [command, items, selectedIndex],
    );

    return (
      <Command
        aria-label={ariaLabel}
        className="border shadow"
        data-testid={testId}
        shouldFilter={false}
        value={items[selectedIndex]?.id}
        onValueChange={(id) => {
          const nextIndex = items.findIndex((item) => item.id === id);
          if (nextIndex >= 0) setSelectedIndex(nextIndex);
        }}
      >
        <CommandEmpty className="flex w-full items-center justify-center p-4 text-sm text-muted-foreground">
          No results
        </CommandEmpty>
        <CommandList>
          {items.map((item) => (
            <CommandItem
              className="flex items-center gap-3 pr-3"
              key={item.id}
              value={item.id}
              onSelect={() => command(item)}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded border bg-secondary">
                <item.icon className="size-4 text-muted-foreground" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium">{item.title}</span>
                <span className="text-xs text-muted-foreground">{item.description}</span>
              </div>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    );
  },
);

function createSuggestionRenderer({
  ariaLabel,
  testId,
}: Pick<EditorSuggestionMenuProps, "ariaLabel" | "testId">) {
  return () => {
    let component: ReactRenderer<EditorSuggestionMenuHandle, EditorSuggestionMenuProps> | undefined;
    let unmount: (() => void) | undefined;

    return {
      onStart: (props: SuggestionProps<EditorSuggestionItem, EditorSuggestionItem>) => {
        component = new ReactRenderer(EditorSuggestionMenu, {
          editor: props.editor,
          props: { ...props, ariaLabel, testId },
        });
        unmount = props.mount(component.element);
      },
      onUpdate: (props: SuggestionProps<EditorSuggestionItem, EditorSuggestionItem>) => {
        component?.updateProps({ ...props, ariaLabel, testId });
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => component?.ref?.onKeyDown(event) ?? false,
      onExit: () => {
        unmount?.();
        component?.destroy();
      },
    };
  };
}

interface PaperclipEditorAutocompleteOptions {
  getMentions: () => MentionOption[];
}

const PaperclipEditorAutocomplete = Extension.create<PaperclipEditorAutocompleteOptions>({
  name: "paperclipEditorAutocomplete",

  addOptions() {
    return {
      getMentions: () => [],
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<EditorSuggestionItem, EditorSuggestionItem>({
        editor: this.editor,
        pluginKey: mentionPluginKey,
        char: "@",
        allowSpaces: true,
        allow: () => this.options.getMentions().length > 0,
        items: ({ query }) =>
          filterSuggestions(buildMentionSuggestionItems(this.options.getMentions()), query),
        command: ({ editor, range, props }) => props.execute({ editor, range }),
        render: createSuggestionRenderer({
          ariaLabel: "Mention suggestions",
          testId: "editor-mention-suggestions",
        }),
      }),
    ];
  },
});

export function createEditorAutocompleteExtension(options: PaperclipEditorAutocompleteOptions) {
  return PaperclipEditorAutocomplete.configure(options);
}

function toKiboSuggestion(item: EditorSuggestionItem): KiboSuggestionItem {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    icon: item.icon,
    searchTerms: item.searchTerms,
    command: item.execute,
  };
}

function filterSlashSuggestions(items: KiboSuggestionItem[], query: string) {
  if (!query.trim()) return items.slice(0, MAX_SUGGESTIONS);
  return new Fuse(items, {
    keys: ["title", "description", "searchTerms"],
    threshold: 0.2,
    minMatchCharLength: 1,
  })
    .search(query)
    .map((result) => result.item)
    .slice(0, MAX_SUGGESTIONS);
}

/** Extends Kibo's single slash-command source with current company routines. */
export function createEditorSlashSuggestions(getRoutines: () => RoutineCommandOption[]): SlashSuggestions {
  return async (props) =>
    filterSlashSuggestions(
      [
        ...(await defaultSlashSuggestions(props)),
        ...buildRoutineSuggestionItems(getRoutines()).map(toKiboSuggestion),
      ],
      props.query,
    );
}

/** Keeps ordinary Kibo slash commands single-token while allowing routine titles to contain spaces. */
export const findEditorSlashSuggestionMatch: SlashFindSuggestionMatch = (config) => {
  const spacedMatch = findSuggestionMatch({ ...config, allowSpaces: true });
  if (spacedMatch?.query.toLocaleLowerCase().startsWith("routine:")) return spacedMatch;
  return findSuggestionMatch({ ...config, allowSpaces: false });
};
