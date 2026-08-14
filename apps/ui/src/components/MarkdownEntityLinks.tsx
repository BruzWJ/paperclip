import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { getTaskDetailQueryOptions } from "../lib/taskDetailCache";
import { taskValueLabel } from "../lib/task-blockers";
import { cn } from "../lib/utils";
import { TaskLinkQuicklook } from "./TaskLinkQuicklook";
import { Badge } from "@/components/ui/badge";

export function MarkdownTaskLink({ taskId, children }: { taskId: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    ...getTaskDetailQueryOptions(queryClient, taskId),
    staleTime: 60_000,
  });

  const identifier = data?.identifier ?? "Task unavailable";
  const title = data?.title ?? identifier;
  const status = data?.boardPresentationStatus;
  const taskLabel = title !== identifier ? `Task ${identifier}: ${title}` : `Task ${identifier}`;

  return (
    <TaskLinkQuicklook
      taskId={taskId}
      taskNumber={data?.taskNumber ?? null}
      taskPrefetch={data}
      data-mention-kind="task"
      // Boxless inline mention: the unified status glyph + a regular-weight
      // underlined link, optically centered with the body text.
      className={cn("paperclip-markdown-task-ref", "font-normal underline")}
      title={title}
      aria-label={taskLabel}
    >
      {status ? <Badge variant="secondary">{taskValueLabel(status)}</Badge> : null}
      {children}
    </TaskLinkQuicklook>
  );
}

type MarkdownEntityMentionLinkProps = {
  companyId: string;
  entityId: string;
  children: ReactNode;
  linkProps: {
    className: string;
    "data-mention-kind": string;
    style: React.CSSProperties | undefined;
  };
};

export function MarkdownAgentMentionLink({
  companyId,
  entityId,
  children,
  linkProps,
}: MarkdownEntityMentionLinkProps) {
  return (
    <Link to="/$companyId/agents/$agentId" params={{ companyId, agentId: entityId }} {...linkProps}>
      {children}
    </Link>
  );
}

export function MarkdownProjectMentionLink({
  companyId,
  entityId,
  children,
  linkProps,
}: MarkdownEntityMentionLinkProps) {
  return (
    <Link to="/$companyId/projects/$projectId" params={{ companyId, projectId: entityId }} {...linkProps}>
      {children}
    </Link>
  );
}

export function renderLinkBody(
  children: ReactNode,
  leadingIcon: ReactNode,
  trailingIcon: ReactNode,
): ReactNode {
  if (!leadingIcon && !trailingIcon) return children;

  // React-markdown can pass arrays/elements for styled link text; the nowrap
  // splitting below is intentionally limited to plain text links.
  if (typeof children === "string" && children.length > 0) {
    if (children.length === 1) {
      return (
        <span style={{ whiteSpace: "nowrap" }}>
          {leadingIcon}
          {children}
          {trailingIcon}
        </span>
      );
    }
    const first = children[0];
    const last = children[children.length - 1];
    const middle = children.slice(1, -1);
    return (
      <>
        {leadingIcon ? (
          <span style={{ whiteSpace: "nowrap" }}>
            {leadingIcon}
            {first}
          </span>
        ) : (
          first
        )}
        {middle}
        {trailingIcon ? (
          <span style={{ whiteSpace: "nowrap" }}>
            {last}
            {trailingIcon}
          </span>
        ) : (
          last
        )}
      </>
    );
  }

  return (
    <>
      {leadingIcon}
      {children}
      {trailingIcon}
    </>
  );
}
