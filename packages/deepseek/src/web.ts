import { AuthService } from "@harness/auth";
import { optionalInject } from "@harness/di";
import { DEEPSEEK_DEFAULT_BASE_URL, deepseekMessagesRoot, deepseekOrigin } from "./catalog.ts";

export interface DeepSeekSearchRequest {
  readonly query: string;
  readonly count?: number;
  readonly originalQuestion?: string;
  readonly needContent?: boolean;
  readonly mode?: "search-api" | "messages-server-tool";
  readonly model?: string;
  readonly maxUses?: number;
  readonly signal?: AbortSignal;
}

export interface DeepSeekSearchResultItem {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly summary?: string;
  readonly content?: string;
  readonly publishedAt?: string;
  readonly siteName?: string;
  readonly score?: number;
}

export interface DeepSeekFetchResult {
  readonly url: string;
  readonly title?: string;
  readonly content: string;
}

export interface DeepSeekWebServiceOptions {
  readonly baseUrl?: string;
  readonly defaultCount?: number;
  readonly requestsPerSecond?: number;
  readonly fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedOriginalQuestion(question: string | undefined): string | undefined {
  const collapsed = question?.replace(/\s+/gu, " ").trim() ?? "";
  if (collapsed.length === 0) return undefined;
  return Array.from(collapsed).slice(0, 128).join("");
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DeepSeekWebService {
  readonly options: DeepSeekWebServiceOptions;

  protected readonly auth = optionalInject(AuthService);
  protected readonly starts: number[] = [];

  constructor(options: DeepSeekWebServiceOptions = {}) {
    this.options = options;
  }

  async search(request: DeepSeekSearchRequest): Promise<readonly DeepSeekSearchResultItem[]> {
    if (request.mode === "messages-server-tool") {
      return this.searchViaMessagesServerTool(request);
    }

    const rps = this.options.requestsPerSecond ?? 5;
    await this.waitForRequestSlot(rps, request.signal);

    const origin = deepseekOrigin(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${origin}/v1/tools/search`;
    const authResult = await this.auth?.authorize({
      url,
      method: "POST",
      signal: request.signal,
    });
    const oriQuestion = boundedOriginalQuestion(request.originalQuestion);
    const count = Math.min(50, Math.max(1, request.count ?? this.options.defaultCount ?? 10));

    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        query: request.query,
        count,
        need_content: request.needContent ?? false,
        ...(oriQuestion !== undefined ? { ori_question: oriQuestion } : {}),
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Search API failed with HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload["results"])) {
      throw new Error("DeepSeek Search API returned an invalid response");
    }

    return payload["results"]
      .filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) && typeof item["url"] === "string",
      )
      .map((item) => ({
        url: String(item["url"]),
        title: typeof item["title"] === "string" ? item["title"] : "",
        snippet: typeof item["snippet"] === "string" ? item["snippet"] : "",
        ...(typeof item["summary"] === "string" && item["summary"]
          ? { summary: item["summary"] }
          : {}),
        ...(typeof item["content"] === "string" && item["content"]
          ? { content: item["content"] }
          : {}),
        ...(typeof item["date"] === "string" && item["date"] ? { publishedAt: item["date"] } : {}),
        ...(typeof item["site_name"] === "string" && item["site_name"]
          ? { siteName: item["site_name"] }
          : {}),
        ...(typeof item["rerank_score"] === "number" ? { score: item["rerank_score"] } : {}),
      }));
  }

  protected async searchViaMessagesServerTool(
    request: DeepSeekSearchRequest,
  ): Promise<readonly DeepSeekSearchResultItem[]> {
    const root = deepseekMessagesRoot(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const url = `${root}/messages`;
    const authResult = await this.auth?.authorize({
      url,
      method: "POST",
      signal: request.signal,
    });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: request.model ?? "deepseek-flash",
        max_tokens: 4_096,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `Perform a web search for the query: ${request.query}` },
            ],
          },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: request.maxUses ?? 5,
          },
        ],
        thinking: { type: "disabled" },
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Messages search failed with HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload["content"])) {
      throw new Error("DeepSeek Messages search returned an invalid response");
    }

    const citationSnippets = new Map<string, string>();
    for (const block of payload["content"]) {
      if (!isRecord(block) || block["type"] !== "text" || !Array.isArray(block["citations"])) {
        continue;
      }
      for (const cite of block["citations"]) {
        if (
          isRecord(cite) &&
          typeof cite["url"] === "string" &&
          typeof cite["cited_text"] === "string" &&
          !citationSnippets.has(cite["url"])
        ) {
          citationSnippets.set(cite["url"], cite["cited_text"]);
        }
      }
    }

    const seen = new Set<string>();
    const results: DeepSeekSearchResultItem[] = [];
    for (const block of payload["content"]) {
      if (
        !isRecord(block) ||
        block["type"] !== "web_search_tool_result" ||
        !Array.isArray(block["content"])
      ) {
        continue;
      }
      for (const item of block["content"]) {
        if (
          !isRecord(item) ||
          item["type"] !== "web_search_result" ||
          typeof item["url"] !== "string" ||
          !item["url"] ||
          seen.has(item["url"])
        ) {
          continue;
        }
        seen.add(item["url"]);
        const snippet =
          typeof item["snippet"] === "string" && item["snippet"]
            ? item["snippet"]
            : (citationSnippets.get(item["url"]) ?? "");
        results.push({
          url: item["url"],
          title: typeof item["title"] === "string" ? item["title"] : "",
          snippet,
          ...(typeof item["page_age"] === "string" && item["page_age"]
            ? { publishedAt: item["page_age"] }
            : {}),
        });
      }
    }
    return results;
  }

  async fetch(urlToFetch: string, signal?: AbortSignal): Promise<DeepSeekFetchResult> {
    const origin = deepseekOrigin(this.options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
    const endpoint = `${origin}/v1/tools/fetch`;
    const authResult = await this.auth?.authorize({
      url: endpoint,
      method: "POST",
      signal,
    });
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const response = await fetchFn(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        ...authResult?.headers,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ url: urlToFetch }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Fetch API failed with HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload["content"] !== "string") {
      throw new Error("DeepSeek Fetch API returned an invalid response");
    }
    return {
      url: urlToFetch,
      ...(typeof payload["title"] === "string" && payload["title"]
        ? { title: payload["title"] }
        : {}),
      content: payload["content"],
    };
  }

  protected async waitForRequestSlot(limit: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const now = performance.now();
      let oldest = this.starts[0];
      while (oldest !== undefined && oldest < now - 1_000) {
        this.starts.shift();
        oldest = this.starts[0];
      }
      if (oldest === undefined || this.starts.length < limit) {
        this.starts.push(now);
        return;
      }
      await abortableDelay(oldest + 1_001 - now, signal);
    }
  }
}
