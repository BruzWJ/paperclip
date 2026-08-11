export type TaskDisplaySource = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  request?: string | null;
};

const TASK_REQUEST_LABEL_MAX_CHARS = 120;

export function taskDisplayTitle(task: TaskDisplaySource): string {
  const title = task.title?.trim();
  if (title) return title;
  const identifier = task.identifier?.trim();
  if (identifier) return identifier;
  const request = task.request?.trim().replace(/\s+/g, " ");
  if (!request) return `Task ${task.id}`;
  if (request.length <= TASK_REQUEST_LABEL_MAX_CHARS) return request;
  return `${request.slice(0, TASK_REQUEST_LABEL_MAX_CHARS - 3).trimEnd()}...`;
}

export function taskReferenceLabel(task: TaskDisplaySource): string {
  return task.identifier?.trim() || taskDisplayTitle(task);
}
