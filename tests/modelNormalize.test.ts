import { describe, expect, it } from "vitest";
import { normalizeModelId } from "../src/shared/modelNormalize";

describe("normalizeModelId", () => {
  it.each([
    ["gemini-pro-orchestrator-neon", "gemini-4-neon"],
    ["gemini-pro-orchestrator-g1-pro", "gemini-4-argon"],
    ["gemini-3-flash-agent", "gemini-3.5-flash"],
    ["gemini-3-flash-agent-a", "gemini-3.5-flash"],
    ["gemini-3-flash-b", "gemini-3.5-flash"],
    ["gemini-3.7-flash-safety-le", "gemini-3.7-flash"],
  ])("maps Antigravity route %s before stripping effort", (input, expected) => {
    expect(normalizeModelId("antigravity", input)).toBe(expected);
  });

  it("is provider-specific for routes, strips at most two case-insensitive suffixes", () => {
    expect(normalizeModelId("opencode", "gemini-pro-orchestrator-neon")).toBe("gemini-pro-orchestrator-neon");
    expect(normalizeModelId("codex", " gpt-5-THINKING-VERY-HIGH ")).toBe("gpt-5");
    expect(normalizeModelId("codex", "gpt-5-low-high-medium")).toBe("gpt-5-low");
    expect(normalizeModelId("claude", "claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5-20250929");
  });
});
