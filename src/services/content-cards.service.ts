/**
 * AI Content Engine — turns uploaded material into interactive post cards.
 *
 *   chunks ──→ LLM names topics
 *          ──→ local embeddings assign/group chunks to topics
 *          ──→ RAG RETRIEVES top-k chunks per topic  ← content source
 *          ──→ LLM decides WHAT & HOW to present it  ← generation
 *          ──→ cards stored in data/content-cards.json
 *
 * The key design rule: RAG is the content source, the LLM is the presenter.
 * No full-PDF dumps into prompts. Each card retrieves only its topic's most
 * relevant chunks (tagged with page numbers / timestamps), so the model never
 * invents facts and every card is grounded in the uploaded material. Works
 * identically for PDFs (page citations) and video/audio (timestamp citations).
 * Cards are regenerated (idempotently) when the same file is uploaded again.
 */

/**
 * Step 1 — ask the LLM to name the topics + write one-line descriptions.
 * NO chunk ids in the response: enumerating every chunk makes free-tier
 * models truncate. Chunks are assigned to topics separately via local
 * embeddings (see assignChunksToTopics), which keeps this call tiny and
 * the assignments deterministic.
 */
async function detectTopics(docs: { id: string; text: string; meta: Record<string, unknown> }[]): Promise<TopicSpec[]> {
  const index = docs
    .map((d) => {
      const page = typeof d.meta.page === 'number' ? ` (p${d.meta.page})` : '';
      return `- ${d.text.slice(0, 120).replace(/\s+/g, ' ')}…${page}`;
    })
    .slice(0, 60) // keep the call small; assignments don't depend on full coverage
    .join('\n');

  const raw = await chatComplete(
    [
      {
        role: 'system',
        content:
          'You are a curriculum analyzer. You name the topics of a study document. ' +
          'Respond with ONLY valid JSON, no markdown, no commentary.',
      },
      {
        role: 'user',
        content:
          `Below are text snippets from one uploaded study file:\n\n${index}\n\n` +
          'List ALL distinct topics in the material. Rules:\n' +
          '- 4-12 topics (be thorough — do NOT cram different sections into a single topic).\n' +
          '- If the file covers many subtopics, list them ALL as separate topics.\n' +
          '- Names are short (2-6 words); descriptions are ONE sentence each.\n' +
          '- Do NOT include chunk ids or subtopics.\n' +
          'Return ONLY this JSON shape:\n' +
          '{"topics":[{"name":"...","description":"..."}]}',
      },
    ],
    { temperature: 0.2, maxTokens: 1500 }
  );

  const parsed = extractJson<{ topics: Array<{ name: string; description: string }> }>(raw);
  return (parsed.topics ?? []).filter((t) => t.name).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    chunkIds: [],
    subtopics: [],
  }));
}

/**
 * Step 1b — assign every chunk to its nearest topic using local embeddings.
 * Deterministic, free, and fast (one MiniLM pass over topics + chunks).
 * Chunks below the similarity threshold stay unassigned (they are skipped,
 * which keeps generated cards grounded in topic-relevant material).
 */
async function assignChunksToTopics(
  docs: { id: string; text: string }[],
  topics: TopicSpec[]
): Promise<void> {
  if (topics.length === 0) return;
  const { embedTexts } = await import('./embedding.service.js');
  const topicVecs = new Map<string, number[]>();
  const anchors = topics.map((t) => `${t.name}: ${t.description}`.slice(0, 300));
  const nameVecs = await embedTexts(anchors);
  nameVecs.forEach((v, i) => topicVecs.set(topics[i].name, v));

  const chunkVecs = await embedTexts(docs.map((d) => d.text));
  // MiniLM cosine similarities between a chunk and a short topic label land
  // lower than document-document similarities — always assign to the closest
  // topic so every chunk still gets a card.

  docs.forEach((doc, ci) => {
    const vec = chunkVecs[ci];
    if (!vec) return;
    let bestTopic: TopicSpec | null = null;
    let bestScore = -1;
    for (const t of topics) {
      const tv = topicVecs.get(t.name);
      if (!tv) continue;
      let dot = 0;
      for (let k = 0; k < Math.min(vec.length, tv.length); k += 1) dot += vec[k] * tv[k];
      if (dot > bestScore) {
        bestScore = dot;
        bestTopic = t;
      }
    }
    if (bestTopic) bestTopic.chunkIds.push(doc.id); // always assign to closest topic
  });
}

