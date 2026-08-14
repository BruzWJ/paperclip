import type { Db } from "@paperclipai/db";

import {
  createDocumentAnnotationsContext,
  type ActorInput,
  type ListThreadsOptions,
  type RemapDocumentInput,
  type DocumentAnnotationsContext,
} from "./document-annotation-foundation.js";
import { buildDocumentAnnotationsDocumentAnnotationQueries } from "./document-annotation-queries.js";
import { buildDocumentAnnotationsDocumentAnnotationMutations } from "./document-annotation-mutations.js";

import {
  selectorToAnchorSnapshot,
  CreateDocumentAnnotationComment,
  CreateDocumentAnnotationThread,
  UpdateDocumentAnnotationThread,
} from "@paperclipai/shared";

export function createDocumentAnnotationsMethods1(
  scope: DocumentAnnotationsContext &
    ReturnType<typeof buildDocumentAnnotationsDocumentAnnotationQueries> &
    ReturnType<typeof buildDocumentAnnotationsDocumentAnnotationMutations>,
) {
  const {
    findThread,
    commentsForThreads,
    listThreads,
    createThreadForTarget,
    addCommentForTarget,
    updateThreadForTarget,
    remapOpenThreads,
  } = scope;

  return {
    listThreadsForTaskDocument: async (taskId: string, key: string, options: ListThreadsOptions = {}) =>
      listThreads({ kind: "task", taskId }, key, options),

    listThreadsForRoutineDocument: async (routineId: string, key: string, options: ListThreadsOptions = {}) =>
      listThreads({ kind: "routine", routineId }, key, options),

    getThreadForTaskDocument: async (taskId: string, key: string, threadId: string) => {
      const { thread } = await findThread({ kind: "task", taskId }, key, threadId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    getThreadForRoutineDocument: async (routineId: string, key: string, threadId: string) => {
      const { thread } = await findThread({ kind: "routine", routineId }, key, threadId);
      if (!thread) return null;
      const comments = await commentsForThreads([thread.id]);
      return { ...thread, comments };
    },

    createThread: async (
      taskId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => createThreadForTarget({ kind: "task", taskId }, key, input, actor),

    createRoutineThread: async (
      routineId: string,
      key: string,
      input: CreateDocumentAnnotationThread,
      actor: ActorInput,
    ) => createThreadForTarget({ kind: "routine", routineId }, key, input, actor),

    addComment: async (
      taskId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => addCommentForTarget({ kind: "task", taskId }, key, threadId, input, actor),

    addRoutineComment: async (
      routineId: string,
      key: string,
      threadId: string,
      input: CreateDocumentAnnotationComment,
      actor: ActorInput,
    ) => addCommentForTarget({ kind: "routine", routineId }, key, threadId, input, actor),

    updateThread: async (
      taskId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => updateThreadForTarget({ kind: "task", taskId }, key, threadId, input, actor),

    updateRoutineThread: async (
      routineId: string,
      key: string,
      threadId: string,
      input: UpdateDocumentAnnotationThread,
      actor: ActorInput,
    ) => updateThreadForTarget({ kind: "routine", routineId }, key, threadId, input, actor),

    remapOpenThreadsForDocument: async (input: RemapDocumentInput & { taskId: string }) =>
      remapOpenThreads({ kind: "task", taskId: input.taskId }, input),

    remapOpenThreadsForRoutineDocument: async (input: RemapDocumentInput & { routineId: string }) =>
      remapOpenThreads({ kind: "routine", routineId: input.routineId }, input),

    selectorToAnchorSnapshot,
  };
}

export function documentAnnotationService(db: Db) {
  const context = createDocumentAnnotationsContext(db);
  const helpers1 = buildDocumentAnnotationsDocumentAnnotationQueries(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildDocumentAnnotationsDocumentAnnotationMutations(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const scope = scope2;
  const methods1 = createDocumentAnnotationsMethods1(scope);
  return { ...methods1 };
}
