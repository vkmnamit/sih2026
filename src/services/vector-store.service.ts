/**
 * Vector store service — a tiny JSON-persisted vector database.
 *
 * Good enough for a demo/prototyping scale (thousands of chunks); the
 * interface (addDocs / search / stats / removeBySource) is deliberately
 * shaped so it can be swapped for pgvector / Qdrant / Pinecone later.
 *
 * Vectors are L2-normalized at write time, so cosine similarity reduces to a
 * dot product.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { Chunk, VectorDoc } from '../types/ingest.js';

interface SearchHit {
  doc: VectorDoc;
  /** cosine similarity in [-1, 1] (≈ [0, 1] for text embeddings) */
  score: number;
}

let docs: VectorDoc[] | null = null;

function load(): VectorDoc[] {
  if (docs) return docs;
  if (fs.existsSync(config.vectorStorePath)) {
    try {
      docs = JSON.parse(fs.readFileSync(config.vectorStorePath, 'utf8')) as VectorDoc[];
    } catch (err) {
      console.error('[vector-store] corrupt store, starting fresh:', (err as Error).message);
      docs = [];
    }
  } else {
    docs = [];
  }
  return docs;
}

function persist(): void {
  if (!docs) return;
  const tmp = `${config.vectorStorePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(docs));
  fs.renameSync(tmp, config.vectorStorePath);
}

/**
 * Index a set of chunks from one source file. Re-indexing the same source
 * replaces its previous documents (idempotent uploads).
 * @param source original file name (e.g. "notes.pdf")
 * @param chunks chunks + their precomputed vectors (same order)
 * @returns number of documents stored
 */
export function addChunks(source: string, chunks: Chunk[], vectors: number[][]): number {
  if (chunks.length !== vectors.length) {
    throw new Error(`chunks/vectors length mismatch: ${chunks.length} vs ${vectors.length}`);
  }
  const store = load();
  removeBySource(source);

  const now = new Date().toISOString();
  chunks.forEach((chunk, i) => {
    const vec = vectors[i];
    if (!vec) return;
    store.push({
      id: `${source}#${chunk.id}`,
      source,
      text: chunk.text,
      meta: chunk.meta,
      vector: vec,
      indexedAt: now,
    });
  });
  persist();
  return store.filter((d) => d.source === source).length;
}

/**
 * Top-k cosine-similarity search. Returns hits sorted best-first.
 * @param sourceFilter when set, only documents from this source file are
 *   considered (scoped mode: "ask about THIS upload").
 */
export function search(queryVector: number[], topK: number, sourceFilter?: string): SearchHit[] {
  const store = load();
  const hits: SearchHit[] = [];
  for (const doc of store) {
    if (sourceFilter && doc.source !== sourceFilter) continue;
    let dot = 0;
    for (let i = 0; i < queryVector.length; i += 1) dot += queryVector[i] * doc.vector[i];
    hits.push({ doc, score: dot });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** Remove every document that came from a given source file. */
export function removeBySource(source: string): void {
  const store = load();
  const before = store.length;
  // Mutate in place (never reassign `docs` — other callers hold the same array)
  for (let i = store.length - 1; i >= 0; i -= 1) {
    if (store[i].source === source) store.splice(i, 1);
  }
  if (store.length !== before) persist();
}

/** All stored documents from one source file (used by the content engine). */
export function getDocsBySource(source: string): VectorDoc[] {
  return load()
    .filter((d) => d.source === source)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Store statistics (for health checks / the test frontend). */
export function stats(): { documents: number; sources: number; sourceNames: string[] } {
  const store = load();
  const names = [...new Set(store.map((d) => d.source))].sort();
  return { documents: store.length, sources: names.length, sourceNames: names };
}