/** Extract the chunk sequence number from a vector-doc id ("notes.pdf#chunk_0003" → 3). */
function chunkSeq(id: string): number {
  const m = id.match(/chunk_(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Split ordered chunk ids into sequential windows (each window = one card). */
function windowChunks(ids: string[], perCard: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += perCard) {
    const win = ids.slice(i, i + perCard);
    if (win.length > 0) out.push(win);
  }
  return out;
}

/**
 * Step 1c — RAG RETRIEVAL: the content source for each card.
 *
 * We do NOT dump every chunk of the file into the LLM. Instead we embed the
 * topic (name + description) and run a scoped vector-store search — the same
 * retrieval the AI Tutor uses — so the model only ever sees the TOP-K chunks
 * that are actually relevant to this topic, each tagged with its source
 * location (page number for PDFs, timestamps for videos/audio).
 */
const CARD_RETRIEVAL_K = 8;

/** Human-readable source location for a chunk: "page 12" / "0:20-1:10". */
function sourceLabel(meta: Record<string, unknown>): string {
  if (typeof meta.page === 'number') {
    const end = typeof meta.pageEnd === 'number' && meta.pageEnd !== meta.page ? `-${meta.pageEnd}` : '';
    return `page ${meta.page}${end}`;
  }
  if (typeof meta.startSec === 'number') {
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const end = typeof meta.endSec === 'number' ? fmt(meta.endSec) : '?';
    return `${fmt(meta.startSec)}-${end}`;
  }
  return 'unspecified location';
}

async function retrieveTopicContext(
  source: string,
  anchor: string,
  preferIds: string[]
): Promise<{ text: string; label: string; score: number }[]> {
  const queryVector = await embedText(anchor.slice(0, 300));
  const hits = search(queryVector, CARD_RETRIEVAL_K * 2, source);
  const prefer = new Set(preferIds);
  return [...hits]
    // Chunks already grouped under this topic are shown first (still by
    // score), then the rest of the retrieved hits fill to top-k.
    .sort((a, b) => {
      const pa = prefer.has(a.doc.id) ? 0 : 1;
      const pb = prefer.has(b.doc.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.score - a.score;
    })
    .slice(0, CARD_RETRIEVAL_K)
    .map(({ doc, score }) => ({
      text: doc.text.slice(0, 1400),
      label: sourceLabel(doc.meta),
      score: Number(score.toFixed(3)),
    }));
}

/**
 * Step 2 — the LLM decides WHAT belongs in the card and HOW to present it.
 *
 * The model receives ONLY the RAG-retrieved chunks (ranked, with citations)
 * and is asked to reason about which facts are the most card-worthy for a
 * student, then emit the card as JSON: catchy title, description, key points
 * ordered by importance, and an interactive quiz. One small call per card.
 *
 * @param name        display label (topic/subtopic name, with " (n/N)" for chapters)
 * @param anchor      full context for the LLM: "Topic: one-line description"
 */
async function generateOneCard(
  source: string,
  name: string,
  anchor: string,
  description: string,
  parentTopic: string | undefined,
  context: { text: string; label: string; score: number }[],
  cardIndex: number
): Promise<ContentCard> {
  const retrieved = context.map((c, i) => `[${i + 1}] (${c.label}, relevance ${c.score})\n${c.text}`).join('\n---\n');

  const raw = await chatComplete(
    [
      {
        role: 'system',
        content:
          'You turn study material into engaging post cards for a student learning feed. ' +
          'First reason silently about the retrieved material: which facts are the MOST important ' +
          'for a student learning this topic, and how should they be presented. Then output the card. ' +
          'Base every key point and quiz question STRICTLY on the retrieved material — never invent facts. ' +
          'Respond with ONLY valid JSON.',
      },
      {
        role: 'user',
        content:
          `Create ONE study post card.\nTOPIC: ${anchor}\n` +
          `PARENT TOPIC: ${parentTopic ?? '(this is a main topic card)'}\n` +
          `SOURCE FILE: ${source}\n\n` +
          `RETRIEVED MATERIAL (already ranked by relevance to this topic):\n\n${retrieved}\n\n` +
          'Return ONLY this JSON shape:\n' +
          '{"title":"short catchy post title","description":"2-3 sentences explaining the idea simply",' +
          '"keyPoints":["3-5 key takeaways, ordered by importance"],"quiz":[{"question":"...","options":["A","B","C","D"],' +
          '"answerIndex":0,"explanation":"why this answer is correct, 1-2 sentences"}]}' +
          ' — exactly 2 quiz questions.',
      },
    ],
    { temperature: 0.4, maxTokens: 1500 }
  );

  const parsed = extractJson<{
    title?: string;
    description?: string;
    keyPoints?: string[];
    quiz?: QuizQuestion[];
  }>(raw);

  return {
    id: `${source}#card_${String(cardIndex).padStart(3, '0')}`,
    source,
    parentTopic,
    name: parsed.title || name,
    description: parsed.description || description,
    keyPoints: (parsed.keyPoints ?? []).slice(0, 6),
    quiz: (parsed.quiz ?? []).filter((q) => q.question && Array.isArray(q.options) && q.options.length >= 2),
        generatedAt: new Date().toISOString(),
  };
}

/**
 * Join a split heading + highlight without duplicating a highlight that is
 * already the heading's ending (e.g. "Divide and conquer search" + "search").
 */
function joinHeading(heading: string | undefined, highlight: string | undefined, fallback: string): string {
  if (!heading) return fallback;
  const h = heading.trim();
  const hi = (highlight ?? '').trim();
  if (!hi) return h;
  if (h.toLowerCase().endsWith(hi.toLowerCase())) return h;
  return `${h} ${hi}`;
}

/**
 * Carousel variant of generateOneCard.
 *
 * Same RAG input (retrieved chunks), but a different prompt that produces the
 * swipeable-timeline field set: category tag, large display number, split
 * heading, chronological events, and an optional bigEvent / visualNumber /
 * takeaway box.  Maps 1:1 to the carousel UI in public/carousel.html.
 */
async function generateCarouselCard(
  source: string,
  name: string,
  anchor: string,
  description: string,
  parentTopic: string | undefined,
  context: { text: string; label: string; score: number }[],
  cardIndex: number
): Promise<ContentCard> {
  const retrieved = context.map((c, i) => `[${i + 1}] (${c.label}, relevance ${c.score})\n${c.text}`).join('\n---\n');

  const raw = await chatComplete(
    [
      {
        role: 'system',
        content:
          'You create swipeable educational carousel cards from study material. ' +
          'Each card is one slide in a timeline-style learning feed. ' +
          'Extract the MOST important dates, numbers, and events from the retrieved ' +
          'material — NEVER invent facts not present in the source. ' +
          'Structure content as a chronological or logical narrative across cards. ' +
          'Respond with ONLY valid JSON.',
      },
      {
        role: 'user',
        content:
          `Create ONE carousel card (one slide) from the study material below.\n\n` +
          `TOPIC: ${anchor}\n` +
          `PARENT TOPIC: ${parentTopic ?? '(main topic)'}\n` +
          `SOURCE: ${source}\n\n` +
          `RETRIEVED MATERIAL (ranked by relevance):\n\n${retrieved}\n\n` +
          'Return ONLY this JSON (no markdown, no commentary):\n' +
          '{\n' +
          '  "category": "short label, 1-4 words (year range or topic)",\n' +
          '  "displayNumber": "REQUIRED: a real year / stat / count from the material",\n' +
          '  "heading": "3-6 word title, first part only",\n' +
          '  "headingHighlight": "1-2 word ending that gets visual highlight",\n' +
          '  "description": "2-3 simple sentences explaining the main idea",\n' +
          '  "events": [\n' +
          '    {"date": "short", "title": "name", "description": "1 sentence", "important": true/false}\n' +
          '  ],\n' +
          '  "bigEvent": {"label": "CAPS", "title": "heading", "body": "para"} or null,\n' +
          '  "visualNumber": {"value": "num", "label": "caption"} or null,\n' +
          '  "takeaway": {"label": "CAPS", "text": "summary"} or null\n' +
          '}\n' +
          'MANDATORY: ALWAYS 2-5 events ordered chronologically; mark 1-3 important=true (star). ' +
          'MANDATORY: ALWAYS include exactly ONE of bigEvent OR visualNumber OR takeaway per card, ' +
          'and ALWAYS fill displayNumber with a real year/stat from the material.',
      },
    ],
    { temperature: 0.5, maxTokens: 2800 }
  );

  const parsed = extractJson<{
    category?: string;
    displayNumber?: string;
    heading?: string;
    headingHighlight?: string;
    description?: string;
    events?: Array<{ date: string; title: string; description: string; important?: boolean }>;
    bigEvent?: { label: string; title: string; body: string } | null;
    visualNumber?: { value: string; label: string } | null;
    takeaway?: { label: string; text: string } | null;
  }>(raw);

  const fullHeading = joinHeading(parsed.heading, parsed.headingHighlight, name);

  return {
    id: `${source}#card_${String(cardIndex).padStart(3, '0')}`,
    source,
    parentTopic,
    format: 'carousel' as const,
    name: fullHeading,
    description: parsed.description || description,
    keyPoints: [],
    quiz: [],
    category: parsed.category,
    displayNumber: parsed.displayNumber,
    heading: parsed.heading,
    headingHighlight: parsed.headingHighlight,
    events: (parsed.events ?? []).slice(0, 5).map((e) => ({
      date: e.date ?? '',
      title: e.title ?? '',
      description: e.description ?? '',
      important: e.important ?? false,
    })),
    bigEvent: parsed.bigEvent ?? undefined,
    visualNumber: parsed.visualNumber ?? undefined,
    takeaway: parsed.takeaway ?? undefined,
    generatedAt: new Date().toISOString(),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { chatComplete, hasLlmKey } from './llm.service.js';
import { getDocsBySource, search } from './vector-store.service.js';
import { embedText } from './embedding.service.js';
import type { ContentCard, QuizQuestion } from '../types/ingest.js';

/**
 * Minimum number of cards for a satisfying carousel experience.
 * When topic-based generation produces fewer than this, the LLM
 * creates supplementary cards (Overview, Key Concepts, Timeline, etc.)
 * to fill out the carousel automatically.
 */
const MIN_CAROUSEL_CARDS = 5;

/**
 * Supplementary card templates — used when the source material
 * produces fewer than MIN_CAROUSEL_CARDS topic cards. The LLM fills
 * these in with content grounded in the RAG-retrieved chunks.
 */
const SUPPLEMENTARY_TEMPLATES = [
  { type: 'overview', label: 'OVERVIEW', heading: 'What is this about?', icon: '📖' },
  { type: 'key-concepts', label: 'KEY CONCEPTS', heading: 'Key ideas to remember', icon: '💡' },
  { type: 'timeline', label: 'TIMELINE', heading: 'Important milestones', icon: '📅' },
  { type: 'deep-dive', label: 'DEEP DIVE', heading: 'Going deeper', icon: '🔬' },
  { type: 'summary', label: 'SUMMARY', heading: 'Final takeaways', icon: '✅' },
];

const CARDS_PATH = path.join(config.rootDir, 'data', 'content-cards.json');

interface TopicSpec {
  name: string;
  description: string;
  chunkIds: string[];
  subtopics?: { name: string; description: string; chunkIds: string[] }[];
}

/** Read all card sets from disk ({} when the file doesn't exist yet). */
function loadAll(): Record<string, { generatedAt: string; cards: ContentCard[] }> {
  if (!fs.existsSync(CARDS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
  } catch (err) {
    console.error('[cards] corrupt cards file, starting fresh:', (err as Error).message);
    return {};
  }
}

function persist(all: Record<string, { generatedAt: string; cards: ContentCard[] }>): void {
  fs.mkdirSync(path.dirname(CARDS_PATH), { recursive: true });
  const tmp = `${CARDS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, CARDS_PATH);
}

/** Tolerant JSON extraction — models sometimes wrap JSON in prose/fences. */
function extractJson<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.search(/[{[]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start === -1 || end === -1) {
    console.error('[cards] LLM response contained no JSON, raw head:', cleaned.slice(0, 500));
    throw new Error('LLM response contains no JSON');
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch (err) {
    console.error('[cards] LLM JSON parse failed, raw tail:', cleaned.slice(-400));
    throw err;
  }
}

/**
 * Supplementary card generator — when topic-based generation produces fewer
 * than MIN_CAROUSEL_CARDS, this function uses the LLM to create additional
 * cards from the full set of RAG-retrieved chunks. This ensures the carousel
 * always has enough slides for a satisfying learning experience.
 */
async function generateSupplementaryCards(
  source: string,
  existingCards: ContentCard[],
  _format: 'post' | 'carousel'
): Promise<ContentCard[]> {
  if (!hasLlmKey()) return [];

  const allDocs = getDocsBySource(source);
  if (allDocs.length === 0) return [];

  // Build a comprehensive context from ALL chunks (up to 20 for the prompt)
  const contextChunks = allDocs
    .slice(0, 20)
    .map((d, i) => `[${i + 1}] (${sourceLabel(d.meta)})\n${d.text.slice(0, 1000)}`)
    .join('\n---\n');

  // Determine which templates we still need
  const existingCount = existingCards.length;
  const needed = Math.max(0, MIN_CAROUSEL_CARDS - existingCount);
  if (needed === 0) return [];

  // Pick templates — always include overview + summary, fill middle as needed
  const templates: typeof SUPPLEMENTARY_TEMPLATES = [];
  templates.push(SUPPLEMENTARY_TEMPLATES[0]); // overview
  if (needed >= 2) templates.push(SUPPLEMENTARY_TEMPLATES[1]); // key-concepts
  if (needed >= 3) templates.push(SUPPLEMENTARY_TEMPLATES[2]); // timeline
  if (needed >= 4) templates.push(SUPPLEMENTARY_TEMPLATES[3]); // deep-dive
  if (needed >= 5) templates.push(SUPPLEMENTARY_TEMPLATES[4]); // summary

  const templateList = templates
    .map((t) => `- ${t.type}: "${t.heading}" (${t.label})`)
    .join('\n');

  const existing = existingCards.map((c) => c.name).join(', ');
  const sysMsg =
    'You are an AI learning assistant that creates engaging educational carousel cards. ' +
    'You synthesize study material into structured, visually-appealing cards. ' +
    'Base EVERY fact, date, and concept STRICTLY on the retrieved material — never invent. ' +
    'Each card should teach something distinct and valuable to a student. ' +
    'Respond with ONLY valid JSON, no markdown, no commentary.';
  const userMsg =
    `Create ${templates.length} supplementary learning cards from the study material below.\n\n` +
    `SOURCE: ${source}\n` +
    `EXISTING CARDS: ${existingCount} topic cards already cover: ${existing}\n\n` +
    `Create cards for these templates:\n${templateList}\n\n` +
    `RETRIEVED MATERIAL (from the uploaded file):\n\n${contextChunks}\n\n` +
    'Return ONLY this JSON shape (no markdown, no commentary):\n' +
    '{"cards":[{"type":"overview|key-concepts|timeline|deep-dive|summary",' +
    '"category":"short label (1-4 words)",' +
    '"displayNumber":"REQUIRED: a real stat/year from the material (never a counter)",' +
    '"heading":"3-6 word title",' +
    '"headingHighlight":"1-2 word highlight ending",' +
    '"description":"2-3 sentences explaining the main idea",' +
    '"events":[{"date":"short","title":"name","description":"1 sentence","important":true}],' +
    '"bigEvent":{"label":"CAPS","title":"heading","body":"para"},' +
    '"visualNumber":{"value":"num","label":"caption"},' +
    '"takeaway":{"label":"CAPS","text":"summary"}}]}\n' +
    'Rules:\n' +
    '- Each card MUST cover DIFFERENT content — do not repeat facts across cards\n' +
    '- ALWAYS include 2-5 events on EVERY card, ordered chronologically\n' +
    '- heading + headingHighlight ALWAYS required; mark 1-2 events important=true\n' +
    '- ALWAYS include exactly ONE of bigEvent OR visualNumber OR takeaway per card\n' +
    '- For "summary" type, always include a takeaway with the main lesson';

  const raw = await chatComplete(
    [
      { role: 'system', content: sysMsg },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0.5, maxTokens: 3000 }
  );

  const parsed = extractJson<{
    cards: Array<{
      type: string;
      category?: string;
      displayNumber?: string;
      heading?: string;
      headingHighlight?: string;
      description?: string;
      events?: Array<{ date: string; title: string; description: string; important?: boolean }>;
      bigEvent?: { label: string; title: string; body: string } | null;
      visualNumber?: { value: string; label: string } | null;
      takeaway?: { label: string; text: string } | null;
    }>;
  }>(raw);

  if (!parsed.cards || !Array.isArray(parsed.cards)) return [];

  const supplementaryCards: ContentCard[] = parsed.cards.map((card, i) => {
    const template = templates[i] || SUPPLEMENTARY_TEMPLATES[0];
    const fullHeading = joinHeading(card.heading, card.headingHighlight, template.heading);

    return {
      id: `${source}#card_${String(existingCount + i).padStart(3, '0')}`,
      source,
      format: 'carousel',
      name: fullHeading,
      description: card.description || `${template.icon} ${template.heading}`,
      keyPoints: [],
      quiz: [],
      supplementary: true,
      category: card.category || template.label,
      displayNumber: card.displayNumber,
      heading: card.heading,
      headingHighlight: card.headingHighlight,
      events: (card.events ?? []).slice(0, 5).map((e) => ({
        date: e.date ?? '',
        title: e.title ?? '',
        description: e.description ?? '',
        important: e.important ?? false,
      })),
      bigEvent: card.bigEvent ?? undefined,
      visualNumber: card.visualNumber ?? undefined,
      takeaway: card.takeaway ?? undefined,
      generatedAt: new Date().toISOString(),
    };
  });

  console.log(`[cards] generated ${supplementaryCards.length} supplementary cards for ${source}`);
  return supplementaryCards;
}

/**
 * Full card pipeline for one uploaded file:
 *   vector-store docs → topic detection → one card per topic/subtopic → save.
 * Cards are generated sequentially (free-tier rate limits) and saved
 * incrementally, so partial results survive an interruption.
 * @returns the number of cards generated
 */
export async function generateCardsForSource(
  source: string,
  depth: number = config.cardsDepth,
  format: 'post' | 'carousel' = 'post'
): Promise<number> {
  const docs = getDocsBySource(source);
  if (docs.length === 0) throw new Error(`No indexed content found for "${source}"`);
  if (!hasLlmKey()) throw new Error('OPENROUTER_API_KEY is not set — cannot generate cards');

  console.log(`[cards] detecting topics for ${source} (${docs.length} chunks)…`);
  // One retry: free-tier models occasionally return a truncated (non-JSON)
  // response when many chunks are in play.
  let topics: TopicSpec[];
  try {
    topics = await detectTopics(docs);
  } catch (err) {
    console.warn('[cards] topic detection failed, retrying once:', (err as Error).message);
    topics = await detectTopics(docs);
  }
  if (topics.length === 0) {
    console.warn('[cards] topic detection returned nothing, retrying once…');
    topics = await detectTopics(docs);
  }
  // Anti-collapse: a file with many chunks is never ONE topic. If the free
  // router grouped everything into a single topic, ask again more firmly.
  if (topics.length === 1 && docs.length >= 12) {
    console.warn('[cards] only 1 topic for a large file — re-detecting…');
    topics = await detectTopics(docs);
  }
  if (topics.length === 0) throw new Error('Topic detection returned no topics');
  await assignChunksToTopics(docs, topics);
  const assigned = topics.reduce((n, t) => n + t.chunkIds.length, 0);
  console.log(`[cards] detected ${topics.length} topics; ${assigned}/${docs.length} chunks assigned`);

  // Step 1c — per-topic subtopic detection (LLM, one call per topic with
  // enough chunks). Keeps output small: only this topic's chunks.
  for (const topic of topics) {
    if (topic.chunkIds.length >= 3) {
      const subChunks = topic.chunkIds
        .map((id) => docs.find((d) => d.id === id))
        .filter((d): d is NonNullable<typeof d> => !!d);
      try {
        const subIndex = subChunks
          .map((d) => `- ${d.text.slice(0, 120).replace(/\s+/g, ' ')}…`)
          .slice(0, 30)
          .join('\n');
        const raw = await chatComplete(
          [
            {
              role: 'system',
              content:
                'You are a curriculum analyzer. You split a topic into subtopics. ' +
                'Respond with ONLY valid JSON, no markdown, no commentary.',
            },
            {
              role: 'user',
              content:
                `Topic: ${topic.name}\n\nIts text snippets:\n\n${subIndex}\n\n` +
                'Split this topic into 3-8 subtopics. Rules:\n' +
                '- Names are short; descriptions are ONE sentence.\n' +
                '- Be thorough — cover ALL parts of the topic.\n' +
                '- Do NOT include chunk ids.\n' +
                'Return ONLY this JSON shape:\n' +
                '{"subtopics":[{"name":"...","description":"..."}]}',
            },
          ],
          { temperature: 0.2, maxTokens: 1200 }
        );
        const parsed = extractJson<{ subtopics: Array<{ name: string; description: string }> }>(raw);
        topic.subtopics = (parsed.subtopics ?? [])
          .filter((s) => s.name)
          .map((s) => ({ name: s.name, description: s.description ?? '', chunkIds: [] }));
      } catch (err) {
        console.warn(`[cards] subtopic detection failed for "${topic.name}":`, (err as Error).message);
      }
    }
    // Assign each of the topic's chunks to its nearest subtopic (local
    // embeddings) so subtopic cards are grounded in the right material.
    if ((topic.subtopics?.length ?? 0) > 0) {
      await assignChunksToTopics(
        topic.chunkIds
          .map((id) => docs.find((d) => d.id === id))
          .filter((d): d is NonNullable<typeof d> => !!d),
        (topic.subtopics ?? []) as TopicSpec[]
      );
    }
  }

  const cards: ContentCard[] = [];

  /**
   * Generate cards for one topic/subtopic.
   * Whole-chapter mode (depth 2): when a section covers more chunks than
   * one card should, it becomes MULTIPLE ordered cards — each window of
   * chunks is RAG-retrieved and turned into its own card labelled " (n/N)".
   * Depth 1 keeps one card per topic/subtopic (original behavior).
   */
  async function generateCardSet(
    label: string,
    anchor: string,
    description: string,
    parentTopic: string | undefined,
    ids: string[],
    depth: number
  ): Promise<void> {
    if (ids.length === 0) return;
    const sortedIds = [...ids].sort((a, b) => chunkSeq(a) - chunkSeq(b));

        const makeOne = async (cardLabel: string, windowIds: string[]): Promise<void> => {
      const context = await retrieveTopicContext(source, anchor, windowIds);
      if (context.length === 0) return;
      try {
        console.log(`[cards] RAG-retrieved ${context.length} chunks → card: ${cardLabel} (${format})`);
        if (format === 'carousel') {
          cards.push(await generateCarouselCard(source, cardLabel, anchor, description, parentTopic, context, cards.length));
        } else {
          cards.push(await generateOneCard(source, cardLabel, anchor, description, parentTopic, context, cards.length));
        }
        persistCards(source, cards);
      } catch (err) {
        console.error(`[cards] card "${cardLabel}" failed, continuing:`, (err as Error).message);
      }
    };

    if (depth >= 2 && sortedIds.length > config.chunksPerCard) {
      const windows = windowChunks(sortedIds, config.chunksPerCard);
      for (let w = 0; w < windows.length; w += 1) {
        await makeOne(`${label} (${w + 1}/${windows.length})`, windows[w]);
      }
    } else {
      await makeOne(label, sortedIds);
    }
  }

  for (const topic of topics) {
    const topicAnchor = `${topic.name}: ${topic.description}`;
    await generateCardSet(topic.name, topicAnchor, topic.description, undefined, topic.chunkIds, depth);

    for (const sub of topic.subtopics ?? []) {
      // Anchor the subtopic to its topic name too, so retrieval finds chunks
      // even when the subtopic grouped very few chunks on its own.
      const subAnchor = `${topic.name} — ${sub.name}: ${sub.description}`;
      await generateCardSet(sub.name, subAnchor, sub.description, topic.name, sub.chunkIds, depth);
    }
  }

  // Supplementary cards: when topic generation produces fewer than
  // MIN_CAROUSEL_CARDS, the LLM creates additional cards (Overview,
  // Key Concepts, Timeline, etc.) to fill out the carousel.
  if (format === 'carousel' && cards.length > 0 && cards.length < MIN_CAROUSEL_CARDS) {
    const supplementary = await generateSupplementaryCards(source, cards, format);
    if (supplementary.length > 0) {
      cards.push(...supplementary);
      persistCards(source, cards);
    }
  }

  // Post-process: set cardTotal on carousel cards so the UI can show "n / N"
  if (format === 'carousel' && cards.length > 0) {
    cards.forEach((c) => { c.cardTotal = cards.length; });
  }
  persistCards(source, cards);
  console.log(`[cards] done — ${cards.length} cards for ${source} (${format})`);
  return cards.length;
}

/** Replace the stored card set for one source (called after each card lands). */
function persistCards(source: string, cards: ContentCard[]): void {
  const all = loadAll();
  all[source] = { generatedAt: new Date().toISOString(), cards };
  persist(all);
}

/** Get generated cards, optionally for one source file. */
export function getCards(source?: string): ContentCard[] {
  const all = loadAll();
  if (source) return all[source]?.cards ?? [];
  return Object.values(all)
    .flatMap((entry) => entry.cards)
    .sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

