import { type Goal, type Project } from "@paperclipai/shared";

export const ONBOARDING_PROJECT_NAME = "Onboarding";

function goalCreatedAt(goal: Goal) {
  const createdAt = goal.createdAt instanceof Date ? goal.createdAt : new Date(goal.createdAt);
  return Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime();
}

function pickEarliestGoal(goals: Goal[]) {
  return [...goals].sort((a, b) => goalCreatedAt(a) - goalCreatedAt(b))[0] ?? null;
}

export function selectDefaultCompanyGoalId(goals: Goal[]): string | null {
  const companyGoals = goals.filter((goal) => goal.level === "company");
  const rootGoals = companyGoals.filter((goal) => !goal.parentId);
  const activeRootGoals = rootGoals.filter((goal) => goal.status === "active");

  return (
    pickEarliestGoal(activeRootGoals)?.id ??
    pickEarliestGoal(rootGoals)?.id ??
    pickEarliestGoal(companyGoals)?.id ??
    null
  );
}

export function buildOnboardingProjectPayload(goalId: string | null) {
  return {
    name: ONBOARDING_PROJECT_NAME,
    status: "in_progress" as const,
    ...(goalId ? { goalIds: [goalId] } : {}),
  };
}

export function selectReusableOnboardingProject<T extends Pick<Project, "name" | "status">>(
  projects: T[],
): T | null {
  return (
    projects.find(
      (project) =>
        project.status !== "cancelled" &&
        project.name.trim().toLowerCase() === ONBOARDING_PROJECT_NAME.toLowerCase(),
    ) ?? null
  );
}

export function buildOnboardingIssuePayload(input: {
  title: string;
  request: string;
  ownerAgentId: string;
  projectId: string;
  goalId: string | null;
}) {
  const title = input.title.trim();
  if (input.request.trim().length === 0) {
    throw new Error("The first issue request must contain non-whitespace text");
  }
  return {
    ...(title ? { title } : {}),
    request: input.request,
    ownerAgentId: input.ownerAgentId,
    idempotencyKey: `onboarding:${input.projectId}:${input.ownerAgentId}`,
    projectId: input.projectId,
    ...(input.goalId ? { goalId: input.goalId } : {}),
  };
}
