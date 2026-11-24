import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mergeAntigravityRecords, readAntigravityDatabase, scanAntigravityDatabase,
} from "../src/main/usage/readers/antigravity";
import { usageRecordSchema } from "../src/shared/types";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "usage-antigravity-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function varint(n: number): number[] {
  return n < 128 ? [n] : [(n % 128) + 128, ...varint(Math.floor(n / 128))];
}
const num = (field: number, n: number) => [...varint(field * 8), ...varint(n)];
const msg = (field: number, ...data: number[][]) => {
  const bytes = data.flat();
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
};
const text = (field: number, value: string) => msg(field, [...Buffer.from(value)]);

test("decodes generations, steps and retries; merges alternate identifiers before applying cutoff", async () => {
  const path = join(dir, "trajectory.db");
  const writer = new DatabaseSync(path);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE gen_metadata(idx INTEGER, data BLOB);
      CREATE TABLE steps(idx INTEGER, metadata BLOB);
      CREATE TABLE trajectory_metadata_blob(data BLOB);
    `);
    writer.prepare("INSERT INTO trajectory_metadata_blob VALUES (?)").run(
      Uint8Array.from(msg(2, num(1, 20))),
    );
    const generation = writer.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
    generation.run(9, Uint8Array.from(msg(1,
      num(3, 5000),
      text(19, "Claude 4.6 Sonnet"),
      msg(4, num(2, 15), num(5, 3), text(12, "linked")),
      msg(17, msg(2, num(1, 1071), num(2, 2), text(11, "retry"))),
    )));
    generation.run(7, Uint8Array.from(msg(1,
      num(3, 5000), msg(4, num(2, 1), text(11, "learned")),
    )));
    const step = writer.prepare("INSERT INTO steps VALUES (?, ?)");
    for (let i = 0; i < 64; i++) step.run(i, null);
    step.run(9, Uint8Array.from([
      ...msg(8, num(1, 21), num(2, 250_000_000)),
      ...msg(9, num(1, 5000), num(3, 4), num(9, 3), num(10, 2), text(11, "step"), text(12, "linked")),
    ]));
    const records = await readAntigravityDatabase(path, 20_000);
    expect(records).toHaveLength(3);
    expect(records.find((record) => record.dedupeKey === "antigravity:11:step")).toMatchObject({
      sessionId: "trajectory", model: "claude-sonnet-4-6", timestampMs: 21_250,
      totals: { uncachedInputTokens: 15, cachedInputTokens: 3, outputTokens: 5, reasoningTokens: 3 },
    });
    expect(records.find((record) => record.dedupeKey === "antigravity:11:learned")).toMatchObject({
      model: "claude-sonnet-4-6", timestampMs: 20_000,
    });
    expect(records.find((record) => record.dedupeKey === "antigravity:11:retry")).toMatchObject({
      model: "gemini-3.6-flash-high", rateModel: "gemini-3.6-flash", timestampMs: 20_000,
    });
    expect(await readAntigravityDatabase(path, 20_001)).toHaveLength(1);
  } finally {
    writer.close();
  }
});

test("ignores an index database and surfaces malformed protobuf", async () => {
  const path = join(dir, "index.db");
  const writer = new DatabaseSync(path);
  try {
    writer.exec("CREATE TABLE summaries (id TEXT)");
    expect(await readAntigravityDatabase(path)).toEqual([]);
    writer.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
    writer.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(1, Uint8Array.of(10, 3, 8));
    await expect(readAntigravityDatabase(path)).rejects.toThrow("Truncated protobuf field");
  } finally {
    writer.close();
  }
});

async function scanFixture(name: string, ...generations: number[][]) {
  const path = join(dir, `${name}.db`);
  const writer = new DatabaseSync(path);
  try {
    writer.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
    const insert = writer.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
    for (const [idx, generation] of generations.entries()) {
      insert.run(idx, Uint8Array.from(msg(1, generation)));
    }
  } finally {
    writer.close();
  }
  const scan = await scanAntigravityDatabase(path);
  // Raw records are persisted and revalidated before cross-file merging.
  return {
    records: usageRecordSchema.array().parse(JSON.parse(JSON.stringify(scan.records))),
    models: scan.models,
  };
}

test("learns from tokenless DBs and merges transitive identifiers across cached DB scans", async () => {
  const first = await scanFixture("first", [
    ...num(3, 1071), ...msg(4, num(2, 11), text(11, "a")),
  ]);
  const last = await scanFixture("last", [
    ...num(3, 1071), ...msg(4, num(3, 7), text(12, "b")),
    ...msg(9, msg(4, num(1, 21))),
  ]);
  const bridge = await scanFixture("bridge", [
    ...num(3, 1071), ...msg(4, num(5, 5), text(11, "a"), text(12, "b")),
  ]);
  const catalog = await scanFixture("catalog", [...num(3, 1071), ...text(19, "Gemini 4 Argon")]);
  expect(catalog.records).toEqual([]);
  const scans = [first, last, bridge, catalog];
  const records = scans.flatMap((scan) => scan.records);
  const models = scans.flatMap((scan) => scan.models);
  const merged = mergeAntigravityRecords(records, 21_000, models);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({
    sessionId: "first", dedupeKey: "antigravity:11:a", model: "gemini-4-argon",
    timestampMs: 21_000,
    totals: { uncachedInputTokens: 11, cachedInputTokens: 5, outputTokens: 7 },
  });
  expect(merged[0]).not.toHaveProperty("antigravity");
  expect(mergeAntigravityRecords(records, 21_001, models)).toEqual([]);

  const conflict = await scanFixture("conflict", [
    ...num(3, 1071), ...text(19, "Gemini 4 Neon"),
    ...msg(4, num(3, 4), text(11, "concrete")),
  ]);
  expect(mergeAntigravityRecords(records, undefined, [...models, ...conflict.models])[0]?.model)
    .toBe("antigravity-model-1071");
  expect(mergeAntigravityRecords([...records, ...conflict.records], undefined, [...models, ...conflict.models])
    .find((record) => record.dedupeKey === "antigravity:11:concrete")?.model).toBe("gemini-4-neon");
});
