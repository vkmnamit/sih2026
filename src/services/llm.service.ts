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

const FREE_MODELS_FALLBACK = [
  config.openRouterModel,
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-24b-instruct-2501:free',
  'meta-llama/llama-3.2-3b-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
];

/** Minimal chat completion — returns the assistant message text with model fallback. */
export async function chatComplete(
  messages: ChatMessage[],
  { temperature = 0.3, maxTokens = 1024 }: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  if (!hasLlmKey()) {
    throw new Error('OPENROUTER_API_KEY is not set. Add it to the .env file.');
  }

  const uniqueModels = [...new Set(FREE_MODELS_FALLBACK.filter(Boolean))];
  let lastError = '';

  for (const modelToTry of uniqueModels) {
    try {
      const res = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openRouterApiKey}`,
          'HTTP-Referer': 'https://sih-2026-eklavya.vercel.app',
          'X-Title': 'EkLavya AI Tutor',
        },
        body: JSON.stringify({
          model: modelToTry,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        lastError = `Model ${modelToTry} returned HTTP ${res.status}: ${errorText.slice(0, 150)}`;
        console.warn(`[llm] ${lastError}, attempting next fallback model...`);
        continue;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 0) {
        return text;
      }
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`[llm] Model ${modelToTry} fetch error: ${lastError}`);
    }
  }

  throw new Error(`All LLM models failed. Last error: ${lastError}`);
}
