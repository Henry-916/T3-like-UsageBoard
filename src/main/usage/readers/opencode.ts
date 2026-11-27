// Adapted from T3 Code (MIT), Copyright (c) 2026 T3 Tools Inc.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { qualifyModelId } from "../../../shared/modelNormalize";
import { tokenCount, totalTokens, type UsageRecord } from "../../../shared/types";

type Row = Record<string, unknown>;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const text = (value: unknown) => typeof value === "string" ? value : "";
const OPENCODE_GATEWAYS = new Set(["opencode", "opencode-go"]);
const MESSAGE_PAGE_SIZE = 64;

function parseOpenCodeMessage(
  source: string,
  fallback: { id?: string; sessionId?: string; timestampMs?: number },
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const rawModel = (text(modelReference.id) || text(modelReference.modelID) || text(message.modelID)).trim();
  const providerId = (text(modelReference.providerID) || text(message.providerID)).trim().toLowerCase();
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!rawModel || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokenCount(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(cache.read),
    cacheCreationTokens: tokenCount(cache.write),
    outputTokens: tokenCount(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  const model = qualifyModelId(providerId, rawModel);
  const bareModel = providerId ? model.slice(providerId.length + 1) : model;
  const free = OPENCODE_GATEWAYS.has(providerId) && bareModel.endsWith("-free");
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // Zero is only authoritative for OpenCode's own free gateway models.
    reportedCostUsd:
      typeof cost === "number" && Number.isFinite(cost) && (cost > 0 || (free && cost === 0))
        ? cost
        : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export async function readOpenCodeJson(filePath: string): Promise<UsageRecord[]> {
  const record = parseOpenCodeMessage(await readFile(filePath, "utf8"), {
    id: basename(filePath, ".json"),
  });
  return record === null ? [] : [record];
}

export type OpenCodeCursors = Record<string, number>

export async function readOpenCodeDatabase(filePath: string, cutoffMs = -Infinity): Promise<UsageRecord[]> {
  return (await readOpenCodeDatabaseIncremental(filePath, cutoffMs)).records
}

/**
 * Read only rows appended after the previous cursors when the database was not
 * rebuilt, so a busy conversation stops rescanning 92 days of history.
 */
export async function readOpenCodeDatabaseIncremental(
  filePath: string,
  cutoffMs = -Infinity,
  previous?: OpenCodeCursors,
): Promise<{ records: UsageRecord[]; cursors: OpenCodeCursors }> {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 100; BEGIN");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has("message") && !tables.has("session_message")) {
      throw new Error("OpenCode database has no message table");
    }
    const columnsOf = (table: "message" | "session_message" | "session_v2") =>
      new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    const maxRowId = (table: string): number => {
      const row = db.prepare(`SELECT MAX(rowid) AS max FROM ${table}`).get() as Row | undefined;
      return typeof row?.max === "number" ? row.max : 0;
    };
    const forks = new Map<string, { parent: string; lastCopiedSeq: number; created: number }>();
    if (
      tables.has("session_v2") && tables.has("session_message") &&
      columnsOf("session_message").has("seq") && columnsOf("session_v2").has("fork_boundary")
    ) {
      // Resolve copied fork messages to their original (session, seq).
      const rows = db.prepare(`
        SELECT fork.id, fork.fork_session_id AS parent, fork.time_created AS created,
          (SELECT MAX(copied.seq) FROM session_message AS copied
           WHERE copied.session_id = fork.fork_session_id
             AND CASE json_extract(fork.fork_boundary, '$.type')
               WHEN 'through' THEN copied.seq <= boundary.seq
               WHEN 'before' THEN copied.seq < boundary.seq
             END) AS last_copied_seq
        FROM session_v2 AS fork
        JOIN session_message AS boundary
          ON boundary.session_id = fork.fork_session_id
         AND boundary.id = CASE WHEN json_valid(fork.fork_boundary)
           THEN json_extract(fork.fork_boundary, '$.messageID') END
        WHERE fork.fork_session_id IS NOT NULL AND json_valid(fork.fork_boundary)
      `).iterate();
      for (const row of rows) {
        if (typeof row.last_copied_seq !== "number" || typeof row.created !== "number") continue;
        forks.set(text(row.id), {
          parent: text(row.parent), lastCopiedSeq: row.last_copied_seq, created: row.created,
        });
      }
    }
    const original = (sessionId: string, seq: number, created: number) => {
      const visited = new Set<string>();
      let session = sessionId;
      for (
        let fork = forks.get(session);
        fork && seq <= fork.lastCopiedSeq && created < fork.created && !visited.has(session);
        fork = forks.get(session)
      ) {
        visited.add(session);
        session = fork.parent;
      }
      return `${session}:${seq}`;
    };
    // A rebuilt database, an empty cursor set, or fork lineage needs a full pass.
    let incremental = previous !== undefined && Object.keys(previous).length > 0 && forks.size === 0;
    if (incremental) {
      for (const [table, rowId] of Object.entries(previous!)) {
        if (!tables.has(table) || maxRowId(table) < rowId) { incremental = false; break; }
      }
    }
    const cursors: OpenCodeCursors = {};
    const records: UsageRecord[] = [];
    const ids = new Set<string>();
    const originals = new Set<string>();
    for (const table of ["message", "session_message"] as const) {
      if (!tables.has(table)) continue;
      const columns = columnsOf(table);
      const hasTimestamp = columns.has("time_created");
      const timestamp = hasTimestamp ? "time_created" : "NULL";
      const lineage = table === "session_message" && forks.size > 0 ? "seq" : "NULL";
      const versionFilter = table === "session_message" ? "AND type IN ('assistant', 'compaction')" : "";
      const timestampFilter = hasTimestamp ? "AND (time_created >= ? OR time_created IS NULL)" : "";
      // Page metadata first, then project just usage fields: raw messages can be hundreds of MB.
      const list = db.prepare(`
        SELECT rowid AS row_id, ${timestamp} AS created, ${lineage} AS seq FROM ${table}
        WHERE rowid > ? ${versionFilter} ${timestampFilter}
        ORDER BY rowid LIMIT ?
      `);
      let after = incremental ? previous?.[table] ?? -Infinity : -Infinity;
      // Capture the high-water mark before scanning: rows appended mid-scan stay
      // for the next incremental pass instead of being skipped forever.
      const tableMax = maxRowId(table);
      while (true) {
        const page = list.all(after, ...(hasTimestamp ? [cutoffMs] : []), MESSAGE_PAGE_SIZE);
        if (page.length === 0) break;
        const metadata = new Map(page.map((row) => [row.row_id, row]));
        const rows = db.prepare(`
          SELECT rowid AS row_id, id, session_id, json_object(
            'tokens', data -> '$.tokens', 'cost', data -> '$.cost',
            'model', data -> '$.model', 'modelID', data -> '$.modelID',
            'providerID', data -> '$.providerID', 'time', data -> '$.time',
            'id', data -> '$.id', 'sessionID', data -> '$.sessionID'
          ) AS data
          FROM ${table}
          WHERE rowid IN (${page.map(() => "?").join(", ")})
            AND CASE WHEN typeof(data) = 'text' AND json_valid(data)
              THEN json_type(data, '$.role') IS NULL OR data ->> '$.role' = 'assistant' END
          ORDER BY rowid
        `).all(...page.map((row) => row.row_id));
        for (const row of rows) {
          const { created, seq } = metadata.get(row.row_id)!;
          const record = parseOpenCodeMessage(text(row.data), {
            id: text(row.id),
            sessionId: text(row.session_id),
            ...(typeof created === "number" ? { timestampMs: created } : {}),
          });
          if (!record || record.timestampMs < cutoffMs) continue;
          if (record.dedupeKey !== null && ids.has(record.dedupeKey)) continue;
          if (typeof seq === "number") {
            const key = original(record.sessionId, seq, record.timestampMs);
            if (originals.has(key)) continue;
            originals.add(key);
          }
          if (record.dedupeKey !== null) ids.add(record.dedupeKey);
          records.push(record);
        }
        if (page.length < MESSAGE_PAGE_SIZE) break;
        after = Number(page[page.length - 1]!.row_id);
      }
      // Advance past filtered rows too: new messages always append at the end.
      cursors[table] = tableMax;
    }
    return { records, cursors };
  } finally {
    db.close();
  }
}
