import type { AiErrorInfo, AiModel, CodingCapability, FreeTierStatus, ModelAvailability } from "@/types/ai";

/** Display helpers for the AI settings. Pure, so they are easy to test. */

export function formatTokens(value: number | null): string {
  return value === null ? "Not reported" : `${value.toLocaleString("en-US")} tokens`;
}

export function formatCoding(value: CodingCapability): string {
  return value === "specialized" ? "Code-focused (by name)" : "Not known";
}

/** Free-tier eligibility only. This says nothing about how much quota is left. */
export function formatFreeTier(value: FreeTierStatus): string {
  switch (value) {
    case "verified_free":
      return "Free tier (verified)";
    case "verified_not_free":
      return "Not free (verified)";
    default:
      return "Not verified";
  }
}

export function formatAvailability(model: Pick<AiModel, "availability">): string {
  const labels: Record<ModelAvailability, string> = { available: "Available", inactive: "Inactive", not_chat: "Not a chat model" };
  return labels[model.availability];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** What to do about an error, in one sentence. */
export function errorHint(error: AiErrorInfo): string | null {
  switch (error.kind) {
    case "invalid_key":
      return "Check that the key is complete and belongs to this provider.";
    case "permission_denied":
      return "The key is valid but not allowed to do this. Check the key's permissions or the provider's regional availability.";
    case "rate_limited":
      return error.retryAfterMs === null ? "Wait a little and try again." : `Try again in about ${formatDuration(error.retryAfterMs)}.`;
    case "model_not_found":
      return "Refresh the model list and pick a model that is still offered.";
    case "not_configured":
      return "Add an API key first.";
    case "network":
    case "provider_unavailable":
    case "timeout":
      return "This is usually temporary. Try again shortly.";
    default:
      return null;
  }
}

/** Models a user can choose as a default: the provider lists them as available chat models. */
export const isSelectable = (model: AiModel): boolean => model.availability === "available";
