import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PricePreset } from "../../shared/types";
import { project, type Shape } from "./opencodePricing";

type Row = Record<string, unknown>;

const MODELS_DEV_URL = "https://models.dev/api.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const CATALOG_VERSION = 4;
const COLD_START_AGE_DAYS = 730;
// Derived / vertical sub-variants must never ride on the parent model's adoption.
const DERIVED_VARIANT = /(?:^|[-_./])(?:highspeed|flashx|healthcare|legal|customtools|contributor|vision-exp|free)(?:$|[-_./])/i;
const LIGHT_TIER = /(?:^|[-_./])(?:flash|lite|mini|nano|haiku)(?:$|[-_./])/i;

type ProviderTier = "A" | "B";
interface ProviderSpec {
  id: string;
  label: string;
  tier: ProviderTier;
  // Tier A: first-party canonical owners. Tier B: owners of domestic-only models.
  owners: string[];
}
type RankedProvider = ProviderSpec & { rank: number };

// Fixed popularity order: Tier A first-party storefronts, then mainstream
// regional storefronts and gateways. Everything else is filtered out.
const PROVIDERS: ProviderSpec[] = [
  { id: "openai", label: "OpenAI", tier: "A", owners: ["openai"] },
  { id: "anthropic", label: "Anthropic", tier: "A", owners: ["anthropic"] },
  { id: "google", label: "Google", tier: "A", owners: ["google"] },
  { id: "deepseek", label: "DeepSeek", tier: "A", owners: ["deepseek"] },
  { id: "alibaba", label: "Alibaba", tier: "A", owners: ["alibaba"] },
  { id: "moonshotai", label: "Moonshot AI", tier: "A", owners: ["moonshotai"] },
  { id: "zai", label: "Zhipu AI", tier: "A", owners: ["zhipuai", "zai"] },
  { id: "minimax", label: "MiniMax", tier: "A", owners: ["minimax"] },
  { id: "xai", label: "xAI", tier: "A", owners: ["xai"] },
  { id: "mistral", label: "Mistral", tier: "A", owners: ["mistral"] },
  { id: "volcengine", label: "ByteDance", tier: "A", owners: ["bytedance-seed", "volcengine"] },
  { id: "stepfun-ai", label: "StepFun", tier: "A", owners: ["stepfun"] },
  { id: "xiaomi", label: "Xiaomi", tier: "A", owners: ["xiaomi"] },
  { id: "tencent-tokenhub", label: "Tencent", tier: "A", owners: ["tencent"] },
  { id: "cohere", label: "Cohere", tier: "A", owners: ["cohere"] },
  { id: "meta", label: "Meta", tier: "A", owners: ["meta"] },
  { id: "alibaba-cn", label: "Alibaba (China)", tier: "B", owners: ["alibaba"] },
  { id: "siliconflow-cn", label: "SiliconFlow (China)", tier: "B", owners: [] },
  { id: "siliconflow", label: "SiliconFlow", tier: "B", owners: [] },
  { id: "moonshotai-cn", label: "Moonshot AI (China)", tier: "B", owners: ["moonshotai"] },
  { id: "zhipuai", label: "Zhipu AI (China)", tier: "B", owners: ["zhipuai", "zai"] },
  { id: "minimax-cn", label: "MiniMax (China)", tier: "B", owners: ["minimax"] },
  { id: "stepfun", label: "StepFun (China)", tier: "B", owners: ["stepfun"] },
  { id: "openrouter", label: "OpenRouter", tier: "B", owners: [] },
  { id: "opencode", label: "OpenCode", tier: "B", owners: [] },
  { id: "opencode-go", label: "OpenCode Go", tier: "B", owners: [] },
  { id: "google-vertex", label: "Google Vertex", tier: "B", owners: [] },
  { id: "amazon-bedrock", label: "Amazon Bedrock", tier: "B", owners: [] },
  { id: "azure", label: "Azure", tier: "B", owners: [] },
  { id: "fireworks-ai", label: "Fireworks AI", tier: "B", owners: [] },
  { id: "togetherai", label: "Together AI", tier: "B", owners: [] },
  { id: "deepinfra", label: "Deep Infra", tier: "B", owners: [] },
];

