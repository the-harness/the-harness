import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
export const { formatNoModelsAvailableMessage } = await import(new URL("core/auth-guidance.js", sdk).href) as {
  formatNoModelsAvailableMessage(): string;
};

export function modelResolverCatalog(
  available: readonly Model<Api>[],
  known: readonly Model<Api>[] = available,
  hasConfiguredAuth: (provider: string) => boolean = (provider) =>
    available.some((model) => model.provider === provider),
): ModelRuntime {
  const view = {
    getModels: (provider?: string) =>
      provider === undefined ? known : known.filter((model) => model.provider === provider),
    async getAvailable(provider?: string) {
      return provider === undefined
        ? available
        : available.filter((model) => model.provider === provider);
    },
    hasConfiguredAuth,
  } satisfies Pick<ModelRuntime, "getModels" | "getAvailable" | "hasConfiguredAuth">;
  // The upstream resolvers read only these catalog methods.
  return view as ModelRuntime;
}

function formatTokens(tokens: number): string {
  const unit =
    tokens >= 1_000_000
      ? { divisor: 1_000_000, suffix: "M" }
      : tokens >= 1_000
        ? { divisor: 1_000, suffix: "K" }
        : undefined;
  if (!unit) return String(tokens);
  const value = tokens / unit.divisor;
  return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + unit.suffix;
}

export function printModelList(models: readonly Model<Api>[], search: string): void {
  const matches = search
    ? fuzzyFilter([...models], search, (model) => `${model.provider} ${model.id}`)
    : [...models];
  if (matches.length === 0) {
    console.log(search ? `No models matching "${search}"` : formatNoModelsAvailableMessage());
    return;
  }
  matches.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const rows = [
    ["provider", "model", "context", "max-out", "thinking", "images"],
    ...matches.map((model) => [
      model.provider,
      model.id,
      formatTokens(model.contextWindow),
      formatTokens(model.maxTokens),
      model.reasoning ? "yes" : "no",
      model.input.includes("image") ? "yes" : "no",
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  console.log(
    rows
      .map((row) => row.map((value, column) => value.padEnd(widths[column]!)).join("  "))
      .join("\n"),
  );
}
