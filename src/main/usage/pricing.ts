import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PriceOverrides, UsageCategoryCost, UsageCostSource, UsagePricing, UsageRecord,
} from "../../shared/types";

type TokenRates = UsageCategoryCost & { cacheWrite1h: number };
type SpeedRates = { standard: TokenRates; fast: TokenRates | null; ultrafast: TokenRates | null };
type ModelRate = SpeedRates & { tiers: readonly { threshold: number; rates: SpeedRates }[] };
export type RateTable = ReadonlyMap<string, ModelRate>;

export interface PricingResult {
  readonly rates: RateTable;
  readonly status: UsagePricing;
}

const URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const keyFor = (name: string): string => name.trim().toLowerCase();
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function readRates(
  entry: Record<string, unknown>,
  suffix: string,
  base?: TokenRates,
  outputFallback?: number,
): TokenRates | null {
  const input = amount(entry[`input_cost_per_token${suffix}`]);
  const output = amount(entry[`output_cost_per_token${suffix}`]) ?? outputFallback;
  if (input === null || output === undefined) return null;
  const cache = (key: string, field: keyof TokenRates, fallback = input) =>
    amount(entry[key + suffix]) ??
    (base && base.input > 0 ? (base[field] / base.input) * input : fallback);
  const cacheWrite = cache("cache_creation_input_token_cost", "cacheWrite");
  return {
    input, output, cacheWrite,
    cacheRead: cache("cache_read_input_token_cost", "cacheRead"),
    cacheWrite1h: cache("cache_creation_input_token_cost_above_1hr", "cacheWrite1h", cacheWrite),
  };
}

function speedRates(entry: Record<string, unknown>, standard: TokenRates, suffix = ""): SpeedRates {
  const specific = entry.provider_specific_entry;
  const multiple = isObject(specific) ? amount(specific.fast) : null;
  const fast = multiple !== null && multiple > 0
    ? {
        input: standard.input * multiple,
        output: standard.output * multiple,
        cacheRead: standard.cacheRead * multiple,
        cacheWrite: standard.cacheWrite * multiple,
        cacheWrite1h: standard.cacheWrite1h * multiple,
      }
    : readRates(entry, `${suffix}_priority`, standard);
  return { standard, fast, ultrafast: readRates(entry, `${suffix}_ultrafast`, standard) };
}

const firstParty = new Set(["anthropic", "deepseek", "gemini", "meta", "mistral", "openai", "xai"]);

function mergeSpeeds(a: SpeedRates, b: SpeedRates): SpeedRates | null {
  const same = (x: TokenRates, y: TokenRates) =>
    x.input === y.input && x.output === y.output && x.cacheRead === y.cacheRead &&
    x.cacheWrite === y.cacheWrite && x.cacheWrite1h === y.cacheWrite1h;
  if (!same(a.standard, b.standard) ||
    (a.fast && b.fast && !same(a.fast, b.fast)) ||
    (a.ultrafast && b.ultrafast && !same(a.ultrafast, b.ultrafast))) return null;
  return { standard: a.standard, fast: a.fast ?? b.fast, ultrafast: a.ultrafast ?? b.ultrafast };
}

function mergeRates(a: ModelRate, b: ModelRate): ModelRate | null {
  const base = mergeSpeeds(a, b);
  if (!base) return null;
  if (!a.tiers.length || !b.tiers.length) return { ...base, tiers: a.tiers.length ? a.tiers : b.tiers };
  if (a.tiers.length !== b.tiers.length) return null;
  const tiers = [];
  for (const [i, tier] of a.tiers.entries()) {
    const other = b.tiers[i];
    const rates = mergeSpeeds(tier.rates, other.rates);
    if (tier.threshold !== other.threshold || !rates) return null;
    tiers.push({ threshold: tier.threshold, rates });
  }
  return { ...base, tiers };
}

