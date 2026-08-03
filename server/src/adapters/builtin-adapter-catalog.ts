import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateServerAdapterModule,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { codexAdapter } from "./codex.js";

export interface BuiltInAdapterCatalogEntry {
  readonly adapterType: string;
  readonly adapter: ServerAdapterModule;
  readonly packageName: string;
  readonly packageRoot: string;
}

const adaptersRoot = path.dirname(fileURLToPath(import.meta.url));

function entry(input: BuiltInAdapterCatalogEntry):
  BuiltInAdapterCatalogEntry {
  if (input.adapterType !== input.adapter.type) {
    throw new Error(
      `Built-in adapter catalog type mismatch: ${input.adapterType}`,
    );
  }
  validateServerAdapterModule(input.adapter);
  return Object.freeze(input);
}

/**
 * The single built-in provider inventory. Registry selection, type
 * reservation, model exposure, implementation identity, and topology checks
 * all consume these exact entries rather than maintaining parallel lists.
 */
export const BUILTIN_ADAPTER_CATALOG = Object.freeze([
  entry({
    adapterType: "codex",
    adapter: codexAdapter,
    packageName: "@paperclipai/server",
    packageRoot: path.join(adaptersRoot, "codex.ts"),
  }),
] satisfies readonly BuiltInAdapterCatalogEntry[]);
