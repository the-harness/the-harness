import { FunctionToolDeclaration, type LlmModelInfo } from "@harness/llm";
import { toValue, type MaybeRefOrGetter } from "reactivity";
import { ScriptedMockLlmProvider } from "./scripted.ts";
import type {
  MockContext,
  MockHandler,
  MockHandlerReturn,
  MockModelConfig,
  ScriptedMockLlmOptions,
} from "./types.ts";
import { MockLlmError } from "./utils.ts";

export type SyntheticPreset = "echo" | "text" | "thinking" | "tools" | "chaos";

export type SyntheticChaosOutcome =
  | "text"
  | "slow"
  | "max_tokens"
  | "retryable_error"
  | "fatal_error";

export interface SyntheticMockLlmOptions extends Omit<ScriptedMockLlmOptions, "handler"> {
  readonly seed?: MaybeRefOrGetter<number>;
  readonly defaultPreset?: SyntheticPreset;
  readonly maxToolRounds?: number;
  readonly chaosWeights?: MaybeRefOrGetter<Partial<Record<SyntheticChaosOutcome, number>>>;
  readonly generators?: Readonly<Record<string, MockHandler>>;
}

const DEFAULT_CHAOS_WEIGHTS: Readonly<Record<SyntheticChaosOutcome, number>> = {
  text: 50,
  slow: 20,
  max_tokens: 10,
  retryable_error: 12,
  fatal_error: 8,
};

export const SYNTHETIC_DEFAULT_MODELS: readonly MockModelConfig[] = [
  { id: "synthetic-text", name: "Synthetic Text", reasoning: false },
  { id: "synthetic-thinking", name: "Synthetic Thinking", reasoning: ["low", "high"] },
  { id: "synthetic-tools", name: "Synthetic Tools", reasoning: ["low", "high"] },
  { id: "synthetic-chaos", name: "Synthetic Chaos", reasoning: false },
  { id: "echo", name: "Echo", reasoning: false },
];

const LOREM_PARAGRAPHS: readonly string[] = [
  "Here is a structured synthetic response generated deterministically for local testing and streaming preview.",
  "You can inspect markdown rendering, incremental token pacing, and abort handling without reaching any external API.",
  "Key observations:\n- Streaming chunks preserve ordering under backpressure\n- Usage counters reflect estimated prompt prefixes\n- Tool schemas can be exercised automatically",
  '```ts\nexport function verifyPipeline(ready: boolean): string {\n  return ready ? "operational" : "pending";\n}\n```',
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sampleStringForKey(key: string | undefined, rng: () => number): string {
  const lower = key?.toLowerCase() ?? "";
  if (lower.includes("path") || lower.includes("file")) {
    const paths = ["README.md", "package.json", "src/index.ts", "tsconfig.json"];
    return paths[Math.floor(rng() * paths.length)]!;
  }
  if (lower.includes("pattern") || lower.includes("glob")) {
    return "**/*.ts";
  }
  if (lower.includes("cmd") || lower.includes("command")) {
    return "echo ok";
  }
  if (lower.includes("url")) {
    return "https://example.com";
  }
  if (lower.includes("query") || lower.includes("search")) {
    return "mock";
  }
  return `sample_${Math.floor(rng() * 1000)}`;
}

export function generateFromSchema(
  schema: Record<string, unknown> | undefined,
  rng: () => number,
  keyHint?: string,
  depth: number = 0,
): unknown {
  if (schema === undefined || depth > 4) {
    return {};
  }
  if ("const" in schema) {
    return schema["const"];
  }
  if ("default" in schema) {
    return schema["default"];
  }
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) {
    const idx = Math.floor(rng() * schema["enum"].length);
    return schema["enum"][idx];
  }
  const union = Array.isArray(schema["oneOf"])
    ? schema["oneOf"]
    : Array.isArray(schema["anyOf"])
      ? schema["anyOf"]
      : undefined;
  if (union !== undefined && union.length > 0) {
    const first = union[Math.floor(rng() * union.length)];
    if (isRecord(first)) {
      return generateFromSchema(first, rng, keyHint, depth + 1);
    }
  }

  const rawType = Array.isArray(schema["type"]) ? schema["type"][0] : schema["type"];
  switch (rawType) {
    case "string":
      return sampleStringForKey(keyHint, rng);
    case "integer":
      return Math.floor(rng() * 10) + 1;
    case "number":
      return Number((rng() * 10).toFixed(2));
    case "boolean":
      return rng() >= 0.5;
    case "array": {
      const items = isRecord(schema["items"]) ? schema["items"] : undefined;
      return items !== undefined ? [generateFromSchema(items, rng, keyHint, depth + 1)] : [];
    }
    case "object":
    default: {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : undefined;
      if (properties === undefined) {
        return {};
      }
      const required = new Set(
        Array.isArray(schema["required"])
          ? schema["required"].filter((item): item is string => typeof item === "string")
          : [],
      );
      const out: Record<string, unknown> = {};
      for (const [propKey, propSchema] of Object.entries(properties)) {
        if (!isRecord(propSchema)) continue;
        if (required.has(propKey) || rng() >= 0.5) {
          out[propKey] = generateFromSchema(propSchema, rng, propKey, depth + 1);
        }
      }
      return out;
    }
  }
}

