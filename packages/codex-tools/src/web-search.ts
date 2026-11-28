import { inject } from "@harness/di";
import { LlmService } from "@harness/llm";
import { ModelSelectionService } from "@harness/model-selection";
import { ToolCallService } from "@harness/tool-call";
import { webSearchParameters } from "./parameters.ts";

const WEB_SEARCH_DESCRIPTION =
  "Search the web for current information. Use this when the answer depends on content that may have changed after your training data, or when the user asks for sources.";

export function useWebSearchTool(): void {
  const toolCall = inject(ToolCallService);
  const llm = inject(LlmService);
  const modelSelection = inject(ModelSelectionService);

  toolCall.useTool({
    name: "web_search",
    description: WEB_SEARCH_DESCRIPTION,
    parameters: webSearchParameters,
    async execute({ query }, { signal }) {
      const { provider } = modelSelection.current;
      const results = await llm.webSearch({ provider, query, signal });
      if (results.length === 0) return `No web results for "${query}".`;
      return results
        .map((item, index) => {
          const snippet = item.snippet.trim();
          const title = item.title.trim() || item.url;
          return snippet.length === 0
            ? `${index + 1}. ${title}\n   ${item.url}`
            : `${index + 1}. ${title}\n   ${item.url}\n   ${snippet}`;
        })
        .join("\n\n");
    },
  });
}
