import { type Db } from "@paperclipai/db";
import { TaskSession } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";
import type { TaskExecutionAcpEventSink } from "./task-execution-attempt-executor.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import { lockTaskSessionProjectionRoot } from "./task-session/event-store.js";
import {
  beginPromptPublication,
  publishToolEvent,
} from "./task-execution-acp-events-postgres-part-2.js";
import { readRunStreamPartProjection } from "./task-execution-run-stream.js";
import {
  lockCurrentPrompt,
  publicationRedactor,
  reject,
} from "./task-execution-acp-events-postgres-part-1.js";

/**
 * Sole provider-neutral productive/consult ACP update projector. Every durable
 * write re-locks the exact run/ref/segment, attempt, lease, and capability.
 */
export function createPostgresTaskExecutionAcpEventSink(options: {
  readonly database: Db;
  readonly runService: Pick<TaskExecutionRunService, "lockRun">;
  readonly now?: () => Date;
}): TaskExecutionAcpEventSink {
  const now = options.now ?? (() => new Date());
  return {
    async publish(input) {
      return options.database.transaction(async (transaction) => {
        const timestamp = now();
        if (!Number.isFinite(timestamp.getTime())) {
          reject("ACP event timestamp is invalid");
        }
        await lockTaskSessionProjectionRoot(transaction, {
          companyId: input.prompt.companyId,
          taskId: input.prompt.taskId,
          sessionId: input.prompt.sessionId,
        });
        await lockCurrentPrompt(
          transaction,
          options.runService,
          input.prompt,
          input.capability,
          timestamp,
        );
        const redactor = publicationRedactor(input.redactor.redactText);
        const publication = await beginPromptPublication(transaction, {
          prompt: input.prompt,
          capability: input.capability,
          redactor,
          timestamp,
        });
        if (input.event.kind === "message_chunk") {
          if (input.event.content.type !== "text") {
            reject("ACP assistant/thought output must be a text content block");
          }
          const text = redactSensitiveText(
            input.redactor.redactText(input.event.content.text),
          );
          const partOrdinal = publication.nextSourceOrdinal;
          if (input.event.channel === "assistant") {
            const textId = `text_${input.prompt.attemptId}_${partOrdinal}`;
            await publication.publish(TaskSession.Event.Text.Started.type, {
              timestamp: timestamp.getTime(),
              sessionID: input.prompt.sessionId,
              assistantMessageID: publication.assistantMessageId,
              textID: textId,
            });
            await publication.publish(TaskSession.Event.Text.Ended.type, {
              timestamp: timestamp.getTime(),
              sessionID: input.prompt.sessionId,
              assistantMessageID: publication.assistantMessageId,
              textID: textId,
              text,
            });
            return readRunStreamPartProjection(
              transaction,
              input.prompt,
              publication.assistantMessageId,
              textId,
            );
          }
          const reasoningId = `reasoning_${input.prompt.attemptId}_${partOrdinal}`;
          await publication.publish(TaskSession.Event.Reasoning.Started.type, {
            timestamp: timestamp.getTime(),
            sessionID: input.prompt.sessionId,
            assistantMessageID: publication.assistantMessageId,
            reasoningID: reasoningId,
          });
          await publication.publish(TaskSession.Event.Reasoning.Ended.type, {
            timestamp: timestamp.getTime(),
            sessionID: input.prompt.sessionId,
            assistantMessageID: publication.assistantMessageId,
            reasoningID: reasoningId,
            text,
          });
          return readRunStreamPartProjection(
            transaction,
            input.prompt,
            publication.assistantMessageId,
            reasoningId,
          );
        }
        if (
          input.event.kind !== "tool_call" &&
          input.event.kind !== "tool_call_update"
        ) {
          reject("unsupported ACP productive session update");
        }
        await publishToolEvent(
          transaction,
          publication,
          input.prompt,
          input.event,
          input.redactor.redactText,
        );
        return readRunStreamPartProjection(
          transaction,
          input.prompt,
          publication.assistantMessageId,
          input.event.toolCallId,
        );
      });
    },
  };
}
export {
  PostgresTaskExecutionAcpEventRejected,
  canonicalPaperclipMcpToolName,
  projectedAcpToolName,
} from "./task-execution-acp-events-postgres-part-1.js";
