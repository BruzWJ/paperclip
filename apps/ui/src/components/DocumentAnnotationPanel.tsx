import { authApi } from "@/api/auth";
import { documentAnnotationsApi, type DocumentAnnotationTarget } from "@/api/document-annotations";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Card } from "@/components/ui/card";
import { Item, ItemActions, ItemContent } from "@/components/ui/item";
import type { CompanyUserProfile } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type {
  Agent,
  DocumentAnnotationThreadStatus,
  DocumentAnnotationThreadWithComments,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocumentAnnotationComposer } from "./DocumentAnnotationComposer";
import type { PendingAnchor } from "./DocumentAnnotationLayer";
import {
  buildOptimisticComment,
  buildOptimisticThread,
  copyAnnotationLink,
} from "./DocumentAnnotationOptimistic";
import { DocumentAnnotationsEmptyState, ThreadCard } from "./DocumentAnnotationThreads";

export interface AnnotationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: DocumentAnnotationTarget;
  documentRevisionNumber: number;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  threads: DocumentAnnotationThreadWithComments[];
  focusedThreadId: string | null;
  onFocusThread: (threadId: string | null) => void;
  focusedCommentId: string | null;
  pendingAnchor: PendingAnchor | null;
  onClearPendingAnchor: () => void;
  /** Request the body layer to start a comment from the current text selection (⌘⇧M). */
  onRequestCommentFromSelection?: () => void;
  newCommentDisabled?: boolean;
  newCommentDisabledReason?: string | null;
  /** When mobile is true, render via shadcn Sheet at the bottom instead of side panel. */
  isMobile?: boolean;
  /** Desktop panel width calculated by the document frame. */
  desktopWidth?: number;
  className?: string;
  /** Resolve `<authorAgentId>` to a display name. */
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name"> & Partial<Pick<Agent, "icon">>>;
  /** Resolve `<authorUserId>` to a display name. */
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile>;
}

export function DocumentAnnotationPanel(props: AnnotationPanelProps) {
  if (props.isMobile) {
    return (
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="paperclip-doc-annotation-sheet z-(--z-60) flex max-h-(--sz-88vh) flex-col rounded-none border-t border-border bg-popover p-0 text-popover-foreground shadow-2xl"
        >
          <SheetTitle className="sr-only">
            Comments on {props.target.documentKey} revision {props.documentRevisionNumber}
          </SheetTitle>
          <div
            className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30"
            aria-hidden="true"
          />
          <AnnotationPanelBody {...props} />
        </SheetContent>
      </Sheet>
    );
  }

  if (!props.open) return null;

  return (
    <Card
      role="complementary"
      aria-label={`Annotations for ${props.target.documentKey.toUpperCase()}, revision ${props.documentRevisionNumber}`}
      data-testid="document-annotation-panel"
      className={cn(
        "isolate h-full max-h-(--sz-80vh) w-(--sz-360px) shrink-0 gap-0 overflow-hidden rounded-none bg-popover py-0 text-popover-foreground shadow-xl",
        props.className,
      )}
      style={props.desktopWidth ? { width: props.desktopWidth, maxWidth: props.desktopWidth } : undefined}
    >
      <AnnotationPanelBody {...props} />
    </Card>
  );
}

export * from "./DocumentAnnotationOptimistic";
export * from "./DocumentAnnotationThreads";

