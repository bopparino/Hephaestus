import type { Config } from './config.js';
import { getDb } from './db.js';

// Local embeddings, GlasHaus doctrine: best-effort everywhere. If the model
// is missing or slow, every caller falls back and retrieval still works on
// its other signals — the vector branch contributes 0, never an error.

let cfg: Config | null = null;
export function initEmbeddings(config: Config): void {
  cfg = config;
}

function embedModel(): string {
  const spec = cfg?.models.embed ?? 'ollama/nomic-embed-text';
  return spec.startsWith('ollama/') ? spec.slice(7) : spec;
}

export async function embed(text: string, timeoutMs = 3000): Promise<Buffer | null> {
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.providers.ollama.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel(), input: text.slice(0, 8000), keep_alive: '24h' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    const vec = data.embeddings?.[0];
    return vec ? Buffer.from(new Float32Array(vec).buffer) : null;
  } catch {
    return null;
  }
}

export function cosine(a: Buffer | null, b: Buffer | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Nightly: fill embeddings for rows that lack one. Stops on first failure —
 *  model not up; try again next pass. */
export async function backfillEmbeddings(batch = 20): Promise<number> {
  const db = getDb();
  const rows = [
    ...(db.prepare("SELECT id, content AS text, 'facts' AS tbl FROM facts WHERE embedding IS NULL AND active = 1 LIMIT ?").all(batch) as { id: number; text: string; tbl: string }[]),
    ...(db.prepare("SELECT id, summary AS text, 'episodes' AS tbl FROM episodes WHERE embedding IS NULL LIMIT ?").all(batch) as { id: number; text: string; tbl: string }[]),
  ];
  let done = 0;
  for (const row of rows) {
    const vec = await embed(row.text, 15000);
    if (!vec) break;
    db.prepare(`UPDATE ${row.tbl} SET embedding = ? WHERE id = ?`).run(vec, row.id);
    done++;
  }
  return done;
}
