import type { PluginLauncherDeclaration, PluginUiContribution } from "@paperclipai/shared";
import * as ReactModule from "react";
import { useEffect, useState, type ComponentType } from "react";

import {
  registerPluginReactComponents,
  resetPluginComponentRegistry,
  type PluginSlotComponentProps,
} from "./plugin-component-registry";

type PluginLoadState = "loading" | "loaded" | "error";

const pluginLoadStates = new Map<string, PluginLoadState>();
const pluginLoadErrors = new Map<string, string>();
const inflightImports = new Map<string, Promise<void>>();
const shimBlobUrls: Record<string, string> = {};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function buildPluginModuleKey(contribution: PluginUiContribution): string {
  return `${contribution.pluginId}:${contribution.updatedAt}`;
}

function buildPluginUiUrl(contribution: PluginUiContribution): string {
  const cacheHint = encodeURIComponent(contribution.updatedAt);
  return `/_plugins/${encodeURIComponent(contribution.pluginId)}/ui/index.js?v=${cacheHint}`;
}

function applyJsxRuntimeKey(
  props: Record<string, unknown> | null | undefined,
  key: string | number | undefined,
): Record<string, unknown> {
  if (key === undefined) return props ?? {};
  return { ...(props ?? {}), key };
}

export function createBridgeModuleShimSource(
  module: object,
  bridgeExpression: string,
  missingMessage: string,
): string {
  const hasDefaultExport = Object.prototype.hasOwnProperty.call(module, "default");
  const exportNames = Object.keys(module)
    .filter((name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name))
    .sort();
  const namedExports = exportNames.map((name) => `        export const ${name} = M.${name};`).join("\n");

  return `
        const M = ${bridgeExpression};
        if (!M) {
          throw new Error(${JSON.stringify(missingMessage)});
        }
${hasDefaultExport ? "        export default M.default;" : ""}
${namedExports}
      `;
}

function getShimBlobUrl(
  specifier: "react" | "react-dom" | "react-dom/client" | "react/jsx-runtime" | "sdk-ui",
): string {
  if (shimBlobUrls[specifier]) return shimBlobUrls[specifier];

  let source: string;
  switch (specifier) {
    case "react":
      source = createBridgeModuleShimSource(
        ReactModule,
        "globalThis.__paperclipPluginBridge__?.react",
        "Paperclip plugin React runtime is not initialized.",
      );
      break;
    case "react/jsx-runtime":
      source = `
        const R = globalThis.__paperclipPluginBridge__?.react;
        if (!R) {
          throw new Error("Paperclip plugin React runtime is not initialized.");
        }
        const withKey = ${applyJsxRuntimeKey.toString()};
        export const jsx = (type, props, key) => R.createElement(type, withKey(props, key));
        export const jsxs = (type, props, key) => R.createElement(type, withKey(props, key));
        export const Fragment = R.Fragment;
      `;
      break;
    case "react-dom":
      if (!globalThis.__paperclipPluginBridge__?.reactDom) {
        throw new Error("Paperclip plugin ReactDOM runtime is not initialized.");
      }
      source = createBridgeModuleShimSource(
        globalThis.__paperclipPluginBridge__.reactDom as object,
        "globalThis.__paperclipPluginBridge__?.reactDom",
        "Paperclip plugin ReactDOM runtime is not initialized.",
      );
      break;
    case "react-dom/client":
      if (!globalThis.__paperclipPluginBridge__?.reactDomClient) {
        throw new Error("Paperclip plugin ReactDOM client runtime is not initialized.");
      }
      source = createBridgeModuleShimSource(
        globalThis.__paperclipPluginBridge__.reactDomClient as object,
        "globalThis.__paperclipPluginBridge__?.reactDomClient",
        "Paperclip plugin ReactDOM client runtime is not initialized.",
      );
      break;
    case "sdk-ui":
      if (!globalThis.__paperclipPluginBridge__?.sdkUi) {
        throw new Error("Paperclip plugin SDK UI runtime is not initialized.");
      }
      source = createBridgeModuleShimSource(
        globalThis.__paperclipPluginBridge__.sdkUi,
        "globalThis.__paperclipPluginBridge__?.sdkUi",
        "Paperclip plugin SDK UI runtime is not initialized.",
      );
      break;
  }

  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  shimBlobUrls[specifier] = url;
  return url;
}

export function rewriteBareSpecifiers(source: string): string {
  const rewrites: Record<string, string> = {
    '"@paperclipai/plugin-sdk/ui"': `"${getShimBlobUrl("sdk-ui")}"`,
    "'@paperclipai/plugin-sdk/ui'": `'${getShimBlobUrl("sdk-ui")}'`,
    '"react/jsx-runtime"': `"${getShimBlobUrl("react/jsx-runtime")}"`,
    "'react/jsx-runtime'": `'${getShimBlobUrl("react/jsx-runtime")}'`,
    '"react-dom/client"': `"${getShimBlobUrl("react-dom/client")}"`,
    "'react-dom/client'": `'${getShimBlobUrl("react-dom/client")}'`,
    '"react-dom"': `"${getShimBlobUrl("react-dom")}"`,
    "'react-dom'": `'${getShimBlobUrl("react-dom")}'`,
    '"react"': `"${getShimBlobUrl("react")}"`,
    "'react'": `'${getShimBlobUrl("react")}'`,
  };

  let result = source;
  for (const [from, to] of Object.entries(rewrites)) {
    result = result.replaceAll(` from ${from}`, ` from ${to}`);
    result = result.replaceAll(`import ${from}`, `import ${to}`);
  }
  return result;
}

