// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Harness,
  TASK_ID,
  act,
  dispatchSubmitShortcut,
  flush,
  makeThread,
  setTextareaValue,
  useMockAnnotationsApiTestState,
  useMockPendingAnchorTestState,
} from "./-TaskDocumentAnnotations.test-support";
const mockAnnotationsApi = useMockAnnotationsApiTestState();
const mockPendingAnchor = useMockPendingAnchorTestState();
describe("TaskDocumentAnnotations", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });
  afterEach(() => {
    container.remove();
  });
  it("does not hijack the global comment shortcut while focus is in an input", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    await Harness.render(container, { initialPanelOpen: true });
    const selectOnlyButton = container.querySelector(
      '[data-testid="mock-annotation-selection-only"]',
    ) as HTMLButtonElement | null;
    await act(async () => selectOnlyButton!.click());
    await flush();
    const input = document.createElement("input");
    container.appendChild(input);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "m",
          metaKey: true,
          shiftKey: true,
        }),
      );
    });
    await flush();
    expect(container.querySelector('[data-testid="document-annotation-composer"]')).toBeNull();
  });
  it("creates a thread from a captured selection and refreshes the shared annotations query", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    mockAnnotationsApi.create.mockResolvedValue(makeThread({ id: "created-1" }));
    await Harness.render(container, { initialPanelOpen: true });
    expect(mockAnnotationsApi.list).toHaveBeenCalledTimes(1);
    const selectButton = container.querySelector(
      '[data-testid="mock-annotation-selection"]',
    ) as HTMLButtonElement | null;
    expect(selectButton).not.toBeNull();
    await act(async () => {
      selectButton!.click();
    });
    await flush();
    const composer = container.querySelector(
      '[data-testid="document-annotation-composer"]',
    ) as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    await act(async () => {
      setTextareaValue(composer!, "New anchored comment");
    });
    await flush();
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Comment",
    );
    expect(submit).not.toBeUndefined();
    await act(async () => {
      submit!.click();
    });
    await flush();
    await flush();
    expect(mockAnnotationsApi.create).toHaveBeenCalledWith(
      {
        kind: "task",
        taskId: TASK_ID,
        documentKey: "plan",
      },
      {
        baseRevisionId: "rev-4",
        baseRevisionNumber: 4,
        selector: mockPendingAnchor.selector,
        body: "New anchored comment",
      },
    );
    expect(mockAnnotationsApi.list.mock.calls.length).toBeGreaterThan(1);
  });
  it("keeps the composer visible with the draft when creating a thread fails", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    mockAnnotationsApi.create.mockRejectedValue(
      new Error("Annotation anchor does not match the current document revision"),
    );
    await Harness.render(container, { initialPanelOpen: true });
    const selectButton = container.querySelector(
      '[data-testid="mock-annotation-selection"]',
    ) as HTMLButtonElement | null;
    expect(selectButton).not.toBeNull();
    await act(async () => {
      selectButton!.click();
    });
    await flush();
    const composer = container.querySelector(
      '[data-testid="document-annotation-composer"]',
    ) as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    await act(async () => {
      setTextareaValue(composer!, "New anchored comment");
    });
    await flush();
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Comment",
    );
    expect(submit).not.toBeUndefined();
    await act(async () => {
      submit!.click();
    });
    await flush();
    await flush();
    const composerAfterFailure = container.querySelector(
      '[data-testid="document-annotation-composer"]',
    ) as HTMLTextAreaElement | null;
    expect(composerAfterFailure).not.toBeNull();
    expect(composerAfterFailure!.value).toBe("New anchored comment");
    expect(container.querySelector('[data-testid="document-annotation-error"]')?.textContent).toContain(
      "Annotation anchor does not match the current document revision",
    );
  });
  it("submits a new anchored comment with ⌘↵", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    mockAnnotationsApi.create.mockResolvedValue(makeThread({ id: "created-1" }));
    await Harness.render(container, { initialPanelOpen: true });
    const selectButton = container.querySelector(
      '[data-testid="mock-annotation-selection"]',
    ) as HTMLButtonElement | null;
    await act(async () => selectButton!.click());
    await flush();
    const composer = container.querySelector(
      '[data-testid="document-annotation-composer"]',
    ) as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    await act(async () => setTextareaValue(composer!, "Submitted via shortcut"));
    await flush();
    await act(async () => dispatchSubmitShortcut(composer!));
    await flush();
    await flush();
    expect(mockAnnotationsApi.create).toHaveBeenCalledWith(
      {
        kind: "task",
        taskId: TASK_ID,
        documentKey: "plan",
      },
      {
        baseRevisionId: "rev-4",
        baseRevisionNumber: 4,
        selector: mockPendingAnchor.selector,
        body: "Submitted via shortcut",
      },
    );
  });
  it("submits a reply with ⌘↵", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread({ id: "open-1" })]);
    mockAnnotationsApi.addComment.mockResolvedValue(makeThread({ id: "open-1" }).comments[0]);
    await Harness.render(container, { initialPanelOpen: true });
    const openThread = container.querySelector('[data-thread-id="open-1"]') as HTMLElement | null;
    await act(async () => openThread!.click());
    await flush();
    const reply = container.querySelector(
      '[data-testid="document-annotation-reply-open-1"]',
    ) as HTMLTextAreaElement | null;
    expect(reply).not.toBeNull();
    await act(async () => setTextareaValue(reply!, "Replying via shortcut"));
    await flush();
    await act(async () => dispatchSubmitShortcut(reply!));
    await flush();
    await flush();
    expect(mockAnnotationsApi.addComment).toHaveBeenCalledWith(
      {
        kind: "task",
        taskId: TASK_ID,
        documentKey: "plan",
      },
      "open-1",
      {
        body: "Replying via shortcut",
      },
    );
  });
  it("keeps a reply draft visible when submitting the reply fails", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread({ id: "open-1" })]);
    mockAnnotationsApi.addComment.mockRejectedValue(new Error("Failed to add reply"));
    await Harness.render(container, { initialPanelOpen: true });
    const openThread = container.querySelector('[data-thread-id="open-1"]') as HTMLElement | null;
    expect(openThread).not.toBeNull();
    await act(async () => openThread!.click());
    await flush();
    const reply = container.querySelector(
      '[data-testid="document-annotation-reply-open-1"]',
    ) as HTMLTextAreaElement | null;
    expect(reply).not.toBeNull();
    await act(async () => setTextareaValue(reply!, "Reply should stay visible"));
    await flush();
    const replyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reply",
    );
    expect(replyButton).not.toBeUndefined();
    await act(async () => replyButton!.click());
    await flush();
    await flush();
    const replyAfterFailure = container.querySelector(
      '[data-testid="document-annotation-reply-open-1"]',
    ) as HTMLTextAreaElement | null;
    expect(replyAfterFailure).not.toBeNull();
    expect(replyAfterFailure!.value).toBe("Reply should stay visible");
    expect(container.querySelector('[data-testid="document-annotation-error"]')?.textContent).toContain(
      "Failed to add reply",
    );
  });
  it("shows resolve and reopen actions and updates thread status", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({ id: "open-1" }),
      makeThread({ id: "resolved-1", status: "resolved" }),
    ]);
    mockAnnotationsApi.updateStatus.mockResolvedValue(makeThread({ id: "open-1", status: "resolved" }));
    await Harness.render(container, { initialPanelOpen: true });
    const openThread = container.querySelector('[data-thread-id="open-1"]') as HTMLElement | null;
    expect(openThread).not.toBeNull();
    await act(async () => openThread!.click());
    await flush();
    const resolveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      /\bResolve\b/.test(button.textContent ?? ""),
    );
    expect(resolveButton).not.toBeUndefined();
    await act(async () => resolveButton!.click());
    await flush();
    expect(mockAnnotationsApi.updateStatus).toHaveBeenCalledWith(
      {
        kind: "task",
        taskId: TASK_ID,
        documentKey: "plan",
      },
      "open-1",
      "resolved",
    );
    // Resolved threads stay in the same list (filter tabs were removed).
    const resolvedThread = container.querySelector('[data-thread-id="resolved-1"]') as HTMLElement | null;
    expect(resolvedThread).not.toBeNull();
    await act(async () => resolvedThread!.click());
    await flush();
    const reopenButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Reopen"),
    );
    expect(reopenButton).not.toBeUndefined();
    await act(async () => reopenButton!.click());
    await flush();
    expect(mockAnnotationsApi.updateStatus).toHaveBeenCalledWith(
      {
        kind: "task",
        taskId: TASK_ID,
        documentKey: "plan",
      },
      "resolved-1",
      "open",
    );
  });
  it("renders the mobile annotation panel through the sheet path", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    try {
      await Harness.render(container, { initialPanelOpen: true });
      const sheet = container.querySelector('[data-slot="sheet-content"]');
      expect(sheet).not.toBeNull();
      expect(sheet?.getAttribute("data-side")).toBe("bottom");
      expect(sheet?.className).toContain("paperclip-doc-annotation-sheet");
      expect(sheet?.className).toContain("z-(--z-60)");
      expect(sheet?.className).toContain("bg-popover");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});
