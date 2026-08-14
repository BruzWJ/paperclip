import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";

import { documentAnnotationsApi, type DocumentAnnotationTarget } from "@/api/document-annotations";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

export function DocumentAnnotationsCountChip({
  target,
  panelOpen,
  onToggle,
}: {
  target: DocumentAnnotationTarget;
  panelOpen: boolean;
  onToggle: () => void;
}) {
  const annotationsQuery = useQuery({
    queryKey:
      target.kind === "routine"
        ? queryKeys.routines.documentAnnotations(target.routineId, target.documentKey, "all")
        : queryKeys.tasks.documentAnnotations(target.taskId, target.documentKey, "all"),
    queryFn: () =>
      documentAnnotationsApi.list(target, {
        status: "all",
        includeComments: true,
      }),
    staleTime: 30_000,
  });
  const openCount = useMemo(
    () =>
      (annotationsQuery.data ?? []).filter(
        (thread) => thread.status === "open" && thread.anchorState !== "orphaned",
      ).length,
    [annotationsQuery.data],
  );

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-state={panelOpen ? "open" : "closed"}
      onClick={onToggle}
      data-testid={`document-annotation-count-${target.documentKey}`}
      aria-label={
        openCount === 0
          ? `Open comments on ${target.documentKey}`
          : `Open ${openCount} unresolved comments on ${target.documentKey}`
      }
      aria-expanded={panelOpen}
    >
      <MessageSquare aria-hidden="true" />
      <span className="tabular-nums">{openCount}</span>
      <span className="hidden sm:inline">{openCount === 1 ? "comment" : "comments"}</span>
    </Button>
  );
}
