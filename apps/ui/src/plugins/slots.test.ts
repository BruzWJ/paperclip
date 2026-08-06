// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginUiContribution } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginSlotMount,
  _resetPluginModuleLoader,
  _registerPluginModuleExportsForTests,
  ensurePluginContributionLoaded,
  resolveRegisteredPluginComponent,
  type ResolvedPluginSlot,
} from "./slots";

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    flushSync(() => {
      root.unmount();
    });
  }
  roots = [];
  _resetPluginModuleLoader();
  delete globalThis.__paperclipPluginBridge__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("plugin slot export registration", () => {
  it("fails closed before fetching a plugin module when the host bridge is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(ensurePluginContributionLoaded({
      pluginId: "plugin-1",
      pluginKey: "acme.example",
      displayName: "Example",
      version: "1.0.0",
      updatedAt: "2026-08-05T00:00:00.000Z",
      slots: [],
      launchers: [],
    })).rejects.toThrow("Paperclip plugin UI bridge is not initialized");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to load UI module for plugin "acme.example"',
      expect.objectContaining({
        message: "Paperclip plugin UI bridge is not initialized; plugin modules cannot load.",
      }),
    );
  });

  it("updates an already-mounted placeholder when the slot export registers later", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const slot: ResolvedPluginSlot = {
      type: "routeSidebar",
      id: "content-machine-sidebar",
      displayName: "Content",
      exportName: "ContentMachineRouteSidebar",
      routePath: "content-machine",
      pluginId: "content-machine-plugin",
      pluginUpdatedAt: "2026-08-05T00:00:00.000Z",
      pluginKey: "content-machine",
      pluginDisplayName: "Content Machine",
    };

    flushSync(() => {
      root.render(createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(PluginSlotMount, {
          slot,
          context: { companyId: "company-1", companyPrefix: "PAP" },
          missingBehavior: "placeholder",
        }),
      ));
    });

    expect(container.textContent).toContain("Content Machine: Content");

    flushSync(() => {
      _registerPluginModuleExportsForTests({
        pluginId: "content-machine-plugin",
        pluginKey: "content-machine",
        displayName: "Content Machine",
        version: "1.0.0",
        updatedAt: "2026-08-05T00:00:00.000Z",
        slots: [{
          type: "routeSidebar",
          id: "content-machine-sidebar",
          displayName: "Content",
          exportName: "ContentMachineRouteSidebar",
          routePath: "content-machine",
        }],
        launchers: [],
      }, {
        ContentMachineRouteSidebar: () => createElement("div", { "data-testid": "content-machine-sidebar" }),
      });
    });

    expect(container.textContent).not.toContain("Content Machine: Content");
    expect(container.querySelector('[data-testid="content-machine-sidebar"]')).not.toBeNull();
  });

  it("rejects a module atomically when any declared export is missing", () => {
    const contribution: PluginUiContribution = {
      pluginId: "plugin-atomic",
      pluginKey: "acme.atomic",
      displayName: "Atomic",
      version: "1.0.0",
      updatedAt: "2026-08-05T00:00:00.000Z",
      slots: [
        {
          type: "sidebar",
          id: "valid",
          displayName: "Valid",
          exportName: "ValidPanel",
        },
        {
          type: "page",
          id: "missing",
          displayName: "Missing",
          exportName: "MissingPage",
          routePath: "atomic",
        },
      ],
      launchers: [],
    };
    const ValidPanel = () => null;

    expect(() => _registerPluginModuleExportsForTests(contribution, { ValidPanel })).toThrow(
      'Plugin "acme.atomic" declares UI export "MissingPage" but its module does not export it.',
    );
    expect(resolveRegisteredPluginComponent(
      contribution.pluginId,
      contribution.updatedAt,
      "ValidPanel",
    )).toBeNull();
  });

  it("rejects a declared export that is not a React component", () => {
    const contribution: PluginUiContribution = {
      pluginId: "plugin-invalid",
      pluginKey: "acme.invalid",
      displayName: "Invalid",
      version: "1.0.0",
      updatedAt: "2026-08-05T00:00:00.000Z",
      slots: [{
        type: "sidebarPanel",
        id: "panel",
        displayName: "Panel",
        exportName: "Panel",
      }],
      launchers: [],
    };

    expect(() => _registerPluginModuleExportsForTests(contribution, { Panel: "paperclip-panel" })).toThrow(
      'Plugin "acme.invalid" UI export "Panel" must be a React component.',
    );
    expect(resolveRegisteredPluginComponent(
      contribution.pluginId,
      contribution.updatedAt,
      "Panel",
    )).toBeNull();
  });

  it("never resolves a component registered for an older contribution revision", () => {
    const pluginId = "plugin-upgrade";
    const oldUpdatedAt = "2026-08-05T00:00:00.000Z";
    const newUpdatedAt = "2026-08-06T00:00:00.000Z";
    const OldPanel = () => null;
    const NewPanel = () => null;

    const contribution = (updatedAt: string): PluginUiContribution => ({
      pluginId,
      pluginKey: "acme.upgrade",
      displayName: "Upgrade",
      version: "1.0.0",
      updatedAt,
      slots: [{
        type: "sidebarPanel",
        id: "panel",
        displayName: "Panel",
        exportName: "Panel",
      }],
      launchers: [],
    });

    _registerPluginModuleExportsForTests(contribution(oldUpdatedAt), { Panel: OldPanel });
    expect(resolveRegisteredPluginComponent(pluginId, oldUpdatedAt, "Panel")?.component).toBe(OldPanel);
    expect(resolveRegisteredPluginComponent(pluginId, newUpdatedAt, "Panel")).toBeNull();

    _registerPluginModuleExportsForTests(contribution(newUpdatedAt), { Panel: NewPanel });
    expect(resolveRegisteredPluginComponent(pluginId, oldUpdatedAt, "Panel")?.component).toBe(OldPanel);
    expect(resolveRegisteredPluginComponent(pluginId, newUpdatedAt, "Panel")?.component).toBe(NewPanel);
  });
});
