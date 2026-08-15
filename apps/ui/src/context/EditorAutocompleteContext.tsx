// Empty collections render dedicated UI when data.length === 0.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildRoutineMentionHref } from "@paperclipai/shared";

import { routinesApi } from "@/api/routines";
import { useOptionalCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";

export interface RoutineCommandOption {
  id: string;
  kind: "routine";
  routineId: string;
  name: string;
  status: string;
  href: string;
  aliases: string[];
}

const EditorAutocompleteContext = createContext<RoutineCommandOption[]>([]);

/** Supplies company-scoped routine commands to Kibo editor adapters. */
export function EditorAutocompleteProvider({ children }: { children: ReactNode }) {
  const companyId = useOptionalCompanyRouteId();
  const { data: routines = [] } = useQuery({
    queryKey: companyId ? queryKeys.routines.list(companyId) : ["routines", "__none__", "__all-projects__"],
    queryFn: () => routinesApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const commands = useMemo<RoutineCommandOption[]>(
    () =>
      routines
        .filter((routine) => routine.status !== "archived")
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((routine) => ({
          id: `routine:${routine.id}`,
          kind: "routine",
          routineId: routine.id,
          name: routine.title,
          status: routine.status,
          href: buildRoutineMentionHref(routine.id),
          aliases: [`routine:${routine.title}`, routine.title, routine.id],
        })),
    [routines],
  );

  return <EditorAutocompleteContext.Provider value={commands}>{children}</EditorAutocompleteContext.Provider>;
}

export function useEditorAutocomplete() {
  return useContext(EditorAutocompleteContext);
}