async function importPluginModule(url: string): Promise<Record<string, unknown>> {
  if (!globalThis.__paperclipPluginBridge__) {
    throw new Error("Paperclip plugin UI bridge is not initialized; plugin modules cannot load.");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch plugin module: ${response.status} ${response.statusText}`);
  }

  const rewritten = rewriteBareSpecifiers(await response.text());
  const blob = new Blob([rewritten], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function isLauncherComponentTarget(launcher: PluginLauncherDeclaration): boolean {
  return (
    launcher.action.type === "openModal" ||
    launcher.action.type === "openDrawer" ||
    launcher.action.type === "openPopover"
  );
}

export function registerPluginModuleExports(
  contribution: PluginUiContribution,
  mod: Record<string, unknown>,
): void {
  const declaredExports = new Set<string>();
  for (const slot of contribution.slots) declaredExports.add(slot.exportName);
  for (const launcher of contribution.launchers) {
    if (isLauncherComponentTarget(launcher)) {
      declaredExports.add(launcher.action.target);
    }
  }

  const components: Array<readonly [string, ComponentType<PluginSlotComponentProps>]> = [];
  for (const exportName of declaredExports) {
    const exported = mod[exportName];
    if (exported === undefined) {
      throw new Error(
        `Plugin "${contribution.pluginKey}" declares UI export "${exportName}" but its module does not export it.`,
      );
    }
    if (typeof exported !== "function") {
      throw new Error(
        `Plugin "${contribution.pluginKey}" UI export "${exportName}" must be a React component.`,
      );
    }
    components.push([exportName, exported as ComponentType<PluginSlotComponentProps>]);
  }

  registerPluginReactComponents(contribution.pluginId, contribution.updatedAt, components);
}

async function loadPluginModule(contribution: PluginUiContribution): Promise<void> {
  const moduleKey = buildPluginModuleKey(contribution);
  const state = pluginLoadStates.get(moduleKey);
  if (state === "loaded") return;

  const inflight = inflightImports.get(moduleKey);
  if (inflight) {
    await inflight;
    return;
  }

  pluginLoadStates.set(moduleKey, "loading");
  pluginLoadErrors.delete(moduleKey);
  const url = buildPluginUiUrl(contribution);

  const importPromise = (async () => {
    try {
      const mod = await importPluginModule(url);
      registerPluginModuleExports(contribution, mod);
      pluginLoadStates.set(moduleKey, "loaded");
    } catch (error) {
      pluginLoadStates.set(moduleKey, "error");
      pluginLoadErrors.set(moduleKey, getErrorMessage(error));
      console.error(`Failed to load UI module for plugin "${contribution.pluginKey}"`, error);
      throw error;
    } finally {
      inflightImports.delete(moduleKey);
    }
  })();

  inflightImports.set(moduleKey, importPromise);
  await importPromise;
}

async function ensurePluginModulesLoaded(contributions: PluginUiContribution[]): Promise<void> {
  await Promise.all(contributions.map((item) => loadPluginModule(item)));
}

export async function ensurePluginContributionLoaded(contribution: PluginUiContribution): Promise<void> {
  await loadPluginModule(contribution);
}

export function pluginModulesAreSettled(contributions: PluginUiContribution[]): boolean {
  return contributions.every((contribution) => {
    const state = pluginLoadStates.get(buildPluginModuleKey(contribution));
    return state !== "loading" && state !== undefined;
  });
}

export function aggregatePluginLoadError(contributions: PluginUiContribution[]): string | null {
  const failures = contributions.flatMap((contribution) => {
    const message = pluginLoadErrors.get(buildPluginModuleKey(contribution));
    return message ? [`${contribution.displayName}: ${message}`] : [];
  });
  return failures.length > 0 ? failures.join("; ") : null;
}

export function usePluginModuleLoader(contributions: PluginUiContribution[] | undefined): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!contributions || contributions.length === 0) return;
    const unloaded = contributions.filter((contribution) => {
      const state = pluginLoadStates.get(buildPluginModuleKey(contribution));
      return state !== "loaded" && state !== "loading";
    });
    if (unloaded.length === 0) return;

    let cancelled = false;
    const finish = () => {
      if (!cancelled) setTick((tick) => tick + 1);
    };
    void ensurePluginModulesLoaded(unloaded).then(finish, finish);
    return () => {
      cancelled = true;
    };
  }, [contributions]);
}

export function resetPluginModuleLoader(): void {
  pluginLoadStates.clear();
  pluginLoadErrors.clear();
  inflightImports.clear();
  resetPluginComponentRegistry();
  if (typeof URL.revokeObjectURL === "function") {
    for (const url of Object.values(shimBlobUrls)) URL.revokeObjectURL(url);
  }
  for (const key of Object.keys(shimBlobUrls)) delete shimBlobUrls[key];
}
