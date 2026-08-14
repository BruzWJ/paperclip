// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { MarkdownEditor } from "./MarkdownEditor";
import type { MarkdownEditorRef } from "./MarkdownEditorTypes";

vi.mock("@/context/EditorAutocompleteContext", () => ({
  useEditorAutocomplete: () => [
    {
      id: "routine:routine-1",
      kind: "routine",
      routineId: "00000000-0000-4000-8000-000000000002",
      name: "Daily review",
      status: "active",
      href: "routine://00000000-0000-4000-8000-000000000002",
      aliases: ["routine:Daily review", "Daily review", "routine-1"],
    },
    {
      id: "routine:routine-2",
      kind: "routine",
      routineId: "00000000-0000-4000-8000-000000000003",
      name: "Daily review",
      status: "active",
      href: "routine://00000000-0000-4000-8000-000000000003",
      aliases: ["routine:Daily review", "Daily review", "routine-2"],
    },
  ],
}));

describe("MarkdownEditor Kibo runtime", () => {
  it("mounts the real Kibo/Tiptap editor and keeps its markdown ref contract", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<MarkdownEditorRef>();
    const onChange = vi.fn();

    try {
      await act(async () => {
        root.render(<MarkdownEditor ref={ref} value="# Kibo editor" onChange={onChange} />);
      });

      await vi.waitFor(() => {
        expect(container.querySelector(".ProseMirror h1")?.textContent).toBe("Kibo editor");
      });

      const editable = container.querySelector(".ProseMirror");
      expect(editable?.getAttribute("role")).toBe("textbox");
      expect(editable?.getAttribute("aria-label")).toBe("Markdown editor");
      expect(editable?.getAttribute("aria-multiline")).toBe("true");

      await act(async () => ref.current?.insertMarkdown("\n\nMore markdown"));
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenCalled();
        expect(container.querySelector(".ProseMirror")?.textContent).toContain("More markdown");
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("opens @ suggestions and inserts the selected domain mention in the real editor", async () => {
    const rangeClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const rangeBoundingRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<MarkdownEditorRef>();
    const onChange = vi.fn();

    try {
      await act(async () => {
        root.render(
          <MarkdownEditor
            ref={ref}
            value=""
            onChange={onChange}
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

      await act(async () => ref.current?.insertMarkdown("@Ad"));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="editor-mention-suggestions"]')).not.toBeNull();
      });

      const option = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="editor-mention-suggestions"] [cmdk-item]'),
      ).find((item) => item.textContent?.includes("@Ada"));
      expect(option).toBeDefined();

      await act(async () => option?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith("[@Ada](agent://00000000-0000-4000-8000-000000000001) ");
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (rangeClientRects) {
        Object.defineProperty(Range.prototype, "getClientRects", rangeClientRects);
      } else {
        Reflect.deleteProperty(Range.prototype, "getClientRects");
      }
      if (rangeBoundingRect) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBoundingRect);
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    }
  });

  it("adds routine commands to Kibo's single slash menu and inserts the selected routine", async () => {
    const rangeClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const rangeBoundingRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<MarkdownEditorRef>();
    const onChange = vi.fn();

    try {
      await act(async () => {
        root.render(<MarkdownEditor ref={ref} value="" onChange={onChange} />);
      });

      await act(async () => ref.current?.insertMarkdown("/routine:Daily review"));
      await vi.waitFor(() => {
        expect(document.querySelectorAll("#slash-command")).toHaveLength(1);
      });
      expect(document.querySelector('[data-testid="editor-command-suggestions"]')).toBeNull();

      const matchingOptions = Array.from(
        document.querySelectorAll<HTMLElement>("#slash-command [cmdk-item]"),
      ).filter((item) => item.textContent?.includes("/routine:Daily review"));
      expect(matchingOptions).toHaveLength(2);
      expect(new Set(matchingOptions.map((item) => item.getAttribute("data-value"))).size).toBe(2);
      const option = matchingOptions[0];
      expect(option).toBeDefined();

      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => container.querySelector(".ProseMirror")?.dispatchEvent(enter));
      expect(enter.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          "[/routine:Daily review](routine://00000000-0000-4000-8000-000000000002) ",
        );
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (rangeClientRects) {
        Object.defineProperty(Range.prototype, "getClientRects", rangeClientRects);
      } else {
        Reflect.deleteProperty(Range.prototype, "getClientRects");
      }
      if (rangeBoundingRect) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBoundingRect);
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    }
  });

  it("moves one Kibo slash-menu item for each ArrowDown event", async () => {
    const rangeClientRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    const rangeBoundingRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<MarkdownEditorRef>();

    try {
      await act(async () => {
        root.render(<MarkdownEditor ref={ref} value="" onChange={() => {}} />);
      });

      await act(async () => ref.current?.insertMarkdown("/"));
      await vi.waitFor(() => {
        expect(document.querySelectorAll("#slash-command [cmdk-item]").length).toBeGreaterThan(2);
      });

      const items = Array.from(document.querySelectorAll<HTMLElement>("#slash-command [cmdk-item]"));
      expect(items[0]?.textContent).toContain("Text");
      expect(items[1]?.textContent).toContain("To-do List");

      const arrowDown = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      await act(async () => container.querySelector(".ProseMirror")?.dispatchEvent(arrowDown));

      expect(arrowDown.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(items[1]?.getAttribute("data-selected")).toBe("true"));
      expect(items[2]?.getAttribute("data-selected")).not.toBe("true");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (rangeClientRects) {
        Object.defineProperty(Range.prototype, "getClientRects", rangeClientRects);
      } else {
        Reflect.deleteProperty(Range.prototype, "getClientRects");
      }
      if (rangeBoundingRect) {
        Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeBoundingRect);
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    }
  });
});
