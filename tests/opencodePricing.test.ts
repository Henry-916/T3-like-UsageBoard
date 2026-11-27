import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOpenCodePricing } from "../src/main/usage/opencodePricing";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "usageboard-pricing-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function put(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

const config = (input: number) => JSON.stringify({
  provider: { CPA: { models: { MODEL: { cost: { input, output: 5 } } } } },
});

describe("loadOpenCodePricing", () => {
  it("projects JSONC without decoding ignored fields and converts object/array tiers", async () => {
    await put(join(home, ".config", "opencode", "opencode.jsonc"), `{
      // fixture
      "provider": { "CPA": {
        "options": { "apiKey": "SYNTHETIC-KEY", "headers": ["SYNTHETIC-HEADER"],
          "baseURL": "https://example.invalid/ignored/*still-string*/",
          "models": { "decoy": { "cost": { "input": 10, "output": 10 } } } },
        "models": {
          "Object": { "id": "  HTTPS://example.invalid/alias  ", "cost": {
            "input": 1, "output": 5, "cache_read": 0, "cache": { "write": 2 },
            "context_over_200k": { "input": 2, "output": 6 },
            "tiers": [{ "tier": { "type": "context", "size": 300000 }, "input": 3, "output": 7 }],
          } },
          "Invalid": { "cost": { "input": -1, "output": 1 } },
          "NonFinite": { "cost": { "input": 1e400, "output": 1 } },
          "Unrelated": { "options": { "cost": { "input": 1, "output": 1 } } },
        },
      } },
      /* a second provider map */
      "providers": { "Gateway": { "models": {
        "Array": { "cost": [
          { "input": -1, "output": 8 },
          { "input": 4, "output": 8, "cache": { "read": 1 } },
          { "input": 6, "output": 9, "tier": { "type": "context", "size": 272000 } },
          { "input": 7, "output": 10, "tier": { "type": "context", "size": 400000 } },
          { "input": 8, "output": 11, "tier": { "type": "other", "size": 500000 } },
        ] },
        "TierOnly": { "cost": [{ "input": 0, "output": 0, "tier": { "type": "context", "size": 1 } }] },
      } } },
    }`);
    const decode = vi.spyOn(JSON, "parse");
    try {
      const { userRates } = await loadOpenCodePricing({ home, env: {} });
      expect([...userRates.keys()]).toEqual(["cpa/object", "cpa/https://example.invalid/alias", "gateway/array"]);
      const obj = userRates.get("cpa/object");
      expect(userRates.get("cpa/https://example.invalid/alias")).toBe(obj);
      expect(obj?.standard).toEqual({
        input: 1e-6, output: 5e-6, cacheRead: 0, cacheWrite: 2e-6, cacheWrite1h: 2e-6,
      });
      expect(obj?.tiers.map(({ threshold, rates }) => [threshold, rates.standard.cacheRead]))
        .toEqual([[300_000, 3e-6], [200_000, 2e-6]]);
      const array = userRates.get("gateway/array");
      expect(array?.standard.cacheRead).toBe(1e-6);
      expect(array?.tiers.map(({ threshold }) => threshold)).toEqual([400_000, 272_000]);
      const decoded = decode.mock.calls.map(([value]) => value).join("\n");
      expect(decoded).not.toMatch(/SYNTHETIC-KEY|SYNTHETIC-HEADER|apiKey|headers|baseURL|decoy|example\.invalid\/ignored/);
    } finally {
      decode.mockRestore();
    }
  });

  it("merges user files by precedence and skips malformed documents", async () => {
    const defaults = join(home, ".config", "opencode");
    const xdg = join(home, "xdg");
    const appData = join(home, "appData");
    const custom = join(home, "custom");
    const explicit = join(home, "chosen.jsonc");
    await put(join(defaults, "opencode.json"), config(1));
    await put(join(defaults, "opencode.jsonc"), config(2));
    await put(join(xdg, "opencode", "opencode.json"), config(3));
    await put(join(appData, "opencode", "opencode.json"), config(4));
    await put(join(custom, "opencode.json"), config(5));
    await put(join(custom, "opencode.jsonc"), `${config(6)} invalid`);
    await put(explicit, config(7));
    const get = async (env: NodeJS.ProcessEnv) =>
      (await loadOpenCodePricing({ home, env })).userRates.get("cpa/model")?.standard.input;
    expect(await get({})).toBe(2e-6);
    expect(await get({ XDG_CONFIG_HOME: xdg })).toBe(3e-6);
    const env = { XDG_CONFIG_HOME: xdg, APPDATA: appData };
    expect(await get(env)).toBe(process.platform === "win32" ? 4e-6 : 3e-6);
    expect(await get({ ...env, OPENCODE_CONFIG_DIR: custom })).toBe(5e-6);
    expect(await get({ ...env, OPENCODE_CONFIG_DIR: custom, OPENCODE_CONFIG: explicit })).toBe(7e-6);
  });

  it("ignores local models.json and opencode.db catalogs entirely", async () => {
    await put(join(home, ".cache", "opencode", "models.json"), JSON.stringify({
      "Alibaba-CN": { models: { "deepseek-v4.1-flash-1017": { cost: { input: 9, output: 9 } } } },
    }));
    const pricing = await loadOpenCodePricing({ home, env: {} });
    expect(pricing.userRates.size).toBe(0);
    expect(pricing).not.toHaveProperty("catalogRates");
  });
});
