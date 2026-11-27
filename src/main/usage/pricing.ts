import type {
  PriceOverrides, RateCondition, RateMultiplier, UsageCategoryCost, UsageCostSource, UsageModelPrice, UsagePricing, UsageRecord,
} from "../../shared/types";
import { multiplierFactor, scaleTokenRates } from "../../shared/pricingMultipliers";
import { buildRateTable, loadModelsDevSnapshot } from "./modelsDev";
import type { ModelRate, TokenRates } from "./rateModel";

export { buildRateTable };
export type { ModelRate, TokenRates } from "./rateModel";
export type RateTable = ReadonlyMap<string, ModelRate>;

export interface PricingResult {
  readonly rates: RateTable;
  readonly status: UsagePricing;
}

const keyFor = (name: string): string => name.trim().toLowerCase();
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

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
      tiers: [],
      // A switched-off peak schedule stays stored but never bills or displays.
      multipliers: price.multipliersEnabled === false ? [] : price.multipliers ?? [],
    });
  }
  return table;
}

const unpriceable = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);
export function lookupRate(table: RateTable, model: string): ModelRate | undefined {
  const key = keyFor(model).split("[", 1)[0];
  return unpriceable.has(key.slice(key.lastIndexOf("/") + 1)) ? undefined : table.get(key);
}

// Client-side synonyms only; never strip an unknown or private relay prefix.
const channelAliases = new Map<string, readonly string[]>([
  ["openai-codex", ["openai"]],
  ["openai-chatgpt", ["openai"]],
  ["claude-code", ["anthropic"]],
  ["dashscope", ["alibaba-cn", "alibaba"]],
  ["bedrock", ["amazon-bedrock"]],
]);

// Snapshot-date suffixes such as -20251101 or -2026-10-01 fall back to the base model.
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

function withoutSnapshotDate(model: string): string {
  return model.replace(SNAPSHOT_SUFFIX, "");
}

function lookupQualifiedRate(table: RateTable, model: string, slash: number): ModelRate | undefined {
  const provider = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  if (!rest || unpriceable.has(rest.split("[", 1)[0].split("/").at(-1)!)) return undefined;
  const base = withoutSnapshotDate(rest);
  for (const target of [provider, ...(channelAliases.get(provider) ?? [])]) {
    const exact = table.get(`${target}/${rest}`);
    if (exact) return exact;
    if (base !== rest) {
      const fallback = table.get(`${target}/${base}`);
      if (fallback) return fallback;
    }
  }
  return undefined;
}

function ratesAt(
  rate: ModelRate,
  speed: UsageRecord["speed"],
  totals: UsageRecord["totals"],
  timestampMs: number | undefined
): TokenRates {
  const prompt = totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
  const tier = rate.tiers.find(({ threshold }) => prompt > threshold)?.rates;
  const selected = tier?.standard ?? rate.standard;
  return scaleTokenRates(selected, multiplierFactor(rate.multipliers, timestampMs, speed));
}

type PricedRecord = Pick<UsageRecord, "model" | "rateModel" | "totals" | "cacheCreation1hTokens" | "speed" | "reportedCostUsd"> &
  Partial<Pick<UsageRecord, "provider" | "timestampMs">>;

export interface OpenCodePriceTables {
  readonly userRates: RateTable;
}

export interface UsagePriceContext {
  readonly overrides?: RateTable;
  readonly opencodeUserRates?: RateTable;
}

interface ResolvedModelRate {
  readonly rate: ModelRate;
  readonly explicit: boolean;
  readonly custom: boolean;
}

function resolveRate(
  table: RateTable,
  record: PricedRecord,
  options?: UsagePriceContext
): ResolvedModelRate | null {
  const key = keyFor(record.model);
  const slash = key.indexOf("/");
  const overrideRate = options?.overrides?.get(key);
  if (overrideRate) return { rate: overrideRate, explicit: true, custom: true };
  // OpenCode config overrides are private relay prices and stay channel-exact.
  const userRate = record.provider === "opencode" || slash >= 0
    ? options?.opencodeUserRates?.get(key)
    : undefined;
  if (userRate) return { rate: userRate, explicit: true, custom: false };
  const rate = slash >= 0
    ? lookupQualifiedRate(table, key, slash)
    : (record.rateModel === undefined ? undefined : lookupRate(table, record.rateModel)) ??
      lookupRate(table, record.model) ??
      (withoutSnapshotDate(key) !== key ? table.get(withoutSnapshotDate(key)) : undefined);
  return rate ? { rate, explicit: false, custom: false } : null;
}

function dateOnly(condition: RateCondition): boolean {
  const keys = Object.keys(condition);
  if (!keys.length) return false;
  if (!keys.every((key) => key === "date" || key === "all")) return false;
  return !condition.all || condition.all.every(dateOnly);
}

