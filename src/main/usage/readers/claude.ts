import { parseTimestampMs, tokenCount, type UsageRecord } from "../../../shared/types";
import { asObject, readJsonl } from "../transcriptReader";

function tokens(usage: Record<string, unknown>) {
  const oneHour = tokenCount(asObject(usage.cache_creation)?.ephemeral_1h_input_tokens);
  return {
    totals: {
      uncachedInputTokens: tokenCount(usage.input_tokens),
      cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      reasoningTokens: 0,
    },
    ...(oneHour > 0 ? { cacheCreation1hTokens: oneHour } : {}),
  };
}

function isModel(model: unknown): model is string {
  return typeof model === "string" && model !== "" && model !== "<synthetic>";
}

function parseClaudeRecord(value: unknown): UsageRecord[] {
  const record = asObject(value);
  if (record?.type !== "assistant") return [];
  const message = asObject(record.message);
  const usage = asObject(message?.usage);
  const model = message?.model;
  const timestampMs = parseTimestampMs(record.timestamp);
  if (!usage || !isModel(model) || timestampMs === null) return [];

  const messageId = typeof message?.id === "string" ? message.id : null;
  const requestId = typeof record.requestId === "string" ? record.requestId : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;
  const cost = record.costUSD;
  const executor: UsageRecord = {
    provider: "claude",
    model,
    timestampMs,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    ...tokens(usage),
    speed: usage.speed === "fast" ? "fast" : "standard",
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };

  const records = [executor];
  if (!Array.isArray(usage.iterations)) return records;
  for (const [index, item] of usage.iterations.entries()) {
    const advisor = asObject(item);
    if (advisor?.type !== "advisor_message" || !isModel(advisor.model)) continue;
    records.push({
      provider: "claude",
      timestampMs,
      sessionId: executor.sessionId,
      speed: executor.speed,
      ...tokens(advisor),
      model: advisor.model,
      reportedCostUsd: null,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  }
  return records;
}

function mergeCopies(first: UsageRecord, copy: UsageRecord): UsageRecord {
  const a = first.totals;
  const b = copy.totals;
  const oneHour = Math.max(first.cacheCreation1hTokens ?? 0, copy.cacheCreation1hTokens ?? 0);
  return {
    ...first,
    ...(oneHour > 0 ? { cacheCreation1hTokens: oneHour } : {}),
    totals: {
      uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
      cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
      cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
      outputTokens: Math.max(a.outputTokens, b.outputTokens),
      reasoningTokens: 0,
    },
    reportedCostUsd:
      first.reportedCostUsd === null || copy.reportedCostUsd === null
        ? (first.reportedCostUsd ?? copy.reportedCostUsd)
        : Math.max(first.reportedCostUsd, copy.reportedCostUsd),
  };
}

export async function readClaudeFile(filePath: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const indices = new Map<string, number>();
  await readJsonl(filePath, (value) => {
    for (const record of parseClaudeRecord(value)) {
      if (record.dedupeKey !== null) {
        const index = indices.get(record.dedupeKey);
        if (index !== undefined) {
          records[index] = mergeCopies(records[index]!, record);
          continue;
        }
        indices.set(record.dedupeKey, records.length);
      }
      records.push(record);
    }
  });
  return records;
}
