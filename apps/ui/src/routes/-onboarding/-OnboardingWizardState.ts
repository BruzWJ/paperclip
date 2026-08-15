export type Step = 0 | 1 | 2;

export const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace",
];

export function buildMissionFromQuestionnaire(q1: string, q2: string, q3: string, q4: string): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim()) parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

export const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

export function loadSavedState(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