export class SyntheticMockLlmProvider extends ScriptedMockLlmProvider {
  protected readonly syntheticOptions: SyntheticMockLlmOptions;

  constructor(options: SyntheticMockLlmOptions = {}) {
    super({
      ...options,
      providerId: options.providerId ?? "mock-synthetic",
      chunkSize: options.chunkSize ?? 12,
      chunkDelayMs: options.chunkDelayMs ?? 10,
    });
    this.syntheticOptions = options;
  }

  protected override defaultModels(): readonly (MockModelConfig | LlmModelInfo)[] {
    const customIds = Object.keys(this.syntheticOptions.generators ?? {});
    if (customIds.length === 0) {
      return SYNTHETIC_DEFAULT_MODELS;
    }
    const existing = new Set(SYNTHETIC_DEFAULT_MODELS.map((m) => m.id));
    const extras: MockModelConfig[] = customIds
      .filter((id) => !existing.has(id))
      .map((id) => ({ id, name: id }));
    return [...SYNTHETIC_DEFAULT_MODELS, ...extras];
  }

  protected override async resolveDefault(ctx: MockContext): Promise<MockHandlerReturn> {
    const custom = this.syntheticOptions.generators?.[ctx.request.model];
    if (custom !== undefined) {
      return custom(ctx);
    }

    const baseSeed = toValue(this.syntheticOptions.seed ?? 1);
    const rng = mulberry32((baseSeed ^ ((ctx.callIndex + 1) * 2_654_435_761)) >>> 0);
    const preset = this.resolvePreset(ctx.request.model);

    switch (preset) {
      case "echo":
        return this.runEcho(ctx);
      case "thinking":
        return this.runThinking(ctx, rng);
      case "tools":
        return this.runTools(ctx, rng);
      case "chaos":
        return this.runChaos(ctx, rng);
      case "text":
      default:
        return this.runText(ctx, rng);
    }
  }

  protected resolvePreset(modelId: string): SyntheticPreset {
    switch (modelId) {
      case "echo":
        return "echo";
      case "synthetic-thinking":
        return "thinking";
      case "synthetic-tools":
        return "tools";
      case "synthetic-chaos":
        return "chaos";
      case "synthetic-text":
        return "text";
      default:
        return this.syntheticOptions.defaultPreset ?? "text";
    }
  }

  protected runEcho(ctx: MockContext): void {
    const parts: string[] = [];
    if (ctx.lastUserText.length > 0) {
      parts.push(`Echo: ${ctx.lastUserText}`);
    }
    if (ctx.toolResults.length > 0) {
      parts.push(`Tool results: ${ctx.toolResults.length}`);
    }
    ctx.text(parts.length > 0 ? parts.join("\n") : "Echo: (empty request)");
  }

