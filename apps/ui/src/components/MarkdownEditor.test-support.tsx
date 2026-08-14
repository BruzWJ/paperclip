// @vitest-environment jsdom

import type { MentionOption } from "./MarkdownEditor";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, vi, type Mock } from "vitest";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ROUTINE_ID = "abcdefac-cdef-4abc-8def-abcdefabcdef";

const mdxEditorMockState = vi.hoisted(() => ({
  emitMountEmptyReset: false,
  emitMountParseError: false,
  emitMountSilentEmptyState: false,
  throwOnRender: false,
  markdownValues: [] as string[],
  suppressHtmlProcessingValues: [] as boolean[],
}));

export function containsHtmlLikeTag(markdown: string) {
  return /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*)?\/?>/.test(markdown);
}

vi.mock("@mdxeditor/editor", async () => {
  const React = await import("react");

  function setForwardedRef<T>(ref: React.ForwardedRef<T | null>, value: T | null) {
    if (typeof ref === "function") {
      ref(value);
      return;
    }
    if (ref) {
      (ref as React.MutableRefObject<T | null>).current = value;
    }
  }

  const MDXEditor = React.forwardRef(function MockMDXEditor(
    {
      markdown,
      placeholder,
      onChange,
      onError,
      className,
      suppressHtmlProcessing,
    }: {
      markdown: string;
      placeholder?: string;
      onChange?: (value: string) => void;
      onError?: (error: unknown) => void;
      suppressHtmlProcessing?: boolean;
      className?: string;
    },
    forwardedRef: React.ForwardedRef<{
      setMarkdown: (value: string) => void;
      focus: () => void;
    } | null>,
  ) {
    if (mdxEditorMockState.throwOnRender) {
      throw new Error("Rich editor render crashed");
    }
    mdxEditorMockState.markdownValues.push(markdown);
    mdxEditorMockState.suppressHtmlProcessingValues.push(Boolean(suppressHtmlProcessing));
    const [content, setContent] = React.useState(markdown);
    const editableRef = React.useRef<HTMLDivElement>(null);
    const handle = React.useMemo(
      () => ({
        setMarkdown: (value: string) => setContent(value),
        focus: () => editableRef.current?.focus(),
      }),
      [],
    );

    React.useEffect(() => {
      if (!suppressHtmlProcessing && containsHtmlLikeTag(markdown)) {
        setContent("");
        onError?.({
          error: "Error parsing markdown: HTML-like formatting requires suppressHtmlProcessing",
          source: markdown,
        });
        return;
      }
      setContent(markdown);
    }, [markdown, onError, suppressHtmlProcessing]);

    React.useEffect(() => {
      setForwardedRef(forwardedRef, null);
      const timer = window.setTimeout(() => {
        setForwardedRef(forwardedRef, handle);
        if (mdxEditorMockState.emitMountEmptyReset) {
          setContent("");
          onChange?.("");
        }
        if (mdxEditorMockState.emitMountSilentEmptyState) {
          setContent("");
        }
        if (mdxEditorMockState.emitMountParseError) {
          setContent("");
          onError?.({
            error: "Unsupported markdown syntax",
            source: markdown,
          });
        }
      }, 0);
      return () => {
        window.clearTimeout(timer);
        setForwardedRef(forwardedRef, null);
      };
    }, []);

    return (
      <div
        ref={editableRef}
        data-testid="mdx-editor"
        className={className}
        contentEditable
        suppressContentEditableWarning
      >
        {content || placeholder || ""}
      </div>
    );
  });

  return {
    CodeMirrorEditor: () => null,
    MDXEditor,
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
    createRootEditorSubscription$: Symbol("createRootEditorSubscription$"),
    headingsPlugin: () => ({}),
    imagePlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    realmPlugin: (plugin: unknown) => plugin,
    tablePlugin: () => ({}),
    thematicBreakPlugin: () => ({}),
  };
});

vi.mock("../lib/mention-deletion", () => ({
  mentionDeletionPlugin: () => ({}),
}));

vi.mock("../lib/paste-normalization", () => ({
  pasteNormalizationPlugin: () => ({}),
}));

const {
  computeMentionMenuPosition,
  findClosestAutocompleteAnchor,
  findMentionMatch,
  isSameAutocompleteSession,
  MarkdownEditor,
  placeCaretAfterMentionAnchor,
  shouldAcceptAutocompleteKey,
  taskMentionTitle,
} = await import("./MarkdownEditor");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export interface MarkdownEditorTestHarness {
  container: HTMLDivElement;
  cleanup: () => void;
}

export function setupMarkdownEditorTest(): MarkdownEditorTestHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const originalRangeRect = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () => ({
    x: 32,
    y: 24,
    width: 12,
    height: 18,
    top: 24,
    right: 44,
    bottom: 42,
    left: 32,
    toJSON: () => ({}),
  });

  return {
    container,
    cleanup: () => {
      container.remove();
      Range.prototype.getBoundingClientRect = originalRangeRect;
      vi.clearAllMocks();
      mdxEditorMockState.emitMountEmptyReset = false;
      mdxEditorMockState.emitMountParseError = false;
      mdxEditorMockState.emitMountSilentEmptyState = false;
      mdxEditorMockState.throwOnRender = false;
      mdxEditorMockState.markdownValues = [];
      mdxEditorMockState.suppressHtmlProcessingValues = [];
    },
  };
}

export function createTouchEvent(
  type: "touchstart" | "touchmove" | "touchend",
  touches: Array<{ clientX: number; clientY: number }>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = touches as unknown as TouchList;
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : list,
  });
  Object.defineProperty(event, "changedTouches", { value: list });
  return event;
}

export async function openMentionMenuFor(
  container: HTMLElement,
  handleChange: Mock<(value: string) => void>,
  mentions: MentionOption[] = [
    {
      id: `project:${PROJECT_ID}`,
      kind: "project",
      name: "Paperclip App",
      projectId: PROJECT_ID,
      projectColor: "#336699",
    },
  ],
  matchText = "Paperclip App",
): Promise<{
  option: HTMLElement;
  root: ReturnType<typeof createRoot>;
  menu: HTMLElement;
}> {
  const root = createRoot(container);
  await act(async () => {
    root.render(<MarkdownEditor value="@Pap" onChange={handleChange} mentions={mentions} />);
  });
  await flush();
  const editable = container.querySelector('[contenteditable="true"]');
  expect(editable).not.toBeNull();
  const textNode = editable?.firstChild;
  expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(textNode!, "@Pap".length);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  await flush();
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).find(
    (node) => node.textContent?.includes(matchText),
  );
  expect(option).toBeTruthy();
  const menu = document.body.querySelector('[data-testid="mention-autocomplete-menu"]') as HTMLElement | null;
  expect(menu).toBeTruthy();
  return { option: option!, root, menu: menu! };
}

export function createFileDragEvent(type: string) {
  const event = (
    typeof DragEvent === "function"
      ? new DragEvent(type, { bubbles: true, cancelable: true })
      : new Event(type, { bubbles: true, cancelable: true })
  ) as Event & {
    dataTransfer: { types: string[]; files: File[]; dropEffect?: string };
  };
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: {
      types: ["Files"],
      files: [],
    },
  });
  return event;
}

export {
  computeMentionMenuPosition,
  findClosestAutocompleteAnchor,
  findMentionMatch,
  isSameAutocompleteSession,
  MarkdownEditor,
  placeCaretAfterMentionAnchor,
  shouldAcceptAutocompleteKey,
  taskMentionTitle,
};

export function useMdxEditorMockStateTestState() {
  return mdxEditorMockState;
}
