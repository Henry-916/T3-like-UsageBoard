import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenCodePriceTables, RateTable } from "./pricing";

type ModelRate = NonNullable<ReturnType<RateTable["get"]>>;
type Row = Record<string, unknown>;
export type Shape = "string" | "number" | {
  fields?: Record<string, Shape>;
  entries?: Shape;
  items?: Shape;
  union?: Shape[];
};

// Validate the whole document, but decode only keys in projected objects and
// allowlisted scalar values. Skipped subtrees never become JS objects or strings.
export function project(source: string, shape: Shape, jsonc: boolean): unknown {
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (): never => { throw new Error("Invalid pricing document"); };
  const digit = (ch: string) => ch >= "0" && ch <= "9";
  const space = () => {
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") pos++;
      else if (jsonc && source.startsWith("//", pos)) {
        pos += 2;
        while (pos < source.length && source[pos] !== "\r" && source[pos] !== "\n") pos++;
      } else if (jsonc && source.startsWith("/*", pos)) {
        const end = source.indexOf("*/", pos + 2);
        if (end < 0) fail();
        pos = end + 2;
      } else break;
    }
  };
  const string = () => {
    if (source[pos++] !== '"') fail();
    while (pos < source.length) {
      const ch = source[pos++];
      if (ch === '"') return;
      if (ch < " ") fail();
      if (ch !== "\\") continue;
      const escape = source[pos++];
      if (escape === "u") {
        for (let i = 0; i < 4; i++) {
          const hex = source[pos++];
          if (!digit(hex) && !(hex >= "a" && hex <= "f") && !(hex >= "A" && hex <= "F")) fail();
        }
      } else if (!escape || !'"\\/bfnrt'.includes(escape)) fail();
    }
    fail();
  };
  const number = () => {
    const digits = () => {
      if (!digit(source[pos])) fail();
      while (digit(source[pos])) pos++;
    };
    if (source[pos] === "-") pos++;
    if (source[pos] === "0") pos++;
    else digits();
    if (source[pos] === ".") {
      pos++;
      digits();
    }
    if (source[pos] === "e" || source[pos] === "E") {
      pos++;
      if (source[pos] === "+" || source[pos] === "-") pos++;
      digits();
    }
  };
  function value(wanted?: Shape): unknown {
    space();
    const start = pos;
    const ch = source[pos];
    const alternatives = typeof wanted === "object" ? wanted.union : undefined;
    const selected = alternatives?.find((option) => {
      if (option === "string") return ch === '"';
      if (option === "number") return ch === "-" || digit(ch);
      return ch === "{" || ch === "[";
    }) ?? wanted;
    const schema = typeof selected === "object" ? selected : undefined;
    if (ch === "{" || ch === "[") {
      const object = ch === "{";
      const end = object ? "}" : "]";
      const row: Row | undefined = object && (schema?.fields || schema?.entries)
        ? Object.create(null) as Row : undefined;
      const items: unknown[] | undefined = !object && schema?.items ? [] : undefined;
      pos++;
      space();
      while (source[pos] !== end) {
        if (object) {
          const keyStart = pos;
          string();
          const key: string | undefined = row ? JSON.parse(source.slice(keyStart, pos)) : undefined;
          space();
          if (source[pos++] !== ":") fail();
          const child = key !== undefined && schema
            ? schema.entries ?? (Object.hasOwn(schema.fields ?? {}, key) ? schema.fields?.[key] : undefined)
            : undefined;
          const result = value(child);
          if (row && key !== undefined && child) row[key] = result;
        } else {
          const result = value(schema?.items);
          items?.push(result);
        }
        space();
        if (source[pos] === end) break;
        if (source[pos++] !== ",") fail();
        space();
        if (!jsonc && source[pos] === end) fail();
      }
      pos++;
      return row ?? items;
    }
    if (ch === '"') {
      string();
      return selected === "string" ? JSON.parse(source.slice(start, pos)) : undefined;
    }
    if (ch === "-" || digit(ch)) {
      number();
      return selected === "number" ? Number(source.slice(start, pos)) : undefined;
    }
    const literal = ch === "t" ? "true" : ch === "f" ? "false" : "null";
    if (!source.startsWith(literal, pos)) fail();
    pos += literal.length;
    return undefined;
  }
  const result = value(shape);
  space();
  if (pos !== source.length) fail();
  return result;
}

