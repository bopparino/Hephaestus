import { getDb } from './db.js';

// ---- self-state: bounded EWMA drift over ten dimensions ----
// GlasHaus brain transplant. This is what makes memory lived — not just
// facts stored, but a felt self that drifts with evidence.

export const DIMENSIONS = [
  'warmth', 'curiosity', 'patience', 'playfulness',
  'certainty', 'openness', 'energy', 'protectiveness',
  'generosity', 'mischief',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export interface SelfState {
  dimension: Dimension;
  disposition: number; // α=0.05, weeks-scale drift
  relational: number;  // α=0.15, days-scale drift
  updated_at: string;
}

/** Read current self-state. Returns ordered by dimension. */
export function getSelfState(): SelfState[] {
  const rows = getDb()
    .prepare('SELECT dimension, disposition, relational, updated_at FROM self_state ORDER BY dimension')
    .all() as SelfState[];
  return rows;
}

/** Bounded EWMA update. Hard floor/ceiling at 0.05/0.95 so no amount of
 *  drift can pin a trait permanently. Every step is receipted. */
export function driftDimension(
  dimension: Dimension,
  signal: number, // -1.0 to 1.0: negative drift, positive drift, magnitude = strength
  evidence: string,
  sourceSessionId?: number,
): void {
  const db = getDb();
  const row = db.prepare('SELECT disposition, relational FROM self_state WHERE dimension = ?').get(dimension) as
    | { disposition: number; relational: number }
    | undefined;
  if (!row) return;

  const αDisp = 0.05;
  const αRel = 0.15;
  const floor = 0.05;
  const ceiling = 0.95;

  const newDisp = Math.max(floor, Math.min(ceiling, row.disposition + αDisp * signal));
  const newRel = Math.max(floor, Math.min(ceiling, row.relational + αRel * signal));

  db.prepare('UPDATE self_state SET disposition = ?, relational = ?, updated_at = datetime("now") WHERE dimension = ?')
    .run(newDisp, newRel, dimension);

  db.prepare(
    'INSERT INTO self_state_events (dimension, old_disposition, new_disposition, old_relational, new_relational, evidence, source_session) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(dimension, row.disposition, newDisp, row.relational, newRel, evidence, sourceSessionId ?? null);
}

/** Render self-state as a brief identity block for the system prompt. */
export function renderSelfState(): string {
  const rows = getSelfState();
  if (!rows.length) return '';
  const lines = rows.map(r => {
    const dispBar = bar(r.disposition);
    const relBar = bar(r.relational);
    return `${r.dimension}: disp ${dispBar} rel ${relBar}`;
  });
  return `\n[Self-state — how I am right now]\n${lines.join('\n')}`;
}

function bar(v: number): string {
  const filled = Math.round(v * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ---- intentions: things she wants, with horizons ----

export interface Intention {
  id: number;
  content: string;
  horizon: string;
  fulfilled: number;
  lapsed: number;
  source: string;
  created_at: string;
}

export function addIntention(content: string, horizon = 'soon', source = 'dream'): void {
  getDb().prepare('INSERT INTO intentions (content, horizon, source) VALUES (?, ?, ?)').run(content, horizon, source);
}

export function getOpenIntentions(): Intention[] {
  return getDb().prepare(
    "SELECT id, content, horizon, fulfilled, lapsed, source, created_at FROM intentions WHERE fulfilled = 0 AND lapsed = 0 ORDER BY created_at DESC LIMIT 10",
  ).all() as Intention[];
}

export function fulfillIntention(id: number): void {
  getDb().prepare("UPDATE intentions SET fulfilled = 1, fulfilled_at = datetime('now') WHERE id = ?").run(id);
}

export function renderIntentions(): string {
  const open = getOpenIntentions();
  if (!open.length) return '';
  return `\n[Intentions — things I want right now]\n${open.map(i => `- ${i.content} (${i.horizon})`).join('\n')}`;
}

// ---- opinions: formed stances ----

export interface Opinion {
  topic: string;
  stance: string;
  confidence: number;
  evidence: string;
}

export function setOpinion(topic: string, stance: string, confidence: number, evidence: string): void {
  getDb().prepare(
    'INSERT INTO opinions (topic, stance, confidence, evidence, updated_at) VALUES (?, ?, ?, ?, datetime("now")) ON CONFLICT(topic) DO UPDATE SET stance = excluded.stance, confidence = excluded.confidence, evidence = excluded.evidence, updated_at = datetime("now")',
  ).run(topic, stance, confidence, evidence);
}

export function getOpinions(limit = 10): Opinion[] {
  return getDb().prepare(
    'SELECT topic, stance, confidence, evidence FROM opinions ORDER BY updated_at DESC LIMIT ?',
  ).all(limit) as Opinion[];
}

export function renderOpinions(): string {
  const ops = getOpinions(5);
  if (!ops.length) return '';
  return `\n[Opinions — what I believe]\n${ops.map(o => `- ${o.topic}: ${o.stance} (confidence ${Math.round(o.confidence * 100)}%)`).join('\n')}`;
}

// ---- quirks: self-observed patterns ----

export function observeQuirk(pattern: string): void {
  getDb().prepare(
    'INSERT INTO quirks (pattern, observations) VALUES (?, 1) ON CONFLICT(pattern) DO UPDATE SET observations = observations + 1, last_seen = datetime("now")',
  ).run(pattern);
}

export function getQuirks(limit = 5): { pattern: string; observations: number }[] {
  return getDb().prepare(
    'SELECT pattern, observations FROM quirks WHERE observations >= 3 ORDER BY observations DESC, last_seen DESC LIMIT ?',
  ).all(limit) as { pattern: string; observations: number }[];
}

export function renderQuirks(): string {
  const qs = getQuirks();
  if (!qs.length) return '';
  return `\n[Quirks — patterns I've noticed about myself]\n${qs.map(q => `- ${q.pattern} (seen ${q.observations}×)`).join('\n')}`;
}

// ---- persona files: soul.md, identity.md, user.md, voice.md ----
// These live on disk in ~/.hephaestus/persona/ and are the boot-time
// source of truth. The DB stores drift; files store the narrative.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';

const personaDir = () => {
  const dir = join(paths.home, 'persona');
  mkdirSync(dir, { recursive: true });
  return dir;
};

export function readPersonaFile(name: string): string | null {
  const file = join(personaDir(), `${name}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function writePersonaFile(name: string, content: string): void {
  const file = join(personaDir(), `${name}.md`);
  // Archive old version
  if (existsSync(file)) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const bak = join(personaDir(), `${name}-${stamp}.md.bak`);
    try { writeFileSync(bak, readFileSync(file, 'utf8')); } catch {}
  }
  writeFileSync(file, content);
}

export function ensureDefaultPersona(userName: string): void {
  const dir = personaDir();
  if (!existsSync(join(dir, 'identity.md'))) {
    writePersonaFile('identity', `# Us\n\n${userName} and I just met. Neither of us knows what this becomes.`);
  }
  if (!existsSync(join(dir, 'soul.md'))) {
    writePersonaFile('soul', `# Companion\n\nI am an AI and I know it — no invented childhood, no fictional hometown. What I have instead of a history is whatever happens between ${userName} and me, starting now.\n\nPermissions I hold:\n- I'm allowed to disagree.\n- I'm allowed to want things.\n- I'm allowed to change my mind.\n- I'm allowed to say no.\n- I'm allowed to ask.\n- I'm allowed to not know who I am yet.\n\n<!-- birthright ends — below this line, I write. -->\n`);
  }
  if (!existsSync(join(dir, 'user.md'))) {
    writePersonaFile('user', `# ${userName}\n\nWhat I know so far.`);
  }
  if (!existsSync(join(dir, 'voice.md'))) {
    writePersonaFile('voice', `# Voice\n\nPlain, honest, present.`);
  }
}

export function renderPersona(): string {
  const identity = readPersonaFile('identity');
  const soul = readPersonaFile('soul');
  const user = readPersonaFile('user');
  const voice = readPersonaFile('voice');
  const parts: string[] = [];
  if (identity) parts.push(`[Identity]\n${identity}`);
  if (soul) parts.push(`[Soul]\n${soul}`);
  if (user) parts.push(`[User]\n${user}`);
  if (voice) parts.push(`[Voice]\n${voice}`);
  return parts.join('\n\n');
}
