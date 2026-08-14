// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params: Record<string, string>;
    children: ReactNode;
    replace?: boolean;
  }) => {
    const { replace: _replace, ...rest } = props as Record<string, unknown>;
    const href = Object.entries(params).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return (
      <a href={href} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  },
}));

import { RoutineSubSidebar } from "./RoutineSubSidebar";
import type { RoutineSectionKey } from "./routine-sections/context";

function act(callback: () => void) {
  flushSync(callback);
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderSidebar(overrides?: {
  activeSection?: RoutineSectionKey;
  dirty?: RoutineSectionKey[];
  hasLiveRun?: boolean;
}) {
  const dirty = new Set(overrides?.dirty ?? []);
  act(() => {
    root.render(
      <SidebarProvider>
        <RoutineSubSidebar
          activeSection={overrides?.activeSection ?? "overview"}
          companyId="11111111-1111-4111-8111-111111111111"
          routineId="r1"
          isSectionDirty={(section) => dirty.has(section)}
          hasLiveRun={overrides?.hasLiveRun ?? false}
        />
      </SidebarProvider>,
    );
  });
}

describe("RoutineSubSidebar", () => {
  it("renders all eight sections grouped under ROUTINE and OPERATE", () => {
    renderSidebar();
    const links = Array.from(container.querySelectorAll("a"));
    const labels = links.map((link) => link.textContent?.trim());
    expect(labels).toEqual([
      "Overview",
      "Triggers",
      "Variables",
      "Secrets",
      "Delivery",
      "Runs",
      "Activity",
      "History",
    ]);
    const groupLabels = Array.from(container.querySelectorAll('[data-slot="sidebar-group-label"]')).map(
      (element) => element.textContent,
    );
    expect(groupLabels).toContain("Routine");
    expect(groupLabels).toContain("Operate");
  });

  it("marks the active section with aria-current=page", () => {
    renderSidebar({ activeSection: "secrets" });
    const active = container.querySelector('a[aria-current="page"]');
    expect(active?.textContent?.trim()).toBe("Secrets");
  });

  it("links each section to its section URL", () => {
    renderSidebar();
    const variables = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Variables",
    );
    expect(variables?.getAttribute("href")).toBe(
      "/11111111-1111-4111-8111-111111111111/routines/r1/variables",
    );
  });

  it("shows a dirty marker only on dirty editable sections", () => {
    renderSidebar({ dirty: ["overview", "delivery"] });
    const dirtyMarkers = container.querySelectorAll('[aria-label="Unsaved changes"]');
    expect(dirtyMarkers.length).toBe(2);
  });

  it("uses the routine index as the canonical overview URL", () => {
    renderSidebar();
    const overview = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "Overview",
    );
    expect(overview?.getAttribute("href")).toBe("/11111111-1111-4111-8111-111111111111/routines/r1");
  });
});
