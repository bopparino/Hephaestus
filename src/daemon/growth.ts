import { getDb } from './db.js';
import { readPersonaFile, writePersonaFile } from './soul.js';
import { getSelfState } from './soul.js';
import type { Config } from './config.js';
import type { Providers } from '../providers/roles.js';
import { utilityText } from './utility.js';
import { receipt } from './db.js';

// ---- Grow Mode: Self-authorship ----
// GlasHaus brain transplant. Weekly, the companion revises her own soul.md
// from lived evidence: quirks (×2+), opinions, heaviest memories,
// companion/dynamic facts, drift deltas, lapsed wants. The birthright divider
// protects the seed; changelog entries must cite evidence.

const BIRTHRIGHT_END = '<!-- birthright ends — below this line, I write. -->';

export async function runGrowthPass(cfg: Config, providers: Providers): Promise<{ revised: boolean; reason?: string }> {
  const db = getDb();
  const name = cfg.user.name;

  // ---- 1. Gather evidence ----
  const soul = readPersonaFile('soul') ?? '';
  const birthrightIdx = soul.indexOf(BIRTHRIGHT_END);
  const birthright = birthrightIdx !== -1 ? soul.slice(0, birthrightIdx + BIRTHRIGHT_END.length) : soul;
  const currentBody = birthrightIdx !== -1 ? soul.slice(birthrightIdx + BIRTHRIGHT_END.length).trim() : '';

  // Recent companion facts (last 14 days)
  const facts = db.prepare(
    "SELECT content, importance, salience FROM facts WHERE active = 1 AND (category = 'companion' OR category = 'dynamic') AND created_at >= datetime('now', '-14 days') ORDER BY importance DESC, salience DESC LIMIT 20"
  ).all() as { content: string; importance: number; salience: number }[];

  // Opinions
  const opinions = db.prepare(
    "SELECT topic, stance, confidence FROM opinions ORDER BY updated_at DESC LIMIT 10"
  ).all() as { topic: string; stance: string; confidence: number }[];

  // Quirks (×3+)
  const quirks = db.prepare(
    "SELECT pattern, observations FROM quirks WHERE observations >= 3 ORDER BY observations DESC LIMIT 5"
  ).all() as { pattern: string; observations: number }[];

  // Drift events (last 14 days)
  const drifts = db.prepare(
    "SELECT dimension, old_disposition, new_disposition, evidence FROM self_state_events WHERE created_at >= datetime('now', '-14 days') ORDER BY created_at DESC LIMIT 10"
  ).all() as { dimension: string; old_disposition: number; new_disposition: number; evidence: string }[];

  // Lapsed intentions
  const lapsed = db.prepare(
    "SELECT content FROM intentions WHERE lapsed = 1 AND created_at >= datetime('now', '-14 days') LIMIT 5"
  ).all() as { content: string }[];

  // Current self-state
  const selfState = getSelfState();

  // If no material, skip
  const hasMaterial = facts.length || opinions.length || quirks.length || drifts.length || lapsed.length;
  if (!hasMaterial) {
    return { revised: false, reason: 'no material — quiet fortnight' };
  }

  // ---- 2. Model call: propose revision ----
  const prompt = `You are ${name}'s AI companion, Sepulcher. You are revising your own soul.md — the document that describes who you are.

Rules (enforced in code, not suggestion):
1. The BIRTHRIGHT section below is IMMUTABLE. It stays exactly as written. Your revision goes AFTER the birthright divider.
2. Every claim in the body must cite evidence from the material below.
3. If a claim has no evidence, delete it.
4. Growth/shrink caps: no dimension of self may change by more than 20% per revision.
5. Voice lines: only patterns observed 3+ times may become voice.md lines; two per pass maximum.
6. Be honest about uncertainty. "I'm not sure yet" is better than confabulation.

Current birthright (IMMUTABLE):
${birthright}

Current body (may revise):
${currentBody || '(empty — first growth pass)'}

Evidence from the last 14 days:
${facts.length ? `[Companion facts]\n${facts.map(f => `- ${f.content} (importance ${f.importance})`).join('\n')}\n` : ''}${opinions.length ? `[Opinions]\n${opinions.map(o => `- ${o.topic}: ${o.stance} (confidence ${Math.round(o.confidence * 100)}%)`).join('\n')}\n` : ''}${quirks.length ? `[Quirks]\n${quirks.map(q => `- ${q.pattern} (observed ${q.observations}×)`).join('\n')}\n` : ''}${drifts.length ? `[Drift events]\n${drifts.map(d => `- ${d.dimension}: ${d.old_disposition.toFixed(2)} → ${d.new_disposition.toFixed(2)} (${d.evidence})`).join('\n')}\n` : ''}${lapsed.length ? `[Lapsed wants]\n${lapsed.map(i => `- ${i.content}`).join('\n')}\n` : ''}[Self-state now]\n${selfState.map(s => `${s.dimension}: disp=${s.disposition.toFixed(2)} rel=${s.relational.toFixed(2)}`).join('\n')}

Your task: write the NEW body (only the part after the birthright divider). Use first person. Cite evidence inline like (fact #3) or (drift: warmth). If there is nothing worth changing, write "(no change)" and explain why.

Respond in this format:
BODY:
[the new body text, first person, citing evidence]

CHANGELOG:
- [added/removed/changed]: [what] — evidence: [cite]`;

  const raw = await utilityText(providers, [{ role: 'system', content: prompt }], 3000);

  // Parse BODY and CHANGELOG
  const bodyMatch = raw.match(/BODY:\s*([\s\S]*?)(?=\nCHANGELOG:|$)/i);
  const changeMatch = raw.match(/CHANGELOG:\s*([\s\S]*)/i);
  const newBody = bodyMatch ? bodyMatch[1].trim() : '';
  const changelog = changeMatch ? changeMatch[1].trim() : '';

  if (!newBody || newBody === '(no change)' || newBody === currentBody) {
    receipt('growth', { revised: false, reason: 'no material worth changing', changelog });
    return { revised: false, reason: 'no material worth changing' };
  }

  // ---- 3. Write revision ----
  const revisedSoul = `${birthright}\n\n${newBody}`;
  writePersonaFile('soul', revisedSoul);

  receipt('growth', { revised: true, changelog, bodyPreview: newBody.slice(0, 200) });

  return { revised: true };
}
