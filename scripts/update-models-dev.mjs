// Regenerate the bundled models.dev snapshot:
//   pnpm update:models
// The output format must stay in sync with src/main/usage/modelsDev.ts.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE = "https://models.dev/experimental/v2.0/api.json?type=all";
const FALLBACK = "https://models.dev/api.json";
const VERSION = 6;

const PRESET_PROVIDERS = new Set([
  "openai", "anthropic", "google", "deepseek", "alibaba", "moonshotai", "zai", "minimax",
  "xai", "mistral", "volcengine", "stepfun-ai", "xiaomi", "tencent-tokenhub", "cohere", "meta",
  "alibaba-cn", "siliconflow-cn", "siliconflow", "moonshotai-cn", "zhipuai", "minimax-cn",
  "stepfun", "openrouter", "opencode", "opencode-go", "google-vertex", "amazon-bedrock", "azure",
  "fireworks-ai", "togetherai", "deepinfra",
]);
const FIRST_PARTY = new Set(["openai", "anthropic", "google", "deepseek", "xai", "mistral", "meta"]);

const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
const amount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const exact = (value) => Number(value.toPrecision(10));

function baseRates(input, output, cache) {
  const explicit = object(cache?.explicit);
  const read = amount(cache?.read) ?? amount(explicit?.read) ?? input;
  const write = cache?.write ?? explicit?.write;
  const scalar = amount(write);
  const writeRow = object(write);
  const short = scalar ?? amount(writeRow?.["5m"]) ?? amount(writeRow?.["30m"]) ?? input;
  const long = scalar ?? amount(writeRow?.["1h"]) ?? amount(writeRow?.["12h"]) ?? short;
  return { i: exact(input), o: exact(output), r: exact(read), w: exact(short), w1: exact(long) };
}

function readRate(raw) {
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
  const valueText = object(entry.text);
  const inputSide = object(valueText?.input);
  const outputSide = object(valueText?.output);
  const input = amount(inputSide?.price) ?? amount(entry.input);
  const output = amount(outputSide?.price) ?? amount(entry.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = inputSide?.cache ?? entry.cache;
  const row = baseRates(input, output, {
    ...object(cache),
    ...(object(cache)?.read === undefined && entry.cache_read !== undefined ? { read: entry.cache_read } : {}),
    ...(object(cache)?.write === undefined && entry.cache_write !== undefined ? { write: entry.cache_write } : {}),
  });
  const tiers = [];
  const addTier = (threshold, tierRaw) => {
    const size = amount(threshold);
    const tier = object(tierRaw);
    if (!size || !tier) return;
    const tierInput = amount(tier.input) ?? amount(tier.price) ?? input;
    const tierOutput = amount(tier.output) ?? output;
    const tierCache = tier.cache;
    tiers.push({ n: size, ...baseRates(tierInput, tierOutput, tierCache ?? cache) });
  };
  if (inputSide?.overrides || outputSide?.overrides) {
    const thresholds = new Map();
    for (const [side, key] of [[inputSide, "input"], [outputSide, "output"]]) {
      for (const item of Array.isArray(side?.overrides) ? side.overrides : []) {
        const override = object(item);
        const size = amount(object(object(override?.when)?.context)?.gt);
        if (!size || size <= 0) continue;
        const held = thresholds.get(size) ?? {};
        held[key] = amount(override.price);
        if (side === inputSide) held.cache = override.cache;
        thresholds.set(size, held);
      }
    }
    for (const [size, tier] of thresholds) {
      addTier(size, { input: tier.input, output: tier.output, cache: tier.cache });
    }
  }
  for (const item of Array.isArray(entry.tiers) ? entry.tiers : []) {
    const tier = object(item);
    const context = object(tier?.tier);
    if (context?.type === "context") addTier(context.size, tier);
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const tier = object(item);
      const context = object(tier?.tier);
      if (context?.type === "context") addTier(context.size, tier);
    }
  }
  if (entry.context_over_200k) addTier(200_000, entry.context_over_200k);
  tiers.sort((a, b) => b.n - a.n);
  const multipliers = Array.isArray(entry.multipliers) ? entry.multipliers : Array.isArray(valueText?.multipliers) ? valueText.multipliers : undefined;
  return {
    ...row,
    ...(tiers.length ? { t: tiers } : {}),
    ...(multipliers?.length ? { m: multipliers } : {}),
  };
}

