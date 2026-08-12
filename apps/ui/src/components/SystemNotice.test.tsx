// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return <a href={href}>{children}</a>;
  },
}));

import { SystemNotice } from "./SystemNotice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe("SystemNotice", () => {
  it("renders the warning tone label and body in a single status container", () => {
    const node = render(
      <SystemNotice
        tone="warning"
        body="Paperclip needs a disposition before this task can continue."
      />,
    );

    const status = node.querySelectorAll('[role="status"]');
    expect(status.length).toBe(1);
    expect(status[0]?.getAttribute("aria-label")).toBe("System warning");
    expect(node.textContent).toContain(
      "Paperclip needs a disposition before this task can continue.",
    );
  });

  it("uses System alert label for danger tone", () => {
    const node = render(
      <SystemNotice tone="danger" body="Recovery escalated to Architect." />,
    );

    const status = node.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("System alert");
  });

  it("uses neutral System notice label by default", () => {
    const node = render(
      <SystemNotice tone="neutral" body="Reassigned to ClaudeFixer." />,
    );

    const status = node.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("System notice");
  });

  it("collapses metadata details by default and toggles aria-expanded on click", () => {
    const node = render(
      <SystemNotice
        tone="warning"
        body="Needs a disposition."
        metadata={[
          {
            title: "Required action",
            rows: [
              {
                kind: "task",
                label: "Source task",
                taskNumber: 3440,
                identifier: "PAP-3440",
                link: true,
              },
            ],
          },
        ]}
      />,
    );

    const button = node.querySelector("button[aria-expanded]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-controls")).not.toBeNull();
    expect(node.textContent).not.toContain("PAP-3440");

    act(() => {
      (button as HTMLButtonElement).click();
    });

    const reopened = node.querySelector("button[aria-expanded]");
    expect(reopened?.getAttribute("aria-expanded")).toBe("true");
    expect(node.textContent).toContain("PAP-3440");
  });

  it("renders metadata expanded when detailsDefaultOpen is true", () => {
    const node = render(
      <SystemNotice
        tone="warning"
        body="Needs a disposition."
        detailsDefaultOpen
        metadata={[
          {
            rows: [{ kind: "text", label: "Suggested action", value: "Pick a disposition" }],
          },
        ]}
      />,
    );

    const button = node.querySelector("button[aria-expanded]");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(node.textContent).toContain("Suggested action");
    expect(node.textContent).toContain("Pick a disposition");
  });

  it("hides the details affordance when no metadata is provided", () => {
    const node = render(<SystemNotice tone="warning" body="Short notice." />);

    expect(node.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("renders typed metadata rows with native route targets when present", () => {
    const node = render(
      <SystemNotice
        tone="danger"
        body="Recovery blocked"
        detailsDefaultOpen
        metadata={[
          {
            rows: [
              {
                kind: "task",
                label: "Recovery task",
                taskNumber: 3440,
                identifier: "PAP-3440",
                link: true,
                title: "Disposition recovery",
              },
              {
                kind: "agent",
                label: "Owner",
                name: "Architect",
                agentId: "223e4567-e89b-42d3-a456-426614174000",
              },
              {
                kind: "run",
                label: "Source run",
                runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
                agentId: "323e4567-e89b-42d3-a456-426614174000",
                status: "succeeded",
              },
            ],
          },
        ]}
      />,
    );

    const links = Array.from(node.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toContain("/11111111-1111-4111-8111-111111111111/tasks/3440");
    expect(links).toContain("/11111111-1111-4111-8111-111111111111/agents/223e4567-e89b-42d3-a456-426614174000");
    expect(links).toContain("/11111111-1111-4111-8111-111111111111/agents/323e4567-e89b-42d3-a456-426614174000/runs/9cdba892-c7ca-4d93-8604-4843873b127c");
    expect(node.textContent).toContain("PAP-3440");
    expect(node.textContent).toContain("Disposition recovery");
    expect(node.textContent).toContain("Architect");
    expect(node.textContent).toContain("succeeded");
  });

  it("renders metadata link rows as plain text when route targets are missing", () => {
    const node = render(
      <SystemNotice
        tone="neutral"
        body="Reassigned"
        detailsDefaultOpen
        metadata={[
          {
            rows: [
              { kind: "agent", label: "Reassigned to", name: "ClaudeFixer" },
              { kind: "run", label: "Run", runId: "abc12345" },
              {
                kind: "task",
                label: "Task",
                taskNumber: null,
                identifier: "PAP-1",
              },
            ],
          },
        ]}
      />,
    );

    expect(node.querySelectorAll("a").length).toBe(0);
    expect(node.textContent).toContain("ClaudeFixer");
    expect(node.textContent).toContain("abc12345");
    expect(node.textContent).toContain("PAP-1");
  });
});
