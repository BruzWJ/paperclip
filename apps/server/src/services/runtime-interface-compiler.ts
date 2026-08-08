import { createHash } from "node:crypto";
import {
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  isMcpToolName,
  type AgentMentionReachGrantKey,
  type IssueExecutionRefMode,
  type JsonSchema,
} from "@paperclipai/shared";
import {
  PAPERCLIP_MANAGED_TOOL_NAMES,
  projectPaperclipManagedTools,
  type PaperclipManagedToolRuntimeProjectionInput,
  type PaperclipRuntimeCommandScope,
  type RuntimePaperclipManagedToolCall,
} from "./paperclip-managed-tool-registry.js";
import {
  RuntimeInterfaceConflict,
  RuntimeToolArgumentsInvalid,
} from "./runtime-tool-errors.js";
import { validateJsonSchemaValue } from "./plugin-config-validator.js";

const PAPERCLIP_RUNTIME_TOOL_NAMES = [
  ...PAPERCLIP_MANAGED_TOOL_NAMES,
  "restore_session",
] as const;

export type PaperclipRuntimeToolName =
  (typeof PAPERCLIP_RUNTIME_TOOL_NAMES)[number];

export type RuntimeToolSource = "paperclip" | "plugin";

export interface CompiledRunToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  source: RuntimeToolSource;
  /** Server-only declaration that this tool may run during a bootstrap turn. */
  bootstrapEnabled?: boolean;
  /** Server-only immutable installation identity for a direct plugin tool. */
  pluginInstallationId?: string;
  /** Server-only exact manifest identity compiled with this declaration. */
  pluginManifestIdentity?: string;
  /** Server-only bare manifest tool name dispatched to that installation. */
  pluginToolName?: string;
  /**
   * Server-only runtime projection supplied by the canonical managed-tool
   * registry. It validates the dynamic descriptor contract and produces one
   * authority-bound command; the provider never receives this function.
   */
  normalizeRuntimeCommand?: (
    value: unknown,
    scope: PaperclipRuntimeCommandScope,
  ) => RuntimePaperclipManagedToolCall;
  /**
   * Server-only validator for non-registry tools such as plugins and recovery.
   * Paperclip-managed descriptors use `normalizeRuntimeCommand` instead so
   * their raw payload is normalized exactly once.
   */
  validateArguments?: (value: unknown) => unknown;
}

/** A tool declared by a ready administrator-installed plugin. */
export interface RuntimePluginTool {
  installationId: string;
  manifestIdentity: string;
  /** Provider-visible, plugin-key namespaced tool name. */
  name: string;
  /** Bare manifest declaration name used only for worker dispatch. */
  toolName: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Opt-in bootstrap availability from the signed plugin manifest. */
  bootstrapEnabled?: boolean;
}

export interface RuntimeInterfaceCompileInput
  extends PaperclipManagedToolRuntimeProjectionInput {
  mentionReachGrants?: Readonly<
    Partial<Record<AgentMentionReachGrantKey, boolean>>
  >;
  /** Ready plugin tools are host-managed and available to every agent. */
  pluginTools: readonly RuntimePluginTool[];
  /**
   * A direct target-not-found replacement may expose one recovery-only
   * reader. It is derived from canonical attempts at compile time, never a
   * persisted provider/session mode.
   */
  restoreSession?: boolean;
}

interface CompiledRuntimeInterface {
  mode: IssueExecutionRefMode;
  descriptors: readonly CompiledRunToolDescriptor[];
  byName: ReadonlyMap<string, CompiledRunToolDescriptor>;
}

export interface RestoreSessionArguments {
  runId?: string;
  cursor?: string;
}

function restoreRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeToolArgumentsInvalid("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function restoreOptionalString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeToolArgumentsInvalid(`${name} must be a non-empty string`);
  }
  return value;
}

export function parseRestoreSessionArguments(
  value: unknown,
): RestoreSessionArguments {
  const input = restoreRecord(value);
  const unknown = Object.keys(input).filter(
    (key) => key !== "runId" && key !== "cursor",
  );
  if (unknown.length > 0) {
    throw new RuntimeToolArgumentsInvalid(
      `Unsupported tool arguments: ${unknown.join(", ")}`,
    );
  }
  const runId = restoreOptionalString(input.runId, "runId");
  const cursor = restoreOptionalString(input.cursor, "cursor");
  if (cursor && !runId) {
    throw new RuntimeToolArgumentsInvalid(
      "runId is required when continuing a restored run trace",
    );
  }
  return { ...(runId ? { runId } : {}), ...(cursor ? { cursor } : {}) };
}

