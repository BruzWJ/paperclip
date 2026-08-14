import { tasksApi } from "@/api/tasks";
import {
  flattenBoardTaskCommentGroupPages,
  shouldAutoloadOlderTaskComments,
  type BoardTaskCommentGroupContinuation,
} from "@/lib/optimistic-task-comments";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";
import { queryKeys } from "@/lib/queryKeys";
import type { BoardTaskCommentGroupPage, BoardTaskThreadEntry } from "@paperclipai/shared";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  JUMP_TO_LATEST_MAX_COMMENT_PAGES,
  TASK_COMMENT_AUTOLOAD_LIMIT,
  TASK_COMMENT_PAGE_SIZE,
} from "./-task-detail-model";

export interface TaskDetailCommentsOptions {
  companyId: string;
  taskId: string;
  detailTab: string;
}

/** Owns grouped comment pagination, continuation expansion, and refresh. */
export function useTaskDetailComments({ companyId, taskId, detailTab }: TaskDetailCommentsOptions) {
  const queryClient = useQueryClient();
  const [commentGroupContinuations, setCommentGroupContinuations] = useState<
    ReadonlyMap<string, BoardTaskCommentGroupContinuation>
  >(() => new Map());
  const loadingCommentGroupRootsRef = useRef(new Set<string>());
  const commentGroupTaskIdRef = useRef(taskId);
  commentGroupTaskIdRef.current = taskId;

  useEffect(() => {
    loadingCommentGroupRootsRef.current.clear();
    setCommentGroupContinuations(new Map());
  }, [taskId]);

  const {
    data: commentPages,
    isLoading: commentsLoading,
    isFetchingNextPage: commentsLoadingOlder,
    hasNextPage: hasOlderComments,
    fetchNextPage: fetchOlderComments,
    refetch: refetchComments,
  } = useInfiniteQuery({
    queryKey: queryKeys.tasks.comments(taskId),
    queryFn: ({ pageParam }) =>
      tasksApi.listComments(taskId, {
        limit: TASK_COMMENT_PAGE_SIZE,
        entryLimit: TASK_COMMENT_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData:
      keepPreviousDataForSameQueryTail<InfiniteData<BoardTaskCommentGroupPage, string | null>>(taskId),
  });
  const comments = useMemo(
    () =>
      flattenBoardTaskCommentGroupPages(
        commentPages?.pages,
        { companyId, taskId },
        commentGroupContinuations,
      ),
    [commentGroupContinuations, commentPages?.pages, taskId, companyId],
  );

  const loadMoreCommentGroup = useCallback(
    async (rootCommentId: string) => {
      if (loadingCommentGroupRootsRef.current.has(rootCommentId)) return;
      const initialGroup = commentPages?.pages
        .flatMap((page) => page.groups)
        .find((group) => group.root.id === rootCommentId);
      const current = commentGroupContinuations.get(rootCommentId);
      const cursor = current?.nextCursor ?? initialGroup?.entriesNextCursor ?? null;
      if (!cursor) return;

      loadingCommentGroupRootsRef.current.add(rootCommentId);
      setCommentGroupContinuations((previous) => {
        const next = new Map(previous);
        next.set(rootCommentId, {
          entries: previous.get(rootCommentId)?.entries ?? [],
          nextCursor: cursor,
          expanded: false,
          loading: true,
          error: null,
        });
        return next;
      });
      let accumulatedEntries = [...(current?.entries ?? [])];
      let nextCursor: string | null = cursor;
      try {
        const seenCursors = new Set<string>();
        while (nextCursor) {
          if (seenCursors.has(nextCursor)) {
            throw new Error("Comment-group cursor repeated");
          }
          seenCursors.add(nextCursor);
          const page = await tasksApi.getCommentThread(taskId, rootCommentId, {
            cursor: nextCursor,
            limit: TASK_COMMENT_PAGE_SIZE,
          });
          const entriesByIdentity = new Map<string, BoardTaskThreadEntry>();
          for (const entry of accumulatedEntries) {
            entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
          }
          for (const entry of page.entries) {
            entriesByIdentity.set(`${entry.kind}:${entry.id}`, entry);
          }
          accumulatedEntries = [...entriesByIdentity.values()];
          nextCursor = page.nextCursor;
        }
        if (commentGroupTaskIdRef.current !== taskId) return;
        setCommentGroupContinuations((previous) => {
          const next = new Map(previous);
          next.set(rootCommentId, {
            entries: accumulatedEntries,
            nextCursor: null,
            expanded: true,
            loading: false,
            error: null,
          });
          return next;
        });
      } catch {
        if (commentGroupTaskIdRef.current !== taskId) return;
        setCommentGroupContinuations((previous) => {
          const next = new Map(previous);
          next.set(rootCommentId, {
            entries: accumulatedEntries,
            nextCursor,
            expanded: false,
            loading: false,
            error: "Couldn’t load replies.",
          });
          return next;
        });
      } finally {
        loadingCommentGroupRootsRef.current.delete(rootCommentId);
      }
    },
    [commentGroupContinuations, commentPages?.pages, taskId],
  );

  const shouldPrefetchOlderComments = useMemo(
    () =>
      shouldAutoloadOlderTaskComments({
        activeDetailTab: detailTab,
        hasOlderComments: hasOlderComments ?? false,
        loadedCommentCount: comments.length,
        initialPageLoading: commentsLoading,
        olderPageLoading: commentsLoadingOlder,
        autoLoadLimit: TASK_COMMENT_AUTOLOAD_LIMIT,
      }),
    [comments.length, commentsLoading, commentsLoadingOlder, detailTab, hasOlderComments],
  );
  useEffect(() => {
    if (!shouldPrefetchOlderComments) return;
    void fetchOlderComments();
  }, [fetchOlderComments, shouldPrefetchOlderComments]);

  const loadOlderComments = useCallback(() => {
    void fetchOlderComments();
  }, [fetchOlderComments]);
  const refetchLatestComments = useCallback(async () => {
    const refreshed = await refetchComments();
    const pages = [...(refreshed.data?.pages ?? [])];
    const pageParams = [...((refreshed.data?.pageParams as Array<string | null> | undefined) ?? [])];
    let cursor = pages.at(-1)?.nextCursor ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor) && seen.size < JUMP_TO_LATEST_MAX_COMMENT_PAGES) {
      seen.add(cursor);
      const page = await tasksApi.listComments(taskId, {
        cursor,
        limit: TASK_COMMENT_PAGE_SIZE,
        entryLimit: TASK_COMMENT_PAGE_SIZE,
      });
      pages.push(page);
      pageParams.push(cursor);
      cursor = page.nextCursor;
    }
    queryClient.setQueryData<InfiniteData<BoardTaskCommentGroupPage, string | null>>(
      queryKeys.tasks.comments(taskId),
      { pages, pageParams },
    );
    await new Promise<void>((resolve) => {
      if (typeof window === "undefined") {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => resolve());
    });
  }, [taskId, queryClient, refetchComments]);

  return {
    commentsLoadingOlder,
    hasOlderComments,
    comments,
    loadMoreCommentGroup,
    loadOlderComments,
    refetchLatestComments,
  };
}
