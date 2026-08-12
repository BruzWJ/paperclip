export type TaskDisplaySource = {
  id?: string;
  identifier: string;
  title?: string | null;
};

export function taskDisplayTitle(task: TaskDisplaySource): string {
  const title = task.title?.trim();
  if (title) return title;
  return task.identifier;
}

export function taskReferenceLabel(task: TaskDisplaySource): string {
  return task.identifier;
}
