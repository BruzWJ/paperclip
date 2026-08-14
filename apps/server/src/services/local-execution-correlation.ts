import { createHash } from "node:crypto";

/**
 * Native ACP sessions remain fenced to their immutable adapter revision even
 * though the physical execution target is now unconditionally local.
 */
export function localExecutionCorrelationFingerprint(adapterConfigRevisionId: string): string {
  if (adapterConfigRevisionId.length === 0 || adapterConfigRevisionId !== adapterConfigRevisionId.trim()) {
    throw new Error("Adapter configuration revision id must be exact and non-empty");
  }
  return createHash("sha256")
    .update(`paperclip.local-execution/v1\0${adapterConfigRevisionId}`, "utf8")
    .digest("hex");
}
