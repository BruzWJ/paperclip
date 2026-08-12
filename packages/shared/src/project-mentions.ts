import { isCanonicalUuid } from "./canonical-uuid.js";

export const PROJECT_MENTION_SCHEME = "project://";
export const AGENT_MENTION_SCHEME = "agent://";
export const USER_MENTION_SCHEME = "user://";
export const ROUTINE_MENTION_SCHEME = "routine://";

const HEX_COLOR_WITH_HASH_RE = /^#[0-9a-f]{6}$/;
const PROJECT_MENTION_LINK_RE = /\[[^\]]*]\((project:\/\/[^)\s]+)\)/gi;
const AGENT_MENTION_LINK_RE = /\[[^\]]*]\((agent:\/\/[^)\s]+)\)/gi;
const USER_MENTION_LINK_RE = /\[[^\]]*]\((user:\/\/[^)\s]+)\)/gi;
const ROUTINE_MENTION_LINK_RE = /\[[^\]]*]\((routine:\/\/[^)\s]+)\)/gi;
const AGENT_ICON_NAME_RE = /^[a-z0-9-]+$/;

export interface ParsedProjectMention {
  projectId: string;
  color: string | null;
}

export interface ParsedAgentMention {
  agentId: string;
  icon: string | null;
}

export interface ParsedUserMention {
  userId: string;
}

export interface ParsedRoutineMention {
  routineId: string;
}

function requireCanonicalUuid(value: string, kind: string): string {
  if (!isCanonicalUuid(value)) {
    throw new TypeError(`${kind} mention requires a canonical UUID.`);
  }
  return value;
}

function encodeOpaqueId(value: string): string {
  if (value.length === 0) {
    throw new TypeError("User mention requires an exact non-empty user ID.");
  }
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildProjectMentionHref(
  projectId: string,
  color?: string | null,
): string {
  const canonicalProjectId = requireCanonicalUuid(projectId, "Project");
  if (color == null) {
    return `${PROJECT_MENTION_SCHEME}${canonicalProjectId}`;
  }
  if (!HEX_COLOR_WITH_HASH_RE.test(color)) {
    throw new TypeError(
      "Project mention color must be an exact lowercase six-digit hex color.",
    );
  }
  return `${PROJECT_MENTION_SCHEME}${canonicalProjectId}?c=${color.slice(1)}`;
}

export function parseProjectMentionHref(
  href: string,
): ParsedProjectMention | null {
  const match = /^project:\/\/([0-9a-f-]+)(?:\?c=([0-9a-f]{6}))?$/.exec(href);
  if (!match || !isCanonicalUuid(match[1])) return null;

  return {
    projectId: match[1],
    color: match[2] ? `#${match[2]}` : null,
  };
}

export function buildAgentMentionHref(
  agentId: string,
  icon?: string | null,
): string {
  const canonicalAgentId = requireCanonicalUuid(agentId, "Agent");
  if (icon == null) {
    return `${AGENT_MENTION_SCHEME}${canonicalAgentId}`;
  }
  if (!AGENT_ICON_NAME_RE.test(icon)) {
    throw new TypeError(
      "Agent mention icon must be an exact lowercase icon name.",
    );
  }
  return `${AGENT_MENTION_SCHEME}${canonicalAgentId}?i=${icon}`;
}

export function parseAgentMentionHref(href: string): ParsedAgentMention | null {
  const match = /^agent:\/\/([0-9a-f-]+)(?:\?i=([a-z0-9-]+))?$/.exec(href);
  if (!match || !isCanonicalUuid(match[1])) return null;

  return {
    agentId: match[1],
    icon: match[2] ?? null,
  };
}

export function buildUserMentionHref(userId: string): string {
  return `${USER_MENTION_SCHEME}${encodeOpaqueId(userId)}`;
}

export function parseUserMentionHref(href: string): ParsedUserMention | null {
  if (!href.startsWith(USER_MENTION_SCHEME)) return null;
  const encodedUserId = href.slice(USER_MENTION_SCHEME.length);
  if (!encodedUserId || /[?#]/.test(encodedUserId)) return null;

  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return null;
  }
  if (!userId || encodeOpaqueId(userId) !== encodedUserId) return null;

  return { userId };
}

export function buildRoutineMentionHref(routineId: string): string {
  return `${ROUTINE_MENTION_SCHEME}${requireCanonicalUuid(routineId, "Routine")}`;
}

export function parseRoutineMentionHref(
  href: string,
): ParsedRoutineMention | null {
  const match = /^routine:\/\/([0-9a-f-]+)$/.exec(href);
  return match && isCanonicalUuid(match[1]) ? { routineId: match[1] } : null;
}

export function extractProjectMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(PROJECT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseProjectMentionHref(match[1]);
    if (parsed) ids.add(parsed.projectId);
  }
  return [...ids];
}

export function extractAgentMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed) ids.add(parsed.agentId);
  }
  return [...ids];
}

export function extractUserMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(USER_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseUserMentionHref(match[1]);
    if (parsed) ids.add(parsed.userId);
  }
  return [...ids];
}

export function extractRoutineMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(ROUTINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseRoutineMentionHref(match[1]);
    if (parsed) ids.add(parsed.routineId);
  }
  return [...ids];
}