const amounts: Record<string, Shape> = {
  input: "number", output: "number", cache_read: "number", cache_write: "number",
  cache: { fields: { read: "number", write: "number" } },
};
const tier: Shape = {
  fields: {
    ...amounts, threshold: "number", tier: { fields: { type: "string", size: "number" } },
  },
};
const cost: Shape = {
  items: tier,
  fields: { ...amounts, tiers: { items: tier }, context_over_200k: { fields: amounts } },
};
const providers: Shape = { entries: { fields: { models: { entries: { fields: { id: "string", cost } } } } } };
const config: Shape = { fields: { provider: providers, providers } };

const v3Write: Shape = { union: ["number", { fields: { "5m": "number", "1h": "number", "30m": "number", "12h": "number" } }] };
const v3Cache: Shape = { fields: { read: "number", write: v3Write, explicit: { fields: { read: "number", write: v3Write } } } };
const v3Side: Shape = {
  fields: {
    price: "number",
    cache: v3Cache,
    overrides: { items: { fields: {
      price: "number", cache: v3Cache,
      when: { fields: { context: { fields: { gt: "number" } } } },
    } } },
  },
};
const v3Providers: Shape = {
  entries: {
    fields: {
      models: { entries: { fields: {
        id: "string", cost: { fields: { text: { fields: { input: v3Side, output: v3Side } } } },
      } } },
    },
  },
};

const object = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;
const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function speedRates(raw: unknown): Omit<ModelRate, "tiers"> | undefined {
  const row = object(raw);
  const input = amount(row?.input);
  const output = amount(row?.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = object(row?.cache);
  const cacheRead = (amount(cache?.read) ?? amount(row?.cache_read) ?? input) / 1e6;
  const cacheWrite = (amount(cache?.write) ?? amount(row?.cache_write) ?? input) / 1e6;
  return {
    standard: { input: input / 1e6, output: output / 1e6, cacheRead, cacheWrite, cacheWrite1h: cacheWrite },
    fast: null, ultrafast: null,
  };
}

function modelRate(raw: unknown): ModelRate | undefined {
  const row = object(raw);
  let base = speedRates(row);
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const item = object(entry);
      if (!item || Object.hasOwn(item, "tier")) continue;
      base = speedRates(item);
      if (base) break;
    }
  }
  if (!base) return undefined;
  const tiers: ModelRate["tiers"][number][] = [];
  const add = (threshold: unknown, entry: unknown) => {
    const size = amount(threshold);
    const rates = speedRates(entry);
    if (size && rates) tiers.push({ threshold: size, rates });
  };
  for (const entry of Array.isArray(raw) ? raw : Array.isArray(row?.tiers) ? row.tiers : []) {
    const item = object(entry);
    const context = object(item?.tier);
    if (context?.type === "context") add(context.size, item);
    else if (!Array.isArray(raw) && item && !Object.hasOwn(item, "tier")) add(item.threshold, item);
  }
  add(200_000, row?.context_over_200k);
  return { ...base, tiers: tiers.sort((a, b) => b.threshold - a.threshold) };
}

function merge(table: Map<string, ModelRate>, raw: unknown) {
  for (const [pid, provider] of Object.entries(object(raw) ?? {})) {
    for (const [mid, model] of Object.entries(object(object(provider)?.models) ?? {})) {
      const row = object(model);
      const rate = modelRate(row?.cost);
      if (!pid.trim() || !mid.trim() || !rate) continue;
      const prefix = pid.trim().toLowerCase();
      table.set(`${prefix}/${mid.trim().toLowerCase()}`, rate);
      if (typeof row?.id === "string" && row.id.trim()) table.set(`${prefix}/${row.id.trim().toLowerCase()}`, rate);
    }
  }
}

function v3WriteRates(raw: unknown, input: number) {
  const scalar = amount(raw);
  if (scalar !== undefined) return { cacheWrite: scalar / 1e6, cacheWrite1h: scalar / 1e6 };
  const row = object(raw);
  if (row) {
    const short = amount(row["5m"]) ?? amount(row["30m"]) ?? input;
    const long = amount(row["1h"]) ?? amount(row["12h"]) ?? short;
    return { cacheWrite: short / 1e6, cacheWrite1h: long / 1e6 };
  }
  return { cacheWrite: input / 1e6, cacheWrite1h: input / 1e6 };
}

