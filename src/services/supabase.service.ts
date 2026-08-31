/**
 * Supabase data layer (OPTIONAL backend).
 *
 * When config.supabase.enabled is true (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are present in .env), the vector store and the content cards are persisted to
 * a Supabase project instead of the local JSON files. The package
 * @supabase/supabase-js is loaded lazily via a dynamic import, so the
 * dependency is only required at runtime when Supabase is actually in use.
 *
 * Tables (see the SQL in the README):
 *   cards      (id text pk, source, idx, generated_at, data jsonb)
 *   documents  (id text pk, source, text, vector jsonb, meta jsonb, indexed_at)
 *   uploads    (source text pk, type, status, stats jsonb, created_at)
 */
import { config } from '../config/index.js';
import type { ContentCard, VectorDoc } from '../types/ingest.js';
import type { SupabaseClient } from '@supabase/supabase-js';

interface CardRow {
  id: string;
  source: string;
  idx: number;
  generated_at: string;
  data: ContentCard;
}

interface DocRow {
  id: string;
  source: string;
  text: string;
  vector: number[];
  meta: Record<string, unknown>;
  indexed_at: string;
}

export interface SupabaseStatus {
  enabled: boolean;
  url?: string;
  tables: { cards: string; documents: string; uploads: string };
  ready: boolean;
}

let _clientPromise: Promise<SupabaseClient> | null = null;

/** true when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are both set. */
export function isSupabaseEnabled(): boolean {
  return config.supabase.enabled;
}

/**
 * Lazily create + cache the Supabase client. Only touches
 * @supabase/supabase-js when called, so the package is not required unless
 * Supabase is actually enabled.
 */
function getClient(): Promise<SupabaseClient> {
  if (!config.supabase.enabled) {
    throw new Error(
      'Supabase is not configured. Set supabase-project-id / supabase_project_id plus supabase-service-key / supabase_service_key in .env.'
    );
  }
  if (!_clientPromise) {
    _clientPromise = import('@supabase/supabase-js').then((mod) =>
      mod.createClient(config.supabase.url, config.supabase.serviceRoleKey)
    );
  }
  return _clientPromise;
}

/** Lightweight health/status for the frontend or /api/store route. */
export function getSupabaseStatus(): SupabaseStatus {
  const s = config.supabase;
  return {
    enabled: s.enabled,
    url: s.url || undefined,
    tables: s.tables,
    ready: _clientPromise !== null,
  };
}

/**
 * Load every card set, grouped by source (shape mirrors the local JSON file).
 * Returns an empty object when no cards exist yet.
 */
export async function loadAllCards(): Promise<Record<string, { generatedAt: string; cards: ContentCard[] }>> {
  const client = await getClient();
    const { data, error } = await client.from(config.supabase.tables.cards).select('id, source, idx, generated_at, data');
  if (error) throw new Error(`Supabase cards.read failed: ${error.message}`);
  const all: Record<string, { generatedAt: string; cards: ContentCard[] }> = {};
  const rows = (data as (CardRow & { idx?: number })[] | null) ?? [];
  for (const row of rows) {
    const set = all[row.source] || (all[row.source] = { generatedAt: row.generated_at ?? '', cards: [] });
    if (row.generated_at && row.generated_at > set.generatedAt) set.generatedAt = row.generated_at;
    set.cards.push(row.data);
  }
  // Re-sort each source's cards back into deck order (idx ascending).
  for (const set of Object.values(all)) {
    set.cards.sort((a, b) => (a.cardTotal ? 0 : 0)); // placeholder, real sort below
    set.cards.sort((a, b) => {
      const ai = parseInt(a.id.split('_').pop() || '0', 10);
      const bi = parseInt(b.id.split('_').pop() || '0', 10);
      return ai - bi;
    });
  }
  return all;
}

/** Replace (delete + insert) all cards for one source file. */
export async function replaceCardsForSource(source: string, cards: ContentCard[]): Promise<void> {
  const client = await getClient();
  const { tables } = config.supabase;
  const { error: delErr } = await client.from(tables.cards).delete().eq('source', source);
  if (delErr) throw new Error(`Supabase cards.delete failed: ${delErr.message}`);
  if (cards.length === 0) return;
  const rows: CardRow[] = cards.map((c, idx) => ({
    id: c.id,
    source,
    idx,
    generated_at: c.generatedAt,
    data: { ...c, cardTotal: cards.length },
  }));
    const { error: upErr } = await client.from(tables.cards).upsert(rows, { onConflict: 'id' });
  if (upErr) throw new Error(`Supabase cards.upsert failed: ${upErr.message}`);
}

// ------------------------------------------------------------- documents ----

/** Load every indexed chunk (used to hydrate the in-process vector cache). */
export async function loadAllDocuments(): Promise<VectorDoc[]> {
  const client = await getClient();
  const { data, error } = await client
    .from(config.supabase.tables.documents)
    .select('id, source, text, vector, meta, indexed_at');
  if (error) throw new Error(`Supabase docs.read failed: ${error.message}`);
  return (data as DocRow[] | null ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    text: r.text,
    meta: (r.meta ?? {}) as VectorDoc['meta'],
    vector: r.vector ?? [],
    indexedAt: r.indexed_at,
  }));
}

/** Replace all chunks for one source file (delete + insert). */
export async function replaceDocuments(source: string, docs: VectorDoc[]): Promise<number> {
  const client = await getClient();
  const { tables } = config.supabase;
  const { error: delErr } = await client.from(tables.documents).delete().eq('source', source);
  if (delErr) throw new Error(`Supabase docs.delete failed: ${delErr.message}`);
  if (docs.length === 0) return 0;
  const rows: DocRow[] = docs.map((d) => ({
    id: d.id,
    source,
    text: d.text,
    vector: d.vector ?? [],
    meta: d.meta as Record<string, unknown>,
    indexed_at: d.indexedAt,
  }));
  const { error: upErr } = await client.from(tables.documents).upsert(rows, { onConflict: 'id' });
  if (upErr) throw new Error(`Supabase docs.upsert failed: ${upErr.message}`);
  return rows.length;
}

/** Remove every indexed chunk for a source (and its vectors). */
export async function deleteDocumentsBySource(source: string): Promise<void> {
  const client = await getClient();
  const { error } = await client.from(config.supabase.tables.documents).delete().eq('source', source);
  if (error) throw new Error(`Supabase docs.delete failed: ${error.message}`);
}

/** Doc + source counts (used by the store status route). */
export async function documentsStats(): Promise<{ documents: number; sources: number; sourceNames: string[] }> {
  const client = await getClient();
  const { data, error } = await client.from(config.supabase.tables.documents).select('source');
  if (error) throw new Error(`Supabase stats failed: ${error.message}`);
  const rows = (data as Array<{ source: string }> | null) ?? [];
  const names = [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
  return { documents: rows.length, sources: names.length, sourceNames: names };
}

// ----------------------------------------------------------------- uploads --

/**
 * Record a successful ingest to the uploads table (best-effort; failures are
 * logged but never fail the ingest response).
 */
export async function upsertUpload(
  source: string,
  type: string,
  stats: Record<string, unknown>,
  status = 'ok'
): Promise<void> {
  const client = await getClient();
  const { error } = await client.from(config.supabase.tables.uploads).upsert(
    [{ source, type, status, stats, created_at: new Date().toISOString() }],
    { onConflict: 'source' }
  );
  if (error) console.error('[supabase] uploads.write failed:', error.message);
}

