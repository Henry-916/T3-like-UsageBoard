import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPricePresets } from "../src/main/usage/pricePresets";

let home: string;
let userData: string;
let fallbackRates: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "usageboard-presets-"));
  userData = join(home, "userData");
  fallbackRates = join(home, "fallback-rates.json");
  await mkdir(userData, { recursive: true });
  await writeFile(fallbackRates, JSON.stringify({
    source: "test",
    fetchedAt: new Date().toISOString(),
    rates: {
      "openai/gpt-5": { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6 },
      "deepseek/deepseek-chat": { input_cost_per_token: 0.28e-6, output_cost_per_token: 0.42e-6 },
    },
  }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function put(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

function modelsDevResponse(providers: unknown): Response {
  return new Response(JSON.stringify(providers), { status: 200 });
}

async function plantLocalCatalogs() {
  await put(join(home, ".cache", "opencode", "models.json"), JSON.stringify({
    localonly: { models: { "local-only-model": { cost: { input: 9, output: 19 } } } },
  }));
  await put(join(home, ".config", "opencode", "opencode.jsonc"), `{
    "provider": {
      "cpa": {
        "options": { "apiKey": "SECRET-KEY", "baseURL": "https://example.invalid/v1" },
        "models": { "claude-opus-4-6": { "cost": { "input": 5, "output": 25 } } }
      }
    }
  }`);
}

describe("loadPricePresets", () => {
  it("loads only from models.dev/api.json, ignores local catalogs and LiteLLM fallback, and uses provider/model as label", async () => {
    await plantLocalCatalogs();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(modelsDevResponse({
      deepseek: {
        models: {
          "deepseek-flash": {
            name: "Daybreak Red",
            canonical_model_id: " DeepSeek/DeepSeek-V4.1-Flash-1017 ",
            cost: [
              { input: 0.28, output: 0.42 },
              { tier: { type: "context", size: 128000 }, input: 0.56, output: 0.84 },
            ],
          },
        },
      },
      openai: {
        options: { apiKey: "SHOULD-NOT-BE-DECODED" },
        models: {
          "gpt-5": { name: "GPT-5", cost: { input: 1.25, output: 10, cache_read: 0.125 } },
        },
      },
    }));

    try {
      const presets = await loadPricePresets({ userData });
      expect(fetchMock).toHaveBeenCalledWith("https://models.dev/api.json", expect.any(Object));
      expect(presets.map(({ modelId }) => modelId)).toEqual([
        "openai/gpt-5", "deepseek/deepseek-v4.1-flash-1017",
      ]);
      expect(presets.every(({ source }) => source === "models.dev")).toBe(true);
      // Local OpenCode files and the LiteLLM fixture are never consulted.
      expect(presets.some(({ modelId }) => modelId.includes("local-only"))).toBe(false);
      expect(presets.some(({ modelId }) => modelId.includes("deepseek-chat"))).toBe(false);

      const flash = presets.find(({ modelId }) => modelId === "deepseek/deepseek-v4.1-flash-1017")!;
      expect(flash).toMatchObject({
        label: "deepseek/deepseek-v4.1-flash-1017",
        providerLabel: "DeepSeek",
        providerId: "deepseek",
        providerRank: 3,
        canonicalId: "deepseek/deepseek-v4.1-flash-1017",
        isCanonicalOwner: true,
        primary: true,
        aliases: ["deepseek-flash"],
        inputCostPerMillionTokens: 0.28,
        outputCostPerMillionTokens: 0.42,
      });
      expect(flash).not.toHaveProperty("cacheReadCostPerMillionTokens");
      expect(flash).not.toHaveProperty("cacheWriteCostPerMillionTokens");

      const gpt = presets.find(({ modelId }) => modelId === "openai/gpt-5")!;
      expect(gpt).toMatchObject({
        label: "openai/gpt-5",
        cacheReadCostPerMillionTokens: 0.125,
      });
      expect(gpt).not.toHaveProperty("cacheWriteCostPerMillionTokens");

      // The cache stores only the projected canonical ID, release metadata and cost.
      const cacheFile = await readFile(join(userData, "models-dev-cache.json"), "utf8");
      const cache = JSON.parse(cacheFile);
      expect(cache.version).toBe(4);
      expect(cache.adoption["deepseek/deepseek-v4.1-flash-1017"]).toBe(1);
      expect(cacheFile).not.toMatch(/Daybreak Red|SHOULD-NOT-BE-DECODED|SECRET-KEY|example\.invalid/);
      expect(cacheFile).toContain('"canonical_model_id":" DeepSeek/DeepSeek-V4.1-Flash-1017 "');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("returns [] on a cold offline start even when local catalogs and fallback rates exist", async () => {
    await plantLocalCatalogs();
    const offline = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      const presets = await loadPricePresets({ userData });
      expect(offline).toHaveBeenCalledWith("https://models.dev/api.json", expect.anything());
      expect(presets).toEqual([]);
    } finally {
      offline.mockRestore();
    }
  });

  it("ignores legacy caches without version 4", async () => {
    await put(join(userData, "models-dev-cache.json"), JSON.stringify({
      version: 3,
      fetchedAt: new Date().toISOString(),
      catalog: { openai: { models: { "gpt-5": { cost: { input: 1, output: 2 } } } } },
    }));
    const offline = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      expect(await loadPricePresets({ userData })).toEqual([]);
    } finally {
      offline.mockRestore();
    }
  });

  it("reuses a fresh 24h cache and falls back to an expired version 4 cache offline", async () => {
    let online = true;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "https://models.dev/api.json" && online) {
        return modelsDevResponse({
          anthropic: {
            models: {
              "sonnet-latest": {
                canonical_model_id: "anthropic/claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
              },
            },
          },
        });
      }
      throw new Error("offline");
    });

    try {
      const first = await loadPricePresets({ userData });
      expect(first.map(({ modelId }) => modelId)).toEqual(["anthropic/claude-sonnet-4-6"]);

      fetchMock.mockClear();
      const second = await loadPricePresets({ userData });
      expect(fetchMock).not.toHaveBeenCalledWith("https://models.dev/api.json", expect.anything());
      expect(second).toEqual(first);

      const cacheFile = await readFile(join(userData, "models-dev-cache.json"), "utf8");
      online = false;
      await put(join(userData, "models-dev-cache.json"), JSON.stringify({
        ...JSON.parse(cacheFile), fetchedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
      }));
      fetchMock.mockClear();
      const stale = await loadPricePresets({ userData });
      expect(fetchMock).toHaveBeenCalledWith("https://models.dev/api.json", expect.anything());
      expect(stale).toEqual(first);
    } finally {
      fetchMock.mockRestore();
    }
  });

it("collects Tier A + Tier B channels, collapses regional copies, keeps price variants, and marks one primary per model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(modelsDevResponse({
      moonshotai: {
        models: {
          "kimi-k3": { canonical_model_id: "moonshotai/kimi-k3", cost: { input: 3, output: 15 } },
          "kimi-k2.7-code": { canonical_model_id: "moonshotai/kimi-k2.7-code", cost: { input: 0.95, output: 4 } },
          "kimi-k2.7-code-highspeed": { canonical_model_id: "moonshotai/kimi-k2.7-code", cost: { input: 1.9, output: 8 } },
        },
      },
      "moonshotai-cn": {
        models: {
          "kimi-k3": { canonical_model_id: "moonshotai/kimi-k3", cost: { input: 2.9879, output: 14.9395 } },
        },
      },
      alibaba: {
        models: {
          "qwen3.7-flash": { canonical_model_id: "alibaba/qwen3.7-flash", cost: { input: 0.06, output: 0.24 } },
        },
      },
      "alibaba-cn": {
        models: {
          "qwen3.7-flash": { canonical_model_id: "alibaba/qwen3.7-flash", cost: { input: 0.055, output: 0.22 } },
          "kimi-k3": { canonical_model_id: "moonshotai/kimi-k3", cost: { input: 2, output: 12 } },
        },
      },
      zai: {
        models: {
          "glm-5.3-flash": { canonical_model_id: "zai/glm-5.3-flash", cost: { input: 0.15, output: 0.5 } },
          "glm-5.3-flashx": { canonical_model_id: "zai/glm-5.3-flash", cost: { input: 0.37, output: 1.25 } },
        },
      },
      zhipuai: {
        models: {
          "glm-5.3-flashx": { canonical_model_id: "zai/glm-5.3-flash", cost: { input: 0.36, output: 1.2 } },
        },
      },
      openrouter: {
        models: { "kimi-k3": { cost: { input: 2, output: 12 } } },
      },
      "amazon-bedrock": {
        models: {
          "anthropic.claude-sonnet-4-6-v1": {
            canonical_model_id: "anthropic/claude-sonnet-4-6", cost: { input: 3, output: 15 },
          },
          "us.anthropic.claude-sonnet-4-6-v1": {
            canonical_model_id: "anthropic/claude-sonnet-4-6", cost: { input: 3, output: 15 },
          },
        },
      },
    }));

    try {
      const presets = await loadPricePresets({ userData });
      const ids = presets.map(({ modelId }) => modelId);
      expect(ids).toEqual(expect.arrayContaining([
        "moonshotai/kimi-k3",
        "moonshotai/kimi-k2.7-code",
        "moonshotai/kimi-k2.7-code-highspeed",
        "moonshotai-cn/kimi-k3",
        "alibaba/qwen3.7-flash",
        "alibaba-cn/qwen3.7-flash",
        "alibaba-cn/kimi-k3",
        "zai/glm-5.3-flash",
        "zai/glm-5.3-flashx",
        "zhipuai/glm-5.3-flashx",
        "openrouter/kimi-k3",
        "amazon-bedrock/anthropic.claude-sonnet-4-6-v1",
      ]));
      expect(ids).toHaveLength(12);
      expect(ids[0]).toBe("moonshotai/kimi-k3");

      const byId = new Map(presets.map((preset) => [preset.modelId, preset]));

      // International first-party storefront wins the primary slot.
      expect(byId.get("moonshotai/kimi-k3")).toMatchObject({
        providerId: "moonshotai", providerRank: 5, providerLabel: "Moonshot AI",
        isCanonicalOwner: true, primary: true,
        inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15,
      });
      expect(byId.get("moonshotai-cn/kimi-k3")).toMatchObject({
        providerRank: 19, isCanonicalOwner: false, primary: false,
      });
      // Tier B resales stay available but never claim canonical ownership.
      expect(byId.get("alibaba-cn/kimi-k3")).toMatchObject({
        canonicalId: "moonshotai/kimi-k3", isCanonicalOwner: false, primary: false,
      });
      expect(byId.get("openrouter/kimi-k3")).toMatchObject({
        canonicalId: "moonshotai/kimi-k3", providerRank: 23, isCanonicalOwner: false, primary: false,
      });

      // Different-price sub-models sharing a canonical ID stay independent.
      expect(byId.get("moonshotai/kimi-k2.7-code-highspeed")).toMatchObject({
        canonicalId: "moonshotai/kimi-k2.7-code:kimi-k2.7-code-highspeed",
        inputCostPerMillionTokens: 1.9, outputCostPerMillionTokens: 8,
        derived: true,
      });
      expect(byId.get("zai/glm-5.3-flashx")).toMatchObject({
        canonicalId: "zai/glm-5.3-flash:glm-5.3-flashx", primary: true,
        inputCostPerMillionTokens: 0.37, outputCostPerMillionTokens: 1.25,
        derived: true,
      });
      expect(byId.get("zai/glm-5.3-flash")).not.toHaveProperty("derived");
      expect(byId.get("zai/glm-5.3-flash")!.aliases).toBeUndefined();
      expect(byId.get("moonshotai/kimi-k2.7-code")!.aliases).toBeUndefined();
      expect(byId.get("zhipuai/glm-5.3-flashx")).toMatchObject({ primary: false });

      // Amazon Bedrock regional copies fold into aliases instead of new presets.
      const bedrock = byId.get("amazon-bedrock/anthropic.claude-sonnet-4-6-v1")!;
      expect(bedrock.aliases).toContain("us.anthropic.claude-sonnet-4-6-v1");
      expect(presets.filter(({ canonicalId }) => canonicalId === "anthropic/claude-sonnet-4-6")).toHaveLength(1);

      const primaries = new Map<string, number>();
      for (const preset of presets.filter(({ primary }) => primary)) {
        primaries.set(preset.canonicalId!, (primaries.get(preset.canonicalId!) ?? 0) + 1);
      }
      expect([...primaries.values()].every((count) => count === 1)).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("ranks by release freshness and catalogue adoption, drops non-chat models, and downweights multimodal output", async () => {
    const resale = { canonical_model_id: "deepseek/deepseek-hot", release_date: "2026-11-01", cost: { input: 1, output: 2 } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(modelsDevResponse({
      openai: {
        models: {
          "gpt-old": { canonical_model_id: "openai/gpt-old", release_date: "2024-01-01", cost: { input: 1, output: 2 } },
          "gpt-new": { canonical_model_id: "openai/gpt-new", release_date: "2026-11-01", cost: { input: 1, output: 2 } },
          "chatgpt-image-latest": {
            canonical_model_id: "openai/chatgpt-image-latest", release_date: "2026-11-01",
            modalities: { output: ["text", "image"] }, cost: { input: 1, output: 2 },
          },
          "tts-1": {
            canonical_model_id: "openai/tts-1", release_date: "2026-11-01",
            modalities: { output: ["audio"] }, cost: { input: 1, output: 2 },
          },
          "text-embedding-3": {
            canonical_model_id: "openai/text-embedding-3", release_date: "2026-11-01",
            cost: { input: 0.1, output: 0 },
          },
        },
      },
      google: {
        models: {
          "deepseek-hot": resale,
          "gemini-image": {
            canonical_model_id: "google/gemini-image", release_date: "2026-11-01",
            modalities: { output: ["image"] }, cost: { input: 1, output: 2 },
          },
        },
      },
      deepseek: { models: { "deepseek-hot": resale } },
      anthropic: { models: { "deepseek-hot": resale } },
      moonshotai: { models: { "deepseek-hot": resale } },
      zai: { models: { "deepseek-hot": resale } },
    }));

    try {
      const presets = await loadPricePresets({ userData });
      const ids = presets.map(({ modelId }) => modelId);
      // Five providers carry the model, so it outranks the single-provider 2026 release.
      expect(ids[0]).toBe("deepseek/deepseek-hot");
      expect(presets.filter(({ modelId }) => modelId === "deepseek/deepseek-hot")).toHaveLength(1);

      const byId = new Map(presets.map((preset) => [preset.modelId, preset]));
      expect(byId.get("openai/gpt-new")!.popularity).toBeCloseTo(1.58496, 5);
      expect(byId.get("openai/chatgpt-image-latest")!.popularity).toBeCloseTo(0.0792481, 6);
      expect(byId.get("deepseek/deepseek-hot")!.popularity).toBeCloseTo(2.80735, 5);

      const fresh = ids.indexOf("openai/gpt-new");
      const image = ids.indexOf("openai/chatgpt-image-latest");
      const stale = ids.indexOf("openai/gpt-old");
      expect(fresh).toBeGreaterThan(0);
      expect(image).toBeGreaterThan(fresh);
      expect(stale).toBeGreaterThan(image);

      expect(ids).not.toContain("openai/tts-1");
      expect(ids).not.toContain("google/gemini-image");
      expect(ids).not.toContain("openai/text-embedding-3");

      const cache = JSON.parse(await readFile(join(userData, "models-dev-cache.json"), "utf8"));
      expect(cache.version).toBe(4);
      expect(cache.adoption["deepseek/deepseek-hot"]).toBe(5);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("log-compresses in-vendor popularity, dampens light tiers and derived variants, and keeps variant adoption at 1", async () => {
    const flagship = { canonical_model_id: "zai/glm-5.3", release_date: "2026-11-01", cost: { input: 1, output: 3 } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(modelsDevResponse({
      zai: {
        models: {
          "glm-5.3": flagship,
          "glm-5.3-flash": {
            canonical_model_id: "zai/glm-5.3-flash", release_date: "2026-11-10",
            cost: { input: 0.15, output: 0.5 },
          },
          "glm-5.3-flashx": {
            canonical_model_id: "zai/glm-5.3", release_date: "2026-11-01",
            cost: { input: 0.37, output: 1.25 },
          },
          "glm-5.3-legal": {
            canonical_model_id: "zai/glm-5.3-legal", release_date: "2026-11-01",
            cost: { input: 2, output: 6 },
          },
        },
      },
      zhipuai: { models: { "glm-5.3": flagship } },
      minimax: { models: { "glm-5.3": flagship } },
    }));

    try {
      const presets = await loadPricePresets({ userData });
      const byId = new Map(presets.map((preset) => [preset.modelId, preset]));
      const ids = presets.map(({ modelId }) => modelId);

      // adoption = 3 providers and the freshest sibling is 9 days newer:
      // log2(3 + 2) * exp(-9 / 180) = 2.20869.
      expect(byId.get("zai/glm-5.3")!.popularity).toBeCloseTo(2.20869, 5);
      // The light tier keeps its own adoption but loses the 0.85 tier weight.
      expect(byId.get("zai/glm-5.3-flash")!.popularity).toBeCloseTo(1.34722, 5);
      // The split variant scores on adoption 1 and the derived weight, not the parent's 3.
      expect(byId.get("zai/glm-5.3-flashx")).toMatchObject({ derived: true });
      expect(byId.get("zai/glm-5.3-flashx")!.popularity).toBeCloseTo(0.376916, 6);
      expect(byId.get("zai/glm-5.3-legal")).toMatchObject({ derived: true });
      expect(byId.get("zai/glm-5.3-legal")!.popularity).toBeCloseTo(0.376916, 6);

      expect(ids.indexOf("zai/glm-5.3")).toBeLessThan(ids.indexOf("zai/glm-5.3-flash"));
      expect(ids.indexOf("zai/glm-5.3-flash")).toBeLessThan(ids.indexOf("zai/glm-5.3-flashx"));
    } finally {
      fetchMock.mockRestore();
    }
  });
});
