import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readOpenCodeDatabase, readOpenCodeJson } from "../src/main/usage/readers/opencode";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "usage-opencode-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const tokens = { input: 11, output: 4, reasoning: 3, cache: { read: 7, write: 2 } };

test("reads legacy assistant JSON with basename identity and gateway pricing", async () => {
  const path = join(dir, "msg-1.json");
  await writeFile(path, JSON.stringify({
    id: "internal", role: "assistant", sessionID: "session", time: { created: 5000 },
    model: { id: " OpenCode-Go/test-free ", providerID: " OpenCode-Go " }, tokens, cost: 0,
  }));
  expect(await readOpenCodeJson(path)).toEqual([{
    provider: "opencode", model: "opencode-go/test-free",
    sessionId: "session", timestampMs: 5000, reportedCostUsd: 0, speed: "standard",
    dedupeKey: "opencode:msg-1",
    totals: {
      uncachedInputTokens: 11, cachedInputTokens: 7, cacheCreationTokens: 2,
      outputTokens: 7, reasoningTokens: 3,
    },
  }]);
  await writeFile(path, "{broken");
  expect(await readOpenCodeJson(path)).toEqual([]);
});

test.each([
  ["test", undefined, "test", null],
  ["google/Gemini", " OpenRouter ", "openrouter/google/Gemini", null],
  ["test-free", "CPA", "cpa/test-free", null],
])("reads JSON model %s and qualifies it only when a provider is present", async (modelID, providerID, model, reportedCostUsd) => {
  const path = join(dir, "msg-2.json");
  await writeFile(path, JSON.stringify({ time: { created: 5000 }, modelID, providerID, tokens, cost: 0 }));
  expect(await readOpenCodeJson(path)).toMatchObject([{ model, reportedCostUsd }]);
});

test("paginates v1 rows and reads live WAL, excluding invalid, user and pre-cutoff rows", async () => {
  const path = join(dir, "opencode.db");
  const writer = new DatabaseSync(path);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    const insert = writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
    const valid = JSON.stringify({ role: "assistant", modelID: "test", providerID: "CPA", cost: 0, tokens });
    for (let i = 0; i < 65; i++) insert.run(`id-${i}`, "session", 5000 + i, valid);
    insert.run("old", "session", 4999, valid);
    insert.run("malformed", "session", 5000, "{broken");
    insert.run("user", "session", 5000, JSON.stringify({ role: "user", modelID: "test", tokens }));
    const records = await readOpenCodeDatabase(path, 5000);
    expect(records).toHaveLength(65);
    expect(records[0]).toMatchObject({ model: "cpa/test", timestampMs: 5000, reportedCostUsd: null });
    expect(records.at(-1)?.dedupeKey).toBe("opencode:id-64");
  } finally {
    writer.close();
  }
});

test("retains v2 compaction spend but skips copied fork messages", async () => {
  const path = join(dir, "opencode-v2.db");
  const writer = new DatabaseSync(path);
  try {
    writer.exec(`
      CREATE TABLE session_v2(id TEXT, fork_session_id TEXT, time_created INTEGER, fork_boundary TEXT);
      CREATE TABLE session_message(id TEXT, session_id TEXT, time_created INTEGER, seq INTEGER, type TEXT, data TEXT);
    `);
    writer.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run(
      "fork", "root", 6000, JSON.stringify({ type: "through", messageID: "orig" }),
    );
    const insert = writer.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
    const data = JSON.stringify({ model: { modelID: "OpenCode/test", providerID: "OPENCODE" }, cost: 0.25, tokens });
    insert.run("orig", "root", 5000, 1, "assistant", data);
    insert.run("copy", "fork", 5000, 1, "assistant", data);
    insert.run("summary", "fork", 6001, 2, "compaction", data);
    expect(await readOpenCodeDatabase(path)).toMatchObject([
      { dedupeKey: "opencode:orig", model: "opencode/test", reportedCostUsd: 0.25 },
      { dedupeKey: "opencode:summary", model: "opencode/test", reportedCostUsd: 0.25 },
    ]);
  } finally {
    writer.close();
  }
});
