import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOpenCodePricing, opencodeDbPaths } from "../src/main/usage/opencodePricing";

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

  it("keeps catalog pricing separate and invalidates cached fingerprints on create, edit and delete", async () => {
    const catalog = join(home, ".cache", "opencode", "models.json");
    const user = join(home, ".config", "opencode", "opencode.json");
    const options = { home, env: {} };
    const empty = await loadOpenCodePricing(options);
    expect(empty.catalogRates.size).toBe(0);
    expect(await loadOpenCodePricing(options)).toBe(empty);
    const document = (input: number) => JSON.stringify(JSON.parse(config(input)).provider);
    await put(catalog, document(6));
    await put(user, config(2));
    const initial = await loadOpenCodePricing(options);
    expect(initial.catalogRates.get("cpa/model")?.standard.input).toBe(6e-6);
    expect(initial.userRates.get("cpa/model")?.standard.input).toBe(2e-6);
    await put(catalog, document(13));
    await put(user, config(17));
    const edited = await loadOpenCodePricing(options);
    expect(edited.catalogRates.get("cpa/model")?.standard.input).toBe(13e-6);
    expect(edited.userRates.get("cpa/model")?.standard.input).toBe(17e-6);
    await rm(catalog);
    expect((await loadOpenCodePricing(options)).catalogRates.size).toBe(0);
  });
});

const v3Body = (input = 0.14) => ({
  "Alibaba-CN": {
    api: "https://SYNTHETIC-SECRET.invalid/v1",
    base_url: "https://SYNTHETIC-SECRET.invalid/v1",
    env: { SECRET_KEY: "SYNTHETIC-SECRET" },
    options: { headers: { Authorization: "SYNTHETIC-SECRET" } },
    headers: { "X-Secret": "SYNTHETIC-SECRET" },
    models: {
      "DeepSeek-V4.1-Flash-1017": {
        id: "DeepSeek-V4.1-Flash-1017",
        name: "SYNTHETIC-SECRET",
        api: "SYNTHETIC-SECRET",
        options: { cost: { text: { input: { price: 900 }, output: { price: 900 } } } },
        cost: { text: {
          input: {
            price: input,
            cache: { read: 0.014, write: { "5m": 0.05, "1h": 0.2 } },
            overrides: [{ when: { context: { gt: 200000 } }, price: 0.28 }],
          },
          output: {
            price: 0.42,
            overrides: [{ when: { context: { gt: 200000 } }, price: 0.84 }],
          },
        } },
      },
      Explicit: {
        cost: { text: {
          input: { price: 1, cache: { explicit: { read: 0.1, write: { "30m": 0.2, "12h": 0.3 } } } },
          output: { price: 2 },
        } },
      },
      Scalar: {
        cost: { text: { input: { price: 3, cache: { write: 0.3 } }, output: { price: 4 } } },
      },
      TieredCache: {
        cost: { text: {
          input: {
            price: 2,
            cache: { read: 0.02, write: { "5m": 0.1, "1h": 0.4 } },
            overrides: [{
              when: { context: { gt: 200000 } }, price: 4,
              cache: { read: 0.04, write: { "5m": 0.2, "1h": 0.8 } },
            }],
          },
          output: { price: 3, overrides: [{ when: { context: { gt: 200000 } }, price: 6 }] },
        } },
      },
      Missing: { cost: { text: { input: { price: 5 } } } },
      "alias-key": { id: "Canonical-ID", cost: { text: { input: { price: 6 }, output: { price: 7 } } } },
    },
  },
});

async function writeDb(file: string, body: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("DELETE FROM kv").run();
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)")
      .run("models-dev:v3:catalog", JSON.stringify({ body: JSON.stringify(body) }));
  } finally {
    db.close();
  }
}

