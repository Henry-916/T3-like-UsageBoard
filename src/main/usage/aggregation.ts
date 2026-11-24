import { normalizeModelId } from "../../shared/modelNormalize";
import {
  EMPTY_TOTALS,
  totalTokens,
  type ModelAliases,
  type PriceOverrides,
  type UsageBucket,
  type UsageRecord,
  type UsageSummaryInput,
} from "../../shared/types";
import { createOverrideRateTable, priceUsage, type PricingResult } from "./pricing";

const HOUR_MS = 3_600_000;
const SLOT_MS = 900_000;

function createUsageWindow(query: UsageSummaryInput) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: query.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const days = new Map<number, string | null>();
  const dayAt = (ms: number): string => {
    const slot = Math.floor(ms / SLOT_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(slot * SLOT_MS);
      day = first === format.format((slot + 1) * SLOT_MS - 1) ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(ms);
  };
  const start = query.sinceTime === undefined ? NaN : Date.parse(query.sinceTime);
  const end = query.untilTime === undefined ? NaN : Date.parse(query.untilTime);
  const exact = Number.isFinite(start) && Number.isFinite(end);
  if (query.resolution === "hour" && !exact) {
    throw new Error("Hourly usage aggregation requires exact time bounds");
  }
  const includes = (ms: number): boolean => {
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return false;
    if (exact) return ms >= start && ms < end;
    const day = dayAt(ms);
    return day >= query.sinceDay && day <= query.untilDay;
  };
  return { includes, dayAt, start };
}

export function createUsageWindowFilter(query: UsageSummaryInput): (timestampMs: number) => boolean {
  return createUsageWindow(query).includes;
}

function resolveModelAliases(aliases: ModelAliases): Map<string, string | null> {
  const resolved = new Map<string, string | null>();
  for (const model of Object.keys(aliases)) {
    if (resolved.has(model)) continue;
    const path: string[] = [];
    let target = model;
    while (Object.hasOwn(aliases, target) && !resolved.has(target)) {
      path.push(target);
      // Null marks both active walks and paths that terminate in cycles.
      resolved.set(target, null);
      target = aliases[target];
    }
    const terminal = Object.hasOwn(aliases, target) ? (resolved.get(target) ?? null) : target;
    for (const alias of path) resolved.set(alias, terminal);
  }
  return resolved;
}

/** Keep the first copy's dimensions, but merge partial copies channel by channel. */
export function mergeUsageCopies(held: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = held.totals;
  const b = copy.totals;
  const cacheCreation1hTokens = Math.max(held.cacheCreation1hTokens ?? 0, copy.cacheCreation1hTokens ?? 0);
  return {
    ...held,
    ...(cacheCreation1hTokens > 0 ? { cacheCreation1hTokens } : {}),
    totals: {
      uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.max(a.outputTokens, b.outputTokens),
      reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    },
    reportedCostUsd: held.reportedCostUsd === null || copy.reportedCostUsd === null
      ? (held.reportedCostUsd ?? copy.reportedCostUsd)
      : Math.max(held.reportedCostUsd, copy.reportedCostUsd),
  };
}

type MutableBucket = Omit<UsageBucket, "costSource" | "sessions"> & {
  sessionIds: Set<string>;
  providerReportedRecords: number;
  unpricedTokens: number;
};
const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

