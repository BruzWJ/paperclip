import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item } from "@/components/ui/item";
import type { CompanyUserProfile } from "@/lib/company-members";
import { cn, relativeTime } from "@/lib/utils";
import type {
  Agent,
  DocumentAnnotationComment,
  DocumentAnnotationThreadWithComments,
} from "@paperclipai/shared";
import { Check, Copy, MoreHorizontal, RotateCcw } from "lucide-react";
import { AgentIcon } from "../agents/AgentIconPicker";
import { deriveInitials } from "@/lib/identity";
import { MarkdownBody } from "../markdown/MarkdownBody";

import { isSubmitShortcut, resolveAuthor, truncate } from "./DocumentAnnotationOptimistic";

export function DocumentAnnotationsEmptyState({ hasOrphanedThreads }: { hasOrphanedThreads: boolean }) {
  return (
    <Empty className="min-h-full rounded-none px-4 py-8">
      <EmptyHeader>
        <EmptyTitle className="text-sm">
          {hasOrphanedThreads ? "No annotations are anchored in this revision." : "No annotations yet."}
        </EmptyTitle>
        <EmptyDescription>Select text in the document to add a comment.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function ThreadCard(props: {
  thread: DocumentAnnotationThreadWithComments;
  expanded: boolean;
  focusedCommentId: string | null;
  onFocus: () => void;
  replyDraft: string;
  onReplyChange: (value: string) => void;
  onSubmitReply: () => void;
  onResolveToggle: () => void;
  onCopyLink: () => void;
  pendingReply: boolean;
  pendingStatus: boolean;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}) {
  const { thread } = props;
  const latestComment = thread.comments[thread.comments.length - 1];

  return (
    <li>
      <Item
        asChild
        variant="outline"
        size="sm"
        className={cn(
          "block scroll-mt-2 rounded-none transition-colors",
          props.expanded && "ring-2 ring-primary/80 ring-offset-1 ring-offset-popover",
          thread.status === "resolved" && "bg-muted",
        )}
      >
        <article
          role="article"
          data-thread-id={thread.id}
          data-anchor-state={thread.anchorState}
          data-status={thread.status}
          data-focused={props.expanded || undefined}
          aria-labelledby={`thread-quote-${thread.id}`}
          tabIndex={0}
          onClick={props.onFocus}
        >
          <blockquote
            id={`thread-quote-${thread.id}`}
            className={cn(
              "mx-3 mt-2 line-clamp-2 overflow-hidden rounded-none bg-muted px-2 py-1 text-xs italic leading-5 text-muted-foreground [overflow-wrap:anywhere]",
              (thread.anchorState === "stale" || thread.status === "resolved") && "bg-muted",
            )}
          >
            {truncate(thread.selectedText, 120)}
          </blockquote>
          {props.expanded ? (
            <div className="space-y-2 px-3 py-2">
              {thread.comments.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  focused={props.focusedCommentId === comment.id}
                  agentMap={props.agentMap}
                  userProfileMap={props.userProfileMap}
                />
              ))}
              <Textarea
                aria-label="Reply to annotation"
                data-testid={`document-annotation-reply-${thread.id}`}
                rows={2}
                value={props.replyDraft}
                onChange={(event) => props.onReplyChange(event.target.value)}
                onKeyDown={(event) => {
                  if (isSubmitShortcut(event)) {
                    event.preventDefault();
                    if (props.replyDraft.trim() && !props.pendingReply) {
                      props.onSubmitReply();
                    }
                  }
                }}
                placeholder="Reply…"
                className="resize-y rounded-none text-sm"
                disabled={props.pendingReply}
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={props.onResolveToggle}
                  disabled={props.pendingStatus}
                  className="gap-1"
                >
                  {thread.status === "resolved" ? (
                    <>
                      <RotateCcw className="h-3 w-3" /> Reopen
                    </>
                  ) : (
                    <>
                      <Check className="h-3 w-3" /> Resolve
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!props.replyDraft.trim() || props.pendingReply}
                  onClick={props.onSubmitReply}
                >
                  {props.pendingReply ? "Sending…" : "Reply"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      title="More actions"
                      aria-label="More thread actions"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={(event) => {
                        event.preventDefault();
                        props.onCopyLink();
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Copy link
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {thread.comments.length} comment
                {thread.comments.length === 1 ? "" : "s"}
              </span>
              {latestComment ? <span className="ml-1">· {truncate(latestComment.body, 120)}</span> : null}
            </p>
          )}
        </article>
      </Item>
    </li>
  );
}

export function CommentRow({
  comment,
  focused,
  agentMap,
  userProfileMap,
}: {
  comment: DocumentAnnotationComment;
  focused: boolean;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}) {
  const author = resolveAuthor(comment, { agentMap, userProfileMap });
  return (
    <Item
      id={`comment-${comment.id}`}
      data-focused={focused || undefined}
      variant="outline"
      size="sm"
      className={cn("block rounded-none px-2 py-1.5", focused && "ring-2 ring-primary/40")}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2 text-(length:--text-micro)">
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar size="sm" className="shrink-0">
            {author.role === "agent" ? (
              <AvatarFallback>
                <AgentIcon icon={author.agentIcon} className="h-3 w-3" />
              </AvatarFallback>
            ) : (
              <>
                {author.imageUrl ? <AvatarImage src={author.imageUrl} alt={author.name} /> : null}
                <AvatarFallback>{deriveInitials(author.name)}</AvatarFallback>
              </>
            )}
          </Avatar>
          <span className="truncate font-medium text-foreground">{author.name}</span>
          {author.role === "agent" ? <span className="text-muted-foreground">· agent</span> : null}
        </span>
        <span className="shrink-0 text-muted-foreground">{relativeTime(comment.createdAt)}</span>
      </div>
      <MarkdownBody className="text-sm leading-6">{comment.body}</MarkdownBody>
    </Item>
  );
}
