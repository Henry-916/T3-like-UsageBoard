import { describe, expect, it } from "vitest";
import { aggregateUsage, createUsageWindowFilter } from "../src/main/usage/aggregation";
import { parseRateTable, type PricingResult } from "../src/main/usage/pricing";
import { EMPTY_TOTALS, type UsageRecord, type UsageSummaryInput } from "../src/shared/types";

const daily: UsageSummaryInput = { sinceDay: "2026-11-01", untilDay: "2026-11-01", timeZone: "America/New_York" };
const pricing: PricingResult = {
  rates: parseRateTable({
    "target": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.000001 },
    "original-rate": { input_cost_per_token: 1, output_cost_per_token: 1 },
  }),
  status: { status: "cached", source: "test", fetchedAt: null, knownModels: 2 },
};
const record = (model: string, overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: "antigravity", model, timestampMs: Date.parse("2026-11-01T05:30:00Z"),
  sessionId: "a", speed: "standard", dedupeKey: null, reportedCostUsd: null,
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: 10, cachedInputTokens: 10, outputTokens: 5, reasoningTokens: 3 },
  ...overrides,
});

describe("aggregateUsage", () => {
  it("isolates same-name OpenCode models strictly by provider prefix", () => {
    const openCode = { provider: "opencode" as const, reportedCostUsd: 1 };
    const records = [
      record("CPA/qwen3.8-flash", openCode),
      record("alibaba-cn/qwen3.8-flash", openCode),
    ];
    const rates = { ...pricing, rates: parseRateTable({
      "qwen3.8-flash": { input_cost_per_token: 1, output_cost_per_token: 1 },
      "dashscope/qwen3.8-flash": { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    }) };
    expect(aggregateUsage(records, daily, rates, {})).toMatchObject([
      { model: "alibaba-cn/qwen3.8-flash", costUsd: 1, costSource: "providerReported" },
      { model: "cpa/qwen3.8-flash", costUsd: 0, costSource: "unpriced" },
    ]);
    expect(aggregateUsage(records, daily, rates, {
      "cpa/qwen3.8-flash": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 4 },
    })).toMatchObject([
      { model: "alibaba-cn/qwen3.8-flash", costUsd: 1, costSource: "providerReported" },
      { model: "cpa/qwen3.8-flash", costSource: "modelPriced", records: 1 },
    ]);
  });

  it("normalizes effort variants, keeps rateModel hints, and counts distinct sessions", () => {
    const rows = aggregateUsage([
      record("gemini-3.6-flash-high", { rateModel: "target" }),
      record("gemini-3.6-flash-medium", { rateModel: "target" }),
      record("gemini-3.6-flash-low", { sessionId: "b", rateModel: "target" }),
      record("gemini-3.6-flash-low", { timestampMs: Date.parse("2026-11-01T03:59:59Z"), rateModel: "target" }),
    ], daily, pricing, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-11-01", model: "gemini-3.6-flash", sessions: 2, records: 3, costSource: "modelPriced",
      totals: { uncachedInputTokens: 30, cachedInputTokens: 30, outputTokens: 15, reasoningTokens: 9 },
    });
    expect(rows[0].costUsd).toBeCloseTo(0.00024, 12);
    expect(rows[0].cacheSavingsUsd).toBeCloseTo(0.00003, 12);
  });

  it("keeps repeated DST hours distinct and excludes the exact upper bound", () => {
    const query: UsageSummaryInput = {
      ...daily, resolution: "hour", sinceTime: "2026-11-01T05:00:00Z", untilTime: "2026-11-01T07:00:00Z",
    };
    const records = ["05:20", "06:20", "07:00"].map((hhmm) =>
      record("target", { timestampMs: Date.parse(`2026-11-01T${hhmm}:00Z`) }));
    const includes = createUsageWindowFilter(query);
    expect(records.map(({ timestampMs }) => includes(timestampMs))).toEqual([true, true, false]);
    expect(aggregateUsage(records, query, pricing, {}).map((row) => row.hourStart)).toEqual([
      "2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z",
    ]);
  });

  it("merges partial copies by provider", () => {
    const rows = aggregateUsage([
      record("unknown", { dedupeKey: "id" }),
      record("unknown", { dedupeKey: "id", sessionId: "copy", totals: { ...EMPTY_TOTALS, outputTokens: 12 } }),
      record("unknown", { provider: "claude", dedupeKey: "id" }),
    ], daily, pricing, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      model: "unknown", records: 1, sessions: 1, unpricedTokens: 32, unpricedRecords: 1, costSource: "unpriced",
    });
    expect(rows[1]).toMatchObject({ provider: "claude", unpricedTokens: 25 });
  });
});
