import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeMultipliers } from "../../shared/pricingMultipliers";
import type { RateMultiplier } from "../../shared/types";
import { FIRST_PARTY_PROVIDERS, PRESET_PROVIDER_IDS } from "./modelsDevProviders";
import { readModelRate } from "./rateModel";
import type { ModelRate, TokenRates } from "./rateModel";
import type { RateTable } from "./pricing";

export const MODELS_DEV_URL = "https://models.dev/experimental/v2.0/api.json?type=all";
export const MODELS_DEV_FALLBACK_URL = "https://models.dev/api.json";
export const MODELS_DEV_SNAPSHOT_VERSION = 6;

const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const RETRY_MS = 60_000;

type Row = Record<string, unknown>;

export interface SnapshotRateTier {
  /** Context threshold in tokens. */
  n: number;
  i: number;
  o: number;
  r: number;
  w: number;
  w1: number;
}

/** One priced model, stored per million tokens to keep the snapshot small. */
export interface SnapshotRate {
  i: number;
  o: number;
  r: number;
  w: number;
  w1: number;
  t?: SnapshotRateTier[];
  m?: RateMultiplier[];
}

export interface SnapshotCatalogModel {
  /** Provider-local alias id (models.dev `id`). */
  i?: string;
  /** Canonical `owner/slug`. */
  c?: string;
  /** Release date used for popularity freshness. */
  r?: string;
  /** Output modalities, when the feed declares them. */
  o?: string[];
}

export interface ModelsDevSnapshot {
  version: number;
  source: string;
  fetchedAt: string;
  etag?: string;
  /** Curated provider rows that feed the price-preset picker. */
  catalog: Record<string, { models: Record<string, SnapshotCatalogModel> }>;
  /** Every priced model, keyed by provider/model, pointing into `rows`. */
  rates: { rows: SnapshotRate[]; keys: Record<string, number> };
  /** How many providers carry each canonical model. */
  adoption: Record<string, number>;
}

const object = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const million = (value: number): number => Number((value * 1e6).toPrecision(10));

function splitCanonical(raw: unknown): { owner: string; slug: string; id: string } | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) return undefined;
  return { owner: value.slice(0, slash), slug: value.slice(slash + 1), id: value };
}

function outputModalities(raw: unknown): string[] | undefined {
  const output = object(raw)?.output;
  if (!Array.isArray(output)) return undefined;
  const values = output.filter((item): item is string => typeof item === "string");
  return values.length ? values : undefined;
}

function toSnapshotRate(rate: ModelRate): SnapshotRate {
  const row: SnapshotRate = {
    i: million(rate.standard.input),
    o: million(rate.standard.output),
    r: million(rate.standard.cacheRead),
    w: million(rate.standard.cacheWrite),
    w1: million(rate.standard.cacheWrite1h),
  };
  if (rate.tiers.length) {
    row.t = rate.tiers.map(({ threshold, rates }) => ({
      n: threshold,
      i: million(rates.standard.input),
      o: million(rates.standard.output),
      r: million(rates.standard.cacheRead),
      w: million(rates.standard.cacheWrite),
      w1: million(rates.standard.cacheWrite1h),
    }));
  }
  if (rate.multipliers.length) row.m = [...rate.multipliers];
  return row;
}

function fromSnapshotRate(row: SnapshotRate): ModelRate {
  const tokenRates = (values: SnapshotRate | SnapshotRateTier): TokenRates => ({
    input: values.i / 1e6,
    output: values.o / 1e6,
    cacheRead: values.r / 1e6,
    cacheWrite: values.w / 1e6,
    cacheWrite1h: values.w1 / 1e6,
  });
  return {
    standard: tokenRates(row),
    tiers: (row.t ?? []).map((tier) => ({ threshold: tier.n, rates: { standard: tokenRates(tier) } })),
    multipliers: normalizeMultipliers(row.m),
  };
}

/**
 * Project a full models.dev document into the compact snapshot. Only the
 * whitelisted pricing fields become JS values; provider credentials, names and
 * every other subtree are never copied.
 */
