import { createHash } from "node:crypto";
import {
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  isMcpToolName,
  type AgentMentionReachGrantKey,
  type TaskExecutionRefMode,
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

const PAPERCLIP_RUNTIME_TOOL_NAMES = PAPERCLIP_MANAGED_TOOL_NAMES;

export type PaperclipRuntimeToolName =
  (typeof PAPERCLIP_RUNTIME_TOOL_NAMES)[number];

export type RuntimeToolSource = "paperclip" | "plugin";
export type RuntimeToolTurn = "bootstrap" | "work";
type RuntimeToolAvailability = RuntimeToolTurn | "both";

export interface CompiledRunToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  source: RuntimeToolSource;
  /** Server-only turn boundary; never exposed in the provider descriptor. */
  availability: RuntimeToolAvailability;
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
   * Server-only validator for non-registry tools such as plugins.
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
  /** Exact provider turn derived from the current execution ref. */
  turn: RuntimeToolTurn;
  mentionReachGrants?: Readonly<
    Partial<Record<AgentMentionReachGrantKey, boolean>>
  >;
  /** Ready plugin tools are host-managed and available to every agent. */
  pluginTools: readonly RuntimePluginTool[];
}

interface CompiledRuntimeInterfaceContract {
  mode: TaskExecutionRefMode;
  descriptors: readonly CompiledRunToolDescriptor[];
}

interface CompiledRuntimeInterface extends CompiledRuntimeInterfaceContract {
  byName: ReadonlyMap<string, CompiledRunToolDescriptor>;
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
    availability: tool.bootstrapEnabled === true ? "both" : "work",
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

function validateCompileInput(input: RuntimeInterfaceCompileInput): void {
  if (input.turn !== "bootstrap" && input.turn !== "work") {
    throw new RuntimeInterfaceConflict("Invalid runtime tool turn");
  }
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
 * registry projections, add host-owned plugin descriptors, and
 * verify a closed provider interface. Raw Paperclip action schemas and
 * parsers live solely with their registry definitions.
 */
function compileRuntimeInterfaceContract(
  input: RuntimeInterfaceCompileInput,
): CompiledRuntimeInterfaceContract {
  validateCompileInput(input);
  const descriptors: CompiledRunToolDescriptor[] = [
    ...projectPaperclipManagedTools(input),
    ...pluginDescriptors(input.pluginTools),
  ];
  const names = new Set<string>();
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
    if (names.has(descriptor.name)) {
      throw new RuntimeInterfaceConflict(
        `Duplicate compiled tool name: ${descriptor.name}`,
      );
    }
    if (descriptor.inputSchema.type !== "object") {
      throw new RuntimeInterfaceConflict(
        `Compiled tool input schema is not an object: ${descriptor.name}`,
      );
    }
    names.add(descriptor.name);
  }
  return {
    mode: input.mode,
    descriptors: Object.freeze(descriptors),
  };
}

export function compileRuntimeInterface(
  input: RuntimeInterfaceCompileInput,
): CompiledRuntimeInterface {
  const contract = compileRuntimeInterfaceContract(input);
  const descriptors = contract.descriptors.filter(
    (descriptor) =>
      descriptor.availability === input.turn ||
      descriptor.availability === "both",
  );
  return {
    mode: contract.mode,
    descriptors,
    byName: new Map(
      descriptors.map((descriptor) => [descriptor.name, descriptor]),
    ),
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
  compiled: CompiledRuntimeInterfaceContract,
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
      availability: descriptor.availability,
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
