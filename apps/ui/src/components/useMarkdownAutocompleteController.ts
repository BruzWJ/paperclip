import type { MDXEditorMethods } from "@mdxeditor/editor";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
} from "react";

import type { RoutineCommandOption } from "../context/EditorAutocompleteContext";
import {
  applyMentionChipDecoration,
  clearMentionChipDecoration,
  parseMentionChipHref,
} from "../lib/mention-chips";
import {
  applyMention,
  findClosestAutocompleteAnchor,
  isSameAutocompleteSession,
  isSelectionInsideCodeLikeElement,
  placeCaretAfterMentionAnchor,
} from "./MarkdownAutocompleteEditing";
import {
  MAX_AUTOCOMPLETE_OPTIONS,
  computeMentionMenuPosition,
  detectMention,
  getMentionMenuSize,
  getMentionMenuViewport,
} from "./MarkdownAutocompleteMenu";
import type { AutocompleteOption, MentionOption, MentionState } from "./MarkdownEditorTypes";
import { buildMentionOptionMap } from "./MarkdownEditorUtils";

export interface MarkdownAutocompleteControllerOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<MDXEditorMethods | null>;
  latestValueRef: MutableRefObject<string>;
  echoIgnoreMarkdownRef: MutableRefObject<string | null>;
  mentions?: MentionOption[];
  slashCommands: RoutineCommandOption[];
  onChange: (value: string) => void;
}