export function buildModelsDevSnapshot(
  document: unknown,
  meta: { source: string; fetchedAt: string; etag?: string },
): ModelsDevSnapshot | null {
  const root = object(document);
  if (!root) return null;
  const rows: SnapshotRate[] = [];
  const keys: Record<string, number> = Object.create(null);
  const catalog: ModelsDevSnapshot["catalog"] = Object.create(null);
  const bare = new Map<string, number | null>();
  const adoption: Record<string, number> = Object.create(null);
  let priced = 0;

  for (const [rawProviderId, rawProvider] of Object.entries(root)) {
    const providerId = text(rawProviderId)?.toLowerCase();
    const models = object(object(rawProvider)?.models);
    if (!providerId || !models) continue;
    const canonicalSeen = new Set<string>();
    for (const [rawModelId, rawModel] of Object.entries(models)) {
      const model = object(rawModel);
      const modelId = text(rawModelId)?.toLowerCase();
      if (!model || !modelId) continue;
      const canonical = splitCanonical(model.canonical_id ?? model.canonical_model_id);
      if (canonical && !canonicalSeen.has(canonical.id)) {
        canonicalSeen.add(canonical.id);
        adoption[canonical.id] = (adoption[canonical.id] ?? 0) + 1;
      }
      const rate = readModelRate(model.cost);
      if (!rate) continue;
      const id = text(model.id)?.toLowerCase();
      const index = rows.length;
      rows.push(toSnapshotRate(rate));
      priced++;
      // Exact provider keys always win over a generated canonical alias.
      keys[`${providerId}/${modelId}`] = index;
      if (id) keys[`${providerId}/${id}`] = index;
      if (canonical && canonical.owner === providerId) {
        const key = `${providerId}/${canonical.slug}`;
        if (!(key in keys)) keys[key] = index;
      }
      if (FIRST_PARTY_PROVIDERS.has(providerId)) {
        for (const bareKey of [modelId, canonical?.owner === providerId ? canonical.slug : undefined]) {
          if (!bareKey) continue;
          const held = bare.get(bareKey);
          if (held === undefined) bare.set(bareKey, index);
          else if (held !== index) bare.set(bareKey, null);
        }
      }
      if (PRESET_PROVIDER_IDS.has(providerId)) {
        const entry: SnapshotCatalogModel = {};
        if (id) entry.i = id;
        if (canonical) entry.c = canonical.id;
        const release = text(model.release_date);
        if (release) entry.r = release;
        const outputs = outputModalities(model.modalities);
        if (outputs) entry.o = outputs;
        (catalog[providerId] ??= { models: Object.create(null) }).models[modelId] = entry;
      }
    }
  }

  for (const [key, index] of bare) {
    if (index !== null) keys[key] = index;
  }
  if (!priced) return null;
  return {
    version: MODELS_DEV_SNAPSHOT_VERSION,
    source: meta.source,
    fetchedAt: meta.fetchedAt,
    ...(meta.etag ? { etag: meta.etag } : {}),
    catalog,
    rates: { rows, keys },
    adoption,
  };
}

export function snapshotRate(snapshot: ModelsDevSnapshot, key: string): ModelRate | undefined {
  const index = snapshot.rates.keys[key];
  if (!Number.isInteger(index)) return undefined;
  const row = snapshot.rates.rows[index];
  return row ? fromSnapshotRate(row) : undefined;
}

/** The single tables used by the pricing engine, derived from one snapshot. */
const rateTables = new WeakMap<ModelsDevSnapshot, RateTable>();
export function buildRateTable(snapshot: ModelsDevSnapshot): RateTable {
  const cached = rateTables.get(snapshot);
  if (cached) return cached;
  const table = new Map<string, ModelRate>();
  for (const [key, index] of Object.entries(snapshot.rates.keys)) {
    const row = snapshot.rates.rows[index];
    if (row) table.set(key, fromSnapshotRate(row));
  }
  rateTables.set(snapshot, table);
  return table;
}

export function parseModelsDevSnapshot(document: unknown): ModelsDevSnapshot | null {
  const root = object(document);
  if (!root || root.version !== MODELS_DEV_SNAPSHOT_VERSION) return null;
  const rates = object(root.rates);
  const catalog = object(root.catalog);
  if (!rates || !catalog || !Array.isArray(rates.rows) || !object(rates.keys)) return null;
  if (rates.rows.length === 0) return null;
  const fetchedAt = text(root.fetchedAt);
  const source = text(root.source);
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt)) || !source) return null;
  return {
    version: MODELS_DEV_SNAPSHOT_VERSION,
    source,
    fetchedAt,
    ...(text(root.etag) ? { etag: text(root.etag) } : {}),
    catalog: catalog as ModelsDevSnapshot["catalog"],
    rates: rates as unknown as ModelsDevSnapshot["rates"],
    adoption: (object(root.adoption) ?? {}) as Record<string, number>,
  };
}

