export type ProviderTier = "A" | "B";

export interface ProviderSpec {
  id: string;
  label: string;
  tier: ProviderTier;
  /** Tier A: first-party canonical owners. Tier B: owners of domestic-only models. */
  owners: string[];
}

// Fixed popularity order: Tier A first-party storefronts, then mainstream
// regional storefronts and gateways. Everything else is filtered out.
export const PRESET_PROVIDERS: readonly ProviderSpec[] = [
  { id: "openai", label: "OpenAI", tier: "A", owners: ["openai"] },
  { id: "anthropic", label: "Anthropic", tier: "A", owners: ["anthropic"] },
  { id: "google", label: "Google", tier: "A", owners: ["google"] },
  { id: "deepseek", label: "DeepSeek", tier: "A", owners: ["deepseek"] },
  { id: "alibaba", label: "Alibaba", tier: "A", owners: ["alibaba"] },
  { id: "moonshotai", label: "Moonshot AI", tier: "A", owners: ["moonshotai"] },
  { id: "zai", label: "Zhipu AI", tier: "A", owners: ["zhipuai", "zai"] },
  { id: "minimax", label: "MiniMax", tier: "A", owners: ["minimax"] },
  { id: "xai", label: "xAI", tier: "A", owners: ["xai"] },
  { id: "mistral", label: "Mistral", tier: "A", owners: ["mistral"] },
  { id: "volcengine", label: "ByteDance", tier: "A", owners: ["bytedance-seed", "volcengine"] },
  { id: "stepfun-ai", label: "StepFun", tier: "A", owners: ["stepfun"] },
  { id: "xiaomi", label: "Xiaomi", tier: "A", owners: ["xiaomi"] },
  { id: "tencent-tokenhub", label: "Tencent", tier: "A", owners: ["tencent"] },
  { id: "cohere", label: "Cohere", tier: "A", owners: ["cohere"] },
  { id: "meta", label: "Meta", tier: "A", owners: ["meta"] },
  { id: "alibaba-cn", label: "Alibaba (China)", tier: "B", owners: ["alibaba"] },
  { id: "siliconflow-cn", label: "SiliconFlow (China)", tier: "B", owners: [] },
  { id: "siliconflow", label: "SiliconFlow", tier: "B", owners: [] },
  { id: "moonshotai-cn", label: "Moonshot AI (China)", tier: "B", owners: ["moonshotai"] },
  { id: "zhipuai", label: "Zhipu AI (China)", tier: "B", owners: ["zhipuai", "zai"] },
  { id: "minimax-cn", label: "MiniMax (China)", tier: "B", owners: ["minimax"] },
  { id: "stepfun", label: "StepFun (China)", tier: "B", owners: ["stepfun"] },
  { id: "openrouter", label: "OpenRouter", tier: "B", owners: [] },
  { id: "opencode", label: "OpenCode", tier: "B", owners: [] },
  { id: "opencode-go", label: "OpenCode Go", tier: "B", owners: [] },
  { id: "google-vertex", label: "Google Vertex", tier: "B", owners: [] },
  { id: "amazon-bedrock", label: "Amazon Bedrock", tier: "B", owners: [] },
  { id: "azure", label: "Azure", tier: "B", owners: [] },
  { id: "fireworks-ai", label: "Fireworks AI", tier: "B", owners: [] },
  { id: "togetherai", label: "Together AI", tier: "B", owners: [] },
  { id: "deepinfra", label: "Deep Infra", tier: "B", owners: [] },
];

export const PRESET_PROVIDER_IDS: ReadonlySet<string> = new Set(PRESET_PROVIDERS.map(({ id }) => id));

/** Bare model IDs only ever borrow this list of official first-party stores. */
export const FIRST_PARTY_PROVIDERS: ReadonlySet<string> = new Set([
  "openai", "anthropic", "google", "deepseek", "xai", "mistral", "meta",
]);
