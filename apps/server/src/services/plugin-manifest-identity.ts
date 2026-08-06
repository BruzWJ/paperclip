import { createHash } from "node:crypto";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Plugin manifest identity requires JSON values");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Exact identity of the validated manifest bound to one plugin runtime. */
export function pluginManifestIdentity(
  manifest: PaperclipPluginManifestV1,
): string {
  return createHash("sha256")
    .update("paperclip.plugin-manifest/v1\n", "utf8")
    .update(canonicalJson(manifest), "utf8")
    .digest("hex");
}