export function aggregateUsage(
  records: readonly UsageRecord[],
  query: UsageSummaryInput,
  pricing: PricingResult,
  overrides: PriceOverrides,
  aliases: ModelAliases,
): UsageBucket[] {
  const window = createUsageWindow(query);
  const rateOverrides = createOverrideRateTable(overrides);
  const aliasTargets = resolveModelAliases(aliases);
  const buckets = new Map<string, MutableBucket>();
  const keyed = new Map<string, UsageRecord>();

  function accumulate(input: UsageRecord) {
    if (!window.includes(input.timestampMs)) return;
    const normalized = normalizeModelId(input.provider, input.model);
    const model = aliasTargets.get(normalized) ?? normalized;
    // An explicit alias reprices at its target, not at the original record's rate hint.
    const record = { ...input, model, rateModel: model === normalized ? input.rateModel : undefined };
    const day = window.dayAt(record.timestampMs);
    const hourStart = query.resolution === "hour"
      ? new Date(window.start + Math.floor((record.timestampMs - window.start) / HOUR_MS) * HOUR_MS).toISOString()
      : undefined;
    const key = JSON.stringify([day, hourStart, record.provider, model]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        day, ...(hourStart === undefined ? {} : { hourStart }), provider: record.provider, model,
        totals: { ...EMPTY_TOTALS }, costUsd: 0, cacheSavingsUsd: 0, records: 0,
        unpricedRecords: 0, unpricedTokens: 0, providerReportedRecords: 0, sessionIds: new Set(),
      };
      buckets.set(key, bucket);
    }
    const priced = priceUsage(pricing.rates, record, rateOverrides);
    const { totals } = bucket;
    totals.uncachedInputTokens += record.totals.uncachedInputTokens;
    totals.cachedInputTokens += record.totals.cachedInputTokens;
    totals.cacheCreationTokens += record.totals.cacheCreationTokens;
    totals.outputTokens += record.totals.outputTokens;
    totals.reasoningTokens += record.totals.reasoningTokens;
    bucket.costUsd += priced.costUsd;
    bucket.cacheSavingsUsd += priced.cacheSavingsUsd;
    if (priced.categoryCostUsd !== null) {
      const sum = bucket.categoryCostUsd ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      sum.input += priced.categoryCostUsd.input;
      sum.output += priced.categoryCostUsd.output;
      sum.cacheRead += priced.categoryCostUsd.cacheRead;
      sum.cacheWrite += priced.categoryCostUsd.cacheWrite;
      bucket.categoryCostUsd = sum;
    }
    if (record.speed === "fast") bucket.fastCostUsd = (bucket.fastCostUsd ?? 0) + priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd = (bucket.ultrafastCostUsd ?? 0) + priced.costUsd;
    bucket.speedPremiumUsd = (bucket.speedPremiumUsd ?? 0) + priced.speedPremiumUsd;
    bucket.records += 1;
    if (record.sessionId) bucket.sessionIds.add(record.sessionId);
    if (priced.costSource === "unpriced") {
      bucket.unpricedRecords += 1;
      bucket.unpricedTokens += totalTokens(record.totals);
    } else if (priced.costSource === "providerReported") {
      bucket.providerReportedRecords += 1;
    }
  }

  for (const record of records) {
    if (record.dedupeKey === null) {
      accumulate(record);
    } else {
      const key = `${record.provider}:${record.dedupeKey}`;
      const held = keyed.get(key);
      keyed.set(key, held === undefined ? record : mergeUsageCopies(held, record));
    }
  }
  for (const record of keyed.values()) accumulate(record);

  return [...buckets.values()].map(({
    sessionIds, providerReportedRecords, categoryCostUsd, fastCostUsd, ultrafastCostUsd, speedPremiumUsd, ...bucket
  }): UsageBucket => ({
    ...bucket,
    sessions: sessionIds.size,
    costSource: bucket.unpricedRecords === bucket.records ? "unpriced"
      : providerReportedRecords === bucket.records ? "providerReported" : "modelPriced",
    ...(categoryCostUsd === undefined ? {} : {
      categoryCostUsd: {
        input: roundUsd(categoryCostUsd.input), output: roundUsd(categoryCostUsd.output),
        cacheRead: roundUsd(categoryCostUsd.cacheRead), cacheWrite: roundUsd(categoryCostUsd.cacheWrite),
      },
    }),
    ...(roundUsd(fastCostUsd ?? 0) === 0 ? {} : { fastCostUsd: roundUsd(fastCostUsd!) }),
    ...(roundUsd(ultrafastCostUsd ?? 0) === 0 ? {} : { ultrafastCostUsd: roundUsd(ultrafastCostUsd!) }),
    ...(roundUsd(speedPremiumUsd ?? 0) === 0 ? {} : { speedPremiumUsd: roundUsd(speedPremiumUsd!) }),
  })).sort((a, b) =>
    a.day.localeCompare(b.day) || (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
    a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
