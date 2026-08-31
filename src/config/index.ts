/**
 * Typed configuration for the Eklavya ingestion backend.
 */
import path from 'node:path';
import fs from 'node:fs';

// Project root — this file lives in <root>/src/config or <root>/dist/config,
// so going up TWO levels is correct in both dev (tsx) and compiled modes.
const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

/**
 * Minimal .env loader (dependency-free). Loads KEY=VALUE pairs from .env at
 * the project root into process.env without overriding existing values.
 * Must run BEFORE the env-dependent config below is evaluated.
 */
const ENV_FILE = path.join(ROOT_DIR, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    // Hyphens are allowed in key names too (e.g. "supabase-project-id=...")
    // so the .env keys the user pasted survive even though they aren't valid
    // shell identifiers.
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}


export const config = {
  /** Where uploaded files are staged before processing */
  uploadDir: path.join(ROOT_DIR, 'uploads'),
  rootDir: ROOT_DIR,

  // ---- PDF pipeline ----
  /**
   * A page is considered "scanned" if MuPDF finds fewer than this many
   * alphanumeric characters on it -> fall back to OCR for that page only.
   */
  ocrMinCharsPerPage: 30,
  ocrLang: 'eng',
  /** Render scale for page -> image rasterization before OCR (3x ≈ 216 dpi) */
  pdfRenderScale: 3,

  // ---- Video pipeline ----
  whisperModel: process.env.WHISPER_MODEL || 'base.en',
  whisperModelRoot: process.env.WHISPER_MODEL_ROOT || undefined,
  /** ffmpeg extracts 16 kHz mono PCM — exactly what whisper.cpp expects */
  audioSampleRate: 16000,

  // ---- Reels (video → 9:16 vertical clips with burned-in captions) ----
  /** Rendered reels land here: data/reels/<safeSource>/reel_N.mp4 */
  reelsDir: path.join(ROOT_DIR, 'data', 'reels'),
  /** Reels rendered per video */
  reelCount: Number(process.env.REEL_COUNT) || 5,
  /** Maximum clip length per reel (seconds) */
  reelMaxSec: Number(process.env.REEL_MAX_SEC) || 30,
  /** Output canvas (TikTok/Reels/Shorts vertical format) */
  reelWidth: Number(process.env.REEL_WIDTH) || 1080,
  reelHeight: Number(process.env.REEL_HEIGHT) || 1920,

  // ---- Chunking (shared by both pipelines) ----
  chunkMaxChars: 1200,
  chunkOverlapChars: 150,

  // ---- AI Content Engine (post cards) ----
  /**
   * Coverage depth for card generation:
   *   1 = one card per topic + one per subtopic
   *   2 = "whole chapter": big topics/sections are split into multiple
   *       ordered cards (chunk windows), so every part of a chapter is a card.
   */
  cardsDepth: Number(process.env.CARDS_DEPTH) || 2,
  /** Chunks covered by one card in whole-chapter mode (depth 2) */
  chunksPerCard: Number(process.env.CHUNKS_PER_CARD) || 4,

  // ---- RAG / knowledge layer ----
  /** Local embedding model (ONNX via @huggingface/transformers, CPU) */
  embeddingModel: process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  /** JSON-persisted vector store (swap for pgvector/Qdrant later) */
  vectorStorePath: path.join(ROOT_DIR, 'data', 'vector-store.json'),
  /** Chunks retrieved per question */
  ragTopK: Number(process.env.RAG_TOP_K) || 5,

  // ---- LLM (OpenRouter — chat only, embeddings stay local) ----
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',

  // ---- Supabase (auth + optional data layer) ----
  // Reads BOTH the hyphenated names used in .env (supabase-project-id) and
  // the underscore aliases (supabase_project_id); the hyphenated ones win.
  supabase: {
    enabled: !!(process.env['supabase-project-id'] || process.env.supabase_project_id) &&
             !!(process.env['supabase-service-key'] || process.env.supabase_service_key),
    url: process.env['supabase-project-id'] || process.env.supabase_project_id || '',
    anonKey: process.env['supabase-anon-key'] || process.env.supabase_anon_key || '',
    serviceRoleKey: process.env['supabase-service-key'] || process.env.supabase_service_key || '',
    tables: {
      cards: process.env.SUPABASE_TABLE_CARDS || 'cards',
      documents: process.env.SUPABASE_TABLE_DOCUMENTS || 'documents',
      uploads: process.env.SUPABASE_TABLE_UPLOADS || 'uploads',
    },
  },

  // ---- Server ----
  port: Number(process.env.PORT) || 3000,
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 500,
} as const;

// Ensure the upload staging + data directories exist
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}
fs.mkdirSync(path.dirname(config.vectorStorePath), { recursive: true });
fs.mkdirSync(config.reelsDir, { recursive: true });


export const ALLOWED_PDF_EXTENSIONS = ['.pdf'] as const;

export const ALLOWED_MEDIA_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac',
] as const;

export type MediaType = (typeof ALLOWED_MEDIA_EXTENSIONS)[number];