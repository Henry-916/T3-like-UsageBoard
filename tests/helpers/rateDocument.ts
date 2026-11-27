import type { RateMultiplier } from "../../src/shared/types";

export interface RateSpec {
  /** Per million tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  multipliers?: RateMultiplier[];
}

/** Build a minimal models.dev v2 document: bare keys live under a first-party provider. */
export function buildRateDocument(models: Record<string, RateSpec>): Record<string, unknown> {
  const providers: Record<string, { models: Record<string, unknown> }> = {};
  const add = (provider: string, key: string, spec: RateSpec) => {
    const entry = providers[provider] ??= { models: {} };
    entry.models[key] = {
      id: key,
      cost: {
        text: {
          input: {
            price: spec.input,
            ...(spec.cacheRead === undefined && spec.cacheWrite === undefined ? {} : {
              cache: {
                ...(spec.cacheRead === undefined ? {} : { read: spec.cacheRead }),
                ...(spec.cacheWrite === undefined ? {} : { write: spec.cacheWrite }),
              },
            }),
          },
          output: { price: spec.output },
        },
        ...(spec.multipliers?.length ? { multipliers: spec.multipliers } : {}),
      },
    };
  };
  for (const [key, spec] of Object.entries(models)) {
    const slash = key.indexOf("/");
    if (slash > 0) add(key.slice(0, slash), key.slice(slash + 1), spec);
    else add("meta", key, spec);
  }
  return providers;
}
