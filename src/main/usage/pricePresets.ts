import type { PricePreset, RateMultiplier } from "../../shared/types";
import { sameMultipliers, timeScheduleMultipliers } from "../../shared/pricingMultipliers";
import { loadModelsDevSnapshot, snapshotRate } from "./modelsDev";
import type { ModelsDevSnapshot } from "./modelsDev";
import { PRESET_PROVIDERS } from "./modelsDevProviders";
import type { ProviderSpec } from "./modelsDevProviders";
import type { ModelRate } from "./rateModel";

type Row = Record<string, unknown>;

const COLD_START_AGE_DAYS = 730;
// Derived / vertical sub-variants must never ride on the parent model's adoption.
const DERIVED_VARIANT = /(?:^|[-_./])(?:highspeed|flashx|healthcare|legal|customtools|contributor|vision-exp|free)(?:$|[-_./])/i;
const LIGHT_TIER = /(?:^|[-_./])(?:flash|lite|mini|nano|haiku)(?:$|[-_./])/i;

type RankedProvider = ProviderSpec & { rank: number };

// Fixed popularity order: Tier A first-party storefronts, then mainstream
// regional storefronts and gateways. Everything else is filtered out.
const rankedProviders: RankedProvider[] = PRESET_PROVIDERS.map((spec, rank) => ({ ...spec, rank }));
const providerById = new Map(rankedProviders.map((provider) => [provider.id, provider]));
const allOwners = [...new Set(PRESET_PROVIDERS.flatMap(({ owners }) => owners))];

const asObject = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;

const ownerOf = (canonicalId: string): string => {
  const slash = canonicalId.indexOf("/");
  return slash > 0 ? canonicalId.slice(0, slash) : "";
};

interface ExtractedCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  multipliers?: RateMultiplier[];
}

const perMillion = (value: number): number => Number((value * 1e6).toPrecision(10));

function extractedCost(rate: ModelRate): ExtractedCost {
  const multipliers = timeScheduleMultipliers(rate.multipliers);
  return {
    input: perMillion(rate.standard.input),
    output: perMillion(rate.standard.output),
    cacheRead: perMillion(rate.standard.cacheRead),
    cacheWrite: perMillion(rate.standard.cacheWrite),
    ...(multipliers.length ? { multipliers } : {}),
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
  const output = raw;
  return Array.isArray(output) ? output.filter((item): item is string => typeof item === "string") : [];
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

function collectProviderPresets(snapshot: ModelsDevSnapshot): PricePreset[] {
  const providers = snapshot.catalog;
  const rows: RawRow[] = [];
  const claims = new Map<string, string>();
  let maxReleaseMs = 0;

  for (const provider of rankedProviders) {
    const models = asObject(providers?.[provider.id])?.models;
    for (const [mid, model] of Object.entries(asObject(models) ?? {})) {
      const key = mid.trim().toLowerCase();
      if (!key) continue;
      const row = asObject(model) ?? {};
      const explicit = splitCanonical(row.c);
      const bareKey = key.slice(key.lastIndexOf("/") + 1);
      const releaseMs = releaseTime(row.r);
      if (releaseMs !== undefined && releaseMs > maxReleaseMs) maxReleaseMs = releaseMs;
      if (explicit) {
        for (const claim of new Set([explicit[1], bareKey, key])) {
          if (!claims.has(claim)) claims.set(claim, explicit[0]);
        }
      }
      const rate = snapshotRate(snapshot, `${provider.id}/${key}`);
      rows.push({
        provider,
        key,
        bareKey,
        explicit,
        cost: rate ? extractedCost(rate) : undefined,
        releaseMs,
        outputs: outputModalities(row.o),
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
    const popularity = scorePopularity(snapshot.adoption[canonicalId] ?? 1, daysOld, key, derived, multimodal);
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
    ...(candidate.cost.multipliers === undefined ? {} : { multipliers: candidate.cost.multipliers }),
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
    preset.cacheWriteCostPerMillionTokens === cost.cacheWrite &&
    sameMultipliers(preset.multipliers ?? [], cost.multipliers ?? []);
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

let memo: { snapshot: ModelsDevSnapshot; presets: PricePreset[] } | undefined;

/**
 * Presets and the billing rate table share the same models.dev snapshot, so a
 * preset always bills exactly like the model detail dialog advertises.
 */
export async function loadPricePresets({
  userData, bundledSnapshot,
}: { userData: string; bundledSnapshot: string }): Promise<PricePreset[]> {
  const snapshot = await loadModelsDevSnapshot({ userData, bundledSnapshot });
  if (!snapshot) return [];
  if (memo?.snapshot === snapshot) return memo.presets;
  const presets = collectProviderPresets(snapshot);
  memo = { snapshot, presets };
  return presets;
}
