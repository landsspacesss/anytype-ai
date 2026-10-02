/**
 * DeepSeek's hosted web search.
 *
 * DeepSeek does NOT expose its built-in web search via the Chat Completions API
 * (`/chat/completions`) — declaring `web_search` there does nothing. It IS
 * exposed via DeepSeek's Anthropic-compatible Messages endpoint as a
 * server-side tool (`web_search_20250305`), so we POST there instead. No extra
 * provider or key is needed: the same DEEPSEEK_API_KEY is used.
 */

export interface WebSearchSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  /** The concatenated assistant answer text (may be empty). */
  text: string;
  /** Deduped-by-url web results the model searched (may be empty). */
  sources: WebSearchSource[];
}

/** Default endpoint: DeepSeek's Anthropic-compatible Messages API. */
export const DEFAULT_WEB_SEARCH_URL = "https://api.deepseek.com/anthropic/v1/messages";

/**
 * Run a web search through DeepSeek's hosted `web_search` server-side tool and
 * return the answer text plus the sources it used. Throws on a non-2xx
 * response. `fetch` is injectable for tests.
 */
export async function webSearch(opts: {
  apiKey: string;
  query: string;
  /** Model id (default "deepseek-flash"). */
  model?: string;
  /** Max number of searches the model may run (default 3). */
  maxUses?: number;
  /** Max tokens for the turn (default 4096 — too small truncates mid-search). */
  maxTokens?: number;
  /** Override the endpoint (default DeepSeek's Anthropic Messages URL). */
  baseUrl?: string;
  /** Injectable fetch (defaults to the global fetch). */
  fetch?: typeof fetch;
}): Promise<WebSearchResult> {
  const {
    apiKey,
    query,
    model = "deepseek-flash",
    maxUses = 3,
    maxTokens = 4096,
    baseUrl = DEFAULT_WEB_SEARCH_URL,
    fetch: fetchImpl = fetch,
  } = opts;

  const res = await fetchImpl(baseUrl, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }],
    }),
  });

  if (!res.ok) {
    throw new Error(`web search failed: ${res.status}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }

  const textParts: string[] = [];
  const sources: WebSearchSource[] = [];
  const seenUrls = new Set<string>();

  const content = (data as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === null || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;

      // Answer text: concatenate every text block (joined by a blank line).
      if (c.type === "text" && typeof c.text === "string") {
        textParts.push(c.text);
        continue;
      }

      // Sources: unwrap every `web_search_tool_result`'s result list.
      if (c.type === "web_search_tool_result" && Array.isArray(c.content)) {
        for (const r of c.content) {
          if (r === null || typeof r !== "object") continue;
          const item2 = r as Record<string, unknown>;
          if (item2.type !== "web_search_result") continue;
          const url = typeof item2.url === "string" ? item2.url : "";
          if (url.length === 0) continue; // skip results missing a url
          if (seenUrls.has(url)) continue; // dedupe by url, keep the first
          seenUrls.add(url);
          sources.push({ title: typeof item2.title === "string" ? item2.title : "", url });
        }
      }
    }
  }

  return { text: textParts.join("\n\n"), sources };
}
