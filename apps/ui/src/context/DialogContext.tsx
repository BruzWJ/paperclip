import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
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

interface OnboardingOptions {
  initialStep?: 1 | 2 | 3 | 4;
  companyId?: string;
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
  onboardingOptions: OnboardingOptions;
  openOnboarding: (options?: OnboardingOptions) => void;
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
  | "onboardingOptions"
  | "onboardingRouteDismissed"
>;

type DialogActionsValue = Omit<DialogContextValue, keyof DialogStateValue>;

const DialogStateContext = createContext<DialogStateValue | null>(null);
const DialogActionsContext = createContext<DialogActionsValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDefaults, setNewTaskDefaults] = useState<NewTaskDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoalDefaults, setNewGoalDefaults] = useState<NewGoalDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingOptions, setOnboardingOptions] = useState<OnboardingOptions>({});
  const [onboardingRouteDismissed, setOnboardingRouteDismissed] = useState(false);

  const openNewTask = useCallback((defaults: NewTaskDefaults = {}) => {
    setNewTaskDefaults(defaults);
    setNewTaskOpen(true);
  }, []);

  const closeNewTask = useCallback(() => {
    setNewTaskOpen(false);
    setNewTaskDefaults({});
  }, []);

  const openNewProject = useCallback(() => {
    setNewProjectOpen(true);
  }, []);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
  }, []);

  const openNewGoal = useCallback((defaults: NewGoalDefaults = {}) => {
    setNewGoalDefaults(defaults);
    setNewGoalOpen(true);
  }, []);

  const closeNewGoal = useCallback(() => {
    setNewGoalOpen(false);
    setNewGoalDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    setNewAgentOpen(true);
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openOnboarding = useCallback((options: OnboardingOptions = {}) => {
    setOnboardingOptions(options);
    setOnboardingOpen(true);
  }, []);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setOnboardingOptions({});
  }, []);

  const stateValue = useMemo<DialogStateValue>(
    () => ({
      newTaskOpen,
      newTaskDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
      onboardingRouteDismissed,
    }),
    [
      newTaskOpen,
      newTaskDefaults,
      newProjectOpen,
      newGoalOpen,
      newGoalDefaults,
      newAgentOpen,
      onboardingOpen,
      onboardingOptions,
      onboardingRouteDismissed,
    ],
  );

  const actionsValue = useMemo<DialogActionsValue>(
    () => ({
      openNewTask,
      closeNewTask,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
      setOnboardingRouteDismissed,
    }),
    [
      openNewTask,
      closeNewTask,
      openNewProject,
      closeNewProject,
      openNewGoal,
      closeNewGoal,
      openNewAgent,
      closeNewAgent,
      openOnboarding,
      closeOnboarding,
      setOnboardingRouteDismissed,
    ],
  );

  return (
    <DialogActionsContext.Provider value={actionsValue}>
      <DialogStateContext.Provider value={stateValue}>
        {children}
      </DialogStateContext.Provider>
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
