import type { ToolCallContent } from "@agentclientprotocol/sdk";

export class InvalidAcpToolOutput extends Error {
  readonly code = "invalid_acp_tool_output";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAcpToolOutput";
  }
}
type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object>,
  stripMetadata: boolean,
): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidAcpToolOutput("ACP tool output contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidAcpToolOutput("ACP tool output is not JSON-compatible");
  }
  if (ancestors.has(value)) {
    throw new InvalidAcpToolOutput("ACP tool output contains a cycle");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const result: CanonicalJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new InvalidAcpToolOutput("ACP tool output contains a sparse array");
      }
      result.push(canonicalJsonValue(value[index], nextAncestors, stripMetadata));
    }
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidAcpToolOutput("ACP tool output contains a non-JSON object");
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(record).sort(codeUnitCompare)) {
    if (stripMetadata && key === "_meta") continue;
    result[key] = canonicalJsonValue(
      record[key],
      nextAncestors,
      stripMetadata,
    );
  }
  return result;
}

function canonicalJson(value: unknown, stripMetadata = false): string {
  return JSON.stringify(canonicalJsonValue(value, new Set(), stripMetadata));
}

function everyNestedText(
  content: readonly ToolCallContent[],
): content is readonly (Extract<ToolCallContent, { type: "content" }> & {
  readonly content: { readonly type: "text"; readonly text: string };
})[] {
  return content.every(
    (entry) =>
      entry.type === "content" &&
      entry.content.type === "text" &&
      typeof entry.content.text === "string",
  );
}

/**
 * Produces the one full, untruncated sourceOutputText used by the canonical
 * Session tool-state projection and inspection. Inputs must already have
 * passed publication redaction; this function performs no provider-specific
 * interpretation.
 */
export function normalizeAcpToolOutput(input: {
  readonly rawOutput?: unknown;
  readonly content?: readonly ToolCallContent[] | null;
}): string {
  if (input.rawOutput !== undefined) {
    return typeof input.rawOutput === "string"
      ? input.rawOutput
      : canonicalJson(input.rawOutput);
  }
  const content = input.content;
  if (!content || content.length === 0) return "";
  if (everyNestedText(content)) {
    return content.map((entry) => entry.content.text).join("\n");
  }
  return canonicalJson(content, true);
}
