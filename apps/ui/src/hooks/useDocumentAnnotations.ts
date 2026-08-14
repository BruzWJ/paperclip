import { useQuery } from "@tanstack/react-query";

import { documentAnnotationsApi, type DocumentAnnotationTarget } from "@/api/document-annotations";
import { queryKeys } from "@/lib/queryKeys";

/** One canonical query contract for annotated task and routine documents. */
export function useDocumentAnnotations(target: DocumentAnnotationTarget) {
  return useQuery({
    queryKey:
      target.kind === "routine"
        ? queryKeys.routines.documentAnnotations(target.routineId, target.documentKey, "all")
        : queryKeys.tasks.documentAnnotations(target.taskId, target.documentKey, "all"),
    queryFn: () => documentAnnotationsApi.list(target, { status: "all", includeComments: true }),
    staleTime: 30_000,
  });
}
