import { basename, resolve } from "node:path";
import { qualifyModelId } from "../../../shared/modelNormalize";
import { parseTimestampMs, type UsageRecord } from "../../../shared/types";
import { asObject, readJsonl } from "../transcriptReader";

const fields = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;
type Counters = Record<(typeof fields)[number], number>;
type Attribution = {
  timestampMs: number;
  model: string;
  speed: UsageRecord["speed"];
  unresolvedServiceTierTurnId?: string;
};
type Pending = { attribution: Attribution; usage: Counters };

function readCounters(value: unknown): Counters | null {
  const raw = asObject(value);
  if (!raw || typeof raw.input_tokens !== "number" || typeof raw.output_tokens !== "number") {
    return null;
  }
  const defaults = [undefined, 0, 0, undefined, 0, raw.input_tokens + raw.output_tokens];
  const counts = fields.map((key, index) => raw[key] === undefined ? defaults[index] : raw[key]);
  if (!counts.every((count): count is number =>
    typeof count === "number" && Number.isInteger(count) && count >= 0
  )) return null;
  const usage = Object.fromEntries(fields.map((key, index) => [key, counts[index]])) as Counters;
  return usage.cached_input_tokens + usage.cache_write_input_tokens <= usage.input_tokens &&
    usage.reasoning_output_tokens <= usage.output_tokens &&
    usage.total_tokens >= components(usage)
    ? usage
    : null;
}

function components(usage: Counters) {
  return usage.input_tokens + usage.output_tokens;
}

function difference(a: Counters, b: Counters) {
  return readCounters(Object.fromEntries(fields.map((key) => [key, a[key] - b[key]])));
}

function advance(previous: Counters | null, last: Counters) {
  return readCounters(
    Object.fromEntries(fields.map((key) => [key, (previous?.[key] ?? 0) + last[key]])),
  );
}

function equal(a: Counters, b: Counters) {
  return fields.every((key) => a[key] === b[key]);
}