const rankedProviders: RankedProvider[] = PROVIDERS.map((spec, rank) => ({ ...spec, rank }));
const providerById = new Map(rankedProviders.map((provider) => [provider.id, provider]));
const allOwners = [...new Set(PROVIDERS.flatMap(({ owners }) => owners))];

const presetAmounts: Record<string, Shape> = {
  input: "number",
  output: "number",
  cache_read: "number",
  cache_write: "number",
  cache: { fields: { read: "number", write: "number" } },
};
const presetTier: Shape = {
  fields: { ...presetAmounts, tier: { fields: { type: "string", size: "number" } } },
};
const presetCost: Shape = { items: presetTier, fields: presetAmounts };
// Only canonical IDs, release dates, output modalities and costs are trusted.
const presetProvider: Shape = {
  fields: {
    models: {
      entries: {
        fields: {
          canonical_model_id: "string",
          release_date: "string",
          modalities: { fields: { output: { items: "string" } } },
          cost: presetCost,
        },
      },
    },
  },
};
const presetProviders: Shape = {
  fields: Object.fromEntries(PROVIDERS.map(({ id }) => [id, presetProvider])),
};
// Whitelisted projection of the whole catalogue: canonical IDs only.
const adoptionProviders: Shape = {
  entries: { fields: { models: { entries: { fields: { canonical_model_id: "string" } } } } },
};

const asObject = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;

const validAmount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const roundMillion = (value: number): number => Number(value.toPrecision(10));

const ownerOf = (canonicalId: string): string => {
  const slash = canonicalId.indexOf("/");
  return slash > 0 ? canonicalId.slice(0, slash) : "";
};

interface ExtractedCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function extractBaseCost(raw: unknown): ExtractedCost | undefined {
  let entry = asObject(raw);
  if (Array.isArray(raw)) {
    entry = undefined;
    for (const item of raw) {
      const candidate = asObject(item);
      if (candidate && !Object.hasOwn(candidate, "tier")) {
        entry = candidate;
        break;
      }
    }
  }
  const input = validAmount(entry?.input);
  const output = validAmount(entry?.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = asObject(entry?.cache);
  const cacheRead = validAmount(cache?.read) ?? validAmount(entry?.cache_read);
  const cacheWrite = validAmount(cache?.write) ?? validAmount(entry?.cache_write);
  return {
    input: roundMillion(input),
    output: roundMillion(output),
    ...(cacheRead === undefined ? {} : { cacheRead: roundMillion(cacheRead) }),
    ...(cacheWrite === undefined ? {} : { cacheWrite: roundMillion(cacheWrite) }),
  };
}

function splitCanonical(raw: unknown): readonly [string, string] | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  return [value.slice(0, slash), value.slice(slash + 1)];
}

