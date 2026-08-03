import type {
  ContentBlock,
  PlanEntry,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { AcpTerminalOccupancy } from "./contract.js";

export interface AcpLivePlanEntry {
  readonly content: string;
  readonly priority: "high" | "medium" | "low";
  readonly status: "pending" | "in_progress" | "completed";
}

export type NormalizedAcpSessionEvent =
  | {
      readonly kind: "message_chunk";
      readonly channel: "assistant" | "thought";
      readonly content: ContentBlock;
    }
  | {
      readonly kind: "user_message_echo";
      readonly content: ContentBlock;
    }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind?: ToolKind;
      readonly status?: ToolCallStatus;
      readonly content?: readonly ToolCallContent[];
      readonly locations?: readonly ToolCallLocation[];
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
    }
  | {
      readonly kind: "tool_call_update";
      readonly toolCallId: string;
      readonly title?: string | null;
      readonly toolKind?: ToolKind | null;
      readonly status?: ToolCallStatus | null;
      readonly content?: readonly ToolCallContent[] | null;
      readonly locations?: readonly ToolCallLocation[] | null;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
    }
  | { readonly kind: "plan"; readonly entries: readonly AcpLivePlanEntry[] }
  | ({ readonly kind: "usage" } & AcpTerminalOccupancy)
  | { readonly kind: "mode"; readonly currentModeId: string }
  | {
      readonly kind: "config_options";
      readonly configOptions: readonly unknown[];
    }
  | {
      readonly kind: "session_info";
      readonly title?: string | null;
      readonly updatedAt?: string | null;
    }
  | {
      readonly kind: "available_commands";
      readonly availableCommands: readonly unknown[];
    };

export class InvalidAcpSessionUpdate extends Error {
  readonly code = "invalid_acp_session_update";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAcpSessionUpdate";
  }
}

function stripMeta<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripMeta(entry)) as T;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "_meta")
      .map(([key, entry]) => [key, stripMeta(entry)]),
  ) as T;
}

function exactPlanEntry(entry: PlanEntry): AcpLivePlanEntry {
  return Object.freeze({
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  });
}

function requireUsageNumber(
  value: number,
  label: string,
  options: { positive?: boolean } = {},
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < (options.positive ? 1 : 0)
  ) {
    throw new InvalidAcpSessionUpdate(`${label} is invalid`);
  }
  return value;
}

/**
 * Converts stable ACP session updates into one provider-neutral Paperclip
 * stream. Experimental named-plan updates are rejected rather than mapped to
 * the stable anonymous full-replacement plan contract.
 */
export function normalizeAcpSessionUpdate(
  notification: SessionNotification,
): NormalizedAcpSessionEvent {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return {
        kind: "user_message_echo",
        content: stripMeta(update.content),
      };
    case "agent_message_chunk":
      return {
        kind: "message_chunk",
        channel: "assistant",
        content: stripMeta(update.content),
      };
    case "agent_thought_chunk":
      return {
        kind: "message_chunk",
        channel: "thought",
        content: stripMeta(update.content),
      };
    case "tool_call":
      return {
        kind: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        ...(update.kind === undefined ? {} : { toolKind: update.kind }),
        ...(update.status === undefined ? {} : { status: update.status }),
        ...(update.content === undefined
          ? {}
          : { content: stripMeta(update.content) }),
        ...(update.locations === undefined
          ? {}
          : { locations: stripMeta(update.locations) }),
        ...(update.rawInput === undefined
          ? {}
          : { rawInput: stripMeta(update.rawInput) }),
        ...(update.rawOutput === undefined
          ? {}
          : { rawOutput: stripMeta(update.rawOutput) }),
      };
    case "tool_call_update":
      return {
        kind: "tool_call_update",
        toolCallId: update.toolCallId,
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.kind === undefined ? {} : { toolKind: update.kind }),
        ...(update.status === undefined ? {} : { status: update.status }),
        ...(update.content === undefined
          ? {}
          : { content: stripMeta(update.content) }),
        ...(update.locations === undefined
          ? {}
          : { locations: stripMeta(update.locations) }),
        ...(update.rawInput === undefined
          ? {}
          : { rawInput: stripMeta(update.rawInput) }),
        ...(update.rawOutput === undefined
          ? {}
          : { rawOutput: stripMeta(update.rawOutput) }),
      };
    case "plan":
      return {
        kind: "plan",
        entries: Object.freeze(update.entries.map(exactPlanEntry)),
      };
    case "plan_update":
    case "plan_removed":
      throw new InvalidAcpSessionUpdate(
        `Unsupported experimental ACP update: ${update.sessionUpdate}`,
      );
    case "usage_update": {
      const used = requireUsageNumber(update.used, "ACP usage used");
      const size = requireUsageNumber(update.size, "ACP usage size", {
        positive: true,
      });
      if (used > size) {
        throw new InvalidAcpSessionUpdate(
          "ACP usage used exceeds the context window size",
        );
      }
      const cost = update.cost
        ? {
            amount: update.cost.amount,
            currency: update.cost.currency,
          }
        : null;
      // Cost validity and company-currency matching are accounting concerns.
      // A malformed or mismatched optional cost must not erase an otherwise
      // valid stop-plus-occupancy settlement.
      return { kind: "usage", used, size, cost };
    }
    case "current_mode_update":
      return { kind: "mode", currentModeId: update.currentModeId };
    case "config_option_update":
      return {
        kind: "config_options",
        configOptions: stripMeta(update.configOptions),
      };
    case "session_info_update":
      return {
        kind: "session_info",
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.updatedAt === undefined
          ? {}
          : { updatedAt: update.updatedAt }),
      };
    case "available_commands_update":
      return {
        kind: "available_commands",
        availableCommands: stripMeta(update.availableCommands),
      };
  }
  throw new InvalidAcpSessionUpdate("Unsupported ACP session update");
}