function v3ModelRate(raw: unknown): ModelRate | undefined {
  const text = object(object(raw)?.text);
  const input = object(text?.input);
  const output = object(text?.output);
  const inputPrice = amount(input?.price);
  const outputPrice = amount(output?.price);
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  const cache = object(input?.cache);
  const explicit = object(cache?.explicit);
  const baseCacheRead = amount(cache?.read) ?? amount(explicit?.read) ?? inputPrice;
  const write = v3WriteRates(cache?.write ?? explicit?.write, inputPrice);
  const standard = {
    input: inputPrice / 1e6, output: outputPrice / 1e6, cacheRead: baseCacheRead / 1e6, ...write,
  };
  const overrides = new Map<number, { inputPrice?: number; outputPrice?: number; cache?: unknown }>();
  const collect = (side: Row | undefined, key: "inputPrice" | "outputPrice") => {
    for (const entry of Array.isArray(side?.overrides) ? side.overrides : []) {
      const item = object(entry);
      const threshold = amount(object(object(item?.when)?.context)?.gt);
      const price = amount(item?.price);
      if (threshold === undefined || threshold <= 0 || price === undefined) continue;
      const tier = overrides.get(threshold) ?? {};
      tier[key] = price;
      if (side === input) tier.cache = item?.cache;
      overrides.set(threshold, tier);
    }
  };
  collect(input, "inputPrice");
  collect(output, "outputPrice");
  const tiers = [...overrides.entries()]
    .sort(([a], [b]) => b - a)
    .map(([threshold, tier]) => {
      const tierInputPrice = tier.inputPrice ?? inputPrice;
      const tierCache = object(tier.cache);
      const tierExplicit = object(tierCache?.explicit);
      const tierCacheRead = amount(tierCache?.read) ?? amount(tierExplicit?.read);
      const tierWriteRaw = tierCache?.write ?? tierExplicit?.write;
      const tierWrite = tierWriteRaw == null ? write : v3WriteRates(tierWriteRaw, tierInputPrice);
      return {
        threshold,
        rates: {
          standard: {
            input: tierInputPrice / 1e6,
            output: (tier.outputPrice ?? outputPrice) / 1e6,
            cacheRead: (tierCacheRead ?? baseCacheRead) / 1e6,
            ...tierWrite,
          },
          fast: null,
          ultrafast: null,
        },
      };
    });
  return { standard, fast: null, ultrafast: null, tiers };
}