/** Coordinates mention/command detection, selection, and chip decoration. */
export function useMarkdownAutocompleteController({
  containerRef,
  editorRef,
  latestValueRef,
  echoIgnoreMarkdownRef,
  mentions,
  slashCommands,
  onChange,
}: MarkdownAutocompleteControllerOptions) {
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const mentionStateRef = useRef<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const autocompleteOptionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const commandEnterArmedRef = useRef(false);
  const autocompleteSelectionHandledRef = useRef(false);
  const mentionActive =
    mentionState !== null &&
    ((mentionState.trigger === "mention" && Boolean(mentions?.length)) ||
      (mentionState.trigger === "command" && slashCommands.length > 0));
  const mentionOptionByKey = useMemo(() => buildMentionOptionMap(mentions), [mentions]);

  const filteredMentions = useMemo<AutocompleteOption[]>(() => {
    if (!mentionState) return [];
    const q = mentionState.query.trim().toLowerCase();
    if (mentionState.trigger === "command") {
      return slashCommands
        .filter((command) => {
          if (!q) return true;
          return command.aliases.some((alias) => alias.toLowerCase().includes(q));
        })
        .slice(0, MAX_AUTOCOMPLETE_OPTIONS);
    }
    if (!mentions) return [];
    return mentions
      .filter((mention) => mention.name.toLowerCase().includes(q))
      .slice(0, MAX_AUTOCOMPLETE_OPTIONS);
  }, [mentionState, mentions, slashCommands]);

  const decorateProjectMentions = useCallback(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    const links = editable.querySelectorAll("a");
    for (const node of links) {
      const link = node as HTMLAnchorElement;
      const parsed = parseMentionChipHref(link.getAttribute("href") ?? "");
      if (!parsed) {
        clearMentionChipDecoration(link);
        continue;
      }

      if (parsed.kind === "project") {
        const option = mentionOptionByKey.get(`project:${parsed.projectId}`);
        applyMentionChipDecoration(link, {
          ...parsed,
          color: parsed.color ?? (option?.kind === "project" ? option.projectColor : null) ?? null,
        });
        continue;
      }

      if (parsed.kind === "routine" || parsed.kind === "user" || parsed.kind === "task") {
        applyMentionChipDecoration(link, parsed);
        continue;
      }

      const option = mentionOptionByKey.get(`agent:${parsed.agentId}`);
      applyMentionChipDecoration(link, {
        ...parsed,
        icon: parsed.icon ?? (option?.kind === "agent" ? option.agentIcon : null) ?? null,
      });
    }
  }, [containerRef, mentionOptionByKey]);

  const checkMention = useCallback(() => {
    if (!containerRef.current || isSelectionInsideCodeLikeElement(containerRef.current)) {
      mentionStateRef.current = null;
      commandEnterArmedRef.current = false;
      setMentionState(null);
      return;
    }
    const result = detectMention(containerRef.current);
    if (result && result.trigger === "mention" && (!mentions || mentions.length === 0)) {
      mentionStateRef.current = null;
      commandEnterArmedRef.current = false;
      setMentionState(null);
      return;
    }
    if (result && result.trigger === "command" && slashCommands.length === 0) {
      mentionStateRef.current = null;
      commandEnterArmedRef.current = false;
      setMentionState(null);
      return;
    }
    const previous = mentionStateRef.current;
    const sameSession = isSameAutocompleteSession(previous, result);
    mentionStateRef.current = result;
    if (!sameSession) {
      commandEnterArmedRef.current = false;
      setMentionIndex(0);
    }
    setMentionState(result);
  }, [containerRef, mentions, slashCommands.length]);

  useEffect(() => {
    if ((!mentions || mentions.length === 0) && slashCommands.length === 0) return;

    const element = containerRef.current;
    const onInput = () => requestAnimationFrame(checkMention);

    document.addEventListener("selectionchange", checkMention);
    element?.addEventListener("input", onInput, true);
    return () => {
      document.removeEventListener("selectionchange", checkMention);
      element?.removeEventListener("input", onInput, true);
    };
  }, [checkMention, containerRef, mentions, slashCommands.length]);

  useEffect(() => {
    if (!mentionActive) return;

    const updatePosition = () => requestAnimationFrame(checkMention);
    const viewport = window.visualViewport;

    viewport?.addEventListener("resize", updatePosition);
    viewport?.addEventListener("scroll", updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      viewport?.removeEventListener("resize", updatePosition);
      viewport?.removeEventListener("scroll", updatePosition);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [checkMention, mentionActive]);

  useEffect(() => {
    if (!mentionActive) return;
    autocompleteOptionRefs.current.length = filteredMentions.length;
    if (mentionIndex >= filteredMentions.length) {
      setMentionIndex(Math.max(0, filteredMentions.length - 1));
      return;
    }
    const activeOption = autocompleteOptionRefs.current[mentionIndex];
    if (!activeOption || typeof activeOption.scrollIntoView !== "function") return;
    activeOption.scrollIntoView({ block: "nearest" });
  }, [filteredMentions.length, mentionActive, mentionIndex]);

  useEffect(() => {
    if (mentionActive) return;
    autocompleteSelectionHandledRef.current = false;
  }, [mentionActive]);

  useEffect(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    let frameId: number | null = null;
    let disposed = false;
    const observe = () => {
      observer.observe(editable, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    };
    const flushDecorations = () => {
      frameId = null;
      if (disposed) return;
      observer.disconnect();
      decorateProjectMentions();
      if (!disposed) observe();
    };
    const scheduleDecorations = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(flushDecorations);
    };
    const observer = new MutationObserver(scheduleDecorations);

    flushDecorations();
    return () => {
      disposed = true;
      observer.disconnect();
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [containerRef, decorateProjectMentions]);

  const selectMention = useCallback(
    (option: AutocompleteOption) => {
      const state = mentionStateRef.current;
      if (!state) return false;
      const current = latestValueRef.current;
      const next = applyMention(current, state, option);
      if (next !== current) {
        latestValueRef.current = next;
        echoIgnoreMarkdownRef.current = next;
        editorRef.current?.setMarkdown(next);
        onChange(next);
      }

      const restoreSelection = (attemptsRemaining: number) => {
        const editable = containerRef.current?.querySelector('[contenteditable="true"]');
        if (!(editable instanceof HTMLElement)) return;

        decorateProjectMentions();
        editable.focus();

        const target = findClosestAutocompleteAnchor(editable, option, state);
        if (!target) {
          if (attemptsRemaining > 0) {
            requestAnimationFrame(() => restoreSelection(attemptsRemaining - 1));
          }
          return;
        }

        placeCaretAfterMentionAnchor(target);
      };

      requestAnimationFrame(() => restoreSelection(4));
      mentionStateRef.current = null;
      commandEnterArmedRef.current = false;
      setMentionState(null);
      return true;
    },
    [containerRef, decorateProjectMentions, echoIgnoreMarkdownRef, editorRef, latestValueRef, onChange],
  );

  const handleAutocompletePress = useCallback(
    (
      event:
        ReactMouseEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement> | ReactTouchEvent<HTMLDivElement>,
      option: AutocompleteOption,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      if (autocompleteSelectionHandledRef.current) return;
      const handled = selectMention(option);
      if (handled) autocompleteSelectionHandledRef.current = true;
    },
    [selectMention],
  );

  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const touchTapThreshold = 8;
  const handleAutocompleteTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartPointRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);
  const handleAutocompleteTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const start = touchStartPointRef.current;
    if (!start) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > touchTapThreshold) {
      touchStartPointRef.current = null;
    }
  }, []);
  const handleAutocompleteTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>, option: AutocompleteOption) => {
      const start = touchStartPointRef.current;
      touchStartPointRef.current = null;
      if (!start) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > touchTapThreshold) {
        return;
      }
      handleAutocompletePress(event, option);
    },
    [handleAutocompletePress],
  );

  const mentionMenuPosition = mentionState
    ? computeMentionMenuPosition(
        mentionState,
        getMentionMenuViewport(),
        getMentionMenuSize(filteredMentions.length),
      )
    : null;

  return {
    mentionActive,
    mentionStateRef,
    commandEnterArmedRef,
    setMentionState,
    filteredMentions,
    setMentionIndex,
    selectMention,
    mentionIndex,
    mentionMenuPosition,
    autocompleteOptionRefs,
    handleAutocompletePress,
    handleAutocompleteTouchStart,
    handleAutocompleteTouchMove,
    handleAutocompleteTouchEnd,
  };
}
