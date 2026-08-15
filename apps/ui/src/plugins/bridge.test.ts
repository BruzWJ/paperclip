// @vitest-environment jsdom
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { MouseEvent as ReactMouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTree as SdkFileTree,
  ManagedRoutinesList as SdkManagedRoutinesList,
  MarkdownBlock as SdkMarkdownBlock,
  MarkdownEditor as SdkMarkdownEditor,
  type FileTreeNode as SdkFileTreeNode,
} from "../../../../packages/plugins/sdk/src/ui/components";
import { SidebarProvider, useSidebar } from "@/context/SidebarContext";
import {
  PluginBridgeContext,
  serializePluginBridgeParams,
  shouldHandleHostNavigationClick,
  useHostNavigation,
  type PluginBridgeContextValue,
} from "./bridge";
import { resolvePluginNavigationHref } from "@paperclipai/shared";
import { initPluginBridge } from "./bridge-init";
import {
  createBridgeModuleShimSource,
  rewriteBareSpecifiers,
} from "./slots";

const routerNavigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerNavigate,
  useLocation: () => ({
    pathname: "/11111111-1111-4111-8111-111111111111/wiki",
    searchStr: "",
    hash: "",
  }),
}));

vi.mock("@/features/markdown/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

function clickEvent(
  overrides: Partial<ReactMouseEvent<HTMLAnchorElement>> = {},
): ReactMouseEvent<HTMLAnchorElement> {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    currentTarget: {
      hasAttribute: () => false,
    },
    ...overrides,
  } as ReactMouseEvent<HTMLAnchorElement>;
}

afterEach(() => {
  delete globalThis.__paperclipPluginBridge__;
});

function act(callback: () => void) {
  flushSync(callback);
}

