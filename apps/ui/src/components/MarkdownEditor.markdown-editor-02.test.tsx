// @vitest-environment jsdom
import {
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildTaskReferenceHref,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_ID,
  ROUTINE_ID,
  act,
  computeMentionMenuPosition,
  findClosestAutocompleteAnchor,
  findMentionMatch,
  flush,
  isSameAutocompleteSession,
  createTouchEvent,
  openMentionMenuFor,
  placeCaretAfterMentionAnchor,
  setupMarkdownEditorTest,
  shouldAcceptAutocompleteKey,
  taskMentionTitle,
} from "./MarkdownEditor.test-support";
describe("MarkdownEditor", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupMarkdownEditorTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("keeps a short mention menu on the same line when it fits below the caret", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 160, viewportBottom: 178, viewportLeft: 120 },
        { offsetLeft: 0, offsetTop: 0, width: 320, height: 220 },
        { width: 188, height: 42 },
      ),
    ).toEqual({
      top: 160,
      left: 130,
    });
  });
  it("keeps mention queries active across spaces", () => {
    expect(findMentionMatch("Ping @Paperclip App", "Ping @Paperclip App".length)).toEqual({
      trigger: "mention",
      marker: "@",
      query: "Paperclip App",
      atPos: 5,
      endPos: "Ping @Paperclip App".length,
    });
  });
  it("still rejects slash commands once spaces are typed", () => {
    expect(findMentionMatch("/open task", "/open task".length)).toBeNull();
  });
  it("keeps routine slash queries active across spaces", () => {
    expect(
      findMentionMatch("/routine:Weekly release review", "/routine:Weekly release review".length),
    ).toEqual({
      trigger: "command",
      marker: "/",
      query: "routine:Weekly release review",
      atPos: 0,
      endPos: "/routine:Weekly release review".length,
    });
  });
  it("does not treat Enter as command autocomplete accept until armed", () => {
    expect(shouldAcceptAutocompleteKey("Enter", "command")).toBe(false);
    expect(shouldAcceptAutocompleteKey("Enter", "command", true)).toBe(true);
    expect(shouldAcceptAutocompleteKey("Enter", "mention")).toBe(true);
    expect(shouldAcceptAutocompleteKey("Tab", "command")).toBe(true);
  });
  it("keeps the same autocomplete session active while the slash query is unchanged", () => {
    const textNode = document.createTextNode("/routine:Weekly");
    expect(
      isSameAutocompleteSession(
        {
          trigger: "command",
          marker: "/",
          query: "routine:Weekly",
          textNode,
          atPos: 0,
          endPos: "/routine:Weekly".length,
        },
        {
          trigger: "command",
          marker: "/",
          query: "routine:Weekly",
          textNode,
          atPos: 0,
          endPos: "/routine:Weekly".length,
        },
      ),
    ).toBe(true);
    expect(
      isSameAutocompleteSession(
        {
          trigger: "command",
          marker: "/",
          query: "routine:Weekly",
          textNode,
          atPos: 0,
          endPos: "/routine:Weekly".length,
        },
        {
          trigger: "command",
          marker: "/",
          query: "routine:Weekly release",
          textNode,
          atPos: 0,
          endPos: "/routine:Weekly release".length,
        },
      ),
    ).toBe(false);
  });
  it("finds routine anchors by mention metadata instead of visible text", () => {
    const editable = document.createElement("div");
    const routineLink = document.createElement("a");
    routineLink.setAttribute("href", buildRoutineMentionHref(ROUTINE_ID));
    routineLink.textContent = "/routine:Weekly release review ";
    editable.appendChild(routineLink);
    const found = findClosestAutocompleteAnchor(editable, {
      id: `routine:${ROUTINE_ID}`,
      kind: "routine",
      routineId: ROUTINE_ID,
      name: "Weekly release review",
      status: "active",
      href: buildRoutineMentionHref(ROUTINE_ID),
      aliases: ["routine:Weekly release review", "Weekly release review"],
    });
    expect(found).toBe(routineLink);
  });
  it("places the caret after the command's trailing space when present", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.appendChild(editable);
    const routineLink = document.createElement("a");
    routineLink.setAttribute("href", buildRoutineMentionHref(ROUTINE_ID));
    routineLink.textContent = "/routine:Weekly release review";
    const trailingSpace = document.createTextNode(" ");
    editable.append(routineLink, trailingSpace);
    expect(placeCaretAfterMentionAnchor(routineLink)).toBe(true);
    const selection = window.getSelection();
    expect(selection?.anchorNode).toBe(trailingSpace);
    expect(selection?.anchorOffset).toBe(1);
    editable.remove();
  });
  it("accepts mention selection from a touch tap", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(container, handleChange);
    const point = { clientX: 100, clientY: 50 };
    act(() => {
      option.dispatchEvent(createTouchEvent("touchstart", [point]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchend", [point]));
    });
    expect(handleChange).toHaveBeenCalledWith(
      `[@Paperclip App](${buildProjectMentionHref(PROJECT_ID, "#336699")}) `,
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("inserts a compact task link when an @task reference is selected", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(
      container,
      handleChange,
      [
        {
          id: "task:123e4567-e89b-42d3-a456-426614174000",
          kind: "task" as const,
          name: "PAP-102 @task references",
          taskId: "123e4567-e89b-42d3-a456-426614174000",
          taskIdentifier: "PAP-102",
        },
      ],
      "PAP-102",
    );
    const point = { clientX: 100, clientY: 50 };
    act(() => {
      option.dispatchEvent(createTouchEvent("touchstart", [point]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchend", [point]));
    });
    expect(handleChange).toHaveBeenCalledWith(
      `[PAP-102](${buildTaskReferenceHref("123e4567-e89b-42d3-a456-426614174000")}) `,
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("renders the task tag and identifier for task mention options", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(
      container,
      handleChange,
      [
        {
          id: "task:123e4567-e89b-42d3-a456-426614174000",
          kind: "task" as const,
          name: "PAP-102 @task references",
          taskId: "123e4567-e89b-42d3-a456-426614174000",
          taskIdentifier: "PAP-102",
        },
      ],
      "PAP-102",
    );
    expect(option.textContent).toContain("PAP-102");
    expect(option.textContent).toContain("@task references");
    expect(option.textContent).toContain("Task");
    await act(async () => {
      root.unmount();
    });
  });
  it("marks the autocomplete portal as floating UI for modal pointer handling", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(container, handleChange);
    const menu = option.closest("[data-paperclip-floating-ui]");
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain("pointer-events-auto");
    await act(async () => {
      root.unmount();
    });
  });
  it("does not preventDefault on touchstart so the mention menu can scroll on mobile", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(container, handleChange);
    const touchstart = createTouchEvent("touchstart", [{ clientX: 100, clientY: 50 }]);
    act(() => {
      option.dispatchEvent(touchstart);
    });
    expect(touchstart.defaultPrevented).toBe(false);
    expect(handleChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
  it("renders all mention matches inside a bounded scroll container", async () => {
    const handleChange = vi.fn();
    const mentions = Array.from({ length: 12 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));
    const { menu, root } = await openMentionMenuFor(container, handleChange, mentions);
    const options = Array.from(menu.querySelectorAll('[data-slot="command-item"]'));
    expect(options).toHaveLength(12);
    expect(menu.className).toContain("max-h-(--sz-208px)");
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu.style.touchAction).toBe("pan-y");
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    act(() => {
      menu.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });
  it("caps rendered mention matches while keeping the menu scrollable", async () => {
    const handleChange = vi.fn();
    const mentions = Array.from({ length: 60 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));
    const { menu, root } = await openMentionMenuFor(container, handleChange, mentions);
    const options = Array.from(menu.querySelectorAll('[data-slot="command-item"]'));
    expect(options).toHaveLength(50);
    expect(menu.className).toContain("overflow-y-auto");
    await act(async () => {
      root.unmount();
    });
  });
  it("scrolls the active mention option into view during keyboard navigation", async () => {
    const handleChange = vi.fn();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const mentions = Array.from({ length: 12 }, (_, index) => ({
      id: `project:project-${index}`,
      kind: "project" as const,
      name: `Paperclip App ${index}`,
      projectId: `project-${index}`,
      projectColor: "#336699",
    }));
    const { root } = await openMentionMenuFor(container, handleChange, mentions);
    scrollIntoView.mockClear();
    const editorScope = container.querySelector('[data-testid="mdx-editor"]')?.parentElement;
    expect(editorScope).toBeTruthy();
    act(() => {
      editorScope?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    await act(async () => {
      root.unmount();
    });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
  it("does not select when the touch moves like a scroll", async () => {
    const handleChange = vi.fn();
    const { option, root } = await openMentionMenuFor(container, handleChange);
    const start = { clientX: 100, clientY: 50 };
    const moved = { clientX: 100, clientY: 90 };
    act(() => {
      option.dispatchEvent(createTouchEvent("touchstart", [start]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchmove", [moved]));
    });
    act(() => {
      option.dispatchEvent(createTouchEvent("touchend", [moved]));
    });
    expect(handleChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});

describe("taskMentionTitle", () => {
  it("strips the leading identifier from the mention name", () => {
    expect(
      taskMentionTitle({
        name: "PAP-102 @task references",
        taskIdentifier: "PAP-102",
      }),
    ).toBe("@task references");
  });

  it("returns the full name when there is no separate title", () => {
    expect(
      taskMentionTitle({
        name: "PAP-7",
        taskIdentifier: "PAP-7",
      }),
    ).toBe("");
  });

  it("falls back to the name when the identifier is missing", () => {
    expect(taskMentionTitle({ name: "Some task" })).toBe("Some task");
  });
});
