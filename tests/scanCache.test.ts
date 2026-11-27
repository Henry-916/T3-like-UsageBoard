import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readScanCache, writeScanCache, type ScanCacheEntry } from "../src/main/usage/scanCache";

test("discards otherwise valid v3 scan cache entries and persists v4 cursors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-scan-cache-"));
  try {
    const path = join(dir, "scan-cache.json");
    const entry: ScanCacheEntry = { provider: "opencode", root: "fixture", fingerprint: "fixture", records: [] };
    await writeFile(path, JSON.stringify({ version: 3, files: { fixture: entry } }));
    expect(await readScanCache(dir)).toEqual(new Map());

    const cache = new Map<string, ScanCacheEntry>([["fixture", { ...entry, cursors: { message: 42 } }]]);
    await writeScanCache(dir, cache);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.version).toBe(4);
    expect(written.files.fixture.cursors).toEqual({ message: 42 });
    expect(await readScanCache(dir)).toEqual(cache);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