describe("plugin host navigation", () => {
  it("resolves plugin page routes into the active company UUID", () => {
    expect(resolvePluginNavigationHref("/wiki", "11111111-1111-4111-8111-111111111111")).toBe(
      "/11111111-1111-4111-8111-111111111111/wiki",
    );
    expect(
      resolvePluginNavigationHref(
        "/wiki?tab=browse#page",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toBe(
      "/11111111-1111-4111-8111-111111111111/wiki?tab=browse#page",
    );
    expect(() => resolvePluginNavigationHref("/wiki", "not-a-uuid")).toThrow(
      "requires a canonical company UUID",
    );
  });

  it("rejects pre-scoped plugin paths so the host has one navigation contract", () => {
    expect(() => resolvePluginNavigationHref(
      "/11111111-1111-4111-8111-111111111111/wiki",
      "11111111-1111-4111-8111-111111111111",
    )).toThrow(
      "absolute company-relative path",
    );
    expect(() => resolvePluginNavigationHref(
      "/22222222-2222-4222-8222-222222222222/wiki",
      "11111111-1111-4111-8111-111111111111",
    )).toThrow(
      "absolute company-relative path",
    );
  });

  it("intercepts only same-origin plain left-click navigation", () => {
    expect(shouldHandleHostNavigationClick(
      clickEvent(),
      "/11111111-1111-4111-8111-111111111111/wiki",
    )).toBe(true);
    expect(
      shouldHandleHostNavigationClick(
        clickEvent({ ctrlKey: true }),
        "/11111111-1111-4111-8111-111111111111/wiki",
      ),
    ).toBe(false);
    expect(
      shouldHandleHostNavigationClick(
        clickEvent(),
        "/11111111-1111-4111-8111-111111111111/wiki",
        "_blank",
      ),
    ).toBe(false);
    expect(
      shouldHandleHostNavigationClick(clickEvent(), "https://example.com/wiki"),
    ).toBe(false);
  });
});

describe("plugin bridge parameter serialization", () => {
  it("canonicalizes nested object keys recursively", () => {
    expect(serializePluginBridgeParams({
      z: [{ beta: 2, alpha: 1 }],
      a: { two: true, one: false },
    })).toBe(serializePluginBridgeParams({
      a: { one: false, two: true },
      z: [{ alpha: 1, beta: 2 }],
    }));
  });

  it("distinguishes nested keys and values", () => {
    const baseline = serializePluginBridgeParams({ query: { taskId: "task-1" } });
    expect(serializePluginBridgeParams({ query: { taskId: "task-2" } })).not.toBe(baseline);
    expect(serializePluginBridgeParams({ query: { runId: "task-1" } })).not.toBe(baseline);
  });

  it("rejects circular and non-JSON values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializePluginBridgeParams(circular)).toThrow("circular references");
    expect(() => serializePluginBridgeParams({ value: undefined })).toThrow("undefined values");
    expect(() => serializePluginBridgeParams({ value: new Date() })).toThrow("plain objects");
  });
});

describe("useHostNavigation mobile drawer behavior", () => {
  // React 19's `act` requires the env flag and React DOM client.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  function makeBridgeValue(): PluginBridgeContextValue {
    return {
      pluginId: "test-plugin",
      hostContext: {
        companyId: "11111111-1111-4111-8111-111111111111",
        projectId: null,
        entityId: null,
        entityType: null,
        userId: null,
        renderEnvironment: null,
      },
    };
  }

  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
    if (typeof window.matchMedia !== "function") {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: /max-width:\s*767px/.test(query) ? width < 768 : false,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }),
      });
    }
  }

  it("closes the sidebar drawer on mobile after a same-origin navigate()", () => {
    setViewport(390);

    let nav: ReturnType<typeof useHostNavigation> | null = null;
    let sidebar: ReturnType<typeof useSidebar> | null = null;
    function Probe() {
      nav = useHostNavigation();
      sidebar = useSidebar();
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(
          SidebarProvider,
          null,
          React.createElement(
            PluginBridgeContext.Provider,
            { value: makeBridgeValue() },
            React.createElement(
              Probe,
            ),
          ),
        ),
      );
    });

    expect(sidebar!.isMobile).toBe(true);
    act(() => sidebar!.setSidebarOpen(true));
    expect(sidebar!.sidebarOpen).toBe(true);

    act(() => nav!.navigate("/wiki?section=ingest"));
    expect(sidebar!.sidebarOpen).toBe(false);
    expect(routerNavigate).toHaveBeenCalledWith({
      href: "/11111111-1111-4111-8111-111111111111/wiki?section=ingest",
      replace: undefined,
      state: undefined,
    });

    act(() => root.unmount());
    container.remove();
  });

  it("leaves the sidebar open on desktop after navigate()", () => {
    setViewport(1280);

    let nav: ReturnType<typeof useHostNavigation> | null = null;
    let sidebar: ReturnType<typeof useSidebar> | null = null;
    function Probe() {
      nav = useHostNavigation();
      sidebar = useSidebar();
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        React.createElement(
          SidebarProvider,
          null,
          React.createElement(
            PluginBridgeContext.Provider,
            { value: makeBridgeValue() },
            React.createElement(
              Probe,
            ),
          ),
        ),
      );
    });

    expect(sidebar!.isMobile).toBe(false);
    expect(sidebar!.sidebarOpen).toBe(true);

    act(() => nav!.navigate("/wiki?section=ingest"));
    expect(sidebar!.sidebarOpen).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});

describe("plugin SDK FileTree bridge", () => {
  const nodes: SdkFileTreeNode[] = [
    {
      name: "wiki",
      path: "wiki",
      kind: "dir",
      children: [
        {
          name: "index.md",
          path: "wiki/index.md",
          kind: "file",
          children: [],
        },
      ],
    },
  ];

  it("injects the host FileTree implementation through the bridge runtime", () => {
    initPluginBridge(React, ReactDOM, ReactDOMClient);

    const html = renderToStaticMarkup(
      React.createElement(SdkFileTree, {
        nodes,
        expandedPaths: ["wiki"],
        selectedFile: "wiki/index.md",
        onToggleDir: () => undefined,
        onSelectFile: () => undefined,
      }),
    );

    expect(html).toContain('role="tree"');
    expect(html).toContain("wiki");
    expect(html).toContain("index.md");
  });

});

