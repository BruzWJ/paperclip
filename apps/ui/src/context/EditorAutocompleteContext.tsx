import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildRoutineMentionHref } from "@paperclipai/shared";
import { routinesApi } from "../api/routines";
import { useOptionalCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "../lib/queryKeys";

export interface RoutineCommandOption {
  id: string;
  kind: "routine";
  routineId: string;
  name: string;
  status: string;
  href: string;
  aliases: string[];
}

interface EditorAutocompleteContextValue {
  slashCommands: RoutineCommandOption[];
}

const EditorAutocompleteContext = createContext<EditorAutocompleteContextValue>({
  slashCommands: [],
});

export function EditorAutocompleteProvider({ children }: { children: ReactNode }) {
  const companyId = useOptionalCompanyRouteId();
  const { data: routines = [] } = useQuery({
    queryKey: companyId
      ? queryKeys.routines.list(companyId)
      : ["routines", "__none__", "__all-projects__"],
    queryFn: () => routinesApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const value = useMemo<EditorAutocompleteContextValue>(() => ({
    slashCommands: [
      ...routines
        .filter((routine) => routine.status !== "archived")
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((routine) => ({
          id: `routine:${routine.id}`,
          kind: "routine" as const,
          routineId: routine.id,
          name: routine.title,
          status: routine.status,
          href: buildRoutineMentionHref(routine.id),
          aliases: [`routine:${routine.title}`, routine.title, routine.id],
        })),
    ],
  }), [routines]);

  return (
    <EditorAutocompleteContext.Provider value={value}>
      {children}
    </EditorAutocompleteContext.Provider>
  );
}

export function useEditorAutocomplete() {
  return useContext(EditorAutocompleteContext);
}
