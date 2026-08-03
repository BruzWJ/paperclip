import { BUILTIN_ADAPTER_CATALOG } from "./builtin-adapter-catalog.js";

/** Conformance-approved declarative ACP backends shipped with Paperclip. */
export const BUILTIN_ADAPTER_TYPES = new Set(
  BUILTIN_ADAPTER_CATALOG.map((entry) => entry.adapterType),
);
