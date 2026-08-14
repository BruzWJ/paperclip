// @vitest-environment jsdom
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  emptySearchResponse,
  getSearchInput,
  renderSearch,
  setupSearchPageTest,
  useSearchApiMockTestState,
  waitForAssertion,
} from "./-Search-test-support";
import { flushSync } from "react-dom";

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
  it("drops a committed operator filter from requests when its token is deleted", async () => {
    searchApiMock.search.mockResolvedValue(emptySearchResponse());
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search", container);
    const input = await getSearchInput(container);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
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
    // Deleting the operator token must also delete its filter from the request.
    flushSync(() => {
      nativeSetter.call(input, "auth");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForAssertion(() => {
      const lastCall = searchApiMock.search.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({
        q: "auth",
        scope: "all",
        limit: 20,
      });
      expect(lastCall?.[1]).not.toHaveProperty("status");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("removes an operator-derived filter chip and strips its token from the query", async () => {
    searchApiMock.search.mockResolvedValue(emptySearchResponse());
    const { root } = renderSearch("/11111111-1111-4111-8111-111111111111/search", container);
    const input = await getSearchInput(container);
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
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
    const removeButton = await (async () => {
      let button: HTMLButtonElement | null = null;
      await waitForAssertion(() => {
        button = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove filter Status: Blocked"]',
        );
        expect(button).not.toBeNull();
      });
      return button!;
    })();
    flushSync(() => {
      removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The chip removal wins over the typed token: the input keeps only the plain
    // text and the re-query carries no status filter.
    await waitForAssertion(() => {
      expect(input.value).toBe("auth");
      const lastCall = searchApiMock.search.mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual({ q: "auth", scope: "all", limit: 20 });
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("shows operator autocomplete suggestions and applies one to the current token", async () => {
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
      input.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      nativeSetter.call(input, "auth sta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    let suggestionButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      const suggestions = container.querySelector('[data-testid="search-operator-suggestions"]');
      expect(suggestions).not.toBeNull();
      expect(suggestions!.textContent).toContain("status:todo");
      expect(suggestions!.textContent).toContain("status:blocked");
      expect(suggestions!.textContent).not.toContain("assignee:me");
      suggestionButton = container.querySelector('button[aria-label="Insert operator status:todo"]');
      expect(suggestionButton).not.toBeNull();
    });
    flushSync(() => {
      suggestionButton!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      suggestionButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForAssertion(() => {
      expect(input.value).toBe("auth status:todo");
    });
    flushSync(() => {
      root.unmount();
    });
  });
  it("round-trips the sort param through the URL and into the search request", async () => {
    searchApiMock.search.mockResolvedValue(emptySearchResponse({ sort: "updated" }));
    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&sort=updated",
      container,
    );
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "auth",
        scope: "all",
        limit: 20,
        sort: "updated",
      });
    });
    await waitForAssertion(() => {
      // The Sort menu trigger reflects the active sort.
      expect(container.textContent).toContain("Recently updated");
    });
    flushSync(() => {
      root.unmount();
    });
  });

  it("renders a removable filter chip and re-queries without the filter when removed", async () => {
    searchApiMock.search.mockResolvedValue(emptySearchResponse());
    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&status=todo",
      container,
    );
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
        q: "auth",
        scope: "all",
        limit: 20,
        status: ["todo"],
      });
    });
    let removeButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      removeButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove filter Status: Todo"]',
      );
      expect(removeButton).not.toBeNull();
    });
    flushSync(() => {
      removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForAssertion(() => {
      const lastCall = searchApiMock.search.mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual({ q: "auth", scope: "all", limit: 20 });
    });
    flushSync(() => {
      root.unmount();
    });
  });

  it("renders zero-results recovery with loosen suggestions when filters empty the page", async () => {
    searchApiMock.search.mockResolvedValueOnce(
      emptySearchResponse({
        zeroResults: {
          unfilteredTotal: 12,
          loosenSuggestions: [
            {
              filter: "status",
              values: ["done"],
              resultCount: 12,
              additionalCount: 12,
            },
          ],
        },
      }),
    );
    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&status=done",
      container,
    );
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="search-zero-results-recovery"]')).not.toBeNull();
      expect(container.textContent).toContain("No results with these filters");
      expect(container.textContent).toContain("12 results match");
      expect(container.textContent).toContain("Loosen a filter");
      expect(container.textContent).toContain("+12 results");
      expect(container.textContent).toContain("Clear all filters");
    });
    flushSync(() => {
      root.unmount();
    });
  });
});
