import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readScanCache, writeScanCache, type ScanCacheEntry } from "../src/main/usage/scanCache";

test("discards otherwise valid v2 scan cache entries and persists v3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-scan-cache-"));
  try {
    const path = join(dir, "scan-cache.json");
    const entry: ScanCacheEntry = { provider: "opencode", root: "fixture", fingerprint: "fixture", records: [] };
    await writeFile(path, JSON.stringify({ version: 2, files: { fixture: entry } }));
    expect(await readScanCache(dir)).toEqual(new Map());

    const cache = new Map([["fixture", entry]]);
    await writeScanCache(dir, cache);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
    expect(await readScanCache(dir)).toEqual(cache);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
