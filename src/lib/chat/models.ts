import type { AiModel, ModelCatalog, ProviderId, ProviderStatus } from "@/types/ai";

/** Models the user may pick for a chat: listed by the provider and able to generate text. */
export function selectableModels(catalogs: readonly ModelCatalog[], provider: ProviderId | null): AiModel[] {
  if (provider === null) return [];
  return (catalogs.find((c) => c.provider === provider)?.models ?? []).filter((m) => m.availability === "available");
}

export function configuredProviders(providers: readonly ProviderStatus[]): ProviderStatus[] {
  return providers.filter((p) => p.configured);
}

export const PROVIDER_LABELS: Record<ProviderId, string> = { gemini: "Google Gemini", groq: "Groq" };
