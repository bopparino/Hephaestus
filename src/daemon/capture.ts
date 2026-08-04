import type { Config } from './config.js';
import { getDb, receipt, sessionScope } from './db.js';
import { addFact, coreFacts, setCore } from './memory.js';
import { utilityJson } from './utility.js';
import type { Providers } from '../providers/roles.js';

// The capture ∘ curate pass — FORGE_NOTES §2.4. Runs AFTER the reply is
// delivered, never competing with the user's task (Hermes), with GlasHaus's
// extraction discipline. One pass, three routes: durable facts → deep
// memory, core promotions/demotions → tier 1, everything else → nowhere
// (the transcript already has it; session search finds it).

// Hermes' shared gate: zero-signal text must not burn a capture turn.
const TRIVIAL = /^(hi|hey|hello|ok(ay)?|thanks?( you)?|ty|lgtm|yes|no|yep|nope|sure|continue|go( on| ahead)?|cool|nice|great|good|k)[.! ]*$/i;

export function isTrivial(text: string): boolean {
  return TRIVIAL.test(text.trim());
}

/** Persisted counter — survives daemon restarts (the Hermes lesson). */
export function bumpCaptureCounter(sessionId: number, captureEvery: number): boolean {
  const db = getDb();
  const key = `capture_ctr:${sessionId}`;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  const count = (row ? Number(row.value) : 0) + 1;
  if (count >= captureEvery) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, '0');
    return true;
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(count));
  return false;
}

interface CaptureResult {
  facts?: { category?: string; content?: string; importance?: number; salience?: number; global?: boolean }[];
  core?: {
    promote_ids?: number[];
    demote_ids?: number[];
    rewrites?: { id?: number; content?: string }[];
  };
  nothing_to_save?: boolean;
}

const CATEGORIES = new Set(['user', 'project', 'decision', 'preference', 'reference', 'general']);

export async function runCapture(cfg: Config, providers: Providers, sessionId: number): Promise<void> {
  const db = getDb();
  const recent = db
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, cfg.memory.captureEvery * 2 + 4)
    .reverse() as { role: string; content: string }[];
  if (!recent.length) return;

  const name = cfg.user.name;
  const scope = sessionScope(sessionId);
  const scopeNote = scope === 'global'
    ? ''
    : `\nThis conversation belongs to the "${scope.slice(8)}" project. Facts default to that project's scope; mark a fact {"global": true} ONLY if it is about ${name} themselves or clearly crosses projects (identity, standing preferences).`;
  const transcript = recent.map(m => `${m.role === 'user' ? name : 'Hephaestus'}: ${m.content}`).join('\n');
  const known = (db.prepare('SELECT content FROM facts WHERE active = 1 ORDER BY updated_at DESC LIMIT 60').all() as { content: string }[])
    .map(f => `- ${f.content}`).join('\n');
  const core = coreFacts('global');
  const coreUsed = core.reduce((n, f) => n + f.content.length, 0);
  const coreList = core.map(f => `[#${f.id}] ${f.content}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);

  const result = await utilityJson<CaptureResult>(providers, [
    {
      role: 'system',
      content: `You are the memory system for Hephaestus, ${name}'s local AI workspace. Two jobs, one pass.

Today's date: ${today}.

JOB 1 — CAPTURE. Extract NEW durable facts from the conversation below — things worth knowing weeks from now.
STRICT RULES — memory integrity depends on these:
- Write facts TIMELESSLY: convert "today"/"currently" into absolute dates or durable phrasing ("As of ${today}, ..."). A fact is read months later; it must not sound like it is happening at read time.
- Write DECLARATIVE facts in a neutral notebook register, in third person: "${name} prefers X", "The cut-sheet project targets Y". NEVER imperative ("Always do X") — imperative entries get re-read as directives later and override live requests.
- If a fact will be stale in a week, it does not belong in memory.
- Only record what was actually said or clearly established. Never infer capabilities, tools, or system features — models confabulate capabilities.
- Procedures, task progress, and completed-work logs are NOT facts — procedures belong in the skills library, the transcript already has the rest. Skip them here.
- Do NOT re-extract facts already known.
Categories: "user" (who ${name} is), "project" (ongoing work), "decision" (what was chosen and why — the load-bearing category), "preference" (how ${name} likes things done), "reference" (pointers), "general".
Rate each: importance 1-10, salience 0-1 (0.1 = trivia, 0.9 = defining).${scopeNote}

JOB 2 — CURATE the MEMORY CORE (the always-visible tier, budget ${cfg.memory.coreBudget} chars, currently ${coreUsed}). Promote a known fact to core only if it should shape EVERY future conversation (identity, standing conventions, active long-arc work). Demote core entries that no longer earn the budget. You may rewrite a core entry for concision. Current core:
${coreList || '(empty)'}

Respond as JSON:
{"facts": [{"category": "...", "content": "...", "importance": 5, "salience": 0.5}], "core": {"promote_ids": [], "demote_ids": [], "rewrites": [{"id": 0, "content": "..."}]}, "nothing_to_save": false}
If nothing is worth saving and the core is fine, respond {"nothing_to_save": true}.

Already known:
${known || '(nothing yet)'}`,
    },
    { role: 'user', content: transcript },
  ]);

  if (!result) return;
  if (result.nothing_to_save) {
    receipt('memory_capture', { sessionId, saved: 0, note: 'nothing to save' }, sessionId);
    return;
  }

  let saved = 0;
  for (const f of result.facts ?? []) {
    if (!f?.content?.trim()) continue;
    addFact({
      content: f.content.trim(),
      category: CATEGORIES.has(f.category ?? '') ? f.category : 'general',
      scope: f.global === true ? 'global' : scope,
      importance: f.importance,
      salience: f.salience ?? null,
      source: 'capture',
      sourceSession: sessionId,
    });
    saved++;
  }

  // Curation — only ids that name a real fact count; models freelance ids.
  const factExists = (id: number) =>
    !!db.prepare('SELECT id FROM facts WHERE id = ? AND active = 1').get(id);
  for (const id of (result.core?.promote_ids ?? []).map(Number)) {
    if (!factExists(id)) continue;
    const wouldUse = coreFacts('global').reduce((n, f) => n + f.content.length, 0);
    if (wouldUse >= cfg.memory.coreBudget) break; // over budget — demote first, next pass
    setCore(id, true, 'capture pass promotion');
  }
  for (const id of (result.core?.demote_ids ?? []).map(Number)) {
    if (factExists(id)) setCore(id, false, 'capture pass demotion');
  }
  for (const rw of result.core?.rewrites ?? []) {
    const id = Number(rw?.id);
    if (!rw?.content?.trim() || !factExists(id)) continue;
    db.prepare("UPDATE facts SET content = ?, updated_at = datetime('now') WHERE id = ? AND core = 1")
      .run(rw.content.trim(), id);
  }

  receipt('memory_capture', {
    sessionId, saved,
    promoted: result.core?.promote_ids?.length ?? 0,
    demoted: result.core?.demote_ids?.length ?? 0,
  }, sessionId);
}
