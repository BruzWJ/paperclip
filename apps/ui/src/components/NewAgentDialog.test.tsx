// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";

const navigateMock = vi.hoisted(() => vi.fn());
const closeNewAgentMock = vi.hoisted(() => vi.fn());
const openNewTaskMock = vi.hoisted(() => vi.fn());
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newAgentOpen: true,
    closeNewAgent: closeNewAgentMock,
    openNewTask: openNewTaskMock,
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogTitle: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("NewAgentDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens manual configuration directly on the new-agent page", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<NewAgentDialog />);
    });
    await flushReact();

    const configureButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) =>
      button.textContent?.startsWith("Configure an ACPX runtime manually"),
    );
    expect(configureButton).toBeTruthy();

    await act(async () => {
      configureButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(closeNewAgentMock).toHaveBeenCalledOnce();
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$companyId/agents/new",
      params: { companyId: COMPANY_ID },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("offers only canonical ACPX-backed creation choices", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<NewAgentDialog />);
    });
    await flushReact();

    expect(container.textContent).toContain("Add a new agent");
    expect(container.textContent).toContain(
      "Configure an ACPX runtime manually",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
