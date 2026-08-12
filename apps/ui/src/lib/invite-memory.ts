const PENDING_INVITE_STORAGE_KEY = "paperclip:pending-invite-token";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function rememberPendingInviteToken(token: string) {
  if (!/\S/.test(token) || !canUseStorage()) return;
  try {
    window.localStorage.setItem(PENDING_INVITE_STORAGE_KEY, token);
  } catch {
    // Ignore storage failures and keep the invite flow usable.
  }
}

export function clearPendingInviteToken(expectedToken?: string) {
  if (!canUseStorage()) return;
  try {
    const current = window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    if (expectedToken !== undefined && current !== expectedToken) return;
    window.localStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function getRememberedInviteToken() {
  if (!canUseStorage()) return null;
  try {
    const token = window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    return token !== null && /\S/.test(token) ? token : null;
  } catch {
    return null;
  }
}