export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (!isObject(document)) return table;
  for (const [name, entry] of Object.entries(document)) {
    if (!isObject(entry) || name === "sample_spec") continue;
    const key = keyFor(name);
    const standard = readRates(entry, "");
    if (!key || !standard) continue;
    const thresholds = new Set<string>();
    for (const field of Object.keys(entry)) {
      const match = /^input_cost_per_token_above_(\d{1,7})k_tokens(?:_priority|_ultrafast)?$/.exec(field);
      if (match) thresholds.add(match[1]);
    }
    const tiers = [...thresholds].map((threshold) => {
      const suffix = `_above_${threshold}k_tokens`;
      const base = readRates(entry, suffix, standard, standard.output) ?? standard;
      return { threshold: Number(threshold) * 1000, rates: speedRates(entry, base, suffix) };
    }).sort((a, b) => b.threshold - a.threshold);
    table.set(key, { ...speedRates(entry, standard), tiers });
  }

  // Bare aliases prefer first-party pricing. Conflicting peers stay unlisted.
  const candidates = new Map<string, { rate: ModelRate | null; preferred: boolean }>();
  for (const [key, rate] of table) {
    const slash = key.indexOf("/");
    const alias = slash < 0 ? key.replace(/^anthropic\./, "") : key.slice(key.lastIndexOf("/") + 1);
    if (!alias || alias === key || table.has(alias)) continue;
    const preferred = slash >= 0 && firstParty.has(key.slice(0, slash));
    const held = candidates.get(alias);
    if (!held || (preferred && !held.preferred)) candidates.set(alias, { rate, preferred });
    else if (held.rate && preferred === held.preferred) {
      candidates.set(alias, { rate: mergeRates(held.rate, rate), preferred });
    }
  }
  for (const [alias, { rate }] of candidates) if (rate) table.set(alias, rate);
  return table;
}

export function createOverrideRateTable(overrides: PriceOverrides): RateTable {
  const table = new Map<string, ModelRate>();
  for (const [name, price] of Object.entries(overrides)) {
    const input = price.inputCostPerMillionTokens / 1e6;
    const cacheWrite = (price.cacheWriteCostPerMillionTokens ?? price.inputCostPerMillionTokens) / 1e6;
    table.set(keyFor(name), {
      standard: {
        input, output: price.outputCostPerMillionTokens / 1e6, cacheWrite, cacheWrite1h: cacheWrite,
        cacheRead: (price.cacheReadCostPerMillionTokens ?? price.inputCostPerMillionTokens) / 1e6,
      },
      fast: null, ultrafast: null, tiers: [],
    });
  }
  return table;
}

const unpriceable = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);
export function lookupRate(table: RateTable, model: string): ModelRate | undefined {
  const key = keyFor(model).split("[", 1)[0];
  return unpriceable.has(key.slice(key.lastIndexOf("/") + 1)) ? undefined : table.get(key);
}

function ratesAt(rate: ModelRate, speed: UsageRecord["speed"], totals: UsageRecord["totals"]): TokenRates {
  const prompt = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
  const tier = rate.tiers.find(({ threshold }) => prompt > threshold)?.rates;
  return tier?.[speed] ?? rate[speed] ?? tier?.standard ?? rate.standard;
}

type PricedRecord = Pick<UsageRecord, "model" | "rateModel" | "totals" | "cacheCreation1hTokens" | "speed" | "reportedCostUsd">;

function categoryCosts(record: PricedRecord, rates: TokenRates): UsageCategoryCost {
  const { totals } = record;
  const oneHour = Math.min(record.cacheCreation1hTokens ?? 0, totals.cacheCreationTokens);
  return {
    input: totals.uncachedInputTokens * rates.input,
    output: totals.outputTokens * rates.output,
    cacheRead: totals.cachedInputTokens * rates.cacheRead,
    cacheWrite: (totals.cacheCreationTokens - oneHour) * rates.cacheWrite + oneHour * rates.cacheWrite1h,
  };
}

