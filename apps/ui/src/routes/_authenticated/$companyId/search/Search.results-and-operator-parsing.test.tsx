// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./-Search-test-support";
import {
  CONTINUATION_TASK_ID,
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
  it("keeps exact identifier searches on the results page", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "PAP-3366",
      normalizedQuery: "pap-3366",
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
          id: CONTINUATION_TASK_ID,
          type: "task",
          score: 1300,
          title: "PAP-3366 Continuation summary",
          routeTarget: {
            kind: "task",
            taskNumber: 3366,
            hash: "document-run-summary",
          },
          matchedFields: ["identifier", "document"],
          sourceLabel: "Document",
          snippet: "Continuation summary excerpt",
          snippets: [
            {
              field: "document",
              label: "Continuation summary",
              text: "Continuation summary excerpt",
              highlights: [],
            },
          ],
          task: {
            id: CONTINUATION_TASK_ID,
            taskNumber: 3366,
            identifier: "PAP-3366",
            title: "Continuation summary",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            request: "Continue from the recorded run summary.",
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
    const { root, routerRef } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=PAP-3366",
      container,
    );
    await waitForAssertion(() => {
      expect(routerRef.current?.state.location.pathname).toBe("/11111111-1111-4111-8111-111111111111/search");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("renders the no-results state with a Search-all action when scope is non-default", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "ghost",
      normalizedQuery: "ghost",
      scope: "comments",
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
    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=ghost&scope=comments",
      container,
    );
    await waitForAssertion(() => {
      expect(container.textContent).toContain("No results for");
      expect(container.textContent).toContain("ghost");
      expect(container.textContent).toContain("Search all scopes");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("parses URL filters into search params and operator pills", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "auth",
      normalizedQuery: "auth",
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
    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&status=todo&updatedWithin=7d",
      container,
    );
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "auth",
        scope: "all",
        limit: 20,
        status: ["todo"],
        updatedWithin: "7d",
      });
    });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("status:todo");
      expect(container.textContent).toContain("updated:>7d");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("parses typed operators before dispatching search", async () => {
    searchApiMock.search.mockResolvedValue({
      query: "auth",
      normalizedQuery: "auth",
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
      nativeSetter.call(input, "auth status:blocked");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "auth",
        scope: "all",
        limit: 20,
        status: ["blocked"],
      });
    });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("status:blocked");
    });
    flushSync(() => {
      root.unmount();
    });
  });
});
