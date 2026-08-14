import {
  validationDetails,
  type TaskExecutionRefMode,
  type JsonSchema,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { type ContextDial, type ContextRetrievalReachPolicy } from "./context-dial-resolver.js";
import { RuntimeToolArgumentsInvalid } from "./runtime-tool-errors.js";
import {
  type PaperclipManagedToolCommand,
  type PaperclipManagedToolCommandFor,
  type PaperclipManagedToolName,
} from "./paperclip-managed-tool-definitions.js";

export interface AgentCatalogEntry {
  id: string;
  name: string;
  capabilities: string | null;
}

export interface RuntimeAgentConfigureTarget {
  id: string;
}

export interface TaskCreateOwnerCatalogEntry extends AgentCatalogEntry {
  kind: "agent";
}

export interface TaskAssignOwnerCatalog {
  taskId: string;
  identifier: string;
  owners: readonly ({ kind: "self" } | TaskCreateOwnerCatalogEntry)[];
}

export interface CreatorUpdateTargetCatalogEntry {
  taskId: string;
}

/** Dynamic facts captured into one exact provider descriptor. */
export interface PaperclipManagedToolRuntimeProjectionInput {
  mode: TaskExecutionRefMode;
  contextDial: ContextDial;
  actionGrants: Readonly<Partial<Record<PaperclipActionKey, boolean>>>;
  isCurrentOwner: boolean;
  taskCreateDirectChildren: readonly TaskCreateOwnerCatalogEntry[];
  taskAssignTargets: readonly TaskAssignOwnerCatalog[];
  creatorUpdateTargets: readonly CreatorUpdateTargetCatalogEntry[];
  mentionTargets: readonly AgentCatalogEntry[];
  configureTargets: readonly RuntimeAgentConfigureTarget[];
}

export interface PaperclipRuntimeCommandScope {
  readonly companyId: string;
  readonly taskId: string;
  readonly targetAgentId: string;
}

export type PaperclipManagedToolLedgerMetadata =
  | { kind: "non_mention" }
  | {
      kind: "mention";
      toolName: "mention_agent" | "mention_board";
      targetAgentId: string | null;
    };

export interface RuntimePaperclipManagedToolCall {
  command: PaperclipManagedToolCommand;
  ledger: PaperclipManagedToolLedgerMetadata;
}

export interface ProjectedPaperclipManagedToolDescriptor {
  name: PaperclipManagedToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  source: "paperclip";
  availability: "work" | "both";
  normalizeRuntimeCommand(
    payload: unknown,
    scope: PaperclipRuntimeCommandScope,
  ): RuntimePaperclipManagedToolCall;
}

export interface RuntimeProjection<Name extends PaperclipManagedToolName> {
  inputSchema: JsonSchema;
  details?: string;
  normalize(payload: unknown, scope: PaperclipRuntimeCommandScope): PaperclipManagedToolCommandFor<Name>;
}

export function runtimeJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { $schema: _dialect, ...result } = toJsonSchemaCompat(schema as never);
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const record = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalize(nested)]),
    ) as Record<string, unknown>;
    // Paperclip's compiled ABI uses exclusive object forms. Preserve the
    // established descriptor bytes while deriving those forms from Zod.
    if (
      Array.isArray(record.anyOf) &&
      record.anyOf.every(
        (option) =>
          typeof option === "object" &&
          option !== null &&
          (option as Record<string, unknown>).type === "object",
      )
    ) {
      record.type = "object";
      record.oneOf = record.anyOf;
      delete record.anyOf;
    }
    if (record.type === "object" && record.properties && record.required === undefined) {
      record.required = [];
    }
    return record;
  };
  return normalize(result) as JsonSchema;
}

export function runtimeArguments<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new RuntimeToolArgumentsInvalid(
    validationDetails(parsed.error)
      .map((detail) => {
        const path = detail.path.length > 0 ? `${detail.path.join(".")}: ` : "";
        return `${path}${detail.message}`;
      })
      .join("; "),
  );
}

export function projection<Name extends PaperclipManagedToolName, Payload>(input: {
  schema: z.ZodType<Payload>;
  details?: string;
  normalize(payload: Payload, scope: PaperclipRuntimeCommandScope): PaperclipManagedToolCommandFor<Name>;
}): RuntimeProjection<Name> {
  return {
    inputSchema: runtimeJsonSchema(input.schema),
    ...(input.details ? { details: input.details } : {}),
    normalize(payload, scope) {
      return input.normalize(runtimeArguments(input.schema, payload), scope);
    },
  };
}

export const runtimeCursor = z
  .string()
  .min(1)
  .optional()
  .describe("Opaque bounded cursor returned by the preceding page.");

export function retrievalReachDescription(input: {
  prefix: string;
  reach: ContextRetrievalReachPolicy;
  taskIdMode: "optional" | "required" | null;
}): string {
  const tiers: string[] = [];
  if (input.reach.active) {
    tiers.push(
      input.taskIdMode === "optional"
        ? "the active task (omit taskId or pass it explicitly)"
        : input.taskIdMode === "required"
          ? "the active task through an explicit taskId"
          : "a run on the active task",
    );
  }
  if (input.reach.descendant) {
    tiers.push(
      input.taskIdMode
        ? "a proper descendant of the active task through an explicit taskId"
        : "a run on a proper descendant of the active task",
    );
  }
  if (input.reach.company) {
    tiers.push(
      input.taskIdMode
        ? "any task in this run's company through an explicit taskId"
        : "a run on any task in this run's company",
    );
  }
  return `${input.prefix} Authorized target tiers: ${tiers.join("; ")}.`;
}
