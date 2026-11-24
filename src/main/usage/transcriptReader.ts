import { createReadStream } from "node:fs";

/** Decode incrementally so a read failure rejects the entire scan, not just the last record. */
export async function readJsonl(filePath: string, visit: (value: unknown) => void): Promise<void> {
  let tail = "";
  function parse(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A damaged line (including a partially written final line) is not a read failure.
      return;
    }
    visit(value);
  }

  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    const lines = (tail + chunk).split("\n");
    tail = lines.pop()!;
    for (const line of lines) parse(line.replace(/^\uFEFF/, ""));
  }
  if (tail.length) parse(tail.replace(/^\uFEFF/, ""));
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
