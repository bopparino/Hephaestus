import type { Config } from './config.js';
import { getDb, receipt } from './db.js';
import { embed } from './embeddings.js';
import { utilityJson } from './utility.js';
import type { Providers } from '../providers/roles.js';

// Episode folding — the chronic, memory-serving half of context management
// (compaction, the acute task-serving half, arrives with the agent runtime).
// Messages beyond the recent window fold into dense third-person episodes
// that recall can surface months later. Rows are marked, never deleted.

export async function foldBacklog(cfg: Config, providers: Providers, sessionId: number): Promise<number> {
  const db = getDb();
  let folded = 0;
  for (;;) {
    const backlog = db.prepare(`
      SELECT id, role, content, created_at FROM messages
      WHERE session_id = ? AND summarized = 0 AND role IN ('user','assistant')
      AND id <= (SELECT COALESCE(MAX(id), 0) - ? FROM messages WHERE session_id = ?)
      ORDER BY id LIMIT ?
    `).all(sessionId, cfg.memory.recentWindow, sessionId, cfg.memory.foldChunk) as
      { id: number; role: string; content: string; created_at: string }[];
    if (backlog.length < cfg.memory.foldChunk) return folded;

    const name = cfg.user.name;
    const transcript = backlog
      .map(m => `[${m.created_at}] ${m.role === 'user' ? name : 'Hephaestus'}: ${m.content}`)
      .join('\n');

    const result = await utilityJson<{ summary?: string; salience?: number }>(providers, [
      {
        role: 'system',
        content: `You are the memory system for Hephaestus, ${name}'s AI workspace. Condense this conversation chunk into one dense episodic note in a neutral third-person notebook register ("${name} and Hephaestus worked on…"). Keep concrete details: names, decisions and their reasons, file paths, numbers, open questions. 100-250 words. Rate salience 0-1 (0.1 = routine, 0.9 = decisions that shape the work for months).

Respond as JSON: {"summary": "...", "salience": 0.5}`,
      },
      { role: 'user', content: transcript },
    ], 1200);

    if (!result?.summary?.trim()) {
      console.error('[folding] model returned nothing usable; leaving chunk for next pass');
      return folded;
    }

    const vec = await embed(result.summary);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO episodes (session_id, started_at, ended_at, summary, salience, first_message_id, last_message_id, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, backlog[0].created_at, backlog.at(-1)!.created_at, result.summary!.trim(),
        result.salience ?? null, backlog[0].id, backlog.at(-1)!.id, vec);
      db.prepare('UPDATE messages SET summarized = 1 WHERE session_id = ? AND id BETWEEN ? AND ?')
        .run(sessionId, backlog[0].id, backlog.at(-1)!.id);
    })();
    folded++;
    receipt('memory_fold', { sessionId, messages: backlog.length }, sessionId);
  }
}

/** Cheap check for the post-exchange hook — count before any model call. */
export function foldPending(cfg: Config, sessionId: number): boolean {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE session_id = ? AND summarized = 0 AND role IN ('user','assistant')
    AND id <= (SELECT COALESCE(MAX(id), 0) - ? FROM messages WHERE session_id = ?)
  `).get(sessionId, cfg.memory.recentWindow, sessionId) as { n: number };
  return row.n >= cfg.memory.foldChunk;
}
