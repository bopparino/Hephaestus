import { getDb } from './db.js';

// Tier 3 — total recall. FTS5 over every transcript forever, results shaped
// as bookended windows (Hermes' trick): opening messages carry the goal,
// the hit window carries the match, closing messages carry the resolution —
// one hit reconstructs a session without paying for its transcript.

interface MessageRow {
  id: number;
  session_id: number;
  role: string;
  content: string;
  created_at: string;
}

export interface SearchHit {
  sessionId: number;
  title: string | null;
  matchId: number;
  opening: MessageRow[];
  window: MessageRow[];
  closing: MessageRow[];
}

/** Preserve balanced quoted phrases; strip FTS5 operators; quote dotted and
 *  hyphenated terms so \`my-app.config.ts\` doesn't explode into implicit ANDs.
 *  OR by default — multi-word queries should widen, not silently narrow. */
export function sanitizeFtsQuery(input: string): string | null {
  const phrases: string[] = [];
  let rest = input;
  rest = rest.replace(/"([^"]*)"/g, (_, p) => {
    if (p.trim()) phrases.push(`"${p.trim().replaceAll('"', '')}"`);
    return ' ';
  });
  const terms = (rest.match(/[^\s]+/g) ?? [])
    .map(t => t.replace(/[():^*]/g, ''))
    .filter(t => t && !/^(AND|OR|NOT|NEAR)$/i.test(t))
    .map(t => (/[.-]/.test(t) ? `"${t}"` : t.replace(/[^\w']/g, '')))
    .filter(Boolean);
  const parts = [...phrases, ...terms].slice(0, 12);
  return parts.length ? parts.join(' OR ') : null;
}

/** Opening + closing bookends of one session — the cheap way to hand a
 *  referenced conversation to the model without paying for its transcript. */
export function sessionBookends(sessionId: number): { title: string | null; opening: MessageRow[]; closing: MessageRow[] } {
  const db = getDb();
  const session = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined;
  const opening = db.prepare(
    "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id LIMIT 3",
  ).all(sessionId) as MessageRow[];
  const closing = (db.prepare(
    "SELECT * FROM (SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 3) ORDER BY id",
  ).all(sessionId) as MessageRow[]).filter(m => !opening.some(o => o.id === m.id));
  return { title: session?.title ?? null, opening, closing };
}

export function searchMessages(query: string, limit = 5): SearchHit[] {
  const db = getDb();
  const q = sanitizeFtsQuery(query);
  if (!q) return [];

  let hits: { id: number; session_id: number }[];
  try {
    hits = db.prepare(`
      SELECT m.id, m.session_id
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY bm25(messages_fts) LIMIT ?
    `).all(q, limit * 3) as { id: number; session_id: number }[];
  } catch {
    return [];
  }

  // One hit per session — the best-ranked one.
  const seen = new Set<number>();
  const results: SearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.session_id) || results.length >= limit) continue;
    seen.add(hit.session_id);
    const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as MessageRow[];
    const session = db.prepare('SELECT title FROM sessions WHERE id = ?').get(hit.session_id) as { title: string | null } | undefined;
    const opening = rows(
      "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id LIMIT 3",
      hit.session_id,
    );
    const window = rows(
      "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? AND id BETWEEN ? AND ? AND role IN ('user','assistant') ORDER BY id",
      hit.session_id, hit.id - 5, hit.id + 5,
    );
    const closing = rows(
      "SELECT * FROM (SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 3) ORDER BY id",
      hit.session_id,
    );
    // Dedupe: drop bookend rows the window already covers.
    const windowIds = new Set(window.map(m => m.id));
    results.push({
      sessionId: hit.session_id,
      title: session?.title ?? null,
      matchId: hit.id,
      opening: opening.filter(m => !windowIds.has(m.id)),
      window,
      closing: closing.filter(m => !windowIds.has(m.id) && !opening.some(o => o.id === m.id)),
    });
  }
  return results;
}
