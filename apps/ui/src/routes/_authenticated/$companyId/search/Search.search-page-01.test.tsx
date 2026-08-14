// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./-Search-test-support";
import {
  ARTIFACT_TASK_ID,
  AUTH_TASK_ID,
  getSearchInput,
  renderSearch,
  setupSearchPageTest,
  useSearchApiMockTestState,
  waitForAssertion,
} from "./-Search-test-support";
const searchApiMock = useSearchApiMockTestState();
describe("Search page", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupSearchPageTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("sends a search request when ?q is in the URL and renders the result", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "auth flake",
      normalizedQuery: "auth flake",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 1,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: AUTH_TASK_ID,
          type: "task",
          score: 100,
          title: "PAP-3142 Auth middleware flakes",
          routeTarget: { kind: "task", taskNumber: 3142, hash: null },
          matchedFields: ["title", "comment"],
          sourceLabel: "Comment",
          snippet: "we hit another flake",
          snippets: [
            {
              field: "title",
              label: "Title",
              text: "Auth middleware flakes",
              highlights: [{ start: 0, end: 4 }],
            },
            {
              field: "comment",
              label: "Comment",
              text: "we hit another flake in the morning batch",
              highlights: [{ start: 16, end: 21 }],
            },
          ],
          task: {
            id: AUTH_TASK_ID,
            taskNumber: 3142,
            identifier: "PAP-3142",
            title: "Auth middleware flakes",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            request: "Investigate intermittent authentication middleware failures.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search?q=auth+flake", container);
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "auth flake",
        scope: "all",
        limit: 20,
      });
    });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("PAP-3142");
      expect(container.textContent).toContain("Auth middleware flakes");
      expect(container.textContent).toContain("1 result");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("renders artifact search results in the company search surface", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "launch brief",
      normalizedQuery: "launch brief",
      scope: "artifacts",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 1,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: "document:artifact-1",
          type: "artifact",
          score: 140,
          title: "Launch Artifact Brief",
          routeTarget: { kind: "task", taskNumber: 42, hash: "document-brief" },
          matchedFields: ["artifact"],
          sourceLabel: "Artifact",
          snippet: "launch brief preview text",
          snippets: [
            {
              field: "artifact",
              label: "Artifact",
              text: "launch brief preview text",
              highlights: [{ start: 0, end: 6 }],
            },
          ],
          artifact: {
            id: "document:artifact-1",
            source: "document",
            mediaKind: "document",
            taskId: ARTIFACT_TASK_ID,
            taskNumber: 42,
            taskIdentifier: "PAP-42",
            taskTitle: "Ship launch artifacts",
            taskFragment: "document-brief",
            projectId: null,
            projectName: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });
    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=launch+brief&scope=artifacts",
      container,
    );
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "launch brief",
        scope: "artifacts",
        limit: 20,
      });
    });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Launch Artifact Brief");
      expect(container.textContent).toContain("PAP-42");
      expect(container.textContent).toContain("launch brief preview text");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("renders comment and document result rows with exact anchors, source chips, and highlights", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "needle",
      normalizedQuery: "needle",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 1,
        document: 1,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: "task-comment",
          type: "task",
          score: 180,
          title: "PAP-77 Comment source",
          routeTarget: {
            kind: "task",
            taskNumber: 77,
            hash: "comment-comment-77",
          },
          matchedFields: ["comment"],
          sourceLabel: "Comment",
          snippet: "thread needle evidence",
          snippets: [
            {
              field: "comment",
              label: "Comment",
              text: "thread needle evidence",
              highlights: [{ start: 7, end: 13 }],
            },
          ],
          task: {
            id: "task-comment",
            taskNumber: 77,
            identifier: "PAP-77",
            title: "Comment source",
            boardPresentationStatus: "todo",
            priority: "medium",
            request: "Review the comment source result.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
        {
          id: "task-document",
          type: "task",
          score: 170,
          title: "PAP-78 Document source",
          routeTarget: { kind: "task", taskNumber: 78, hash: "document-plan" },
          matchedFields: ["document"],
          sourceLabel: "Plan",
          snippet: "plan needle evidence",
          snippets: [
            {
              field: "document",
              label: "Plan",
              text: "plan needle evidence",
              highlights: [{ start: 5, end: 11 }],
            },
          ],
          task: {
            id: "task-document",
            taskNumber: 78,
            identifier: "PAP-78",
            title: "Document source",
            boardPresentationStatus: "todo",
            priority: "medium",
            request: "Review the document source result.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search?q=needle", container);
    await waitForAssertion(() => {
      expect(
        container.querySelector(
          'a[href="/11111111-1111-4111-8111-111111111111/tasks/77#comment-comment-77"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('a[href="/11111111-1111-4111-8111-111111111111/tasks/78#document-plan"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain("Comment");
      expect(container.textContent).toContain("Doc");
      expect(container.querySelectorAll("mark")).toHaveLength(2);
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("renders the explicit loading state while search is pending", async () => {
    searchApiMock.search.mockReturnValueOnce(new Promise(() => {}));
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search?q=slow", container);
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="search-loading"]')?.textContent).toContain("slow");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("renders the explicit error state with retry and fallback actions", async () => {
    searchApiMock.search.mockRejectedValueOnce(Object.assign(new Error("Search failed"), { status: 500 }));
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search?q=broken", container);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Couldn’t run that search");
      expect(container.textContent).toContain("The server returned 500.");
      expect(container.textContent).toContain("Retry");
      expect(container.textContent).toContain("Open Tasks filter view");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("debounces typing into the input and dispatches a search after the debounce window", async () => {
    searchApiMock.search.mockResolvedValue({
      query: "deflake",
      normalizedQuery: "deflake",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
    });
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search", container);
    const input = await getSearchInput(container);
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "deflake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The debounce hasn't fired yet, so no API call should be made synchronously.
    expect(searchApiMock.search).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "deflake",
        scope: "all",
        limit: 20,
      });
    });
    flushSync(() => {
      root.unmount();
    });
  });
});