function pluginDescriptors(
  tools: readonly RuntimePluginTool[],
): CompiledRunToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: "plugin",
    pluginInstallationId: tool.installationId,
    pluginManifestIdentity: tool.manifestIdentity,
    pluginToolName: tool.toolName,
    bootstrapEnabled: tool.bootstrapEnabled === true,
    validateArguments(argumentsValue) {
      const validation = validateJsonSchemaValue(
        argumentsValue,
        tool.inputSchema,
      );
      if (!validation.valid) {
        throw new RuntimeToolArgumentsInvalid(
          `Invalid arguments for ${tool.name}: ${validation.errors
            ?.map((error) => `${error.field} ${error.message}`)
            .join("; ") ?? "schema validation failed"}`,
        );
      }
      return argumentsValue;
    },
  }));
}

function recoveryDescriptors(
  input: RuntimeInterfaceCompileInput,
): CompiledRunToolDescriptor[] {
  if (input.restoreSession !== true) return [];
  return [{
    name: "restore_session",
    title: "Restore prior session history",
    description:
      "Returns the exact read_issue_agent_run result for each prior run by this agent in the current issue, excluding the current trigger run. To continue one trace, provide its runId and nextCursor. Available only during this recovery bootstrap.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        cursor: {
          type: "string",
          minLength: 1,
          description: "Opaque bounded cursor returned by the preceding page.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    source: "paperclip",
    bootstrapEnabled: true,
    validateArguments: parseRestoreSessionArguments,
  }];
}

function validateCompileInput(input: RuntimeInterfaceCompileInput): void {
  for (const key of PAPERCLIP_ACTION_KEYS) {
    if (
      input.actionGrants[key] !== undefined &&
      typeof input.actionGrants[key] !== "boolean"
    ) {
      throw new RuntimeInterfaceConflict(`Invalid action grant value for ${key}`);
    }
  }
  for (const key of AGENT_MENTION_REACH_GRANT_KEYS) {
    if (
      input.mentionReachGrants?.[key] !== undefined &&
      typeof input.mentionReachGrants[key] !== "boolean"
    ) {
      throw new RuntimeInterfaceConflict(
        `Invalid mention reach grant value for ${key}`,
      );
    }
  }
}

/**
 * Compiler responsibility is deliberately narrow: select the canonical
 * registry projections, add host-owned recovery/plugin descriptors, and
 * verify a closed provider interface. Raw Paperclip action schemas and
 * parsers live solely with their registry definitions.
 */
export function compileRuntimeInterface(
  input: RuntimeInterfaceCompileInput,
): CompiledRuntimeInterface {
  validateCompileInput(input);
  const descriptors: CompiledRunToolDescriptor[] = [
    ...projectPaperclipManagedTools(input),
    ...recoveryDescriptors(input),
    ...pluginDescriptors(input.pluginTools),
  ];
  const byName = new Map<string, CompiledRunToolDescriptor>();
  for (const descriptor of descriptors) {
    if (!isMcpToolName(descriptor.name)) {
      throw new RuntimeInterfaceConflict(
        `Compiled tool name is not provider-safe: ${descriptor.name}`,
      );
    }
    if (
      descriptor.source !== "paperclip" &&
      (PAPERCLIP_RUNTIME_TOOL_NAMES as readonly string[]).includes(
        descriptor.name,
      )
    ) {
      throw new RuntimeInterfaceConflict(
        `External tool collides with Paperclip tool: ${descriptor.name}`,
      );
    }
    if (byName.has(descriptor.name)) {
      throw new RuntimeInterfaceConflict(
        `Duplicate compiled tool name: ${descriptor.name}`,
      );
    }
    byName.set(descriptor.name, descriptor);
  }
  return {
    mode: input.mode,
    descriptors: Object.freeze(descriptors),
    byName,
  };
}

function canonicalDescriptorJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeInterfaceConflict(
        "Runtime descriptor contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDescriptorJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new RuntimeInterfaceConflict(
      "Runtime descriptor contains a non-JSON value",
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalDescriptorJson(record[key])}`,
    )
    .join(",")}}`;
}

/**
 * Stable server-authority digest shared by pre-activation prompt resolution
 * and the active capability gateway. Projection functions are deliberately
 * excluded; their provider-visible schema and immutable catalogs are the
 * call-time contract.
 */
function compiledRuntimeInterfaceDigest(
  compiled: CompiledRuntimeInterface,
): string {
  const contract = {
    mode: compiled.mode,
    descriptors: compiled.descriptors.map((descriptor) => ({
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      source: descriptor.source,
      pluginInstallationId: descriptor.pluginInstallationId,
      pluginManifestIdentity: descriptor.pluginManifestIdentity,
      pluginToolName: descriptor.pluginToolName,
      bootstrapEnabled: descriptor.bootstrapEnabled,
    })),
  };
  return createHash("sha256")
    .update("paperclip.runtime-interface/v1\n", "utf8")
    .update(canonicalDescriptorJson(contract), "utf8")
    .digest("hex");
}

export function runtimeInterfaceDigest(
  input: RuntimeInterfaceCompileInput,
): string {
  return compiledRuntimeInterfaceDigest(compileRuntimeInterface(input));
}
