/**
 * RAG service — the knowledge-intelligence orchestrator.
 *
 *   Question ──→ embed ──→ vector search (top-k chunks)
 *                                 ↓
 *                    chunks (with page/timestamp citations)
 *                                 ↓
 *                    LLM (OpenRouter) ──→ grounded answer + sources
 *
 * Indexing happens automatically during ingestion: every chunk the PDF/video
 * pipeline produces is embedded and stored here (see indexChunks).
 */
import { config } from '../config/index.js';
import { embedText, embedTexts } from './embedding.service.js';
import { addChunks, search } from './vector-store.service.js';
import { chatComplete, hasLlmKey } from './llm.service.js';
import { findReelForTimestamp } from './reel.service.js';
import type { AskResponse, Chunk, RagSource } from '../types/ingest.js';

const SYSTEM_PROMPT = [
  'You are Eklavya, a patient AI tutor for students.',
  'Answer ONLY using the study material provided in the context.',
  'If the context does not contain the answer, say so honestly instead of guessing.',
  'Explain clearly and simply, as if teaching a student who is new to the topic.',
  'When you use information from the material, cite it inline like [source: page 3] or [source: 00:20-01:10].',
].join(' ');

// ------------------------------------------------------------------ indexing

/**
 * Embed + store chunks from one uploaded file into the vector DB.
 * @param source original file name, used as the citation source
 * @param chunks chunks produced by the ingestion pipeline
 * @returns number of documents indexed
 */
export async function indexChunks(source: string, chunks: Chunk[]): Promise<number> {
  if (chunks.length === 0) return 0;
  const vectors = await embedTexts(chunks.map((c) => c.text));
  return addChunks(source, chunks, vectors);
}

// -------------------------------------------------------------- asking (RAG)

/** Build a citation label like "notes.pdf · page 3" or "lecture.mp4 · 00:20-01:10". */
function citeSource(src: RagSource): string {
  const bits: string[] = [src.source];
  if (src.page != null) {
    bits.push(`page ${src.page}${src.pageEnd != null ? `-${src.pageEnd}` : ''}`);
  } else if (src.startSec != null) {
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    bits.push(`${fmt(src.startSec)}-${src.endSec != null ? fmt(src.endSec) : '?'}`);
  }
  return bits.join(' · ');
}

/** Main RAG entry point: question in, grounded answer + sources out. */
export async function ask(
  question: string,
  { source }: { source?: string } = {}
): Promise<AskResponse> {
  const trimmed = question.trim();

  const queryVector = await embedText(trimmed);
  const hits = search(queryVector, config.ragTopK, source || undefined);

  const sources: RagSource[] = hits.map(({ doc, score }) => ({
    source: doc.source,
    page: doc.meta.page,
    pageEnd: doc.meta.pageEnd,
    startSec: doc.meta.startSec,
    endSec: doc.meta.endSec,
    extraction: doc.meta.extraction,
    score: Number(score.toFixed(4)),
    snippet: doc.text.slice(0, 240) + (doc.text.length > 240 ? '…' : ''),
  }));

  // If the best-matching chunk comes from an uploaded VIDEO, link the answer
  // to the rendered reel that explains exactly this portion (contextual cut,
  // never a random one — sections come from the LLM topic pipeline).
  const videoHit = hits.find(({ doc }) => typeof doc.meta.startSec === 'number');
  const reel = (videoHit ? findReelForTimestamp(videoHit.doc.source, videoHit.doc.meta.startSec as number) : null) ?? undefined;

  if (hits.length === 0) {
    // If no indexed content, fallback to general Socratic AI tutoring instead of hard failure
    if (hasLlmKey()) {
      try {
        const generalPrompt = [
          'You are Eklavya, an expert AI tutor for computer science and engineering students.',
          'Explain concepts clearly and Socratically with examples, analogies, and practice questions.',
          'Format your answers nicely with markdown, code snippets if relevant, and key takeaways.',
        ].join(' ');

        const answer = await chatComplete([
          { role: 'system', content: generalPrompt },
          { role: 'user', content: trimmed },
        ]);

        return {
          ok: true,
          question: trimmed,
          grounded: false,
          model: config.openRouterModel,
          answer: answer + '\n\n*(💡 Tip: Upload course materials or lecture PDFs to get answers grounded directly in your class notes!)*',
          sources: [],
        };
      } catch (err) {
        console.error('[rag] General LLM fallback failed:', err);
      }
    }

    return {
      ok: true,
      question: trimmed,
      grounded: false,
      model: 'none',
      answer: source
        ? `No indexed content found for "${source}". Re-upload the file, or switch back to "All materials".`
        : 'Hello! I am your AI Tutor. You can ask me any technical question, or upload study materials via the Teacher portal to get answers grounded in your specific notes!',
      sources: [],
    };
  }

  const context = hits
    .map(({ doc }, i) => `[${i + 1}] ${citeSource(sources[i])}\n${doc.text}`)
    .join('\n\n---\n\n');

  // LLM path (needs OPENROUTER_API_KEY); extractive fallback otherwise so the
  // pipeline is testable end-to-end before a key is configured.
  let lastLlmError = '';
  if (hasLlmKey()) {
    try {
      const answer = await chatComplete([
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Study material retrieved from the student's uploaded content:\n\n${context}\n\n---\n\nStudent question: ${trimmed}`,
        },
      ]);
      return { ok: true, question: trimmed, grounded: true, model: config.openRouterModel, answer, sources, reel };
    } catch (err) {
      // LLM failure must not lose the retrieval results — fall through
      lastLlmError = (err as Error).message;
      console.error('[rag] LLM call failed, using extractive fallback:', lastLlmError);
    }
  }

  const answer = hasLlmKey()
    ? [
        '⚠️ The LLM call failed — showing the retrieved study material directly.',
        '(LLM error: ' + lastLlmError + ')',
        '',
        ...hits.map(({ doc }, i) => `▪ ${citeSource(sources[i])}\n${doc.text}`),
      ].join('\n')
    : [
        '⚠️ No LLM key configured (set OPENROUTER_API_KEY in .env) — showing the retrieved study material directly:',
        '',
        ...hits.map(({ doc }, i) => `▪ ${citeSource(sources[i])}\n${doc.text}`),
      ].join('\n');

  return { ok: true, question: trimmed, grounded: false, model: 'retrieval-only', answer, sources, reel };
}
