import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelsDevSnapshot, loadModelsDevSnapshot, parseModelsDevSnapshot, resetModelsDevState, waitForModelsDevRefresh } from "../src/main/usage/modelsDev";
import { buildRateTable, createOverrideRateTable, describeRecordRate, loadPricing, lookupRate, priceUsage } from "../src/main/usage/pricing";
import { describeMultiplierRules } from "../src/shared/pricingMultipliers";
import { EMPTY_TOTALS } from "../src/shared/types";

const cost = (input: number, output: number, extra?: Record<string, unknown>) => ({
  text: {
    input: { price: input, ...(extra ?? {}) },
    output: { price: output },
  },
});

const document = {
  anthropic: {
    models: {
      "claude-test": {
        id: "claude-test-20260101",
        canonical_id: "anthropic/claude-test",
        cost: {
          text: {
            input: {
              price: 2,
              cache: { read: 0.5, write: { "5m": 3, "1h": 4 } },
              overrides: [{
                when: { context: { gt: 1000 } },
                price: 4,
                cache: { read: 1, write: { "5m": 6, "1h": 8 } },
              }],
            },
            output: { price: 10, overrides: [{ when: { context: { gt: 1000 } }, price: 20 }] },
          },
          multipliers: [{ when: { service_tier: { equals: "fast" } }, factor: 2 }],
        },
      },
      "claude-opus-5-5": { canonical_id: "anthropic/claude-opus-5-5", cost: cost(1, 2) },
    },
  },
  openai: { models: { "gpt-5": { canonical_id: "openai/gpt-5", cost: cost(1, 2) } } },
  reseller: { models: { "claude-test": { canonical_id: "anthropic/claude-test", cost: cost(9, 9) } } },
  opencode: {
    models: {
      "model-free": {
        canonical_id: "opencode/model-free",
        cost: { text: { input: { price: 0 }, output: { price: 0 } } },
      },
    },
  },
  "alibaba-cn": {
    models: {
      qwen: { canonical_id: "alibaba/qwen", cost: cost(1, 1) },
      "deepseek-v4.1-flash-1017": { canonical_id: "deepseek/deepseek-v4.1-flash-1017", cost: cost(0.28, 1.13) },
    },
  },
};

const snapshot = buildModelsDevSnapshot(document, { source: "test", fetchedAt: new Date().toISOString() })!;
const table = buildRateTable(snapshot);
const record = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  speed: "standard" as const,
  reportedCostUsd: null,
  cacheCreation1hTokens: 4,
  timestampMs: Date.parse("2026-11-24T00:00:00Z"),
  totals: { ...EMPTY_TOTALS, uncachedInputTokens: 10, cachedInputTokens: 20, cacheCreationTokens: 10, outputTokens: 5, reasoningTokens: 5 },
  ...extra,
});