describe("plugin SDK markdown component bridge", () => {
  it("injects markdown display and editor components through the bridge runtime", () => {
    initPluginBridge(React, ReactDOM, ReactDOMClient);

    const registry = globalThis.__paperclipPluginBridge__?.sdkUi;
    expect(registry?.MarkdownBlock).toBeTypeOf("function");
    expect(registry?.MarkdownEditor).toBeTypeOf("function");
    expect(registry?.TasksList).toBeTypeOf("function");
    expect(registry?.OwnerPicker).toBeTypeOf("function");
    expect(registry?.ProjectPicker).toBeTypeOf("function");
    expect(registry?.ManagedRoutinesList).toBeTypeOf("function");
  });

  it("renders plugin-provided markdown components when registered by the host", () => {
    initPluginBridge(React, ReactDOM, ReactDOMClient);
    globalThis.__paperclipPluginBridge__ = {
      ...globalThis.__paperclipPluginBridge__!,
      sdkUi: {
        ...globalThis.__paperclipPluginBridge__!.sdkUi,
        MarkdownBlock: ({ content, enableWikiLinks, wikiLinkRoot }: { content: string; enableWikiLinks?: boolean; wikiLinkRoot?: string }) =>
          React.createElement("article", {
            "data-wiki-links": enableWikiLinks ? "true" : "false",
            "data-wiki-root": wikiLinkRoot,
          }, content),
        MarkdownEditor: ({ value }: { value: string }) =>
          React.createElement("textarea", { value, readOnly: true }),
        ManagedRoutinesList: ({ routines }: { routines: Array<{ title: string }> }) =>
          React.createElement("section", null, routines.map((routine) => routine.title).join(", ")),
      },
    };

    const markdownHtml = renderToStaticMarkup(React.createElement(SdkMarkdownBlock, {
      content: "# Wiki",
      enableWikiLinks: true,
      wikiLinkRoot: "/wiki/page",
    }));
    expect(markdownHtml).toContain("# Wiki");
    expect(markdownHtml).toContain('data-wiki-links="true"');
    expect(markdownHtml).toContain('data-wiki-root="/wiki/page"');
    expect(renderToStaticMarkup(React.createElement(SdkMarkdownEditor, { value: "# Wiki", onChange: () => undefined }))).toContain("# Wiki");
    expect(renderToStaticMarkup(React.createElement(SdkManagedRoutinesList, {
      routines: [{ key: "lint", title: "Run lint", status: "active" }],
    }))).toContain("Run lint");
  });
});

describe("plugin React shim", () => {
  it.each([
    ["React", React, "globalThis.__paperclipPluginBridge__?.react"],
    ["ReactDOM", ReactDOM, "globalThis.__paperclipPluginBridge__?.reactDom"],
    ["ReactDOM client", ReactDOMClient, "globalThis.__paperclipPluginBridge__?.reactDomClient"],
  ])("re-exports every named export from the host %s module", (_name, module, bridgeExpression) => {
    const source = createBridgeModuleShimSource(
      module,
      bridgeExpression,
      "missing",
    );

    for (const name of Object.keys(module).sort()) {
      if (name === "default") continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      expect(source).toContain(`export const ${name} = M.${name};`);
    }

    expect(source).toContain("export default M.default;");
  });

  it("rewrites only the canonical plugin SDK UI subpath", () => {
    initPluginBridge(React, ReactDOM, ReactDOMClient);
    const canonical = 'import { usePluginData } from "@paperclipai/plugin-sdk/ui";';
    const nonCanonicalSpecifiers = [
      'import { usePluginData } from "@paperclipai/plugin-sdk";',
      'import { usePluginData } from "@paperclipai/plugin-sdk/ui/hooks";',
      'import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui/types";',
    ];

    expect(rewriteBareSpecifiers(canonical)).not.toContain('from "@paperclipai/plugin-sdk/ui"');
    for (const source of nonCanonicalSpecifiers) {
      expect(rewriteBareSpecifiers(source)).toBe(source);
    }
  });

  it("re-exports the exact canonical SDK UI runtime without a default or component fallbacks", () => {
    const sdkUi = {
      useHostContext: () => null,
      MetricCard: () => null,
    };
    const source = createBridgeModuleShimSource(
      sdkUi,
      "globalThis.__paperclipPluginBridge__?.sdkUi",
      "missing",
    );

    expect(source).toContain("export const MetricCard = M.MetricCard;");
    expect(source).toContain("export const useHostContext = M.useHostContext;");
    expect(source).not.toContain("export default");
    expect(source).not.toContain("fallback");
    expect(source).not.toContain("MissingPaperclipSdkUiComponent");
  });
});