function mergeV3(table: Map<string, ModelRate>, raw: unknown) {
  for (const [pid, provider] of Object.entries(object(raw) ?? {})) {
    for (const [mid, model] of Object.entries(object(object(provider)?.models) ?? {})) {
      const row = object(model);
      const rate = v3ModelRate(row?.cost);
      if (!pid.trim() || !mid.trim() || !rate) continue;
      const prefix = pid.trim().toLowerCase();
      table.set(`${prefix}/${mid.trim().toLowerCase()}`, rate);
      if (typeof row?.id === "string" && row.id.trim()) table.set(`${prefix}/${row.id.trim().toLowerCase()}`, rate);
    }
  }
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.map((path) => resolve(path)).filter((path) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fingerprint(path: string) {
  try {
    const info = await stat(path);
    return info.isFile() ? `${info.mtimeMs}:${info.size}` : "missing";
  } catch {
    return "missing";
  }
}

let cached: { signature: string; pricing: OpenCodePriceTables } | undefined;

export function opencodeConfigPaths({
  home = homedir(), env = process.env,
}: { home?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const { XDG_CONFIG_HOME, APPDATA, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG } = env;
  const configPaths = unique([
    join(home, ".config", "opencode"),
    ...(XDG_CONFIG_HOME ? [join(XDG_CONFIG_HOME, "opencode")] : []),
    ...(process.platform === "win32" && APPDATA ? [join(APPDATA, "opencode")] : []),
    ...(OPENCODE_CONFIG_DIR ? [OPENCODE_CONFIG_DIR] : []),
  ]).flatMap((dir) => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]);
  if (OPENCODE_CONFIG) configPaths.push(resolve(OPENCODE_CONFIG));
  return configPaths;
}

export function opencodeCatalogPaths({
  home = homedir(), env = process.env,
}: { home?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const { XDG_CACHE_HOME, LOCALAPPDATA } = env;
  return unique([
    ...(XDG_CACHE_HOME ? [join(XDG_CACHE_HOME, "opencode", "models.json")] : []),
    join(home, ".cache", "opencode", "models.json"),
    ...(LOCALAPPDATA ? [join(LOCALAPPDATA, "opencode", "models.json")] : []),
  ]);
}

function expandDir(value: string, home: string): string {
  const path = value.trim();
  return resolve(path === "~" ? home : /^~[/\\]/.test(path) ? join(home, path.slice(2)) : path);
}

export function opencodeDbPaths({
  home = homedir(), env = process.env,
}: { home?: string; env?: NodeJS.ProcessEnv } = {}): string[] {
  const { OPENCODE_DATA_DIR, XDG_DATA_HOME, LOCALAPPDATA } = env;
  const specified = OPENCODE_DATA_DIR?.split(",").map((dir) => dir.trim()).filter(Boolean) ?? [];
  const dirs = specified.length ? specified : [
    ...(XDG_DATA_HOME?.trim() ? [join(XDG_DATA_HOME, "opencode")] : [join(home, ".local", "share", "opencode")]),
    ...(process.platform === "win32" && LOCALAPPDATA ? [join(LOCALAPPDATA, "opencode")] : []),
  ];
  return unique(dirs.map((dir) => join(expandDir(dir, home), "opencode.db")));
}

function readV3Catalog(path: string): unknown {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 100");
    const row = db.prepare("SELECT value FROM kv WHERE key = 'models-dev:v3:catalog' LIMIT 1").get() as Row | undefined;
    if (typeof row?.value !== "string") return;
    const body = object(project(row.value, { fields: { body: "string" } }, false))?.body;
    if (typeof body !== "string") return;
    return project(body, v3Providers, false);
  } catch {
    return;
  } finally {
    try { db?.close(); } catch { /* an unreadable database must never block scans */ }
  }
}

export async function loadOpenCodePricing({
  home = homedir(), env = process.env,
}: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<OpenCodePriceTables> {
  const configPaths = opencodeConfigPaths({ home, env });
  const catalogPaths = opencodeCatalogPaths({ home, env });
  const dbPaths = opencodeDbPaths({ home, env });
  const paths = [...configPaths, ...catalogPaths, ...dbPaths];
  const fingerprints = await Promise.all(paths.map(fingerprint));
  // SQLite in WAL mode can commit into the sidecar before the main file changes.
  const walFingerprints = await Promise.all(dbPaths.map((path) => fingerprint(`${path}-wal`)));
  const signature = JSON.stringify([
    configPaths.length, catalogPaths.length, dbPaths.length, paths, fingerprints, walFingerprints,
  ]);
  if (cached?.signature === signature) return cached.pricing;

  const userRates = new Map<string, ModelRate>();
  const catalogRates = new Map<string, ModelRate>();
  for (const [i, path] of configPaths.entries()) {
    if (fingerprints[i] === "missing") continue;
    try {
      const raw = project(await readFile(path, "utf8"), config, true);
      const root = object(raw);
      merge(userRates, root?.provider);
      merge(userRates, root?.providers);
    } catch {
      // Missing, inaccessible, or malformed files never block usage scans.
    }
  }
  const catalogOffset = configPaths.length;
  for (const [i, path] of catalogPaths.entries()) {
    if (fingerprints[catalogOffset + i] === "missing") continue;
    try {
      merge(catalogRates, project(await readFile(path, "utf8"), providers, false));
    } catch {
      // A stale or partial file cache never blocks usage scans.
    }
  }
  const dbOffset = catalogOffset + catalogPaths.length;
  for (const [i, path] of dbPaths.entries()) {
    if (fingerprints[dbOffset + i] === "missing") continue;
    try {
      const raw = readV3Catalog(path);
      if (raw !== undefined) mergeV3(catalogRates, raw);
    } catch {
      // Locked, missing, or malformed SQLite catalogs never block usage scans.
    }
  }
  const pricing = { userRates, catalogRates };
  cached = { signature, pricing };
  return pricing;
}
