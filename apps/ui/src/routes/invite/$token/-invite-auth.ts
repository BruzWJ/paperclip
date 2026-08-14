import type { AuthMode } from "@/api/auth";

export type { AuthMode } from "@/api/auth";
export type AuthFeedback = { tone: "error" | "info"; message: string };
export function formatUserRole(role: string | null | undefined) {
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
}
export function getAuthErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}
function getAuthErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  return message.length > 0 ? message : null;
}
export function mapInviteAuthFeedback(error: unknown, authMode: AuthMode, email: string): AuthFeedback {
  const code = getAuthErrorCode(error);
  const message = getAuthErrorMessage(error);
  const emailLabel = email.trim().length > 0 ? email.trim() : "that email";
  if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")
    return {
      tone: "info",
      message: `An account already exists for ${emailLabel}. Sign in below to continue with this invite.`,
    };
  if (code === "INVALID_EMAIL_OR_PASSWORD" || (authMode === "sign_in" && message === "Request failed: 401"))
    return {
      tone: "error",
      message:
        "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
    };
  if (authMode === "sign_up" && message === "Request failed: 422")
    return {
      tone: "info",
      message: `An account may already exist for ${emailLabel}. Try signing in instead.`,
    };
  return { tone: "error", message: message ?? "Authentication failed" };
}
export function isBootstrapAcceptancePayload(payload: unknown) {
  return Boolean(
    payload && typeof payload === "object" && "bootstrapAccepted" in (payload as Record<string, unknown>),
  );
}
export function isApprovedUserJoinPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { status?: unknown }).status === "approved";
}
