// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactGroupCard } from "./-ArtifactGroupCard";
import type { CompanyArtifact, CompanyArtifactGroup } from "@/api/artifacts";

const TASK_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: React.ComponentProps<"a"> & {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string | undefined>;
  }) => {
    const pathname = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    const query = new URLSearchParams(
      Object.entries(search ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ).toString();
    return (
      <a href={`${pathname}${query ? `?${query}` : ""}`} {...props}>
        {children}
      </a>
    );
  },
}));

function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "artifact-1",
    source: "attachment",
    mediaKind: "image",
    title: "Hero shot",
    previewText: null,
    contentType: "image/png",
    contentPath: "/files/hero.png",
    openPath: "/files/hero.png",
    downloadPath: "/files/hero.png?download=1",
    task: {
      id: TASK_ID,
      taskNumber: 42,
      identifier: "PAP-42",
      title: "Ship launch",
    },
    project: null,
    createdByAgent: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
    taskFragment: "attachment-1",
    ...overrides,
  } as CompanyArtifact;
}

function sampleGroup(overrides: Partial<CompanyArtifactGroup> = {}): CompanyArtifactGroup {
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
    mediaKinds: ["image"],
    previewArtifacts: [sampleArtifact()],
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(group: CompanyArtifactGroup) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <ArtifactGroupCard
        group={group}
        linkOptions={{
          to: "/$companyId/artifacts",
          params: { companyId: "11111111-1111-4111-8111-111111111111" },
          search: { groupBy: "task", groupTaskId: TASK_ID },
        }}
      />,
    );
  });
  return { container, root };
}

describe("ArtifactGroupCard", () => {
  let mounted: {
    container: HTMLElement;
    root: ReturnType<typeof createRoot>;
  } | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    if (mounted) {
      flushSync(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
  });

  it("shows a stack effect and plural count when count > 1", () => {
    mounted = render(sampleGroup({ count: 3 }));
    const card = mounted.container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-stacked")).toBe("true");
    expect(card.getAttribute("data-count")).toBe("3");
    // Two decorative stack layers sit behind the card.
    expect(mounted.container.querySelectorAll('[data-testid="artifact-stack-layer"]').length).toBe(2);
    expect(mounted.container.textContent).toContain("3 artifacts");
  });

  it("omits the stack effect and uses singular count when count === 1", () => {
    mounted = render(sampleGroup({ count: 1 }));
    const card = mounted.container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
    expect(card.getAttribute("data-stacked")).toBe("false");
    expect(card.getAttribute("data-count")).toBe("1");
    expect(mounted.container.querySelectorAll('[data-testid="artifact-stack-layer"]').length).toBe(0);
    expect(mounted.container.textContent).toContain("1 artifact");
    expect(mounted.container.textContent).not.toContain("1 artifacts");
  });

  it("links to the provided stack destination and shows the task subject", () => {
    mounted = render(sampleGroup());
    const anchor = mounted.container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute("href")).toContain(`groupTaskId=${TASK_ID}`);
    expect(mounted.container.textContent).toContain("PAP-42");
    expect(mounted.container.textContent).toContain("Ship launch");
  });

  it("renders the first preview artifact image", () => {
    mounted = render(sampleGroup());
    const img = mounted.container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/files/hero.png");
  });

  it("falls back to a placeholder when there are no preview artifacts", () => {
    mounted = render(sampleGroup({ previewArtifacts: [] }));
    expect(mounted.container.querySelector("img")).toBeNull();
    const card = mounted.container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
    expect(card).not.toBeNull();
  });
});