export function AnnotationPanelBody(props: AnnotationPanelProps) {
  const queryClient = useQueryClient();
  const [composerValue, setComposerValue] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [mutationError, setMutationError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyTestId = props.isMobile ? "document-annotation-panel" : undefined;
  const annotationTarget = props.target;

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    staleTime: 5 * 60_000,
  });
  const currentUser = useMemo(() => {
    const user = session?.user;
    return {
      id: user?.id ?? null,
      name: user?.name?.trim() || user?.email?.trim() || "You",
      image: user?.image ?? null,
    };
  }, [session]);

  // Show every thread that can be anchored in the document (orphaned threads have
  // lost their anchor). Filters were removed in favour of a single simple list.
  // Sort in document order (top-to-bottom) — not by recency — so the comment list
  // stays congruent with the highlights as you scroll the document.
  const visibleThreads = useMemo(
    () =>
      props.threads
        .filter((thread) => thread.anchorState !== "orphaned")
        .sort(
          (a, b) =>
            a.normalizedStart - b.normalizedStart ||
            a.markdownStart - b.markdownStart ||
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [props.threads],
  );
  const hasOrphanedThreads = props.threads.some((thread) => thread.anchorState === "orphaned");

  const annotationsQueryKey = useMemo(
    () =>
      annotationTarget.kind === "routine"
        ? queryKeys.routines.documentAnnotations(
            annotationTarget.routineId,
            annotationTarget.documentKey,
            "all",
          )
        : queryKeys.tasks.documentAnnotations(annotationTarget.taskId, annotationTarget.documentKey, "all"),
    [annotationTarget],
  );

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        if (!Array.isArray(query.queryKey)) return false;
        if (annotationTarget.kind === "routine") {
          return (
            query.queryKey[0] === "routines" &&
            query.queryKey[1] === "document-annotations" &&
            query.queryKey[2] === annotationTarget.routineId &&
            query.queryKey[3] === annotationTarget.documentKey
          );
        }
        return (
          query.queryKey[0] === "tasks" &&
          query.queryKey[1] === "document-annotations" &&
          query.queryKey[2] === annotationTarget.taskId &&
          query.queryKey[3] === annotationTarget.documentKey
        );
      },
    });
  }, [annotationTarget, queryClient]);

  const createThread = useMutation({
    mutationFn: async (body: string) => {
      if (!props.pendingAnchor) throw new Error("No selection to anchor to.");
      if (!props.baseRevisionId) throw new Error("Document has no revision yet.");
      return documentAnnotationsApi.create(annotationTarget, {
        baseRevisionId: props.baseRevisionId,
        baseRevisionNumber: props.baseRevisionNumber,
        selector: props.pendingAnchor.selector,
        body,
      });
    },
    // Optimistically drop the new thread into the cache so submission feels instant.
    onMutate: async (body: string) => {
      const anchor = props.pendingAnchor;
      if (!anchor || !props.baseRevisionId) return undefined;
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey: annotationsQueryKey });
      const previous = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey);
      const optimisticThread = buildOptimisticThread({
        body,
        selectedText: anchor.selectedText,
        target: annotationTarget,
        documentKey: annotationTarget.documentKey,
        baseRevisionId: props.baseRevisionId,
        baseRevisionNumber: props.baseRevisionNumber,
        normalizedStart: anchor.selector.position.normalizedStart,
        markdownStart: anchor.selector.position.markdownStart,
        author: currentUser,
      });
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey, (current) => [
        ...(current ?? []),
        optimisticThread,
      ]);
      props.onFocusThread(optimisticThread.id);
      return { previous, optimisticId: optimisticThread.id };
    },
    onError: (error, _body, context) => {
      if (context?.previous) {
        queryClient.setQueryData(annotationsQueryKey, context.previous);
      }
      setMutationError(error instanceof Error && error.message ? error.message : "Failed to create comment.");
    },
    onSuccess: (thread, _body, context) => {
      // Swap the optimistic placeholder for the real thread before refetch settles.
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey, (current) =>
        (current ?? []).map((entry) => (entry.id === context?.optimisticId ? thread : entry)),
      );
      props.onClearPendingAnchor();
      setComposerValue("");
      setMutationError(null);
      props.onFocusThread(thread.id);
    },
    onSettled: () => invalidateAll(),
  });

  const addReply = useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      documentAnnotationsApi.addComment(annotationTarget, threadId, { body }),
    // Optimistically append the reply so it stays on screen through the round-trip.
    onMutate: async ({ threadId, body }) => {
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey: annotationsQueryKey });
      const previous = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey);
      const optimisticComment = buildOptimisticComment({
        body,
        threadId,
        target: annotationTarget,
        author: currentUser,
      });
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey, (current) =>
        (current ?? []).map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                comments: [...thread.comments, optimisticComment],
                updatedAt: optimisticComment.createdAt,
              }
            : thread,
        ),
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(annotationsQueryKey, context.previous);
      }
      setMutationError(error instanceof Error && error.message ? error.message : "Failed to add reply.");
    },
    onSuccess: (_comment, variables) => {
      setReplyDrafts((current) => ({ ...current, [variables.threadId]: "" }));
      setMutationError(null);
    },
    onSettled: () => invalidateAll(),
  });

  const updateStatus = useMutation({
    mutationFn: ({ threadId, status }: { threadId: string; status: DocumentAnnotationThreadStatus }) =>
      documentAnnotationsApi.updateStatus(annotationTarget, threadId, status),
    onMutate: async ({ threadId, status }) => {
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey: annotationsQueryKey });
      const previous = queryClient.getQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey);
      queryClient.setQueryData<DocumentAnnotationThreadWithComments[]>(annotationsQueryKey, (current) =>
        (current ?? []).map((thread) => (thread.id === threadId ? { ...thread, status } : thread)),
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(annotationsQueryKey, context.previous);
      }
      setMutationError(
        error instanceof Error && error.message ? error.message : "Failed to update comment status.",
      );
    },
    onSuccess: () => setMutationError(null),
    onSettled: () => invalidateAll(),
  });

  useEffect(() => {
    if (!props.open) {
      setComposerValue("");
    }
  }, [props.open]);

  useEffect(() => {
    if (props.pendingAnchor && props.open) {
      composerRef.current?.focus();
    }
  }, [props.open, props.pendingAnchor]);

  // Keep the comment list congruent with the document: when a thread becomes
  // focused — whether by clicking its highlight in the doc or by adding a new
  // comment — scroll that card into view in the pane.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.focusedThreadId) return;
    const container = listScrollRef.current;
    if (!container) return;
    const card = container.querySelector<HTMLElement>(`[data-thread-id="${props.focusedThreadId}"]`);
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [props.focusedThreadId, visibleThreads]);

  const mutationStatusMessage = createThread.isPending
    ? "Posting annotation comment…"
    : addReply.isPending
      ? "Posting annotation reply…"
      : updateStatus.isPending
        ? "Updating annotation status…"
        : null;

  return (
    <>
      <Item
        data-testid={bodyTestId}
        size="sm"
        className="shrink-0 justify-end gap-1 rounded-none border-x-0 border-t-0 bg-popover px-2 py-1.5"
      >
        <ItemContent className="flex-none text-(length:--text-micro) tabular-nums text-muted-foreground">
          rev {props.documentRevisionNumber}
        </ItemContent>
        <ItemActions>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              props.onFocusThread(null);
              props.onOpenChange(false);
            }}
            aria-label="Close annotation panel"
          >
            <X className="h-4 w-4" />
          </Button>
        </ItemActions>
      </Item>
      {props.newCommentDisabled && props.newCommentDisabledReason ? (
        <Alert data-testid="document-annotation-disabled-reason">
          <AlertDescription>{props.newCommentDisabledReason}</AlertDescription>
        </Alert>
      ) : null}
      {mutationError ? (
        <Alert variant="destructive" data-testid="document-annotation-error">
          <AlertDescription>{mutationError}</AlertDescription>
        </Alert>
      ) : null}
      {mutationStatusMessage ? (
        <p role="status" className="sr-only">
          {mutationStatusMessage}
        </p>
      ) : null}
      <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto bg-popover px-3 py-2">
        {visibleThreads.length === 0 ? (
          <DocumentAnnotationsEmptyState hasOrphanedThreads={hasOrphanedThreads} />
        ) : (
          <ul className="space-y-2">
            {visibleThreads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                expanded={thread.id === props.focusedThreadId}
                focusedCommentId={thread.id === props.focusedThreadId ? props.focusedCommentId : null}
                onFocus={() => props.onFocusThread(thread.id)}
                replyDraft={replyDrafts[thread.id] ?? ""}
                onReplyChange={(value) =>
                  setReplyDrafts((current) => ({
                    ...current,
                    [thread.id]: value,
                  }))
                }
                onSubmitReply={() => {
                  const body = (replyDrafts[thread.id] ?? "").trim();
                  if (!body) return;
                  addReply.mutate({ threadId: thread.id, body });
                }}
                onResolveToggle={() =>
                  updateStatus.mutate({
                    threadId: thread.id,
                    status: thread.status === "resolved" ? "open" : "resolved",
                  })
                }
                onCopyLink={() => copyAnnotationLink(props.target.documentKey, thread.id)}
                pendingReply={addReply.isPending && addReply.variables?.threadId === thread.id}
                pendingStatus={updateStatus.isPending && updateStatus.variables?.threadId === thread.id}
                agentMap={props.agentMap}
                userProfileMap={props.userProfileMap}
              />
            ))}
          </ul>
        )}
      </div>
      {props.pendingAnchor ? (
        <DocumentAnnotationComposer
          anchor={props.pendingAnchor}
          currentUser={currentUser}
          composerRef={composerRef}
          value={composerValue}
          onValueChange={setComposerValue}
          posting={createThread.isPending}
          disabled={props.newCommentDisabled}
          hasBaseRevision={Boolean(props.baseRevisionId)}
          onCancel={() => {
            props.onClearPendingAnchor();
            setComposerValue("");
          }}
          onSubmit={(body) => createThread.mutate(body)}
        />
      ) : null}
    </>
  );
}
