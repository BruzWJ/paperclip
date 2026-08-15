import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import {
  mapCommentMetadataToSystemNoticeSections,
  systemNoticeLabelForTone,
  type SystemNoticeMetadataRow,
} from "@/lib/system-notice-comment";
import { formatDateTime } from "@/lib/utils";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Link } from "@tanstack/react-router";
import { useContext } from "react";
import type { TaskChatMessage } from "@/lib/task-chat-messages";

import { TaskChatMessageActionsMenu } from "./-TaskChatMessageActionsMenu";
import {
  getThreadMessageCopyText,
  isTaskCommentMetadata,
  isTaskCommentPresentation,
  TaskChatCtx,
} from "./-TaskChatShared";
import { commentDateLabel, taskChatMessageCustom } from "./-TaskChatMessageUtils";

interface SystemNoticeCommentRowProps {
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
  return (
    <span>
      {row.status ? `${row.status} · ` : ""}
      {row.runId}
    </span>
  );
}

export function SystemNoticeCommentRow({ message, anchorId }: SystemNoticeCommentRowProps) {
  const { onImageClick } = useContext(TaskChatCtx);
  const companyId = useCompanyRouteId();
  const custom = taskChatMessageCustom(message);
  const presentation = isTaskCommentPresentation(custom.presentation) ? custom.presentation : null;
  const metadata = isTaskCommentMetadata(custom.commentMetadata) ? custom.commentMetadata : null;
  const tone = presentation?.tone ?? "neutral";
  const label = systemNoticeLabelForTone(tone, presentation?.title);
  const body = getThreadMessageCopyText(message);
  const sections = mapCommentMetadataToSystemNoticeSections(metadata);

  return (
    <Message from="assistant" role="status" aria-label={label} className="max-w-full gap-1.5">
      <MessageContent
        onClick={(event) => {
          const target = event.target;
          if (target instanceof HTMLImageElement && target.src) onImageClick?.(target.src);
        }}
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{label}</span>
            <span aria-hidden="true">·</span>
            <span>Paperclip</span>
            <span aria-hidden="true">·</span>
            <time
              dateTime={message.createdAt.toISOString()}
              title={formatDateTime(message.createdAt)}
              className="text-(length:--text-micro)"
            >
              {commentDateLabel(message.createdAt)}
            </time>
          </div>
          <TaskChatMessageActionsMenu
            message={message}
            authorLabel="Paperclip"
            anchorId={anchorId}
            copyLabel="Copy system notice"
            linkLabel="Copy link to system notice"
          />
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
    </Message>
  );
}
