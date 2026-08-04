export type IssueDisplaySource = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  request?: string | null;
};

const ISSUE_REQUEST_LABEL_MAX_CHARS = 120;

export function issueDisplayTitle(issue: IssueDisplaySource): string {
  const title = issue.title?.trim();
  if (title) return title;
  const identifier = issue.identifier?.trim();
  if (identifier) return identifier;
  const request = issue.request?.trim().replace(/\s+/g, " ");
  if (!request) return `Issue ${issue.id}`;
  if (request.length <= ISSUE_REQUEST_LABEL_MAX_CHARS) return request;
  return `${request.slice(0, ISSUE_REQUEST_LABEL_MAX_CHARS - 3).trimEnd()}...`;
}

export function issueReferenceLabel(issue: IssueDisplaySource): string {
  return issue.identifier?.trim() || issueDisplayTitle(issue);
}
