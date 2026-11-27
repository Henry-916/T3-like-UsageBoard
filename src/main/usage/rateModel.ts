import type { RateMultiplier, UsageCategoryCost } from "../../shared/types";
import { normalizeMultipliers } from "../../shared/pricingMultipliers";

export type TokenRates = UsageCategoryCost & { cacheWrite1h: number };
export type ModelRate = {
  readonly standard: TokenRates;
  readonly tiers: readonly { threshold: number; rates: { standard: TokenRates } }[];
  readonly multipliers: readonly RateMultiplier[];
};

type Row = Record<string, unknown>;

const object = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;

const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

type CacheShape = { read?: unknown; write?: unknown; explicit?: unknown };

function baseRates(input: number, output: number, cache?: CacheShape): TokenRates {
  const explicit = object(cache?.explicit) as CacheShape | undefined;
  const read = amount(cache?.read) ?? amount(explicit?.read) ?? input;
  const write = cache?.write ?? explicit?.write;
  const scalar = amount(write);
  const writeRow = object(write);
  const short = scalar ?? amount(writeRow?.["5m"]) ?? amount(writeRow?.["30m"]) ?? input;
  const long = scalar ?? amount(writeRow?.["1h"]) ?? amount(writeRow?.["12h"]) ?? short;
  return {
    input: input / 1e6,
    output: output / 1e6,
    cacheRead: read / 1e6,
    cacheWrite: short / 1e6,
    cacheWrite1h: long / 1e6,
  };
}

function flatTiers(entry: Row): { threshold: number; rates: { standard: TokenRates } }[] {
  const tiers: { threshold: number; rates: { standard: TokenRates } }[] = [];
  const add = (threshold: unknown, raw: unknown) => {
    const size = amount(threshold);
    const row = object(raw);
    if (!size || !row) return;
    const input = amount(row.input);
    const output = amount(row.output);
    if (input === undefined || output === undefined) return;
    tiers.push({
      threshold: size,
      rates: { standard: baseRates(input, output, row.cache as CacheShape | undefined) },
    });
  };
  for (const item of Array.isArray(entry.tiers) ? entry.tiers : []) {
    const row = object(item);
    const tier = object(row?.tier);
    if (tier?.type === "context") add(tier.size, row);
  }
  add(200_000, entry.context_over_200k);
  return tiers.sort((a, b) => b.threshold - a.threshold);
}

/** Read the flattened v1 cost shape, used by models.dev's stable feed. */
function flatRate(raw: unknown): ModelRate | undefined {
  let entry = object(raw);
  if (Array.isArray(raw)) {
    entry = undefined;
    for (const item of raw) {
      const candidate = object(item);
      if (!candidate || Object.hasOwn(candidate, "tier")) continue;
      if (amount(candidate.input) === undefined || amount(candidate.output) === undefined) continue;
      entry = candidate;
      break;
    }
  }
  if (!entry) return undefined;
  const input = amount(entry.input);
  const output = amount(entry.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = entry.cache as CacheShape | undefined;
  const rates = baseRates(input, output, {
    read: cache?.read ?? entry.cache_read,
    write: cache?.write ?? entry.cache_write,
    explicit: cache?.explicit,
  });
  const tiers = flatTiers(entry);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = object(item);
      const tier = object(row?.tier);
      if (tier?.type !== "context") continue;
      const threshold = amount(tier.size);
      const tierInput = amount(row?.input);
      const tierOutput = amount(row?.output);
      if (!threshold || tierInput === undefined || tierOutput === undefined) continue;
      tiers.push({
        threshold,
        rates: { standard: baseRates(tierInput, tierOutput, row?.cache as CacheShape | undefined) },
      });
    }
    tiers.sort((a, b) => b.threshold - a.threshold);
  }
  return { standard: rates, tiers, multipliers: normalizeMultipliers(entry.multipliers) };
}

/** Read the v2 `cost.text` shape with context overrides and peak multipliers. */
function textRate(raw: unknown): ModelRate | undefined {
  const entry = object(raw);
  const text = object(entry?.text);
  const inputSide = object(text?.input);
  const outputSide = object(text?.output);
  const inputPrice = amount(inputSide?.price);
  const outputPrice = amount(outputSide?.price);
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  const cache = inputSide?.cache as CacheShape | undefined;
  const standard = baseRates(inputPrice, outputPrice, cache);
  const overrides = new Map<number, { inputPrice?: number; outputPrice?: number; cache?: unknown }>();
  const collect = (side: Row | undefined, key: "inputPrice" | "outputPrice") => {
    for (const item of Array.isArray(side?.overrides) ? side.overrides : []) {
      const override = object(item);
      const threshold = amount(object(object(override?.when)?.context)?.gt);
      const price = amount(override?.price);
      if (threshold === undefined || threshold <= 0 || price === undefined) continue;
      const tier = overrides.get(threshold) ?? {};
      tier[key] = price;
      if (side === inputSide) tier.cache = override?.cache;
      overrides.set(threshold, tier);
    }
  };
  collect(inputSide, "inputPrice");
  collect(outputSide, "outputPrice");
  const tiers = [...overrides.entries()]
    .sort(([a], [b]) => b - a)
    .map(([threshold, tier]) => {
      const tierCache = object(tier.cache) as CacheShape | undefined;
      const merged: CacheShape = {
        read: tierCache?.read ?? cache?.read,
        write: tierCache?.write ?? cache?.write,
        explicit: tierCache?.explicit ?? cache?.explicit,
      };
      return {
        threshold,
        rates: {
          standard: baseRates(tier.inputPrice ?? inputPrice, tier.outputPrice ?? outputPrice, merged),
        },
      };
    });
  return {
    standard,
    tiers,
    multipliers: normalizeMultipliers(entry?.multipliers ?? text?.multipliers),
  };
}

/** The one cost reader shared by the catalog snapshot and OpenCode user overrides. */
export function readModelRate(raw: unknown): ModelRate | undefined {
  return textRate(raw) ?? flatRate(raw);
}
