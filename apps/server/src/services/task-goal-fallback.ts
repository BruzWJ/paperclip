type MaybeId = string | null | undefined;

export function resolveNextTaskGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;

  const resolveFallbackGoalId = (targetProjectId: MaybeId) => {
    if (targetProjectId) return null;
    return input.defaultGoalId ?? null;
  };

  if (input.goalId !== undefined) {
    return input.goalId ?? resolveFallbackGoalId(projectId);
  }

  const currentFallbackGoalId = resolveFallbackGoalId(input.currentProjectId);
  const nextFallbackGoalId = resolveFallbackGoalId(projectId);

  if (!input.currentGoalId) {
    return nextFallbackGoalId;
  }

  if (input.currentGoalId === currentFallbackGoalId) {
    return nextFallbackGoalId;
  }

  return input.currentGoalId;
}