function releaseTime(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

function outputModalities(raw: unknown): string[] {
  const output = asObject(raw)?.output;
  return Array.isArray(output) ? output.filter((item): item is string => typeof item === "string") : [];
}

function collectAdoption(raw: unknown): Record<string, number> {
  const providers = asObject(raw);
  const adoption: Record<string, number> = {};
  for (const provider of Object.values(providers ?? {})) {
    const seen = new Set<string>();
    const models = asObject(asObject(provider)?.models);
    for (const model of Object.values(models ?? {})) {
      const canonical = splitCanonical(asObject(model)?.canonical_model_id);
      if (!canonical) continue;
      const id = `${canonical[0]}/${canonical[1]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      adoption[id] = (adoption[id] ?? 0) + 1;
    }
  }
  return adoption;
}

interface RawRow {
  provider: RankedProvider;
  key: string;
  bareKey: string;
  explicit: readonly [string, string] | undefined;
  cost: ExtractedCost | undefined;
  releaseMs: number | undefined;
  outputs: string[];
}

interface Candidate extends Omit<RawRow, "cost"> {
  cost: ExtractedCost;
  canonicalId: string;
  canonicalSlug: string;
  isCanonicalOwner: boolean;
  regional: boolean;
  routerAlias: boolean;
  derived: boolean;
  daysOld: number;
  multimodal: boolean;
  popularity: number;
}

// Log compression keeps the in-vendor score about the mainstream rank instead of
// the number of third-party hosts an open model happens to have.
function scorePopularity(
  adoptionCount: number,
  daysOld: number,
  key: string,
  derived: boolean,
  multimodal: boolean
): number {
  const tierWeight = derived ? 0.25 : LIGHT_TIER.test(key) ? 0.85 : 1;
  return Number((
    Math.log2(adoptionCount + 2) *
    Math.exp(-daysOld / 180) *
    tierWeight *
    (multimodal ? 0.05 : 1)
  ).toPrecision(6));
}

function collectProviderPresets(rawProviders: unknown, adoption: Record<string, number>): PricePreset[] {
  const providers = asObject(rawProviders);
  const rows: RawRow[] = [];
  const claims = new Map<string, string>();
  let maxReleaseMs = 0;

  for (const provider of rankedProviders) {
    const models = asObject(asObject(providers?.[provider.id])?.models);
    for (const [mid, model] of Object.entries(models ?? {})) {
      const key = mid.trim().toLowerCase();
      if (!key) continue;
      const row = asObject(model) ?? {};
      const explicit = splitCanonical(row.canonical_model_id);
      const bareKey = key.slice(key.lastIndexOf("/") + 1);
      const releaseMs = releaseTime(row.release_date);
      if (releaseMs !== undefined && releaseMs > maxReleaseMs) maxReleaseMs = releaseMs;
      if (explicit) {
        for (const claim of new Set([explicit[1], bareKey, key])) {
          if (!claims.has(claim)) claims.set(claim, explicit[0]);
        }
      }
      rows.push({
        provider,
        key,
        bareKey,
        explicit,
        cost: extractBaseCost(row.cost),
        releaseMs,
        outputs: outputModalities(row.modalities),
      });
    }
  }

  // Only a brand prefix on a slug that vendor actually lists counts as ownership evidence.
  const brandedSlugs = new Map<string, string>();
  for (const { bareKey } of rows) {
    const owner = allOwners.find((name) => ["-", "_", "."].some((separator) => bareKey.startsWith(name + separator)));
    if (owner) brandedSlugs.set(bareKey, owner);
  }

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const { provider, key, bareKey, explicit, cost, releaseMs, outputs } = row;
    if (!cost) continue;
    // Pure image / audio / video and vector or rerank models are not chat models.
    if (outputs.length > 0 && !outputs.includes("text")) continue;
    if (cost.output === 0 && /(?:embed|rerank)/i.test(key)) continue;

    const slash = key.lastIndexOf("/");
    const keyPrefix = slash > 0 ? key.slice(0, slash) : "";
    const [owner, slug] = explicit
      ?? [claims.get(bareKey) ?? brandedSlugs.get(bareKey) ?? (keyPrefix || provider.owners[0] || provider.id), bareKey];
    const canonicalId = `${owner}/${slug}`;
    const multimodal = outputs.some((item) => item !== "text");
    const daysOld = releaseMs === undefined
      ? COLD_START_AGE_DAYS
      : Math.max(0, (maxReleaseMs - releaseMs) / 86_400_000);
    const derived = DERIVED_VARIANT.test(key) || DERIVED_VARIANT.test(slug);
    const popularity = scorePopularity(adoption[canonicalId] ?? 1, daysOld, key, derived, multimodal);
    candidates.push({
      provider,
      key,
      bareKey,
      explicit,
      cost,
      releaseMs,
      outputs,
      canonicalId,
      canonicalSlug: slug,
      isCanonicalOwner: provider.tier === "A" && provider.owners.includes(owner),
      regional: /^(?:us|eu|au|jp|apac)\./.test(key),
      routerAlias: key.includes("/routers/"),
      derived,
      daysOld,
      multimodal,
      popularity,
    });
  }

  const byProvider = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const list = byProvider.get(candidate.provider.rank) ?? [];
    list.push(candidate);
    byProvider.set(candidate.provider.rank, list);
  }

  const presets: PricePreset[] = [];
  for (const group of byProvider.values()) {
    // Canonical directory rows first; regional and router copies collapse later.
    group.sort((a, b) =>
      Number(a.regional) - Number(b.regional) ||
      Number(a.routerAlias) - Number(b.routerAlias) ||
      Number(a.key !== a.canonicalSlug) - Number(b.key !== b.canonicalSlug) ||
      a.key.localeCompare(b.key));

    const merged = new Map<string, PricePreset>();
    const pid = group[0].provider.id;
    for (const candidate of group) {
      const providerLabel = candidate.provider.label;
      const existing = merged.get(candidate.canonicalId);
      if (!existing) {
        const modelId = candidate.isCanonicalOwner && pid === ownerOf(candidate.canonicalId)
          ? `${pid}/${candidate.canonicalSlug}`
          : `${pid}/${candidate.key}`;
        const preset = makePreset(candidate, modelId, candidate.canonicalId, providerLabel,
          candidate.key === candidate.canonicalSlug ? undefined : [candidate.key]);
        merged.set(candidate.canonicalId, preset);
        presets.push(preset);
        continue;
      }
      if (candidate.regional || candidate.routerAlias) {
        addAlias(existing, candidate.key);
        continue;
      }
      // A same-provider sub-model sharing the canonical ID but priced differently is a real variant.
      if (candidate.key !== candidate.canonicalSlug && !sameCost(existing, candidate.cost)) {
        const variantId = `${candidate.canonicalId}:${candidate.key}`;
        if (!merged.has(variantId)) {
          // A split variant is derived and scores on its own adoption of 1, never the parent's.
          const variantCandidate: Candidate = {
            ...candidate,
            derived: true,
            popularity: scorePopularity(1, candidate.daysOld, candidate.key, true, candidate.multimodal),
          };
          const variant = makePreset(variantCandidate, `${pid}/${candidate.key}`, variantId, providerLabel);
          merged.set(variantId, variant);
          presets.push(variant);
        }
        continue;
      }
      if (candidate.key !== candidate.canonicalSlug) addAlias(existing, candidate.key);
    }
  }

  markPrimary(presets);
  return presets.sort((a, b) =>
    (b.popularity ?? 0) - (a.popularity ?? 0) ||
    Number(b.isCanonicalOwner) - Number(a.isCanonicalOwner) ||
    (a.providerRank ?? 999) - (b.providerRank ?? 999) ||
    a.modelId.localeCompare(b.modelId));
}

function makePreset(
  candidate: Candidate,
  modelId: string,
  canonicalId: string,
  providerLabel: string,
  aliases?: string[]
): PricePreset {
  return {
    id: `models.dev:${modelId}`,
    modelId,
    label: modelId,
    providerId: candidate.provider.id,
    providerLabel,
    providerRank: candidate.provider.rank,
    canonicalId,
    isCanonicalOwner: candidate.isCanonicalOwner,
    popularity: candidate.popularity,
    primary: false,
    ...(candidate.derived ? { derived: true } : {}),
    source: "models.dev",
    ...(aliases === undefined ? {} : { aliases }),
    inputCostPerMillionTokens: candidate.cost.input,
    outputCostPerMillionTokens: candidate.cost.output,
    ...(candidate.cost.cacheRead === undefined ? {} : { cacheReadCostPerMillionTokens: candidate.cost.cacheRead }),
    ...(candidate.cost.cacheWrite === undefined ? {} : { cacheWriteCostPerMillionTokens: candidate.cost.cacheWrite }),
  };
}

function addAlias(preset: PricePreset, alias: string) {
  if (!alias || alias === preset.modelId || preset.aliases?.includes(alias)) return;
  (preset.aliases ??= []).push(alias);
}

function sameCost(preset: PricePreset, cost: ExtractedCost): boolean {
  return preset.inputCostPerMillionTokens === cost.input &&
    preset.outputCostPerMillionTokens === cost.output &&
    preset.cacheReadCostPerMillionTokens === cost.cacheRead &&
    preset.cacheWriteCostPerMillionTokens === cost.cacheWrite;
}

function markPrimary(presets: PricePreset[]) {
  const groups = new Map<string, PricePreset[]>();
  for (const preset of presets) {
    const canonicalId = preset.canonicalId ?? preset.modelId;
    const list = groups.get(canonicalId) ?? [];
    list.push(preset);
    groups.set(canonicalId, list);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      Number(b.isCanonicalOwner) - Number(a.isCanonicalOwner) ||
      (a.providerRank ?? 999) - (b.providerRank ?? 999) ||
      (b.popularity ?? 0) - (a.popularity ?? 0) ||
      a.modelId.localeCompare(b.modelId));
    const representative = group.find(isPrimaryCandidate);
    for (const preset of group) preset.primary = preset === representative;
  }
}

function isPrimaryCandidate(preset: PricePreset): boolean {
  if (preset.isCanonicalOwner) return true;
  const provider = providerById.get(preset.providerId ?? "");
  if (provider?.tier !== "B" || provider.owners.length === 0) return false;
  return provider.owners.includes(ownerOf(preset.canonicalId ?? ""));
}

function readAdoption(raw: unknown): Record<string, number> {
  const adoption: Record<string, number> = {};
  for (const [id, value] of Object.entries(asObject(raw) ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) adoption[id] = value;
  }
  return adoption;
}

async function readCachedModelsDev(
  cachePath: string
): Promise<{ presets: PricePreset[]; fresh: boolean } | null> {
  try {
    const snapshot = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
    const root = asObject(snapshot);
    // Older projections lack adoption counts and the metadata used for ranking.
    if (root?.version !== CATALOG_VERSION) return null;
    const catalog = asObject(root?.catalog);
    if (!catalog) return null;
    const presets = collectProviderPresets(catalog, readAdoption(root?.adoption));
    if (presets.length === 0) return null;
    const fetchedAt = typeof root?.fetchedAt === "string" ? Date.parse(root.fetchedAt) : NaN;
    const age = Number.isFinite(fetchedAt) ? Date.now() - fetchedAt : Infinity;
    return { presets, fresh: age >= 0 && age < TTL_MS };
  } catch {
    return null;
  }
}

const pendingFetch = new Map<string, Promise<PricePreset[]>>();
const retryAfter = new Map<string, number>();

async function fetchModelsDev(userData: string, cachePath: string): Promise<PricePreset[]> {
  try {
    const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return [];
    const text = await response.text();
    // The whitelisted projections never decode apiKey, baseURL, headers, options or name.
    const adoption = collectAdoption(project(text, adoptionProviders, false));
    const catalog = asObject(project(text, presetProviders, false));
    if (!catalog) return [];
    const presets = collectProviderPresets(catalog, adoption);
    if (presets.length === 0) return [];
    const partial = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(userData, { recursive: true });
      await writeFile(partial, JSON.stringify({
        version: CATALOG_VERSION,
        source: MODELS_DEV_URL,
        fetchedAt: new Date().toISOString(),
        adoption,
        catalog,
      }), "utf8");
      await rename(partial, cachePath);
    } catch {
      await rm(partial, { force: true }).catch(() => {});
    }
    return presets;
  } catch {
    return [];
  }
}

async function readModelsDevPresets(userData: string): Promise<PricePreset[]> {
  const cachePath = join(userData, "models-dev-cache.json");
  const cached = await readCachedModelsDev(cachePath);
  if (cached?.fresh) return cached.presets;

  let inflight = pendingFetch.get(cachePath);
  if (!inflight && Date.now() >= (retryAfter.get(cachePath) ?? 0)) {
    inflight = fetchModelsDev(userData, cachePath).then((fresh) => {
      if (fresh.length === 0) retryAfter.set(cachePath, Date.now() + 60_000);
      return fresh;
    }).finally(() => pendingFetch.delete(cachePath));
    pendingFetch.set(cachePath, inflight);
  }
  const fetched = inflight ? await inflight : [];
  return fetched.length > 0 ? fetched : (cached?.presets ?? []);
}

export async function loadPricePresets({ userData }: { userData: string }): Promise<PricePreset[]> {
  return readModelsDevPresets(userData);
}