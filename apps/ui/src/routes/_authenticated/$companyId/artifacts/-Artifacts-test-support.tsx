// @vitest-environment jsdom

import type { CompanyArtifact, CompanyArtifactGroup } from "@/api/artifacts";
import { TestRouter } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { Route } from ".";

export const Artifacts = getRouteComponent(Route);

export const TASK_ID = "44444444-4444-4444-8444-444444444444";

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const artifactsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/api/artifacts", () => ({
  artifactsApi: artifactsApiMock,
}));

// Render the menu inline (no radix portal / pointer-capture) so option clicks
// are deterministic in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (value: string) => void;
  }) => {
    const resolveValue = (target: EventTarget | null) =>
      (target as HTMLElement).closest("button")?.getAttribute("value") ?? null;
    const selectFrom = (target: EventTarget | null) => {
      const value = resolveValue(target);
      if (value) onValueChange?.(value);
    };
    return (
      <div
        role="radiogroup"
        tabIndex={0}
        onPointerDown={(event) => selectFrom(event.target)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            selectFrom(event.target);
          }
        }}
      >
        {children}
      </div>
    );
  },
  DropdownMenuRadioItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/routes/_authenticated/$companyId/artifacts/-ArtifactCard", () => ({
  ArtifactCard: ({ artifact }: { artifact: CompanyArtifact }) => (
    <article data-testid="artifact-card">{artifact.title}</article>
  ),
  ArtifactPreview: ({ artifact }: { artifact: CompanyArtifact }) => (
    <div data-testid="artifact-preview">{artifact.title}</div>
  ),
}));

export type ObserverCallback = IntersectionObserverCallback;

export let latestObserverCallback: ObserverCallback | null = null;

export function resetLatestObserverCallback() {
  latestObserverCallback = null;
}

export class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  constructor(callback: ObserverCallback) {
    latestObserverCallback = callback;
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

export function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "artifact-1",
    source: "document",
    mediaKind: "document",
    title: "Launch Brief",
    previewText: "launch brief preview",
    contentType: "text/markdown",
    contentPath: null,
    openPath: null,
    downloadPath: null,
    task: {
      id: TASK_ID,
      taskNumber: 42,
      identifier: "PAP-42",
      title: "Ship launch",
    },
    project: null,
    createdByAgent: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
    taskFragment: "document-brief",
    ...overrides,
  };
}

export function sampleGroup(overrides: Partial<CompanyArtifactGroup> = {}): CompanyArtifactGroup {
  return {
    id: `task:${TASK_ID}`,
    groupBy: "task",
    task: {
      id: TASK_ID,
      taskNumber: 42,
      identifier: "PAP-42",
      title: "Ship launch",
    },
    title: "Ship launch",
    count: 3,
    mediaKinds: ["document"],
    previewArtifacts: [sampleArtifact()],
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

export async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

export function renderArtifacts(
  container: HTMLDivElement,
  initialEntries: string[] = ["/11111111-1111-4111-8111-111111111111/artifacts"],
) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TestRouter initialEntries={initialEntries}>
          <Artifacts />
        </TestRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

export function useBreadcrumbStateTestState() {
  return breadcrumbState;
}

export function useArtifactsApiMockTestState() {
  return artifactsApiMock;
}