async function readSnapshotFile(path: string): Promise<ModelsDevSnapshot | null> {
  try {
    return parseModelsDevSnapshot(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

async function writeSnapshotFile(path: string, snapshot: ModelsDevSnapshot): Promise<void> {
  const partial = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(partial, JSON.stringify(snapshot), "utf8");
    await rename(partial, path);
  } catch {
    await rm(partial, { force: true }).catch(() => {});
  }
}

export interface ModelsDevFetchRequest {
  url: string;
  etag?: string;
}

export interface ModelsDevFetchResponse {
  status: number;
  body?: string;
  etag?: string;
}

type Fetcher = (request: ModelsDevFetchRequest) => Promise<ModelsDevFetchResponse | null>;

let injectedFetcher: Fetcher | undefined;

/** The worker injects the main-process bridge so `electron.net.fetch` inherits the system proxy. */
export function setModelsDevFetcher(fetcher: Fetcher | undefined): void {
  injectedFetcher = fetcher;
}

async function request(request: ModelsDevFetchRequest): Promise<ModelsDevFetchResponse | null> {
  if (injectedFetcher) return injectedFetcher(request);
  try {
    const response = await fetch(request.url, {
      headers: request.etag ? { "If-None-Match": request.etag } : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      status: response.status,
      body: response.status === 304 ? undefined : await response.text(),
      etag: response.headers?.get?.("etag") ?? undefined,
    };
  } catch {
    return null;
  }
}

async function download(etag?: string): Promise<{ snapshot: ModelsDevSnapshot } | "not-modified" | null> {
  for (const [index, url] of [MODELS_DEV_URL, MODELS_DEV_FALLBACK_URL].entries()) {
    const result = await request({ url, ...(index === 0 && etag ? { etag } : {}) });
    if (!result) continue;
    if (result.status === 304 && index === 0) return "not-modified";
    // The experimental path can disappear; fall through to the stable feed.
    if (result.status === 404 || result.status >= 500) continue;
    if (result.status < 200 || result.status >= 300 || !result.body) continue;
    let document: unknown;
    try {
      document = JSON.parse(result.body);
    } catch {
      continue;
    }
    const snapshot = buildModelsDevSnapshot(document, {
      source: url,
      fetchedAt: new Date().toISOString(),
      ...(result.etag ? { etag: result.etag } : {}),
    });
    if (snapshot) return { snapshot };
  }
  return null;
}

const recent = new Map<string, ModelsDevSnapshot>();
const fromBundle = new Set<string>();
const pending = new Map<string, Promise<void>>();
const retryAfter = new Map<string, number>();

function isFresh(snapshot: ModelsDevSnapshot, at: number): boolean {
  const age = at - Date.parse(snapshot.fetchedAt);
  return age >= 0 && age < TTL_MS;
}

function refresh(cachePath: string, etag: string | undefined, now: () => number): Promise<void> {
  const task = (async () => {
    const result = await download(etag);
    if (result === "not-modified") {
      const cached = recent.get(cachePath) ?? await readSnapshotFile(cachePath);
      if (!cached) return;
      const refreshed: ModelsDevSnapshot = { ...cached, fetchedAt: new Date(now()).toISOString() };
      recent.set(cachePath, refreshed);
      fromBundle.delete(cachePath);
      await writeSnapshotFile(cachePath, refreshed);
      return;
    }
    if (!result) {
      retryAfter.set(cachePath, now() + RETRY_MS);
      return;
    }
    recent.set(cachePath, result.snapshot);
    fromBundle.delete(cachePath);
    retryAfter.delete(cachePath);
    await writeSnapshotFile(cachePath, result.snapshot);
  })();
  pending.set(cachePath, task);
  void task.finally(() => { if (pending.get(cachePath) === task) pending.delete(cachePath); });
  return task;
}

export interface LoadModelsDevOptions {
  userData: string;
  bundledSnapshot: string;
  now?: () => number;
}

/**
 * Return a usable snapshot immediately. A cache younger than 24h is returned
 * as-is; otherwise the expired cache (or the bundled snapshot) answers the
 * first frame while one deduplicated background refresh runs.
 */
export async function loadModelsDevSnapshot({
  userData, bundledSnapshot, now = Date.now,
}: LoadModelsDevOptions): Promise<ModelsDevSnapshot | null> {
  const cachePath = join(userData, "models-dev-cache.json");
  const cached = recent.get(cachePath) ?? await readSnapshotFile(cachePath);
  if (cached && !fromBundle.has(cachePath)) {
    recent.set(cachePath, cached);
    if (isFresh(cached, now())) return cached;
    if (!pending.has(cachePath) && now() >= (retryAfter.get(cachePath) ?? 0)) {
      void refresh(cachePath, cached.etag, now);
    }
    return cached;
  }
  // First install: answer from the bundled snapshot and still refresh at once.
  const bundled = cached ?? await readSnapshotFile(bundledSnapshot);
  if (bundled) {
    recent.set(cachePath, bundled);
    fromBundle.add(cachePath);
  }
  if (!pending.has(cachePath) && now() >= (retryAfter.get(cachePath) ?? 0)) {
    void refresh(cachePath, bundled?.etag, now);
  }
  return bundled;
}

/** Wait for an in-flight snapshot refresh; used by tests and graceful shutdown. */
export async function waitForModelsDevRefresh(userData: string): Promise<void> {
  const cachePath = join(userData, "models-dev-cache.json");
  await pending.get(cachePath);
}

export function resetModelsDevState(): void {
  recent.clear();
  fromBundle.clear();
  pending.clear();
  retryAfter.clear();
  injectedFetcher = undefined;
}
