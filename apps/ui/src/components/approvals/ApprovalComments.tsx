import { MarkdownBody } from "@/components/MarkdownBody";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/identity";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Item, ItemContent, ItemGroup, ItemHeader } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import type { Agent, ApprovalComment } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";

export function ApprovalComments({
  comments,
  agentsById,
  agentNamesById,
  companyId,
  body,
  isPosting,
  onBodyChange,
  onSubmit,
}: {
  comments: ApprovalComment[];
  agentsById: Map<string, Agent>;
  agentNamesById: Map<string, string>;
  companyId: string;
  body: string;
  isPosting: boolean;
  onBodyChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const authorName = (comment: ApprovalComment) =>
    comment.authorAgentId
      ? (agentNamesById.get(comment.authorAgentId) ??
        comment.authorAgentId.slice(0, 8))
      : "Board";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Comments ({comments.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ItemGroup className="gap-2">
          {comments.map((comment) => {
            const name = authorName(comment);
            return (
              <Item key={comment.id} variant="outline" size="sm">
                <ItemHeader>
                  {comment.authorAgentId &&
                  agentsById.has(comment.authorAgentId) ? (
                    <Link
                      to="/$companyId/agents/$agentId"
                      params={{ companyId, agentId: comment.authorAgentId }}
                      className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
                      title={name}
                    >
                      <Avatar size="sm">
                        <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
                      </Avatar>
                      <span className="truncate text-xs">{name}</span>
                      <span className="sr-only">View agent profile</span>
                    </Link>
                  ) : (
                    <span
                      className="inline-flex min-w-0 items-center gap-1.5"
                      title={name}
                    >
                      <Avatar size="sm">
                        <AvatarFallback>{deriveInitials(name)}</AvatarFallback>
                      </Avatar>
                      <span className="truncate text-xs">{name}</span>
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {new Date(comment.createdAt).toLocaleString()}
                  </span>
                </ItemHeader>
                <ItemContent>
                  <MarkdownBody className="text-sm text-muted-foreground">
                    {comment.body}
                  </MarkdownBody>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
        <Textarea
          aria-label="Approval comment"
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={!body.trim() || isPosting}
        >
          {isPosting ? <Spinner /> : null}
          {isPosting ? "Posting…" : "Post comment"}
        </Button>
      </CardFooter>
    </Card>
  );
}
