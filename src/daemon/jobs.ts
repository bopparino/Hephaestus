import { getDb, receipt } from './db.js';

// The heartbeat — schedule math and job CRUD (GAPS §1). The ticker lives in
// server.ts where the exchange machinery is; this module is pure bookkeeping.
//
// Three schedule forms, no cron syntax (blueprint lesson from Hermes: humans
// never type raw cron):
//   "every 15m" | "every 2h" | "every 1d"
//   "daily@09:00"            (local time)
//   "once@2026-08-05T09:00"  (local ISO, fires once then disables)
//
// Claiming advances next_run BEFORE the run starts — a crashed run is a
// missed delivery, never a double-fire (the one-shot claim lesson).

export interface Job {
  id: number;
  name: string;
  schedule: string;
  prompt: string;
  automaton: string;
  project: string | null;
  enabled: number;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
}

export function computeNext(schedule: string, from: Date): Date | null {
  const every = schedule.match(/^every\s+(\d+)([mhd])$/i);
  if (every) {
    const n = Number(every[1]);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[every[2].toLowerCase() as 'm' | 'h' | 'd'];
    if (n < 1) return null;
    return new Date(from.getTime() + n * unitMs);
  }
  const daily = schedule.match(/^daily@(\d{2}):(\d{2})$/);
  if (daily) {
    const next = new Date(from);
    next.setHours(Number(daily[1]), Number(daily[2]), 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  const once = schedule.match(/^once@(.+)$/);
  if (once) {
    const at = new Date(once[1]);
    if (Number.isNaN(at.getTime())) return null;
    return at > from ? at : null; // a past one-shot never fires
  }
  return null;
}

export function validSchedule(schedule: string): boolean {
  return computeNext(schedule, new Date()) !== null || /^once@/.test(schedule);
}

export function addJob(input: {
  name: string; schedule: string; prompt: string;
  automaton?: string; project?: string | null;
}): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.name)) throw new Error('job name must be kebab-case');
  const next = computeNext(input.schedule, new Date());
  if (!next) throw new Error(`unparseable or already-past schedule: "${input.schedule}" (every 15m | daily@09:00 | once@2026-01-01T09:00)`);
  getDb().prepare(`
    INSERT INTO jobs (name, schedule, prompt, automaton, project, next_run)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      schedule = excluded.schedule, prompt = excluded.prompt,
      automaton = excluded.automaton, project = excluded.project,
      next_run = excluded.next_run, enabled = 1
  `).run(input.name, input.schedule, input.prompt,
    input.automaton === 'dev' ? 'dev' : 'chat', input.project ?? null, next.toISOString());
  receipt('job_add', { name: input.name, schedule: input.schedule });
}

export function listJobs(): Job[] {
  return getDb().prepare('SELECT * FROM jobs WHERE enabled = 1 ORDER BY next_run').all() as Job[];
}

export function getJob(name: string): Job | undefined {
  return getDb().prepare('SELECT * FROM jobs WHERE name = ?').get(name) as Job | undefined;
}

export function removeJob(name: string): void {
  getDb().prepare('UPDATE jobs SET enabled = 0 WHERE name = ?').run(name);
  receipt('job_remove', { name });
}

/** Due jobs, claimed: next_run advances (or the job disables, for one-shots)
 *  before any run starts. Crash → missed delivery, never double-fire. */
export function claimDue(now = new Date()): Job[] {
  const db = getDb();
  const due = db.prepare(
    'SELECT * FROM jobs WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?',
  ).all(now.toISOString()) as Job[];
  for (const job of due) {
    const next = /^once@/.test(job.schedule) ? null : computeNext(job.schedule, now);
    if (next) {
      db.prepare('UPDATE jobs SET next_run = ? WHERE id = ?').run(next.toISOString(), job.id);
    } else {
      db.prepare('UPDATE jobs SET next_run = NULL, enabled = 0 WHERE id = ?').run(job.id);
    }
  }
  return due;
}

export function recordRun(name: string, outcome: { silent: boolean; delivered: boolean; error?: string }): void {
  getDb().prepare("UPDATE jobs SET last_run = datetime('now'), last_result = ? WHERE name = ?")
    .run(outcome.error ? `error: ${outcome.error.slice(0, 200)}` : outcome.silent ? 'silent' : outcome.delivered ? 'delivered' : 'stored', name);
  receipt('job_run', { name, ...outcome });
}
