/**
 * Embedding service — converts text into normalized vectors using a local
 * ONNX model (@huggingface/transformers). No API key, no network calls after
 * the first run (model is cached under models/).
 *
 *   TEXT ──→ all-MiniLM-L6-v2 ──→ [0.13, -0.82, ...] (384 dims, L2-normalized)
 */
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { config } from '../config/index.js';

// Cache downloaded model weights under <root>/models/ (already gitignored)
env.cacheDir = path.join(config.rootDir, 'models');
env.allowLocalModels = false;

type Extractor = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;
let extractorPromise: Promise<Extractor> | null = null;

/** Lazily load the embedding model once per process */
function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', config.embeddingModel, {
      dtype: 'q8',
    }) as Promise<Extractor>;
  }
  return extractorPromise;
}

/**
 * Embed a batch of texts. Returns one L2-normalized vector per text, so
 * cosine similarity between any two vectors is just their dot product.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const usable = texts.map((t) => (t ?? '').trim()).filter(Boolean);
  if (usable.length === 0) return [];

  const extractor = await getExtractor();
  const output = await extractor(usable, { pooling: 'mean', normalize: true });
  return output.tolist() as number[][];
}

/** Embed a single text. */
export async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  if (!vec) throw new Error('Cannot embed empty text');
  return vec;
}
