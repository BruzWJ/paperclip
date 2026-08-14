// @vitest-environment jsdom

import { SidebarProvider } from "@/components/ui/sidebar";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarShell, SIDEBAR_RAIL_WIDTH } from "./SidebarShell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function TestShell(props: ComponentProps<typeof SidebarShell>) {
  return (
    <SidebarProvider open={!props.collapsed} className="contents">
      <SidebarShell {...props} />
    </SidebarProvider>
  );
}

function pointerEvent(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("SidebarShell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  const shell = () => container.querySelector<HTMLElement>("[data-sidebar-shell]")!;
  const sidebar = () => container.querySelector<HTMLElement>("[data-slot=sidebar]")!;
  const panel = () => container.querySelector<HTMLElement>("[data-slot=sidebar-container]")!;
  const handle = () => container.querySelector<HTMLElement>('[role="separator"]');

  it("uses, resizes, and persists the expanded width", () => {
    window.localStorage.setItem("test.sidebar.width", "320");
    act(() => {
      root.render(
        <TestShell open resizable storageKey="test.sidebar.width">
          Sidebar
        </TestShell>,
      );
    });
    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("320px");
    expect(handle()?.getAttribute("aria-valuenow")).toBe("320");

    handle()!.setPointerCapture = vi.fn();
    act(() => {
      handle()!.dispatchEvent(pointerEvent("pointerdown", 320));
      handle()!.dispatchEvent(pointerEvent("pointermove", 360));
      handle()!.dispatchEvent(pointerEvent("pointerup", 360));
    });
    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("360px");
    expect(window.localStorage.getItem("test.sidebar.width")).toBe("360");
  });

  it("supports accessible keyboard resizing and clamps its bounds", () => {
    act(() => {
      root.render(
        <TestShell open resizable storageKey="test.sidebar.width">
          Sidebar
        </TestShell>,
      );
    });
    act(() => handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("208px");
    act(() => handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(shell().style.getPropertyValue("--sidebar-width")).toBe("420px");
  });

  it("delegates icon collapse and suppresses resizing in the rail", () => {
    act(() => {
      root.render(
        <TestShell open collapsed resizable>
          Sidebar
        </TestShell>,
      );
    });
    expect(sidebar().getAttribute("data-state")).toBe("collapsed");
    expect(shell().style.getPropertyValue("--sidebar-width-icon")).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    expect(handle()).toBeNull();
  });

  it("hides the desktop shell when closed", () => {
    act(() => {
      root.render(<TestShell open={false}>Sidebar</TestShell>);
    });
    expect(shell().className).toContain("md:hidden");
  });

  it("expands as an overlay while peeking without changing provider state", () => {
    act(() => {
      root.render(
        <TestShell open collapsed peeking>
          Sidebar
        </TestShell>,
      );
    });
    expect(sidebar().getAttribute("data-state")).toBe("collapsed");
    expect(panel().getAttribute("data-sidebar-overlay")).toBe("");
    expect(panel().className).toContain("shadow-lg");
    expect(panel().className).toContain("z-30");
  });

  it("disables the primitive's width transition", () => {
    act(() => {
      root.render(<TestShell open>Sidebar</TestShell>);
    });
    expect(shell().className).toContain("transition-none");
  });
});
