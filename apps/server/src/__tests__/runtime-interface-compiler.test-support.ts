import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  CANONICAL_UUID_RE,
  PAPERCLIP_ACTION_KEYS,
} from "@paperclipai/shared";
import { compileRuntimeInterface } from "../services/runtime-interface-compiler.ts";
import { RuntimeToolArgumentsInvalid } from "../services/runtime-tool-errors.ts";
import { resolveContextDial } from "../services/context-dial-resolver.ts";
import { PAPERCLIP_MANAGED_TOOL_METADATA } from "../services/paperclip-managed-tool-registry.ts";

export const COMMENT_PREFIX =
  "Reads one chronological bounded page of first-class Session comments. Authorized target tiers: ";
export const RUN_PREFIX =
  "Reads the delivered source message(s) and bounded provider-safe detailed turns for exactly one run selected by required runId. Authorized target tiers: ";
export const reachCases = [
  {
    current: false,
    descendant: false,
    company: false,
    commentTiers: "",
    runTiers: "",
  },
  {
    current: false,
    descendant: false,
    company: true,
    commentTiers: "any task in this run's company through an explicit taskId",
    runTiers: "a run on any task in this run's company",
  },
  {
    current: false,
    descendant: true,
    company: false,
    commentTiers: "a proper descendant of the active task through an explicit taskId",
    runTiers: "a run on a proper descendant of the active task",
  },
  {
    current: false,
    descendant: true,
    company: true,
    commentTiers:
      "a proper descendant of the active task through an explicit taskId; any task in this run's company through an explicit taskId",
    runTiers: "a run on a proper descendant of the active task; a run on any task in this run's company",
  },
  {
    current: true,
    descendant: false,
    company: false,
    commentTiers: "the active task (omit taskId or pass it explicitly)",
    runTiers: "a run on the active task",
  },
  {
    current: true,
    descendant: false,
    company: true,
    commentTiers:
      "the active task (omit taskId or pass it explicitly); any task in this run's company through an explicit taskId",
    runTiers: "a run on the active task; a run on any task in this run's company",
  },
  {
    current: true,
    descendant: true,
    company: false,
    commentTiers:
      "the active task (omit taskId or pass it explicitly); a proper descendant of the active task through an explicit taskId",
    runTiers: "a run on the active task; a run on a proper descendant of the active task",
  },
  {
    current: true,
    descendant: true,
    company: true,
    commentTiers:
      "the active task (omit taskId or pass it explicitly); a proper descendant of the active task through an explicit taskId; any task in this run's company through an explicit taskId",
    runTiers:
      "a run on the active task; a run on a proper descendant of the active task; a run on any task in this run's company",
  },
] as const;
export function compileInput(
  overrides: Partial<Parameters<typeof compileRuntimeInterface>[0]> = {},
): Parameters<typeof compileRuntimeInterface>[0] {
  return {
    mode: "owner",
    turn: "work",
    contextDial: resolveContextDial({ agent: {} }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    taskCreateDirectChildren: [],
    taskAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    configureTargets: [],
    pluginTools: [],
    ...overrides,
  };
}

const runtimeScope = {
  companyId: "company-1",
  taskId: "task-1",
  targetAgentId: "agent-1",
};

export function normalizeRuntimeCommand(
  descriptor: NonNullable<ReturnType<typeof compileRuntimeInterface>["descriptors"][number]> | undefined,
  payload: unknown,
) {
  if (!descriptor?.normalizeRuntimeCommand) {
    throw new Error(`Expected a canonical runtime projection for ${descriptor?.name}`);
  }
  return descriptor.normalizeRuntimeCommand(payload, runtimeScope);
}

export { describe, expect, it, AGENT_CONTEXT_GRANT_KEYS };
export { AGENT_MENTION_REACH_GRANT_KEYS, CANONICAL_UUID_RE, PAPERCLIP_ACTION_KEYS };
export { compileRuntimeInterface, RuntimeToolArgumentsInvalid, resolveContextDial };
export { PAPERCLIP_MANAGED_TOOL_METADATA };
