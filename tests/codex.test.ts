import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readCodexFile } from "../src/main/usage/readers/codex";
import { usageRecordSchema } from "../src/shared/types";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString();
const event = (timestamp: string, type: string, payload: object) => ({ timestamp, type, payload });
const tokens = (input_tokens: number, output_tokens: number, extra = {}) => ({
  input_tokens, output_tokens, ...extra,
});
const snapshot = (seconds: number, last?: object, total?: object) =>
  event(at(seconds), "event_msg", {
    type: "token_count",
    info: { last_token_usage: last, total_token_usage: total },
  });
const context = (model: string) => event(at(0), "turn_context", { model });
const meta = (options = {}) => event(at(0), "session_meta", { id: "session", ...options });

async function read(rows: object[], rolloutName?: string) {
  const dir = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    await mkdir(join(dir, "archive"));
    const file = join(dir, rolloutName ?? "codex.jsonl");
    const copy = join(dir, "archive", rolloutName ?? "archived.jsonl");
    const json = rows.map((row) => JSON.stringify(row)).join("\n");
    await Promise.all([writeFile(file, json), writeFile(copy, json)]);
    const records = await readCodexFile(file);
    expect(await readCodexFile(copy)).toEqual(records);
    return records;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("validates cumulative deltas, ignores repeats, and rebases zeroed snapshots", async () => {
  const last = tokens(10, 4, {
    cached_input_tokens: 4, cache_write_input_tokens: 2, reasoning_output_tokens: 3,
  });
  const records = await read([
    meta(), context("first"),
    snapshot(1, last, last),
    snapshot(2, last, last),
    snapshot(3, tokens(1, 2), tokens(11, 6, {
      cached_input_tokens: 4, cache_write_input_tokens: 2, reasoning_output_tokens: 3,
    })),
    snapshot(4, tokens(0, 0, { total_tokens: 100 }), tokens(0, 0)),
    context("second"),
    event(at(5), "event_msg", {
      type: "thread_settings_applied", thread_settings: { service_tier: "priority" },
    }),
    snapshot(5, last, last),
    snapshot(6, tokens(1, 2, { cached_input_tokens: 3 })),
  ]);
  expect(records.map(({ model, speed, totals }) => [model, speed, totals.uncachedInputTokens]))
    .toEqual([["first", "standard", 4], ["first", "standard", 1], ["second", "fast", 4]]);
  expect(records[0]?.totals).toEqual({
    uncachedInputTokens: 4, cachedInputTokens: 4, cacheCreationTokens: 2,
    outputTokens: 4, reasoningTokens: 3,
  });
  expect(new Set(records.map((record) => record.dedupeKey)).size).toBe(3);
});

test("uses cumulative-only and mismatched snapshots as baselines without billing them", async () => {
  const records = await read([
    meta(), context("model"),
    snapshot(1, undefined, tokens(10, 10)),
    snapshot(2, tokens(2, 2), tokens(12, 12)),
    // This last request cannot explain a jump of 8 in both channels.
    snapshot(3, tokens(3, 3), tokens(20, 20)),
    snapshot(4, tokens(4, 4), tokens(24, 24)),
    // A later rewind can bill only the latest request, provided the prefix is valid.
    snapshot(5, tokens(3, 3), tokens(8, 8)),
    // No usable last request, but still resets the baseline.
    snapshot(6, undefined, tokens(0, 0)),
    snapshot(7, tokens(1, 1), tokens(1, 1)),
  ]);
  expect(records.map(({ timestampMs, totals }) => [timestampMs, totals.uncachedInputTokens]))
    .toEqual([[2, 2], [4, 4], [5, 3], [7, 1]].map(([second, input]) => [Date.parse(at(second)), input]));
});

test("uses the official rollout ID when metadata lacks a usable session ID", async () => {
  const id = "019b5940-42ef-72c2-8f54-c5d57b525e15";
  const records = await read([
    meta({ id: " ", session_id: "", model_provider: "openai" }),
    event(at(1), "turn_context", { model: "model", turn_id: "turn" }),
    snapshot(2, tokens(1, 1), tokens(1, 1)),
  ], `rollout-2026-10-01T00-00-00-${id}.jsonl`);
  expect(records).toHaveLength(1);
  expect(usageRecordSchema.parse(records[0]).sessionId).toBe(id);
  expect(records[0]).not.toHaveProperty("unresolvedServiceTierTurnId");
});

test("scopes unnamed, metadata-free sessions to their own file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-codex-fallback-"));
  try {
    const files = [join(dir, "one.jsonl"), join(dir, "two.jsonl")];
    const json = [
      context("model"),
      event(at(1), "token_usage_record", { usage: tokens(1, 1), response_id: "same-response" }),
    ].map((row) => JSON.stringify(row)).join("\n");
    await Promise.all(files.map((file) => writeFile(file, json)));
    const records = (await Promise.all(files.map(readCodexFile))).flat();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => usageRecordSchema.parse(record).sessionId)).size).toBe(2);
    expect(new Set(records.map((record) => record.dedupeKey)).size).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("carries model but only marks native OpenAI turns with their own model for tier recovery", async () => {
  const records = await read([
    meta({ id: " ", session_id: "native", model_provider: "openai" }),
    event(at(0), "turn_context", { model: "model", turn_id: "first-turn" }),
    snapshot(1, tokens(1, 1), tokens(1, 1)),
    event(at(2), "turn_context", { turn_id: "no-own-model" }),
    snapshot(3, tokens(1, 1), tokens(2, 2)),
    event(at(4), "turn_context", { model: "model", turn_id: "last-turn" }),
    event(at(4), "event_msg", {
      type: "thread_settings_applied", thread_settings: { service_tier: "ultrafast" },
    }),
    snapshot(5, tokens(1, 1), tokens(3, 3)),
  ]);
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({ sessionId: "native", unresolvedServiceTierTurnId: "first-turn" });
  expect(records[1]).toMatchObject({ model: "model", speed: "standard" });
  expect(records[1]).not.toHaveProperty("unresolvedServiceTierTurnId");
  expect(records[2]?.speed).toBe("ultrafast");
  expect(records[2]).not.toHaveProperty("unresolvedServiceTierTurnId");
});

test("suppresses fork copies, bridges anonymous requests and honors identified ledger entries", async () => {
  const records = await read([
    meta({ forked_from_id: "parent" }), context("model"),
    snapshot(0, tokens(10, 10), tokens(10, 10)),
    event(at(2), "token_usage_record", { usage: tokens(4, 4) }),
    snapshot(3, tokens(3, 3), tokens(14, 14)),
    event(at(4), "token_usage_record", { usage: tokens(7, 7), response_id: "response" }),
    snapshot(4, tokens(7, 7), tokens(21, 21)),
  ]);
  expect(records.map((record) => record.totals.uncachedInputTokens)).toEqual([1, 3, 7]);
  expect(records[2]?.dedupeKey).toBe('["codex","session","response"]');
});
