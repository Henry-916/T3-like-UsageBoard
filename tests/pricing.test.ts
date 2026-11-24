import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOverrideRateTable, loadPricing, lookupRate, parseRateTable, priceUsage } from "../src/main/usage/pricing";
import { EMPTY_TOTALS } from "../src/shared/types";

const document = {
  "anthropic/claude-test": {
    input_cost_per_token: 2e-6, output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.5e-6, cache_creation_input_token_cost: 3e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
    input_cost_per_token_above_1k_tokens: 4e-6, output_cost_per_token_above_1k_tokens: 20e-6,
    provider_specific_entry: { fast: 2 },
  },
  "reseller/claude-test": { input_cost_per_token: 9, output_cost_per_token: 9 },
  incomplete: { input_cost_per_token: 1 },
};
const table = parseRateTable(document);
const record = {
  model: "claude-test",
  speed: "standard" as const,
  reportedCostUsd: null,
  cacheCreation1hTokens: 4,
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 10, outputTokens: 5, reasoningTokens: 5 },
};

describe("priceUsage", () => {
  it("prefers first-party aliases and separates cache TTLs without double-billing reasoning", () => {
    expect(lookupRate(table, "incomplete")).toBeUndefined();
    const priced = priceUsage(table, { ...record, model: " CLAUDE-TEST[1m]" });
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.categoryCostUsd?.cacheWrite).toBeCloseTo(34e-6, 12);
    expect(priced.costUsd).toBeCloseTo(114e-6, 12);
    expect(priced.cacheSavingsUsd).toBeCloseTo(30e-6, 12);
  });

  it("handles context tiers and fast rates", () => {
    const priced = priceUsage(table, {
      ...record, speed: "fast", totals: { ...record.totals, uncachedInputTokens: 1000 },
    });
    expect(priced.categoryCostUsd?.input).toBeCloseTo(0.008, 12);
    expect(priced.speedPremiumUsd).toBeCloseTo(priced.costUsd / 2, 12);
  });

  it("uses provider-reported costs (even zero) before overrides and LiteLLM", () => {
    const overrides = createOverrideRateTable({
      "claude-test": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 1, cacheReadCostPerMillionTokens: 0 },
    });
    expect(priceUsage(table, record, overrides).costUsd).toBeCloseTo(85e-6, 12);
    const reported = priceUsage(table, { ...record, reportedCostUsd: 0.5 }, overrides);
    expect(reported).toMatchObject({ costUsd: 0.5, costSource: "providerReported" });
    expect(Object.values(reported.categoryCostUsd!).reduce((sum, part) => sum + part, 0)).toBeCloseTo(0.5);
    expect(priceUsage(table, { ...record, model: "unknown", reportedCostUsd: 0 }, overrides))
      .toMatchObject({ costUsd: 0, categoryCostUsd: null, costSource: "providerReported" });
    expect(priceUsage(table, { ...record, model: "unknown" }, overrides)).toMatchObject({ costSource: "unpriced" });
  });
});

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usage-rates-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPricing", () => {
  it("uses a valid recent disk cache without fetching", async () => {
    const dir = await directory();
    const fetchedAt = new Date().toISOString();
    await writeFile(join(dir, "litellm-rates-cache.json"), JSON.stringify({ fetchedAt, rates: document }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await loadPricing(dir, join(dir, "missing.json"))).status).toMatchObject({ status: "cached", fetchedAt });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the pinned bundled snapshot without waiting on the network", async () => {
    const dir = await directory();
    const fetchMock = vi.fn(async (_url: string, { signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const pricing = await loadPricing(dir, resolve("resources/fallback-rates.json"));
    expect(pricing.status).toMatchObject({ status: "cached", source: expect.stringMatching(/litellm\/[0-9a-f]{40}\//) });
    expect(lookupRate(pricing.rates, "gemini-3.6-flash")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for a deduplicated fetch only when there is no usable local table and writes the 24h cache", async () => {
    const dir = await directory();
    const fetchMock = vi.fn(async () => Response.json(document));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([loadPricing(dir, join(dir, "missing")), loadPricing(dir, join(dir, "missing"))]);
    expect(a.status.status).toBe("fresh");
    expect(b.status.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(await readFile(join(dir, "litellm-rates-cache.json"), "utf8"));
    expect(cache).toMatchObject({ source: a.status.source, fetchedAt: a.status.fetchedAt, rates: document });
  });

  it("uses a stale cache before the bundle on failure and is unavailable only with neither", async () => {
    const dir = await directory();
    const fetchedAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await writeFile(join(dir, "litellm-rates-cache.json"), JSON.stringify({ fetchedAt, rates: document }));
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    expect((await loadPricing(dir, resolve("resources/fallback-rates.json"))).status).toMatchObject({ status: "cached", fetchedAt });
    const empty = await directory();
    expect((await loadPricing(empty, join(empty, "missing"))).status.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
