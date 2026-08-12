import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

export type NavigationAction = "POP" | "PUSH" | "REPLACE";

/**
 * Projects TanStack History actions onto the three navigation categories the
 * board uses to choose its page-transition direction.
 */
export function useNavigationAction(): NavigationAction {
  const router = useRouter();
  const [action, setAction] = useState<NavigationAction>("POP");

  useEffect(
    () => router.history.subscribe(({ action: nextAction }) => {
      setAction(
        nextAction.type === "PUSH" || nextAction.type === "REPLACE"
          ? nextAction.type
          : "POP",
      );
    }),
    [router],
  );

  return action;
}
