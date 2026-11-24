import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readJsonl } from "../src/main/usage/transcriptReader";

test("streams UTF-8 JSONL, tolerates framing damage, and propagates I/O errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-jsonl-"));
  try {
    const file = join(dir, "transcript.jsonl");
    // The first Chinese character crosses the default 64 KiB file-stream boundary.
    const value = `${"a".repeat(65_531)}你`;
    await writeFile(file, `\uFEFF"${value}"\r\nbroken\r\n42`);
    const values: unknown[] = [];
    await readJsonl(file, (entry) => values.push(entry));
    expect(values).toEqual([value, 42]);
    await expect(readJsonl(join(dir, "missing"), () => {})).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
