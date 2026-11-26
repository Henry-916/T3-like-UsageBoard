import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenCodePriceTables, RateTable } from "./pricing";

type ModelRate = NonNullable<ReturnType<RateTable["get"]>>;
type Row = Record<string, unknown>;
type Shape = "string" | "number" | {
  fields?: Record<string, Shape>;
  entries?: Shape;
  items?: Shape;
};

// Validate the whole document, but decode only keys in projected objects and
// allowlisted scalar values. Skipped subtrees never become JS objects or strings.
function project(source: string, shape: Shape, jsonc: boolean): unknown {
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
    const schema = typeof wanted === "object" ? wanted : undefined;
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
      return wanted === "string" ? JSON.parse(source.slice(start, pos)) : undefined;
    }
    if (ch === "-" || digit(ch)) {
      number();
      return wanted === "number" ? Number(source.slice(start, pos)) : undefined;
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

export async function loadOpenCodePricing({
  home = homedir(), env = process.env,
}: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<OpenCodePriceTables> {
  const { XDG_CONFIG_HOME, APPDATA, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG, XDG_CACHE_HOME, LOCALAPPDATA } = env;
  const configPaths = unique([
    join(home, ".config", "opencode"),
    ...(XDG_CONFIG_HOME ? [join(XDG_CONFIG_HOME, "opencode")] : []),
    ...(process.platform === "win32" && APPDATA ? [join(APPDATA, "opencode")] : []),
    ...(OPENCODE_CONFIG_DIR ? [OPENCODE_CONFIG_DIR] : []),
  ]).flatMap((dir) => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]);
  if (OPENCODE_CONFIG) configPaths.push(resolve(OPENCODE_CONFIG));
  const catalogPaths = unique([
    ...(XDG_CACHE_HOME ? [join(XDG_CACHE_HOME, "opencode", "models.json")] : []),
    join(home, ".cache", "opencode", "models.json"),
    ...(LOCALAPPDATA ? [join(LOCALAPPDATA, "opencode", "models.json")] : []),
  ]);
  const paths = [...configPaths, ...catalogPaths];
  const fingerprints = await Promise.all(paths.map(fingerprint));
  const signature = JSON.stringify([configPaths.length, paths, fingerprints]);
  if (cached?.signature === signature) return cached.pricing;

  const userRates = new Map<string, ModelRate>();
  const catalogRates = new Map<string, ModelRate>();
  for (const [i, path] of paths.entries()) {
    if (fingerprints[i] === "missing") continue;
    const user = i < configPaths.length;
    try {
      const raw = project(await readFile(path, "utf8"), user ? config : providers, user);
      if (user) {
        const root = object(raw);
        merge(userRates, root?.provider);
        merge(userRates, root?.providers);
      } else {
        merge(catalogRates, raw);
      }
    } catch {
      // Missing, inaccessible, or malformed files never block usage scans.
    }
  }
  const pricing = { userRates, catalogRates };
  cached = { signature, pricing };
  return pricing;
}
