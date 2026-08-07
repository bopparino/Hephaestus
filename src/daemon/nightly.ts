import { copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from './config.js';
import { getDb, receipt } from './db.js';
import { backfillEmbeddings } from './embeddings.js';
import { foldBacklog } from './folding.js';
import type { Providers } from '../providers/roles.js';
import { paths } from './paths.js';
import { runDreamPass } from './dream.js';

// The secular dream slot: consolidation, folding backlog, embedding
// backfill, backup-with-integrity-check. Everything soft, everything
// capped, everything receipted.

const NIGHTLY_CAP = 20; // consolidation ops per night — gentle, like the parent

function consolidate(): { merged: number; decayed: number } {
  const db = getDb();
  let merged = 0;
  let decayed = 0;

  // Merge exact duplicates within a scope: keep the oldest row, carry the
  // highest importance, soft-delete the rest.
  const dupes = db.prepare(`
    SELECT lower(content) AS key, scope, COUNT(*) AS n, MIN(id) AS keep, MAX(importance) AS imp
    FROM facts WHERE active = 1 GROUP BY key, scope HAVING n > 1 LIMIT ?
  `).all(NIGHTLY_CAP) as { key: string; scope: string; keep: number; imp: number }[];
  for (const d of dupes) {
    db.prepare("UPDATE facts SET importance = ?, updated_at = datetime('now') WHERE id = ?").run(d.imp, d.keep);
    merged += db.prepare(
      "UPDATE facts SET active = 0, updated_at = datetime('now') WHERE active = 1 AND scope = ? AND lower(content) = ? AND id != ?",
    ).run(d.scope, d.key, d.keep).changes;
  }

  // Decay stale trivia — low importance, low salience, untouched for a month.
  // Soft-delete: reversible, like everything else.
  decayed = db.prepare(`
    UPDATE facts SET active = 0, updated_at = datetime('now')
    WHERE id IN (
      SELECT id FROM facts
      WHERE active = 1 AND core = 0 AND importance <= 3 AND COALESCE(salience, 0.5) < 0.4
      AND updated_at < datetime('now', '-30 days')
      LIMIT ?
    )
  `).run(Math.max(0, NIGHTLY_CAP - merged)).changes;

  return { merged, decayed };
}

function backup(): { file: string; ok: boolean } {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const dest = join(paths.home, 'backups', `core-${stamp}.db`);
  // WAL checkpoint first so the copy is complete, then verify the COPY —
  // a backup you haven't integrity-checked is a hope, not a backup.
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  copyFileSync(paths.db, dest);
  let ok = false;
  try {
    const check = new Database(dest, { readonly: true });
    ok = (check.pragma('integrity_check', { simple: true }) as string) === 'ok';
    check.close();
    // Opening a WAL-mode copy leaves sidecars; the backup is the .db alone.
    for (const side of [`${dest}-wal`, `${dest}-shm`]) {
      try { unlinkSync(side); } catch { /* absent */ }
    }
  } catch { /* ok stays false */ }
  // Keep the last 7 — name-sorted is date-sorted.
  const all = readdirSync(join(paths.home, 'backups')).filter(f => /^core-\d{8}\.db$/.test(f)).sort();
  for (const old of all.slice(0, -7)) unlinkSync(join(paths.home, 'backups', old));
  return { file: dest, ok };
}

export async function runNightly(cfg: Config, providers: Providers): Promise<Record<string, unknown>> {
  const db = getDb();
  const sessions = db.prepare('SELECT DISTINCT session_id FROM messages WHERE summarized = 0').all() as { session_id: number }[];
  let episodes = 0;
  for (const s of sessions) {
    try {
      episodes += await foldBacklog(cfg, providers, s.session_id);
    } catch (err) {
      console.error(`[nightly] folding session ${s.session_id}:`, err);
    }
  }
  const { merged, decayed } = consolidate();
  const embedded = await backfillEmbeddings();

  // ---- Dream pass: the soul feels at night ----
  let dreamResult: unknown = null;
  try {
    dreamResult = await runDreamPass(cfg, providers);
  } catch (err) {
    console.error('[nightly] dream pass failed:', err);
  }

  const bak = backup();
  const summary = { episodes, merged, decayed, embedded, dream: dreamResult, backup: bak.file, backupOk: bak.ok };
  receipt('nightly', summary);
  db.prepare("INSERT INTO meta (key, value) VALUES ('nightly_last', date('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  return summary;
}

/** Call every ~30 min; runs once per day in the small hours (or when overdue). */
export function nightlyDue(): boolean {
  const hour = new Date().getHours();
  if (hour < 3 || hour >= 5) return false;
  const row = getDb().prepare("SELECT value FROM meta WHERE key = 'nightly_last'").get() as { value: string } | undefined;
  const today = new Date().toISOString().slice(0, 10);
  return row?.value !== today;
}