export async function readCodexFile(filePath: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const occurrences = new Map<string, number>();
  // Official rollout names retain their thread ID when moved into archived_sessions.
  const namedSession = /^rollout-.+-([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\.jsonl$/i
    .exec(basename(filePath))?.[1]?.toLowerCase();
  const fallbackSessionId = namedSession ?? `file:${resolve(filePath)}`;
  let sessionId = "";
  let sawSessionMeta = false;
  let model = "";
  let modelProvider = "";
  let turnId = "";
  let sawThreadSettings = false;
  let speed: UsageRecord["speed"] = "standard";
  let forkAnchor: number | null = null;
  let baseline: Counters | null = null;
  let baselineAt: number | undefined;
  let lastSignature: string | null = null;
  let sequenceStart: string | undefined;
  let ledgerActive = false;
  let pending: Pending[] = [];

  function dateBaseline(timestampMs: number) {
    baselineAt = Math.max(baselineAt ?? timestampMs, timestampMs);
  }

  function rebase(cumulative: Counters, timestampMs: number) {
    baseline = cumulative;
    dateBaseline(timestampMs);
    pending = [];
    if (components(cumulative) === 0) sequenceStart = undefined;
  }

  function isForkCopy(timestampMs: number) {
    if (forkAnchor === null) return false;
    // Copied ancestor history is restamped within a burst; it isn't billed again.
    if (timestampMs - forkAnchor < 1000) {
      forkAnchor = timestampMs;
      return true;
    }
    forkAnchor = null;
    lastSignature = null;
    return false;
  }

  function emit(usage: Counters, attribution: Attribution, responseId?: string) {
    const attributedSessionId = sessionId || fallbackSessionId;
    const totals = {
      uncachedInputTokens:
        usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      cacheCreationTokens: usage.cache_write_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.reasoning_output_tokens,
    };
    let dedupeKey: string;
    if (responseId !== undefined) {
      dedupeKey = JSON.stringify(["codex", attributedSessionId, responseId]);
    } else {
      // A moved rollout may appear in both sessions and archived_sessions. Preserve
      // identical legitimate requests by counting occurrences under the same key.
      const key = JSON.stringify([attributedSessionId, attribution.timestampMs, attribution.model, totals]);
      const index = occurrences.get(key) ?? 0;
      occurrences.set(key, index + 1);
      dedupeKey = JSON.stringify(["codex", key, index]);
    }
    records.push({
      provider: "codex",
      sessionId: attributedSessionId,
      ...attribution,
      totals,
      reportedCostUsd: null,
      dedupeKey,
    });
  }

  await readJsonl(filePath, (value) => {
    const record = asObject(value);
    const payload = asObject(record?.payload);
    if (!record || !payload) return;

    if (record.type === "session_meta") {
      if (sawSessionMeta) return;
      sawSessionMeta = true;
      for (const id of [payload.id, payload.session_id]) {
        if (typeof id === "string" && id.trim() !== "") {
          sessionId = id.trim();
          break;
        }
      }
      if (typeof payload.model_provider === "string") modelProvider = payload.model_provider.trim().toLowerCase();
      const spawn = asObject(asObject(asObject(payload.source)?.subagent)?.thread_spawn);
      if (typeof payload.forked_from_id === "string" || typeof spawn?.parent_thread_id === "string") {
        forkAnchor = parseTimestampMs(record.timestamp);
      }
      return;
    }
    if (record.type === "turn_context") {
      ledgerActive = false;
      if (typeof payload.model === "string") model = payload.model.trim();
      turnId = typeof payload.model === "string" && model !== "" &&
        typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
      return;
    }
    if (payload.type === "thread_settings_applied") {
      sawThreadSettings = true;
      const settings = asObject(payload.thread_settings);
      if (settings) {
        const tier = settings.service_tier;
        speed = tier === "ultrafast" ? tier : tier === "fast" || tier === "priority" ? "fast" : "standard";
      }
      return;
    }
    if (record.type !== "token_usage_record" && payload.type !== "token_count") return;
    const timestampMs = parseTimestampMs(record.timestamp);
    if (timestampMs === null || model === "") return;
    const attribution: Attribution = {
      timestampMs,
      model: modelProvider === "openai" ? model : qualifyModelId(modelProvider, model),
      speed,
      // Only a native session and explicit turn/model identify a history lookup.
      ...(!sawThreadSettings && modelProvider === "openai" && sessionId && turnId
        ? { unresolvedServiceTierTurnId: turnId }
        : {}),
    };

    if (record.type === "token_usage_record") {
      const usage = readCounters(payload.usage);
      if (!usage || isForkCopy(timestampMs)) return;
      const responseId = payload.response_id;
      if (typeof responseId === "string" && responseId !== "") {
        ledgerActive = true;
        for (const request of pending) {
          baseline = advance(baseline, request.usage);
          emit(request.usage, request.attribution);
        }
        baseline = advance(baseline, usage);
        dateBaseline(timestampMs);
        pending = [];
        emit(usage, attribution, responseId);
      } else {
        ledgerActive = false;
        pending.push({ usage, attribution });
      }
      return;
    }

    const info = asObject(payload.info);
    if (!info) return;
    const last = readCounters(info.last_token_usage);
    const hasCumulative = info.total_token_usage != null;
    const cumulative = readCounters(info.total_token_usage);
    const signature = last === null ? null : JSON.stringify(last);
    if (isForkCopy(timestampMs)) {
      if (cumulative) rebase(cumulative, timestampMs);
      else if (!hasCumulative && last && signature !== lastSignature) {
        baseline = advance(baseline, last);
        dateBaseline(timestampMs);
      }
      lastSignature = signature;
      return;
    }
    if (ledgerActive) {
      // Identified ledger requests, not their possibly rewound snapshots, are billed.
      if (cumulative) rebase(cumulative, timestampMs);
      return;
    }

    const previous = baseline;
    const previousAt = baselineAt;
    const unreported = pending;
    // Even without a usable last request, a valid cumulative snapshot establishes
    // the next baseline. Never bill a request inferred from totals alone.
    if (cumulative) rebase(cumulative, timestampMs);
    if (!last || (hasCumulative && !cumulative)) return;
    if (components(last) === 0) {
      lastSignature = null;
      return;
    }
    if (cumulative && previous && equal(cumulative, previous)) return;
    if (last.total_tokens !== components(last)) return;

    if (cumulative) {
      const restarted = equal(cumulative, last);
      const start = JSON.stringify([timestampMs, last]);
      if (restarted && start === sequenceStart) {
        baseline = previous;
        baselineAt = previousAt;
        return;
      }
      const lowered = previous && fields.some((key) => cumulative[key] < previous[key]);
      const rewound = lowered && previousAt !== undefined && timestampMs > previousAt;
      const reconciled = !previous || rewound
        ? difference(cumulative, last) !== null
        : fields.every((key) => cumulative[key] - previous[key] === last[key]);
      if (!restarted && !reconciled) {
        const final = unreported.at(-1);
        const remainder = final && difference(final.usage, last);
        if (previous && final && remainder && fields.every(
          (key) => cumulative[key] - previous[key] ===
            unreported.reduce((sum, request) => sum + request.usage[key], 0)
        )) {
          for (const request of unreported.slice(0, -1)) {
            if (components(request.usage) > 0) emit(request.usage, request.attribution);
          }
          if (components(remainder) > 0) emit(remainder, final.attribution);
        } else {
          if (previousAt !== undefined && (timestampMs < previousAt ||
            (timestampMs === previousAt && lowered && components(cumulative) > 0))) {
            baseline = previous;
            pending = unreported;
          }
          return;
        }
      }
      if (restarted) sequenceStart = start;
    } else {
      if (signature === lastSignature) return;
      const advanced = advance(previous, last);
      if (!advanced) return;
      baseline = advanced;
      dateBaseline(timestampMs);
    }

    lastSignature = signature;
    emit(last, attribution);
  });
  return records;
}