export function priceUsage(table: RateTable, record: PricedRecord, overrides?: RateTable): {
  costUsd: number;
  costSource: UsageCostSource;
  categoryCostUsd: UsageCategoryCost | null;
  speedPremiumUsd: number;
  cacheSavingsUsd: number;
} {
  const reported = amount(record.reportedCostUsd);
  const rate = overrides?.get(keyFor(record.model)) ??
    (record.rateModel === undefined ? undefined : lookupRate(table, record.rateModel)) ??
    lookupRate(table, record.model);
  const costSource = reported !== null ? "providerReported" : rate ? "modelPriced" : "unpriced";
  if (!rate) {
    return { costUsd: reported ?? 0, costSource, categoryCostUsd: null, speedPremiumUsd: 0, cacheSavingsUsd: 0 };
  }
  const selected = ratesAt(rate, record.speed, record.totals);
  const costs = categoryCosts(record, selected);
  const sum = (c: UsageCategoryCost) => c.input + c.output + c.cacheRead + c.cacheWrite;
  const listCost = sum(costs);
  const cacheSavingsUsd = record.totals.cachedInputTokens * (selected.input - selected.cacheRead);
  if (reported !== null && listCost <= 0) {
    return { costUsd: reported, costSource, categoryCostUsd: null, speedPremiumUsd: 0, cacheSavingsUsd };
  }
  const scale = reported === null ? 1 : reported / listCost;
  return {
    costUsd: reported ?? listCost,
    costSource,
    categoryCostUsd: {
      input: costs.input * scale, output: costs.output * scale,
      cacheRead: costs.cacheRead * scale, cacheWrite: costs.cacheWrite * scale,
    },
    speedPremiumUsd: record.speed === "standard"
      ? 0 : (listCost - sum(categoryCosts(record, ratesAt(rate, "standard", record.totals)))) * scale,
    cacheSavingsUsd,
  };
}

function result(rates: RateTable, status: UsagePricing["status"], source: string, fetchedAt: string | null): PricingResult {
  return { rates, status: { status, source, fetchedAt, knownModels: rates.size } };
}

async function readLocal(path: string): Promise<PricingResult | null> {
  try {
    const snapshot: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(snapshot)) return null;
    const rates = parseRateTable(snapshot.rates);
    if (rates.size === 0) return null;
    const source = typeof snapshot.source === "string" && snapshot.source.trim() ? snapshot.source : URL;
    const fetchedAt = typeof snapshot.fetchedAt === "string" && Number.isFinite(Date.parse(snapshot.fetchedAt))
      ? snapshot.fetchedAt : null;
    return result(rates, "cached", source, fetchedAt);
  } catch {
    return null;
  }
}

async function refresh(userData: string, cachePath: string): Promise<PricingResult | null> {
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const document: unknown = await response.json();
    const rates = parseRateTable(document);
    if (rates.size === 0) return null;
    const fetchedAt = new Date().toISOString();
    const partial = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(userData, { recursive: true });
      await writeFile(partial, JSON.stringify({ source: URL, fetchedAt, rates: document }), "utf8");
      await rename(partial, cachePath);
    } catch {
      await rm(partial, { force: true }).catch(() => {});
    }
    return result(rates, "fresh", URL, fetchedAt);
  } catch {
    return null;
  }
}

const pending = new Map<string, Promise<PricingResult | null>>();
const retryAfter = new Map<string, number>();
const recent = new Map<string, PricingResult>();
function isFresh(pricing: PricingResult): boolean {
  if (pricing.status.fetchedAt === null) return false;
  const age = Date.now() - Date.parse(pricing.status.fetchedAt);
  return age >= 0 && age < TTL_MS;
}

export async function loadPricing(userData: string, fallbackPath: string): Promise<PricingResult> {
  const cachePath = join(userData, "litellm-rates-cache.json");
  const last = recent.get(cachePath);
  if (last && isFresh(last)) return last;
  const cached = await readLocal(cachePath);
  if (cached && isFresh(cached)) return cached;
  const local = cached ?? last ?? await readLocal(fallbackPath);
  // Another caller may have finished a refresh while this caller read local files.
  const latest = recent.get(cachePath);
  if (latest && isFresh(latest)) return latest;
  let update = pending.get(cachePath);
  if (!update && Date.now() >= (retryAfter.get(cachePath) ?? 0)) {
    update = refresh(userData, cachePath).then((fresh) => {
      if (fresh) recent.set(cachePath, fresh);
      else retryAfter.set(cachePath, Date.now() + 60_000);
      return fresh;
    }).finally(() => pending.delete(cachePath));
    pending.set(cachePath, update);
  }
  return local ?? await update ?? result(new Map(), "unavailable", URL, null);
}
