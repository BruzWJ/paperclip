import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { TaskWorkMode } from "@paperclipai/shared";

interface NewTaskDefaults {
  status?: string;
  workMode?: TaskWorkMode;
  priority?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  goalId?: string;
  parentId?: string;
  parentIdentifier?: string;
  parentTitle?: string;
  ownerAgentId?: string;
  title?: string;
  request?: string;
}

interface NewGoalDefaults {
  parentId?: string;
}

interface DialogContextValue {
  newTaskOpen: boolean;
  newTaskDefaults: NewTaskDefaults;
  openNewTask: (defaults?: NewTaskDefaults) => void;
  closeNewTask: () => void;
  newProjectOpen: boolean;
  openNewProject: () => void;
  closeNewProject: () => void;
  newGoalOpen: boolean;
  newGoalDefaults: NewGoalDefaults;
  openNewGoal: (defaults?: NewGoalDefaults) => void;
  closeNewGoal: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  onboardingOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
  // Whether the user has dismissed the route-driven onboarding wizard (the one
  // that auto-opens on /onboarding). Shared so the route launcher can hand off
  // fully to the wizard instead of remaining interactive behind it.
  onboardingRouteDismissed: boolean;
  setOnboardingRouteDismissed: (dismissed: boolean) => void;
}

type DialogStateValue = Pick<
  DialogContextValue,
  | "newTaskOpen"
  | "newTaskDefaults"
  | "newProjectOpen"
  | "newGoalOpen"
  | "newGoalDefaults"
  | "newAgentOpen"
  | "onboardingOpen"
  | "onboardingRouteDismissed"
>;

type DialogActionsValue = Omit<DialogContextValue, keyof DialogStateValue>;

const DialogStateContext = createContext<DialogStateValue | null>(null);
const DialogActionsContext = createContext<DialogActionsValue | null>(null);

const initialDialogState: DialogStateValue = {
  newTaskOpen: false,
  newTaskDefaults: {},
  newProjectOpen: false,
  newGoalOpen: false,
  newGoalDefaults: {},
  newAgentOpen: false,
  onboardingOpen: false,
  onboardingRouteDismissed: false,
};

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialDialogState);

  const actionsValue = useMemo<DialogActionsValue>(
    () => ({
      openNewTask: (defaults = {}) =>
        setState((current) => ({
          ...current,
          newTaskOpen: true,
          newTaskDefaults: defaults,
        })),
      closeNewTask: () =>
        setState((current) => ({
          ...current,
          newTaskOpen: false,
          newTaskDefaults: {},
        })),
      openNewProject: () => setState((current) => ({ ...current, newProjectOpen: true })),
      closeNewProject: () => setState((current) => ({ ...current, newProjectOpen: false })),
      openNewGoal: (defaults = {}) =>
        setState((current) => ({
          ...current,
          newGoalOpen: true,
          newGoalDefaults: defaults,
        })),
      closeNewGoal: () =>
        setState((current) => ({
          ...current,
          newGoalOpen: false,
          newGoalDefaults: {},
        })),
      openNewAgent: () => setState((current) => ({ ...current, newAgentOpen: true })),
      closeNewAgent: () => setState((current) => ({ ...current, newAgentOpen: false })),
      openOnboarding: () => setState((current) => ({ ...current, onboardingOpen: true })),
      closeOnboarding: () => setState((current) => ({ ...current, onboardingOpen: false })),
      setOnboardingRouteDismissed: (onboardingRouteDismissed) =>
        setState((current) => ({
          ...current,
          onboardingRouteDismissed,
        })),
    }),
    [],
  );

  return (
    <DialogActionsContext.Provider value={actionsValue}>
      <DialogStateContext.Provider value={state}>{children}</DialogStateContext.Provider>
    </DialogActionsContext.Provider>
  );
}

export function useDialogActions() {
  const ctx = useContext(DialogActionsContext);
  if (!ctx) {
    throw new Error("useDialogActions must be used within DialogProvider");
  }
  return ctx;
}

export function useDialogState() {
  const ctx = useContext(DialogStateContext);
  if (!ctx) {
    throw new Error("useDialogState must be used within DialogProvider");
  }
  return ctx;
}

export function useDialog() {
  return {
    ...useDialogState(),
    ...useDialogActions(),
  };
}
