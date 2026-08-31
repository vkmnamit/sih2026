/**
 * LLM service — OpenRouter chat-completions client (plain fetch, no SDK).
 *
 * OpenRouter is chat-only: it does not provide embeddings, which is why the
 * embedding side of RAG stays local (see embedding.service.ts).
 *
 * Configure via .env:
 *   OPENROUTER_API_KEY=sk-or-...
 *   OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
 */
import { config } from '../config/index.js';

/** True when an API key is configured and LLM generation can be attempted. */
export function hasLlmKey(): boolean {
  return config.openRouterApiKey.trim().length > 0;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Minimal chat completion — returns the assistant message text. */
export async function chatComplete(
  messages: ChatMessage[],
  { temperature = 0.3, maxTokens = 1024 }: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  if (!hasLlmKey()) {
    throw new Error('OPENROUTER_API_KEY is not set. Add it to the .env file.');
  }

  const call = (): Promise<Response> =>
    fetch(`${config.openRouterBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openRouterApiKey}`,
        // OpenRouter attribution headers (recommended for app identification)
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Eklavya',
      },
      body: JSON.stringify({
        model: config.openRouterModel,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      // Hard timeout — a hung OpenRouter request must never stall a
      // background pipeline (e.g. reel metadata generation) forever.
      signal: AbortSignal.timeout(120_000),
    });

  // Free-tier models are often transiently rate-limited (429) or return an
  // empty completion — retry once after a short backoff.
  let res = await call();
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2500));
    res = await call();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let text = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) {
    await new Promise((r) => setTimeout(r, 2500));
    res = await call();
    if (res.ok) {
      const retried = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      text = retried.choices?.[0]?.message?.content?.trim() ?? '';
    } else {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter error ${res.status}: ${body.slice(0, 300)}`);
    }
  }
  if (!text) throw new Error('OpenRouter returned an empty completion');
  return text;
}
