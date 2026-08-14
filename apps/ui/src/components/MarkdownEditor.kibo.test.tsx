// @vitest-environment jsdom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditor } from "./MarkdownEditor";
import type { MarkdownEditorRef } from "./MarkdownEditorTypes";

const editorState = vi.hoisted(() => {
  const state = {
    markdown: "",
    focus: vi.fn(),
    setContent: vi.fn(),
    insertContent: vi.fn(),
    extensions: [] as unknown[],
    editor: {} as {
      getMarkdown: () => string;
      commands: {
        focus: (position: string) => void;
        setContent: (content: string, options: unknown) => void;
        insertContent: (content: string, options: unknown) => void;
      };
    },
  };
  state.editor = {
    getMarkdown: () => state.markdown,
    commands: {
      focus: (position) => state.focus(position),
      setContent: (content, options) => {
        state.markdown = content;
        state.setContent(content, options);
      },
      insertContent: (content, options) => state.insertContent(content, options),
    },
  };
  return state;
});

vi.mock("@tiptap/react", () => ({
  useCurrentEditor: () => ({ editor: editorState.editor }),
}));

vi.mock("@/components/kibo-ui/editor", () => {
  function EditorProvider({
    children,
    content,
    editable,
    placeholder,
    extensions = [],
    onUpdate,
    onBlur,
  }: {
    children: ReactNode;
    content: string;
    editable: boolean;
    placeholder?: string;
    extensions?: unknown[];
    onUpdate?: (event: { editor: typeof editorState.editor }) => void;
    onBlur?: () => void;
  }) {
    editorState.extensions = extensions;
    return (
      <section
        data-testid="kibo-editor"
        data-content={content}
        data-editable={String(editable)}
        data-placeholder={placeholder}
        data-extension-count={extensions.length}
      >
        <button
          data-testid="emit-update"
          type="button"
          onClick={() => {
            editorState.markdown = "Changed through Kibo";
            onUpdate?.({ editor: editorState.editor });
          }}
        />
        <button data-testid="emit-blur" type="button" onClick={() => onBlur?.()} />
        {children}
      </section>
    );
  }

  function Menu({ children }: { children?: ReactNode }) {
    return <div data-testid="kibo-editor-menu">{children}</div>;
  }

  const Control = () => null;
  return {
    EditorProvider,
    EditorBubbleMenu: Menu,
    EditorFloatingMenu: Menu,
    EditorClearFormatting: Control,
    EditorFormatBold: Control,
    EditorFormatCode: Control,
    EditorFormatItalic: Control,
    EditorFormatStrike: Control,
    EditorLinkSelector: Control,
    EditorNodeBulletList: Control,
    EditorNodeCode: Control,
    EditorNodeHeading1: Control,
    EditorNodeHeading2: Control,
    EditorNodeHeading3: Control,
    EditorNodeOrderedList: Control,
    EditorNodeQuote: Control,
    EditorNodeTable: Control,
    EditorNodeTaskList: Control,
    EditorNodeText: Control,
    EditorSelector: Menu,
  };
});

describe("MarkdownEditor Kibo adapter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    editorState.markdown = "";
    editorState.focus.mockClear();
    editorState.setContent.mockClear();
    editorState.insertContent.mockClear();
    editorState.extensions = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the controlled markdown contract through the Kibo editor", async () => {
    editorState.markdown = "# Initial";

    await act(async () => {
      root.render(<MarkdownEditor value="# Initial" onChange={() => {}} placeholder="Write an update" />);
    });

    const editor = container.querySelector('[data-testid="kibo-editor"]');
    expect(editor?.getAttribute("data-content")).toBe("# Initial");
    expect(editor?.getAttribute("data-editable")).toBe("true");
    expect(editor?.getAttribute("data-placeholder")).toBe("Write an update");
    expect(container.querySelectorAll('[data-testid="kibo-editor-menu"]')).toHaveLength(4);
    expect(editorState.setContent).not.toHaveBeenCalled();
  });

  it("synchronizes external markdown without emitting an editor update", async () => {
    editorState.markdown = "Initial";
    const onChange = vi.fn();

    await act(async () => {
      root.render(<MarkdownEditor value="Initial" onChange={onChange} />);
    });
    await act(async () => {
      root.render(<MarkdownEditor value="Remote update" onChange={onChange} />);
    });

    expect(editorState.setContent).toHaveBeenLastCalledWith("Remote update", {
      contentType: "markdown",
      emitUpdate: false,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds the domain autocomplete extension beside Kibo's markdown and image extensions", async () => {
    editorState.markdown = "";
    await act(async () => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => {}}
          mentions={[
            {
              id: "agent:agent-1",
              kind: "agent",
              name: "Ada",
              agentId: "00000000-0000-4000-8000-000000000001",
              agentIcon: null,
            },
          ]}
        />,
      );
    });

    expect(container.querySelector('[data-testid="kibo-editor"]')?.getAttribute("data-extension-count")).toBe(
      "3",
    );
    expect(editorState.extensions.at(-1)).toMatchObject({
      name: "paperclipEditorAutocomplete",
    });
  });

  it("forwards Kibo updates, blur, and the imperative markdown commands", async () => {
    editorState.markdown = "Initial";
    const onChange = vi.fn();
    const onBlur = vi.fn();
    const ref = createRef<MarkdownEditorRef>();

    await act(async () => {
      root.render(<MarkdownEditor ref={ref} value="Initial" onChange={onChange} onBlur={onBlur} />);
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="emit-update"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      container
        .querySelector<HTMLButtonElement>('[data-testid="emit-blur"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      ref.current?.focus();
      ref.current?.insertMarkdown("**More**");
    });

    expect(onChange).toHaveBeenCalledWith("Changed through Kibo");
    expect(onBlur).toHaveBeenCalledOnce();
    expect(editorState.focus).toHaveBeenCalledWith("end");
    expect(editorState.insertContent).toHaveBeenCalledWith("**More**", {
      contentType: "markdown",
    });
  });

  it("keeps read-only Kibo editors non-mutating", async () => {
    editorState.markdown = "Read only";
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorRef>();

    await act(async () => {
      root.render(<MarkdownEditor ref={ref} value="Read only" onChange={onChange} readOnly />);
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="emit-update"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      ref.current?.insertMarkdown("Ignored");
    });

    expect(container.querySelector('[data-testid="kibo-editor"]')?.getAttribute("data-editable")).toBe(
      "false",
    );
    expect(container.querySelector('[data-testid="kibo-editor-menu"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(editorState.insertContent).not.toHaveBeenCalled();
  });
});