/** Scheduled price changes already in effect are folded into the shown unit price. */
function dateFactor(rules: readonly RateMultiplier[], timestampMs: number): number {
  const dated = rules.filter((rule) => dateOnly(rule.when));
  return multiplierFactor(dated, timestampMs);
}

export function describeRecordRate(
  table: RateTable,
  record: PricedRecord,
  context?: RateTable | UsagePriceContext
): UsageModelPrice | undefined {
  const options = context && "get" in context ? { overrides: context } : context;
  const resolved = resolveRate(table, record, options);
  if (!resolved) return undefined;
  const perMillion = (value: number): number => Number((value * 1e6).toPrecision(10));
  const factor = dateFactor(resolved.rate.multipliers, Date.now());
  const rate = (rates: TokenRates): UsageCategoryCost => scaleTokenRates(rates, factor);
  const standard = rate(resolved.rate.standard);
  const tiers = resolved.rate.tiers.map(({ threshold, rates }) => {
    const priced = rate(rates.standard);
    return {
      threshold,
      inputCostPerMillionTokens: perMillion(priced.input),
      outputCostPerMillionTokens: perMillion(priced.output),
      cacheReadCostPerMillionTokens: perMillion(priced.cacheRead),
      cacheWriteCostPerMillionTokens: perMillion(priced.cacheWrite),
    };
  });
  return {
    inputCostPerMillionTokens: perMillion(standard.input),
    outputCostPerMillionTokens: perMillion(standard.output),
    cacheReadCostPerMillionTokens: perMillion(standard.cacheRead),
    cacheWriteCostPerMillionTokens: perMillion(standard.cacheWrite),
    ...(resolved.custom ? { custom: true } : {}),
    ...(tiers.length ? { tiers } : {}),
    ...(resolved.rate.multipliers.length ? { multipliers: [...resolved.rate.multipliers] } : {}),
  };
}

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

export function priceUsage(table: RateTable, record: PricedRecord, context?: RateTable | UsagePriceContext): {
  costUsd: number;
  costSource: UsageCostSource;
  categoryCostUsd: UsageCategoryCost | null;
  speedPremiumUsd: number;
  cacheSavingsUsd: number;
} {
  const options = context && "get" in context ? { overrides: context } : context;
  const resolved = resolveRate(table, record, options);
  const reported = resolved?.explicit ? null : amount(record.reportedCostUsd);
  if (!resolved) {
    // A provider total that cannot be split across token categories is not an estimate.
    if (reported === 0) {
      return { costUsd: 0, costSource: "providerReported",
        categoryCostUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        speedPremiumUsd: 0, cacheSavingsUsd: 0 };
    }
    return { costUsd: 0, costSource: "unpriced", categoryCostUsd: null, speedPremiumUsd: 0, cacheSavingsUsd: 0 };
  }
  const rate = resolved.rate;
  const selected = ratesAt(rate, record.speed, record.totals, record.timestampMs);
  const costs = categoryCosts(record, selected);
  const sum = (c: UsageCategoryCost) => c.input + c.output + c.cacheRead + c.cacheWrite;
  const listCost = sum(costs);
  const cacheSavingsUsd = record.totals.cachedInputTokens * (selected.input - selected.cacheRead);
  if (listCost <= 0) {
    // A known free model stays at zero; a lump-sum report for a zero-priced rate is not trusted.
    return { costUsd: 0, costSource: "modelPriced",
      categoryCostUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      speedPremiumUsd: 0, cacheSavingsUsd };
  }
  const scale = reported === null ? 1 : reported / listCost;
  return {
    costUsd: reported ?? listCost,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: {
      input: costs.input * scale, output: costs.output * scale,
      cacheRead: costs.cacheRead * scale, cacheWrite: costs.cacheWrite * scale,
    },
    speedPremiumUsd: record.speed === "standard"
      ? 0 : (listCost - sum(categoryCosts(record, ratesAt(rate, "standard", record.totals, record.timestampMs)))) * scale,
    cacheSavingsUsd,
  };
}

function result(rates: RateTable, status: UsagePricing["status"], source: string, fetchedAt: string | null): PricingResult {
  return { rates, status: { status, source, fetchedAt, knownModels: rates.size } };
}

/**
 * The one official catalog source. A fresh local snapshot answers instantly;
 * an expired cache or the bundled snapshot answers the first frame while the
 * main process refreshes in the background.
 */
export async function loadPricing(userData: string, bundledSnapshot: string): Promise<PricingResult> {
  const snapshot = await loadModelsDevSnapshot({ userData, bundledSnapshot });
  if (!snapshot) return result(new Map(), "unavailable", "https://models.dev/api.json", null);
  return result(buildRateTable(snapshot), "cached", snapshot.source, snapshot.fetchedAt);
}
