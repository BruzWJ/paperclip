import {
  issueSessionCompactionControls,
  type Db,
} from "@paperclipai/db";
import type { IssueSessionMessage } from "@paperclipai/shared/issue-session";
import * as IssueSession from "@paperclipai/shared/issue-session";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  IssueSessionLifecycleConflict,
} from "./store.js";

/** The sole provider-visible replacement for an actively pruned tool result. */
export const PRUNED_TOOL_RESULT_PLACEHOLDER =
  "[Old tool result content cleared]";

export interface ActiveIssueSessionPruneScope {
  companyId: string;
  issueId: string;
  sessionId: string;
  historyScopeKind: "turns-recovery" | "comments-recovery";
  historyScopeId: string;
  audience: "turns" | "comments";
  sourceHighWaterSeq: number;
}

export type ActiveIssueSessionPruneEffects = ReadonlySet<string>;

export function issueSessionPrunedToolKey(
  assistantMessageId: string,
  toolId: string,
): string {
  return `${assistantMessageId}\0${toolId}`;
}

/**
 * Resolves the only controls that may alter a model-facing lowerer. Durable
 * `time.pruned` remains audit metadata; it is intentionally not an input to
 * this selector so a scalar timestamp can never hide a result by itself.
 */
export async function loadActiveIssueSessionPruneEffects(
  db: Db,
  scope: ActiveIssueSessionPruneScope,
): Promise<ActiveIssueSessionPruneEffects> {
  const effects = new Set<string>();
  let afterId: string | null = null;
  do {
    const page = await db
      .select({
        id: issueSessionCompactionControls.id,
        assistantMessageId:
          issueSessionCompactionControls.assistantMessageId,
        toolId: issueSessionCompactionControls.toolId,
      })
      .from(issueSessionCompactionControls)
      .where(
        and(
          eq(issueSessionCompactionControls.companyId, scope.companyId),
          eq(issueSessionCompactionControls.issueId, scope.issueId),
          eq(issueSessionCompactionControls.sessionId, scope.sessionId),
          eq(issueSessionCompactionControls.kind, "tool-pruned"),
          eq(issueSessionCompactionControls.disposition, "active"),
          eq(
            issueSessionCompactionControls.historyScopeKind,
            scope.historyScopeKind,
          ),
          eq(
            issueSessionCompactionControls.historyScopeId,
            scope.historyScopeId,
          ),
          eq(issueSessionCompactionControls.audience, scope.audience),
          eq(
            issueSessionCompactionControls.sourceHighWaterSeq,
            scope.sourceHighWaterSeq,
          ),
          ...(afterId
            ? [gt(issueSessionCompactionControls.id, afterId)]
            : []),
        ),
      )
      .orderBy(asc(issueSessionCompactionControls.id))
      .limit(500);
    for (const row of page) {
      if (!row.assistantMessageId || !row.toolId) {
        throw new IssueSessionLifecycleConflict(
          "Active tool-pruned control has no canonical assistant/tool identity",
          {
            sessionId: scope.sessionId,
            historyScopeKind: scope.historyScopeKind,
            historyScopeId: scope.historyScopeId,
          },
        );
      }
      effects.add(
        issueSessionPrunedToolKey(row.assistantMessageId, row.toolId),
      );
    }
    afterId = page.length === 500 ? page.at(-1)!.id : null;
  } while (afterId !== null);
  return effects;
}

/**
 * Produces an ephemeral model-lowering clone. The canonical V2 row, its
 * source companion, and every audit/read-run projection remain untouched.
 */
export function lowerIssueSessionMessageForActivePruneEffects(
  message: IssueSessionMessage,
  effects: ActiveIssueSessionPruneEffects,
): IssueSessionMessage {
  if (message.type !== "assistant" || effects.size === 0) return message;

  let changed = false;
  const content = message.content.map((part) => {
    if (
      part.type !== "tool" ||
      !effects.has(issueSessionPrunedToolKey(message.id, part.id))
    ) {
      return part;
    }
    if (part.state.status !== "completed") {
      throw new IssueSessionLifecycleConflict(
        "Active tool-pruned control targets a non-completed assistant tool",
        { assistantMessageId: message.id, toolId: part.id },
      );
    }
    changed = true;
    const { provider, ...tool } = part;
    return {
      ...tool,
      ...(provider
        ? {
            provider: {
              executed: provider.executed,
              ...(provider.metadata
                ? { metadata: provider.metadata }
                : {}),
            },
          }
        : {}),
      state: {
        status: "completed" as const,
        input: part.state.input,
        structured: {},
        content: [
          {
            type: "text" as const,
            text: PRUNED_TOOL_RESULT_PLACEHOLDER,
          },
        ],
      },
    };
  });
  return changed
    ? IssueSession.Message.Assistant.make({ ...message, content })
    : message;
}

export function lowerIssueSessionMessagesForActivePruneEffects(
  messages: readonly IssueSessionMessage[],
  effects: ActiveIssueSessionPruneEffects,
): readonly IssueSessionMessage[] {
  return messages.map((message) =>
    lowerIssueSessionMessageForActivePruneEffects(message, effects),
  );
}
