import type {
  PluginJsonValue,
  PluginToolStructuredData,
  ToolResult,
} from "./types.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPluginJsonValue(
  value: unknown,
  ancestors: Set<object>,
): value is PluginJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = true;
    for (const item of value) {
      if (!isPluginJsonValue(item, ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = isPlainRecord(value)
      && Object.values(value).every((item) => isPluginJsonValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function decodeStructuredData(value: unknown): PluginToolStructuredData {
  if (!isPlainRecord(value) || !isPluginJsonValue(value, new Set())) {
    throw new Error("Invalid plugin ToolResult: data must be a JSON object");
  }
  return value as PluginToolStructuredData;
}

/** Decode the one canonical plugin-tool result crossing worker, ledger, and MCP boundaries. */
export function decodeToolResult(value: unknown): ToolResult {
  if (!isPlainRecord(value)) {
    throw new Error("Invalid plugin ToolResult: expected an object");
  }
  if (typeof value.ok !== "boolean") {
    throw new Error("Invalid plugin ToolResult: ok must be true or false");
  }

  const allowedKeys = value.ok
    ? new Set(["ok", "content", "data"])
    : new Set(["ok", "error", "data"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid plugin ToolResult: unexpected fields");
  }

  const data = Object.prototype.hasOwnProperty.call(value, "data")
    ? decodeStructuredData(value.data)
    : undefined;

  if (value.ok) {
    if (typeof value.content !== "string") {
      throw new Error("Invalid plugin ToolResult: successful results require string content");
    }
    return {
      ok: true,
      content: value.content,
      ...(data === undefined ? {} : { data }),
    };
  }

  if (typeof value.error !== "string") {
    throw new Error("Invalid plugin ToolResult: failed results require a string error");
  }
  return {
    ok: false,
    error: value.error,
    ...(data === undefined ? {} : { data }),
  };
}
