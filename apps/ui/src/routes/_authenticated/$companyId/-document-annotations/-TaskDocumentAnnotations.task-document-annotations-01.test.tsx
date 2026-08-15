// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEP_LINK_THREAD_ID,
  Harness,
  TASK_ID,
  act,
  flush,
  makeThread,
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
  it("renders the open count chip and opens the panel on click", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    await Harness.render(container);
    const chip = container.querySelector('[data-testid="document-annotation-count-plan"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("1");
    expect(mockAnnotationsApi.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      (chip as HTMLButtonElement).click();
    });
    await flush();
    const panel = container.querySelector('[data-testid="document-annotation-panel"]');
    expect(panel).not.toBeNull();
    const anchor = container.querySelector('[data-testid="document-annotation-panel-anchor"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.className).toContain("fixed");
    expect(anchor?.className).toContain("z-(--z-60)");
  });
  it("keeps the desktop annotation panel inside the task content area when properties are visible", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectFor = (left: number, top: number, right: number, bottom: number) => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this instanceof HTMLElement && this.id === "main-content") {
        return rectFor(0, 0, 900, 800);
      }
      if (
        this instanceof HTMLElement &&
        this.getAttribute("data-testid") === "document-annotation-body-plan"
      ) {
        return rectFor(80, 120, 640, 620);
      }
      return originalGetBoundingClientRect.call(this);
    });
    try {
      await Harness.render(container, { initialPanelOpen: true }, true);
      const anchor = container.querySelector(
        '[data-testid="document-annotation-panel-anchor"]',
      ) as HTMLElement | null;
      const panel = container.querySelector(
        '[data-testid="document-annotation-panel"]',
      ) as HTMLElement | null;
      expect(anchor).not.toBeNull();
      expect(panel).not.toBeNull();
      expect(anchor!.style.left).toBe("524px");
      expect(anchor!.style.width).toBe("360px");
      expect(panel!.style.width).toBe("360px");
      expect(parseFloat(anchor!.style.left) + parseFloat(anchor!.style.width)).toBeLessThanOrEqual(884);
    } finally {
      rectSpy.mockRestore();
    }
  });
  it("offsets the desktop annotation panel from the document with a left margin when there is room", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const rectFor = (left: number, top: number, right: number, bottom: number) => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this instanceof HTMLElement && this.id === "main-content") {
        return rectFor(0, 0, 1400, 800);
      }
      if (
        this instanceof HTMLElement &&
        this.getAttribute("data-testid") === "document-annotation-body-plan"
      ) {
        return rectFor(80, 120, 640, 620);
      }
      return originalGetBoundingClientRect.call(this);
    });
    try {
      await Harness.render(container, { initialPanelOpen: true }, true);
      const anchor = container.querySelector(
        '[data-testid="document-annotation-panel-anchor"]',
      ) as HTMLElement | null;
      expect(anchor).not.toBeNull();
      // The document body ends at 640; the panel should clear it with a margin
      // rather than sitting flush against the document's right edge.
      expect(parseFloat(anchor!.style.left)).toBeGreaterThan(640);
      expect(anchor!.style.left).toBe("664px");
    } finally {
      rectSpy.mockRestore();
    }
  });
  it("auto-opens the panel and focuses the thread when deep-linked", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread({ id: DEEP_LINK_THREAD_ID })]);
    await Harness.render(container, {
      locationHash: `#document-plan&thread=${DEEP_LINK_THREAD_ID}`,
    });
    const panel = container.querySelector('[data-testid="document-annotation-panel"]');
    expect(panel).not.toBeNull();
    const focusedThread = container.querySelector(`[data-thread-id="${DEEP_LINK_THREAD_ID}"][data-focused]`);
    expect(focusedThread).not.toBeNull();
  });
  it("shows a disabled reason in the panel when the draft is dirty", async () => {
    mockAnnotationsApi.list.mockResolvedValue([makeThread()]);
    await Harness.render(container, { draftDirty: true, initialPanelOpen: true });
    const reason = container.querySelector('[data-testid="document-annotation-disabled-reason"]');
    expect(reason).not.toBeNull();
    expect(reason!.textContent).toMatch(/draft/i);
  });
  it("shows open and resolved threads together in a single list (no filter tabs)", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({ id: "open-1" }),
      makeThread({ id: "resolved-1", status: "resolved" }),
      makeThread({ id: "orphan-1", anchorState: "orphaned" }),
    ]);
    await Harness.render(container, { initialPanelOpen: true });
    // Open + resolved both render without any filter interaction.
    expect(container.querySelector('[data-thread-id="open-1"]')).not.toBeNull();
    expect(container.querySelector('[data-thread-id="resolved-1"]')).not.toBeNull();
    // Orphaned threads can't be anchored in the doc, so they stay hidden.
    expect(container.querySelector('[data-thread-id="orphan-1"]')).toBeNull();
    // The Open/Resolved/Stale/Orphaned filter chips are gone.
    const filterChip = Array.from(container.querySelectorAll("button")).find((button) =>
      ["Open", "Resolved", "Stale", "Orphaned"].includes((button.textContent ?? "").trim()),
    );
    expect(filterChip).toBeUndefined();
  });
  it("orders threads by document position, not API/recency order", async () => {
    // Returned out of document order: later-in-doc first, earlier-in-doc last.
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({
        id: "thread-late",
        normalizedStart: 900,
        markdownStart: 900,
      }),
      makeThread({
        id: "thread-early",
        normalizedStart: 10,
        markdownStart: 10,
      }),
      makeThread({
        id: "thread-mid",
        normalizedStart: 400,
        markdownStart: 400,
      }),
    ]);
    await Harness.render(container, { initialPanelOpen: true });
    const order = Array.from(container.querySelectorAll("[data-thread-id]")).map((el) =>
      el.getAttribute("data-thread-id"),
    );
    expect(order).toEqual(["thread-early", "thread-mid", "thread-late"]);
  });
  it("renders author name + role from agent and user maps", async () => {
    mockAnnotationsApi.list.mockResolvedValue([
      makeThread({
        id: "open-1",
        comments: [
          {
            id: "comment-board",
            companyId: "co-1",
            threadId: "open-1",
            taskId: TASK_ID,
            documentId: "doc-1",
            body: "From the board.",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            createdByRunId: null,
            createdAt: new Date("2026-04-01T00:01:00Z"),
            updatedAt: new Date("2026-04-01T00:01:00Z"),
          },
          {
            id: "comment-agent",
            companyId: "co-1",
            threadId: "open-1",
            taskId: TASK_ID,
            documentId: "doc-1",
            body: "From the agent.",
            authorType: "agent",
            authorAgentId: "agent-uxdesigner",
            authorUserId: null,
            createdByRunId: "run-1",
            createdAt: new Date("2026-04-01T00:02:00Z"),
            updatedAt: new Date("2026-04-01T00:02:00Z"),
          },
        ],
      }),
    ]);
    const agentMap = new Map([["agent-uxdesigner", { id: "agent-uxdesigner", name: "UXDesigner" }]]);
    const userProfileMap = new Map([["user-1", { label: "Dotta", image: null }]]);
    await Harness.render(container, { initialPanelOpen: true, agentMap, userProfileMap });
    // Click the open thread to expand it.
    const threadCard = container.querySelector('[data-thread-id="open-1"]') as HTMLElement | null;
    expect(threadCard).not.toBeNull();
    await act(async () => threadCard!.click());
    await flush();
    const expandedThread = container.querySelector('[data-thread-id="open-1"]');
    const expandedText = expandedThread?.textContent ?? "";
    expect(expandedText).toContain("Dotta");
    expect(expandedText).not.toContain("· board");
    expect(expandedText).toContain("UXDesigner");
    expect(expandedText).toContain("· agent");
    // Each rendered comment shows an author avatar.
    const avatars = expandedThread?.querySelectorAll('[data-slot="avatar"]') ?? [];
    expect(avatars.length).toBe(2);
  });
  it("does not render a persistent New comment on selection hint when panel is open", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    await Harness.render(container, { initialPanelOpen: true });
    const cta = container.querySelector('[data-testid="document-annotation-new-comment-cta"]');
    expect(cta).toBeNull();
    expect(container.textContent).toContain("No annotations yet.");
    expect(container.textContent).toContain("Select text in the document to add a comment.");
    expect(container.textContent).not.toMatch(/New comment on selection/i);
    expect(container.textContent).not.toMatch(/⌘⇧M/);
  });
  it("keeps a captured selection from opening the composer until the layer requests a comment", async () => {
    mockAnnotationsApi.list.mockResolvedValue([]);
    await Harness.render(container, { initialPanelOpen: true });
    const selectOnlyButton = container.querySelector(
      '[data-testid="mock-annotation-selection-only"]',
    ) as HTMLButtonElement | null;
    expect(selectOnlyButton).not.toBeNull();
    await act(async () => {
      selectOnlyButton!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="document-annotation-composer"]')).toBeNull();
    expect(container.querySelector('[data-testid="document-annotation-new-comment-cta"]')).toBeNull();
    const directRequestButton = container.querySelector(
      '[data-testid="mock-annotation-selection"]',
    ) as HTMLButtonElement | null;
    expect(directRequestButton).not.toBeNull();
    await act(async () => {
      directRequestButton!.click();
    });
    await flush();
    const composer = container.querySelector(
      '[data-testid="document-annotation-composer"]',
    ) as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(container.textContent).toContain(mockPendingAnchor.selectedText);
  });
});
