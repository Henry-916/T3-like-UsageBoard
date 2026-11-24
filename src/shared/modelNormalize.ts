import type { UsageRecord } from "./types";

const effortSuffix =
  /-(?:extra-low|xhigh|very-high|high|medium|low|minimal|tiered|thinking|control|agent|orchestrator)$/i;

export function normalizeModelId(provider: UsageRecord["provider"], rawModel: string): string {
  const model = rawModel.trim();
  if (provider === "antigravity") {
    const route = model.toLowerCase();
    if (route === "gemini-pro-orchestrator-neon") return "gemini-4-neon";
    if (route === "gemini-pro-orchestrator-g1-pro") return "gemini-4-argon";
    if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(route)) return "gemini-3.5-flash";
    if (route === "gemini-3.7-flash-safety-le") return "gemini-3.7-flash";
  }
  return model.replace(effortSuffix, "").replace(effortSuffix, "") || model;
}