describe("OpenCode SQLite catalog", () => {
  const defaultDb = () => resolve(join(home, ".local", "share", "opencode", "opencode.db"));

  it("collects data directories with the same rules as account discovery", () => {
    expect(opencodeDbPaths({ home, env: {} })).toEqual([defaultDb()]);
    const xdg = join(home, "xdg");
    expect(opencodeDbPaths({ home, env: { XDG_DATA_HOME: xdg } }))
      .toEqual([resolve(join(xdg, "opencode", "opencode.db"))]);
    const local = join(home, "local");
    expect(opencodeDbPaths({ home, env: { LOCALAPPDATA: local } })).toEqual(process.platform === "win32"
      ? [defaultDb(), resolve(join(local, "opencode", "opencode.db"))]
      : [defaultDb()]);
    const custom = join(home, "custom");
    expect(opencodeDbPaths({ home, env: { OPENCODE_DATA_DIR: `${custom}, ${custom}, ~/tilde` } })).toEqual([
      resolve(join(custom, "opencode.db")), resolve(join(home, "tilde", "opencode.db")),
    ]);
  });

  it("reads the v3 kv catalog read-only, whitelists cost.text and merges tiers", async () => {
    const dbPath = defaultDb();
    await writeDb(dbPath, v3Body());
    const decode = vi.spyOn(JSON, "parse");
    try {
      const { catalogRates } = await loadOpenCodePricing({ home, env: {} });
      expect([...catalogRates.keys()]).toEqual([
        "alibaba-cn/deepseek-v4.1-flash-1017", "alibaba-cn/explicit", "alibaba-cn/scalar",
        "alibaba-cn/tieredcache", "alibaba-cn/alias-key", "alibaba-cn/canonical-id",
      ]);
      const deepseek = catalogRates.get("alibaba-cn/deepseek-v4.1-flash-1017");
      expect(deepseek?.standard).toEqual({
        input: 0.14 / 1e6, output: 0.42 / 1e6, cacheRead: 0.014 / 1e6,
        cacheWrite: 0.05 / 1e6, cacheWrite1h: 0.2 / 1e6,
      });
      expect(deepseek?.tiers.map(({ threshold, rates }) => [
        threshold, rates.standard.input, rates.standard.output, rates.standard.cacheRead,
        rates.standard.cacheWrite, rates.standard.cacheWrite1h,
      ])).toEqual([[200_000, 0.28 / 1e6, 0.84 / 1e6, 0.014 / 1e6, 0.05 / 1e6, 0.2 / 1e6]]);
      const tiered = catalogRates.get("alibaba-cn/tieredcache");
      expect(tiered?.standard).toEqual({
        input: 2 / 1e6, output: 3 / 1e6, cacheRead: 0.02 / 1e6,
        cacheWrite: 0.1 / 1e6, cacheWrite1h: 0.4 / 1e6,
      });
      expect(tiered?.tiers.map(({ threshold, rates }) => [
        threshold, rates.standard.input, rates.standard.output, rates.standard.cacheRead,
        rates.standard.cacheWrite, rates.standard.cacheWrite1h,
      ])).toEqual([[200_000, 4 / 1e6, 6 / 1e6, 0.04 / 1e6, 0.2 / 1e6, 0.8 / 1e6]]);
      expect(catalogRates.get("alibaba-cn/explicit")?.standard).toMatchObject({
        input: 1e-6, output: 2e-6, cacheRead: 0.1 / 1e6, cacheWrite: 0.2 / 1e6, cacheWrite1h: 0.3 / 1e6,
      });
      expect(catalogRates.get("alibaba-cn/scalar")?.standard).toMatchObject({
        input: 3e-6, output: 4e-6, cacheRead: 3e-6, cacheWrite: 0.3 / 1e6, cacheWrite1h: 0.3 / 1e6,
      });
      expect(catalogRates.has("alibaba-cn/missing")).toBe(false);
      expect(catalogRates.get("alibaba-cn/alias-key")).toBe(catalogRates.get("alibaba-cn/canonical-id"));

      // Only allowlisted keys ever become decoded objects; sensitive subtrees stay skipped.
      for (const { value } of decode.mock.results) {
        if (typeof value !== "object" || value === null) continue;
        expect(Object.keys(value).some((key) =>
          ["api", "base_url", "env", "options", "headers", "name"].includes(key))).toBe(false);
      }
    } finally {
      decode.mockRestore();
    }
  });

  it("lets the v3 catalog override models.json and reloads when only the WAL changes", async () => {
    const dbPath = defaultDb();
    const legacy = join(home, ".cache", "opencode", "models.json");
    await put(legacy, JSON.stringify({
      "Alibaba-CN": { models: { "deepseek-v4.1-flash-1017": { cost: { input: 9, output: 9 } } } },
    }));
    await writeDb(dbPath, v3Body());
    const options = { home, env: {} };
    // The first read-only open creates empty WAL/SHM sidecars of its own.
    await loadOpenCodePricing(options);
    const initial = await loadOpenCodePricing(options);
    expect(initial.catalogRates.get("alibaba-cn/deepseek-v4.1-flash-1017")?.standard.input).toBe(0.14 / 1e6);
    expect(await loadOpenCodePricing(options)).toBe(initial);

    // SQLite can commit into <db>-wal without touching the main database file.
    await writeFile(`${dbPath}-wal`, "");
    const reloaded = await loadOpenCodePricing(options);
    expect(reloaded).not.toBe(initial);
    expect(reloaded.catalogRates.get("alibaba-cn/deepseek-v4.1-flash-1017")?.standard.input).toBe(0.14 / 1e6);
  });
});
