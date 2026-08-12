// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "lucide-react";
import { SidebarNavItem, SidebarNavExpandedProvider } from "./SidebarNavItem";
import { TooltipProvider } from "@/components/ui/tooltip";

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: () => {},
  collapsed: false,
  peeking: false,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params: _params, className, activeProps: _activeProps, inactiveProps, activeOptions: _activeOptions, state: _state, ...props }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
    activeProps?: { className?: string };
    inactiveProps?: { className?: string };
    activeOptions?: unknown;
    state?: unknown;
  }) => {
    return (
      <a href={to} className={[className, inactiveProps?.className].filter(Boolean).join(" ")} {...props}>
        {children}
      </a>
    );
  },
}));

const inboxLinkOptions = {
  to: "/$companyId/inbox",
  params: { companyId: "11111111-1111-4111-8111-111111111111" },
} as const;

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarNavItem", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sidebarState.collapsed = false;
    sidebarState.peeking = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function render(node: ReactNode) {
    act(() => {
      root.render(<TooltipProvider>{node}</TooltipProvider>);
    });
  }

  function link() {
    return container.querySelector("a") as HTMLAnchorElement;
  }

  function classTokens(element: Element | null | undefined) {
    return element?.className.toString().split(/\s+/).filter(Boolean) ?? [];
  }

  it("shows the full label and numeric badge when expanded", () => {
    render(<SidebarNavItem linkOptions={inboxLinkOptions} label="Inbox" icon={Inbox} badge={28} badgeLabel="unread" />);

    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Inbox");
    expect(label?.className).not.toContain("sr-only");
    // The numeric badge is rendered in full (not a dot) and no rail aria-label is set.
    expect(container.textContent).toContain("28");
    expect(link().getAttribute("aria-label")).toBeNull();
  });

  it("clips the label (kept in flow for 1:1 row height) and collapses the badge to a dot in the rail", () => {
    sidebarState.collapsed = true;
    render(<SidebarNavItem linkOptions={inboxLinkOptions} label="Inbox" icon={Inbox} badge={28} badgeLabel="unread" />);

    // The label stays in the DOM/a11y tree (not display:none) so screen readers
    // still announce it. Unlike sr-only it is kept IN FLOW (zero-width, clipped,
    // transparent) so it still contributes its line-height — that keeps the row
    // exactly as tall as the expanded state, so the icon never shifts (PAP-10676).
    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Inbox");
    expect(label).toBeTruthy();
    expect(label?.className).not.toContain("sr-only");
    expect(classTokens(label)).toContain("w-0");
    expect(classTokens(label)).toContain("overflow-hidden");

    // The numeric count is no longer rendered as text; it is a dot with an
    // accessible text equivalent on the link.
    expect(container.textContent).not.toContain("28 ");
    expect(link().getAttribute("aria-label")).toBe("Inbox, 28 unread");

    // Tooltip wraps the row; the trigger is the wrapper element so the Link's
    // own flex className is preserved (PAP-10676), with the <a> nested inside it.
    expect(link().parentElement?.getAttribute("data-slot")).toBe("tooltip-trigger");
  });

  it("surfaces the trailing status label in the rail aria-label", () => {
    sidebarState.collapsed = true;
    render(
      <SidebarNavItem
        linkOptions={{
          to: "/$companyId/agents/$agentId",
          params: { companyId: "11111111-1111-4111-8111-111111111111", agentId: "codexcoder" },
        }}
        label="CodexCoder"
        icon={Inbox}
        trailing={<span aria-label="Invalid reporting chain" />}
        trailingLabel="Invalid reporting chain"
      />,
    );

    // The trailing warning is hidden in the rail, so its text equivalent must
    // ride on the link's accessible name.
    expect(link().getAttribute("aria-label")).toBe("CodexCoder, Invalid reporting chain");
  });

  it("keeps the full presentation while peeking even when collapsed", () => {
    sidebarState.collapsed = true;
    sidebarState.peeking = true;
    render(<SidebarNavItem linkOptions={inboxLinkOptions} label="Inbox" icon={Inbox} badge={28} badgeLabel="unread" />);

    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Inbox");
    expect(label?.className).not.toContain("sr-only");
    expect(container.textContent).toContain("28");
    expect(link().getAttribute("aria-label")).toBeNull();
  });

  it("forces the full label inside an expanded contextual pane even when globally collapsed", () => {
    // The takeover model collapses the global sidebar (collapsed=true) while the
    // 240px SecondarySidebar still needs readable labels (PAP-10700). The
    // provider must override the global rail collapse.
    sidebarState.collapsed = true;
    render(
      <SidebarNavExpandedProvider>
        <SidebarNavItem linkOptions={inboxLinkOptions} label="Inbox" icon={Inbox} badge={28} badgeLabel="unread" />
      </SidebarNavExpandedProvider>,
    );

    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Inbox");
    expect(classTokens(label)).not.toContain("w-0");
    expect(classTokens(label)).toContain("flex-1");
    // Full numeric badge, no rail aria-label, no tooltip wrapper.
    expect(container.textContent).toContain("28");
    expect(link().getAttribute("aria-label")).toBeNull();
    expect(link().parentElement?.getAttribute("data-slot")).not.toBe("tooltip-trigger");
  });

  it("surfaces the live count in the rail aria-label", () => {
    sidebarState.collapsed = true;
    render(
      <SidebarNavItem
        linkOptions={{ to: "/$companyId/dashboard", params: { companyId: "11111111-1111-4111-8111-111111111111" } }}
        label="Dashboard"
        icon={Inbox}
        liveCount={3}
      />,
    );

    expect(link().getAttribute("aria-label")).toBe("Dashboard, 3 live");
  });
});
