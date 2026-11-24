import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readClaudeFile } from "../src/main/usage/readers/claude";

test("merges Claude message snapshots channel by channel and prices advisor usage separately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-claude-"));
  try {
    const file = join(dir, "claude.jsonl");
    const timestamp = "2026-10-01T00:00:00Z";
    const event = (model: string, usage: object, costUSD?: number) => ({
      type: "assistant",
      timestamp,
      costUSD,
      requestId: "req",
      sessionId: "session",
      message: { id: "msg", model, usage },
    });
    const advisor = { type: "advisor_message", model: "advisor", input_tokens: 9 };
    await writeFile(file, [
      event("claude-executor", {
        input_tokens: 10,
        cache_creation_input_tokens: 8,
        cache_creation: { ephemeral_1h_input_tokens: 5 },
        speed: "fast",
        iterations: [{ type: "message" }, advisor],
      }),
      event("claude-executor", {
        input_tokens: 2,
        cache_read_input_tokens: 4,
        output_tokens: 12,
        iterations: [{ type: "message" }, { ...advisor, input_tokens: 4, output_tokens: 3 }],
      }, 0.5),
      event("<synthetic>", { input_tokens: 123 }),
      { ...event("bad-timestamp", { input_tokens: 100 }), timestamp: "invalid" },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const records = await readClaudeFile(file);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      dedupeKey: "msg:req",
      timestampMs: Date.parse(timestamp),
      sessionId: "session",
      speed: "fast",
      cacheCreation1hTokens: 5,
      reportedCostUsd: 0.5,
      totals: {
        uncachedInputTokens: 10, cachedInputTokens: 4, cacheCreationTokens: 8,
        outputTokens: 12, reasoningTokens: 0,
      },
    });
    expect(records[1]).toMatchObject({
      dedupeKey: "msg:req:advisor:1", model: "advisor", reportedCostUsd: null, speed: "fast",
      totals: { uncachedInputTokens: 9, outputTokens: 3 },
    });
    expect(records[1]).not.toHaveProperty("cacheCreation1hTokens");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
