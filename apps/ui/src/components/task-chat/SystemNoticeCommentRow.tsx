import { Message, MessageContent, MessageResponse, MessageToolbar } from "@/components/ai-elements/message";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import {
  mapCommentMetadataToSystemNoticeSections,
  systemNoticeLabelForTone,
} from "@/lib/system-notice-comment";
import { formatDateTime } from "@/lib/utils";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Link } from "@tanstack/react-router";
import { useContext } from "react";
import type { TaskChatMessage } from "../../lib/task-chat-messages";

import type { SystemNoticeMetadataRow } from "../SystemNotice";
import { TaskChatMessageActionBar } from "./TaskChatMessageActionBar";
import {
  getThreadMessageCopyText,
  isTaskCommentMetadata,
  isTaskCommentPresentation,
  TaskChatCtx,
} from "./TaskChatShared";
import { taskChatMessageCustom } from "./TaskChatMessageUtils";

export interface SystemNoticeCommentRowProps {
  message: TaskChatMessage;
  anchorId?: string;
}

function MetadataValue({ row, companyId }: { row: SystemNoticeMetadataRow; companyId: string }) {
  if (row.kind === "text") return <span>{row.value}</span>;
  if (row.kind === "code") return <code>{row.value}</code>;
  if (row.kind === "task") {
    const label = [row.identifier ?? "Task unavailable", row.title].filter(Boolean).join(" — ");
    return row.link && row.taskNumber !== null ? (
      <Link to="/$companyId/tasks/$taskNumber" params={{ companyId, taskNumber: String(row.taskNumber) }}>
        {label}
      </Link>
    ) : (
      <span>{label}</span>
    );
  }
  if (row.kind === "agent") {
    return row.agentId ? (
      <Link to="/$companyId/agents/$agentId" params={{ companyId, agentId: row.agentId }}>
        {row.name}
      </Link>
    ) : (
      <span>{row.name}</span>
    );
  }
  return row.agentId ? (
    <Link
      to="/$companyId/agents/$agentId/runs/$runId"
      params={{ companyId, agentId: row.agentId, runId: row.runId }}
    >
      {row.status ? `${row.status} · ` : ""}
      {row.runId}
    </Link>
  ) : (
    <span>
      {row.status ? `${row.status} · ` : ""}
      {row.runId}
    </span>
  );
}

/** A system-authored transcript entry composed only from AI Elements surfaces. */
export function SystemNoticeCommentRow({ message, anchorId }: SystemNoticeCommentRowProps) {
  const { agentMap, onImageClick } = useContext(TaskChatCtx);
  const routeCompanyId = useCompanyRouteId();
  const custom = taskChatMessageCustom(message);
  const presentation = isTaskCommentPresentation(custom.presentation) ? custom.presentation : null;
  const metadata = isTaskCommentMetadata(custom.commentMetadata) ? custom.commentMetadata : null;
  const tone = presentation?.tone ?? "neutral";
  const label = systemNoticeLabelForTone(tone, presentation?.title);
  const body = getThreadMessageCopyText(message);
  const runAgentId = typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgent = runAgentId ? agentMap?.get(runAgentId) : null;
  const companyId = routeCompanyId;
  const sections = mapCommentMetadataToSystemNoticeSections(metadata, { runAgentId });
  const sourceLabel = runAgent?.name ?? "Paperclip";

  return (
    <Message from="assistant" role="status" aria-label={label}>
      <MessageContent
        onClick={(event) => {
          const target = event.target;
          if (target instanceof HTMLImageElement && target.src) onImageClick?.(target.src);
        }}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{label}</span>
          <span aria-hidden="true">·</span>
          {runAgent && runId ? (
            <Link
              to="/$companyId/agents/$agentId/runs/$runId"
              params={{ companyId, agentId: runAgent.id, runId }}
            >
              {sourceLabel}
            </Link>
          ) : (
            <span>{sourceLabel}</span>
          )}
          {message.createdAt ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatDateTime(message.createdAt)}</span>
            </>
          ) : null}
        </div>
        <MessageResponse>{body}</MessageResponse>

        {sections.length > 0 ? (
          <Task defaultOpen={presentation?.detailsDefaultOpen ?? false}>
            <TaskTrigger title="Details">
              <button type="button" className="text-sm text-muted-foreground">
                Details
              </button>
            </TaskTrigger>
            <TaskContent>
              {sections.flatMap((section, sectionIndex) =>
                section.rows.map((row, rowIndex) => (
                  <TaskItem key={`${sectionIndex}:${rowIndex}`}>
                    {section.title ? `${section.title} · ` : ""}
                    {row.label}: <MetadataValue row={row} companyId={companyId} />
                  </TaskItem>
                )),
              )}
            </TaskContent>
          </Task>
        ) : null}
      </MessageContent>
      <MessageToolbar>
        <TaskChatMessageActionBar
          message={message}
          authorLabel={sourceLabel}
          anchorId={anchorId}
          copyLabel="Copy system notice"
          linkLabel="Copy link to system notice"
        />
      </MessageToolbar>
    </Message>
  );
}
