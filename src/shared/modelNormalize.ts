import type { UsageRecord } from "./types";

const effortSuffix =
  /-(?:extra-low|xhigh|very-high|high|medium|low|minimal|tiered|thinking|control|agent|orchestrator)$/i;

export function qualifyModelId(providerId: string, model: string): string {
  if (!providerId) return model;
  const prefix = `${providerId}/`;
  return model.toLowerCase().startsWith(prefix) ? `${prefix}${model.slice(prefix.length)}` : `${prefix}${model}`;
}

function stripEffort(model: string): string {
  return model.replace(effortSuffix, "").replace(effortSuffix, "") || model;
}

export function normalizeModelId(provider: UsageRecord["provider"], rawModel: string): string {
  const model = rawModel.trim();
  const slash = model.indexOf("/");
  if (slash !== -1) {
    const prefix = model.slice(0, slash).toLowerCase();
    const rest = model.slice(slash + 1).trim();
    return rest ? `${prefix}/${stripEffort(rest)}` : model;
  }
  if (provider === "antigravity") {
    const route = model.toLowerCase();
    if (route === "gemini-pro-orchestrator-neon") return "gemini-4-neon";
    if (route === "gemini-pro-orchestrator-g1-pro") return "gemini-4-argon";
    if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(route)) return "gemini-3.5-flash";
    if (route === "gemini-3.7-flash-safety-le") return "gemini-3.7-flash";
  }
  return stripEffort(model);
}