function splitCanonical(raw) {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  return { owner: value.slice(0, slash), slug: value.slice(slash + 1), id: value };
}

async function fetchDocument() {
  for (const url of [SOURCE, FALLBACK]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (response.status === 404 || response.status >= 500) continue;
    if (!response.ok) continue;
    return { url, document: await response.json(), etag: response.headers.get("etag") ?? undefined };
  }
  throw new Error("models.dev did not answer on either catalogue path");
}

const { url, document, etag } = await fetchDocument();
const rows = [];
const keys = Object.create(null);
const catalog = Object.create(null);
const adoption = Object.create(null);
const bare = new Map();
let priced = 0;

for (const [rawProviderId, rawProvider] of Object.entries(document)) {
  const providerId = text(rawProviderId)?.toLowerCase();
  const models = object(object(rawProvider)?.models);
  if (!providerId || !models) continue;
  const canonicalSeen = new Set();
  for (const [rawModelId, rawModel] of Object.entries(models)) {
    const model = object(rawModel);
    const modelId = text(rawModelId)?.toLowerCase();
    if (!model || !modelId) continue;
    const canonical = splitCanonical(model.canonical_id ?? model.canonical_model_id);
    if (canonical && !canonicalSeen.has(canonical.id)) {
      canonicalSeen.add(canonical.id);
      adoption[canonical.id] = (adoption[canonical.id] ?? 0) + 1;
    }
    const rate = readRate(model.cost);
    if (!rate) continue;
    const id = text(model.id)?.toLowerCase();
    const index = rows.length;
    rows.push(rate);
    priced++;
    keys[`${providerId}/${modelId}`] = index;
    if (id) keys[`${providerId}/${id}`] = index;
    if (canonical && canonical.owner === providerId) {
      const key = `${providerId}/${canonical.slug}`;
      if (!(key in keys)) keys[key] = index;
    }
    if (FIRST_PARTY.has(providerId)) {
      for (const bareKey of [modelId, canonical?.owner === providerId ? canonical.slug : undefined]) {
        if (!bareKey) continue;
        const held = bare.get(bareKey);
        if (held === undefined) bare.set(bareKey, index);
        else if (held !== index) bare.set(bareKey, null);
      }
    }
    if (PRESET_PROVIDERS.has(providerId)) {
      const entry = {};
      if (id) entry.i = id;
      if (canonical) entry.c = canonical.id;
      const release = text(model.release_date);
      if (release) entry.r = release;
      const outputs = object(model.modalities)?.output;
      if (Array.isArray(outputs)) {
        const values = outputs.filter((item) => typeof item === "string");
        if (values.length) entry.o = values;
      }
      (catalog[providerId] ??= { models: Object.create(null) }).models[modelId] = entry;
    }
  }
}
for (const [key, index] of bare) if (index !== null) keys[key] = index;

const snapshot = {
  version: VERSION,
  source: url,
  fetchedAt: new Date().toISOString(),
  ...(etag ? { etag } : {}),
  catalog,
  rates: { rows, keys },
  adoption,
};
const json = JSON.stringify(snapshot);
const output = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "models-dev-snapshot.json");
await writeFile(output, json, "utf8");
console.log(`models.dev snapshot: ${rows.length} priced models, ${Object.keys(keys).length} keys, ${Object.keys(catalog).length} preset providers`);
console.log(`${output} (${(json.length / 1024).toFixed(0)} KB)`);