  protected runText(ctx: MockContext, rng: () => number): void {
    const first = LOREM_PARAGRAPHS[Math.floor(rng() * LOREM_PARAGRAPHS.length)]!;
    const second = LOREM_PARAGRAPHS[Math.floor(rng() * LOREM_PARAGRAPHS.length)]!;
    const topic = ctx.lastUserText.trim();
    const intro = topic.length > 0 ? `Regarding "${topic.slice(0, 60)}":\n\n` : "";
    ctx.text(`${intro}${first}\n\n${second}`);
  }

  protected runThinking(ctx: MockContext, rng: () => number): void {
    const topic = ctx.lastUserText.trim() || "the request";
    ctx.think(`Evaluating "${topic.slice(0, 48)}" step by step and preparing response.`);
    this.runText(ctx, rng);
  }

  protected runTools(ctx: MockContext, rng: () => number): void {
    const maxRounds = this.syntheticOptions.maxToolRounds ?? 2;
    const tools = ctx.tools;
    if (tools.length === 0 || ctx.toolResults.length >= maxRounds) {
      if (ctx.toolResults.length > 0) {
        const names = ctx.toolResults.map((r) => r.toolName).join(", ");
        ctx.think("Reviewing tool results before summarizing.");
        ctx.text(`Completed ${ctx.toolResults.length} tool call(s) (${names}).`);
        return;
      }
      this.runThinking(ctx, rng);
      return;
    }

    const callable = tools.filter(
      (tool): tool is FunctionToolDeclaration => tool instanceof FunctionToolDeclaration,
    );
    const chosen: FunctionToolDeclaration = callable[Math.floor(rng() * callable.length)]!;
    const args = generateFromSchema(chosen.parameters, rng);
    ctx.think(`Calling tool '${chosen.name}' (round ${ctx.toolResults.length + 1}).`);
    ctx.toolCall(chosen.name, args);
  }

  protected async runChaos(ctx: MockContext, rng: () => number): Promise<void> {
    const customWeights = toValue(this.syntheticOptions.chaosWeights ?? {});
    const weights: Record<SyntheticChaosOutcome, number> = {
      text: customWeights.text ?? DEFAULT_CHAOS_WEIGHTS.text,
      slow: customWeights.slow ?? DEFAULT_CHAOS_WEIGHTS.slow,
      max_tokens: customWeights.max_tokens ?? DEFAULT_CHAOS_WEIGHTS.max_tokens,
      retryable_error: customWeights.retryable_error ?? DEFAULT_CHAOS_WEIGHTS.retryable_error,
      fatal_error: customWeights.fatal_error ?? DEFAULT_CHAOS_WEIGHTS.fatal_error,
    };

    const entries = Object.entries(weights) as Array<[SyntheticChaosOutcome, number]>;
    const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
    let cursor = rng() * (total > 0 ? total : 1);
    let picked: SyntheticChaosOutcome = "text";
    for (const [outcome, weight] of entries) {
      if (weight <= 0) continue;
      if (cursor < weight) {
        picked = outcome;
        break;
      }
      cursor -= weight;
    }

    switch (picked) {
      case "slow":
        await ctx.sleep(150);
        this.runText(ctx, rng);
        break;
      case "max_tokens":
        ctx.text("Partial synthetic output truncated by max_tokens limit...");
        ctx.stopReason("max_tokens");
        break;
      case "retryable_error":
        throw new MockLlmError("Synthetic chaos: transient rate limit", { retryable: true });
      case "fatal_error":
        ctx.text("Partial output before failure ");
        throw new MockLlmError("Synthetic chaos: fatal upstream failure", { retryable: false });
      case "text":
      default:
        this.runText(ctx, rng);
        break;
    }
  }
}