describe("priceUsage", () => {
  it("prefers first-party aliases and separates cache TTLs without double-billing reasoning", () => {
    const priced = priceUsage(table, record(" CLAUDE-TEST[1m]"));
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.categoryCostUsd?.cacheWrite).toBeCloseTo(34e-6, 12);
    expect(priced.costUsd).toBeCloseTo(114e-6, 12);
    expect(priced.cacheSavingsUsd).toBeCloseTo(30e-6, 12);
  });

  it("handles context tiers and fast service-tier multipliers", () => {
    const priced = priceUsage(table, record("claude-test", {
      speed: "fast",
      totals: { ...record("claude-test").totals, uncachedInputTokens: 1000 },
    }));
    expect(priced.categoryCostUsd?.input).toBeCloseTo(0.008, 12);
    expect(priced.speedPremiumUsd).toBeCloseTo(priced.costUsd / 2, 12);
  });

  it("uses override list prices instead of old reported totals and preserves the free fallback", () => {
    const overrides = createOverrideRateTable({
      "claude-test": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 1, cacheReadCostPerMillionTokens: 0 },
    });
    expect(priceUsage(table, record("claude-test"), overrides).costUsd).toBeCloseTo(85e-6, 12);
    for (const reportedCostUsd of [0, 0.5]) {
      const repriced = priceUsage(table, record("claude-test", { reportedCostUsd }), overrides);
      expect(repriced.costSource).toBe("modelPriced");
      expect(repriced.costUsd).toBeCloseTo(85e-6, 12);
      expect(repriced.categoryCostUsd?.cacheRead).toBe(0);
    }
    expect(priceUsage(table, record("unknown", { reportedCostUsd: 0 }), overrides))
      .toMatchObject({ costUsd: 0, costSource: "providerReported",
        categoryCostUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(priceUsage(table, record("unknown", { reportedCostUsd: 0.75 }), overrides)).toEqual({
      costUsd: 0, costSource: "unpriced", categoryCostUsd: null, speedPremiumUsd: 0, cacheSavingsUsd: 0,
    });
    // A zero-priced rate cannot split a positive lump-sum report; do not trust it.
    expect(priceUsage(table, record("opencode/model-free", { reportedCostUsd: 2 }), overrides)).toMatchObject({
      costUsd: 0, costSource: "modelPriced",
      categoryCostUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("only forwards whitelisted gateway synonyms and never strips a private prefix", () => {
    for (const model of ["openai-codex/gpt-5", "openai-chatgpt/gpt-5"]) {
      expect(priceUsage(table, record(model)).costSource).toBe("modelPriced");
    }
    expect(priceUsage(table, record("claude-code/claude-opus-5-5")).costSource).toBe("modelPriced");
    expect(priceUsage(table, record("dashscope/qwen")).costSource).toBe("modelPriced");
    for (const model of ["custom/gpt-5", "cpa/gpt-5", "opencsg/gpt-5"]) {
      expect(priceUsage(table, record(model, { reportedCostUsd: 0.5 }))).toEqual({
        costUsd: 0, costSource: "unpriced", categoryCostUsd: null, speedPremiumUsd: 0, cacheSavingsUsd: 0,
      });
    }
    expect(lookupRate(table, "gpt-5")).toBeDefined();
    expect(lookupRate(table, "reseller/claude-test")).toBeDefined();
  });

  it("falls back from snapshot-date suffixes to the same channel's base model", () => {
    const priced = priceUsage(table, record("anthropic/claude-opus-5-5-20261001"));
    expect(priced.costSource).toBe("modelPriced");
    expect(priced.costUsd).toBeCloseTo(50e-6, 12);
    expect(priceUsage(table, record("anthropic/claude-opus-5-5-2026-10-01")).costSource).toBe("modelPriced");
    expect(priceUsage(table, record("custom/claude-opus-5-5-20261001")).costSource).toBe("unpriced");
  });

  it("folds an already-effective date-only change into the displayed unit price", () => {
    const dated = buildRateTable(buildModelsDevSnapshot({
      openai: {
        models: {
          "gpt-dated": {
            cost: {
              text: { input: { price: 1 }, output: { price: 2 } },
              multipliers: [{ when: { date: { gte: "2020-01-01" } }, factor: 1.5 }],
            },
          },
        },
      },
    }, { source: "test", fetchedAt: new Date().toISOString() })!);
    const described = describeRecordRate(dated, record("gpt-dated"));
    expect(described?.inputCostPerMillionTokens).toBeCloseTo(1.5, 10);
    expect(described?.outputCostPerMillionTokens).toBeCloseTo(3, 10);
    // The peak describer ignores date-only rules because they are already baked in.
    expect(describeMultiplierRules(described?.multipliers, "UTC")).toBeNull();
  });
});

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usage-rates-"));
  dirs.push(dir);
  return dir;
}
beforeEach(() => resetModelsDevState());
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.map((dir) => waitForModelsDevRefresh(dir).catch(() => undefined)));
  resetModelsDevState();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

const cacheSnapshot = (fetchedAt: string) => ({ ...snapshot, fetchedAt });

describe("bundled snapshot", () => {
  it("ships priced first-party models with their peak schedules", async () => {
    const parsed = parseModelsDevSnapshot(JSON.parse(
      await readFile(resolve("resources/models-dev-snapshot.json"), "utf8"),
    ));
    expect(parsed?.version).toBe(6);
    const bundled = buildRateTable(parsed!);
    const deepseek = lookupRate(bundled, "deepseek/deepseek-v4.1-flash-1017");
    expect(deepseek?.standard.input).toBeGreaterThan(0);
    expect(deepseek?.multipliers.length).toBeGreaterThan(0);
    expect(lookupRate(bundled, "alibaba-cn/deepseek-v4.1-flash-1017")).toBeDefined();
    expect(lookupRate(bundled, "gpt-5")).toBeDefined();
  });
});

describe("loadPricing", () => {
  it("uses a fresh local snapshot without fetching", async () => {
    const dir = await directory();
    const fetchedAt = new Date().toISOString();
    await writeFile(join(dir, "models-dev-cache.json"), JSON.stringify(cacheSnapshot(fetchedAt)));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pricing = await loadPricing(dir, join(dir, "missing.json"));
    expect(pricing.status).toMatchObject({ status: "cached", fetchedAt });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the bundled snapshot instantly and refreshes in the background", async () => {
    const dir = await directory();
    const bundled = join(dir, "models-dev-snapshot.json");
    await writeFile(bundled, JSON.stringify(cacheSnapshot(new Date(Date.now() - 25 * 3_600_000).toISOString())));
    const fetchMock = vi.fn(async () => Response.json(document, { headers: { etag: '"v1"' } }));
    vi.stubGlobal("fetch", fetchMock);
    const pricing = await loadPricing(dir, bundled);
    expect(pricing.status.status).toBe("cached");
    expect(lookupRate(pricing.rates, "gpt-5")).toBeDefined();
    await waitForModelsDevRefresh(dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(await readFile(join(dir, "models-dev-cache.json"), "utf8"));
    expect(cache).toMatchObject({ version: 6, etag: '"v1"', source: "https://models.dev/experimental/v2.0/api.json?type=all" });
  });

  it("deduplicates concurrent refreshes and revalidates with ETag", async () => {
    const dir = await directory();
    const bundled = join(dir, "models-dev-snapshot.json");
    await writeFile(bundled, JSON.stringify(cacheSnapshot(new Date(Date.now() - 25 * 3_600_000).toISOString())));
    const fetchMock = vi.fn(async () => Response.json(document));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([loadPricing(dir, bundled), loadPricing(dir, bundled)]);
    await waitForModelsDevRefresh(dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await loadModelsDevSnapshot({ userData: dir, bundledSnapshot: bundled }))?.version).toBe(6);
  });

  it("handles 304 Not Modified by refreshing fetchedAt without downloading", async () => {
    const dir = await directory();
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await writeFile(join(dir, "models-dev-cache.json"), JSON.stringify({ ...cacheSnapshot(stale), etag: '"old"' }));
    const fetchMock = vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"old"' } }));
    vi.stubGlobal("fetch", fetchMock);
    await loadPricing(dir, join(dir, "missing"));
    await waitForModelsDevRefresh(dir);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { "If-None-Match": '"old"' },
    }));
    const cache = JSON.parse(await readFile(join(dir, "models-dev-cache.json"), "utf8"));
    expect(Date.parse(cache.fetchedAt)).toBeGreaterThan(Date.parse(stale));
  });

  it("falls back to the stable models.dev feed when the experimental path is gone", async () => {
    const dir = await directory();
    const bundled = join(dir, "models-dev-snapshot.json");
    await writeFile(bundled, JSON.stringify(cacheSnapshot(new Date(Date.now() - 25 * 3_600_000).toISOString())));
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://models.dev/experimental/v2.0/api.json?type=all") {
        return new Response("not found", { status: 404 });
      }
      return Response.json(document);
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadPricing(dir, bundled);
    await waitForModelsDevRefresh(dir);
    const cache = JSON.parse(await readFile(join(dir, "models-dev-cache.json"), "utf8"));
    expect(cache.source).toBe("https://models.dev/api.json");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a stale cache before the bundle on failure and is unavailable only with neither", async () => {
    const dir = await directory();
    const fetchedAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await writeFile(join(dir, "models-dev-cache.json"), JSON.stringify(cacheSnapshot(fetchedAt)));
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const stale = await loadPricing(dir, join(dir, "missing.json"));
    expect(stale.status).toMatchObject({ status: "cached", fetchedAt });
    await waitForModelsDevRefresh(dir);
    const empty = await directory();
    expect((await loadPricing(empty, join(empty, "missing"))).status.status).toBe("unavailable");
  });
});
