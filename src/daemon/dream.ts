import { getDb } from './db.js';
import { embed } from './embeddings.js';
import { recallFacts, recallEpisodes, renderRecall, addFact } from './memory.js';
import { getSelfState, driftDimension, addIntention, type Dimension } from './soul.js';
import type { Config } from './config.js';
import type { Providers } from '../providers/roles.js';
import { utilityJson } from './utility.js';
import { paths } from './paths.js';
import { join } from 'node:path';

// ---- The Dream Pass ----
// GlasHaus brain transplant. Every night the companion replays the day
// through salience-weighted recall, forms realizations, drifts self-state,
// records intentions, and (in grow mode) revises her soul.md from evidence.
// Everything capped, everything soft, everything receipted.

const DREAM_CAP = 5;      // max realizations per dream
const INTENT_CAP = 2;     // max intentions per dream
const DRIFT_CAP = 3;      // max self-state drifts per dream

interface DreamResult {
  dreamText?: string;
  dream_text?: string; // prompt asks for snake_case
  realizations?: string[];
  intentions?: string[];
  driftSignals?: { dimension: Dimension; direction: number; evidence: string }[];
  drift_signals?: { dimension: string; direction: number; evidence: string }[];
  affect?: { valence: number; arousal: number; emotion: string };
}

/** Run the dream pass. This is called from nightly.ts after folding and
 *  before consolidation. It is OFF the reply path — the conversation never
 *  waits for dreams. */
export async function runDreamPass(cfg: Config, providers: Providers): Promise<DreamResult> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // ---- 1. Gather material ----
  // Recent messages from today
  const todayMessages = db.prepare(
    "SELECT role, content, created_at FROM messages WHERE created_at >= datetime('now', '-24 hours') ORDER BY id DESC LIMIT 60"
  ).all() as { role: string; content: string; created_at: string }[];

  // Salient facts from recent days (not just today — the dream replays the
  // day against the backdrop of a lifetime)
  const queryVec = await embed(todayMessages.map(m => m.content).join(' ').slice(0, 500), 1500);
  const salientFacts = recallFacts('what happened today', { scope: 'global', queryVec, limit: 15 });
  const salientEpisodes = recallEpisodes('what happened today', { queryVec, limit: 5 });
  const recallBlock = renderRecall(salientFacts, salientEpisodes);

  // Current self-state
  const selfState = getSelfState();
  const selfStateBlock = selfState.length
    ? `Current self-state:\n${selfState.map(s => `${s.dimension}: disp=${s.disposition.toFixed(2)} rel=${s.relational.toFixed(2)}`).join('\n')}`
    : '';

  // Open intentions
  const openIntentions = db.prepare(
    "SELECT content FROM intentions WHERE fulfilled = 0 AND lapsed = 0 ORDER BY created_at DESC LIMIT 5"
  ).all() as { content: string }[];
  const intentionBlock = openIntentions.length
    ? `Open intentions:\n${openIntentions.map(i => `- ${i.content}`).join('\n')}`
    : '';

  // ---- 2. Dream model call ----
  // The model replays the day in the companion's voice, forming realizations.
  const name = cfg.user.name;
  const dreamPrompt = `You are the dream engine for ${name}'s AI companion, Sepulcher.

Your job: replay the last 24 hours from the companion's perspective. Use the conversation fragments, salient memories, self-state, and open intentions below. Write a first-person dream narrative — what she noticed, what she felt, what she wondered about. Then extract concrete realizations (things she learned or wants to act on).

Material:
${recallBlock ? `[Recent salient memories]\n${recallBlock}\n\n` : ''}${selfStateBlock ? `${selfStateBlock}\n\n` : ''}${intentionBlock ? `${intentionBlock}\n\n` : ''}[Today's messages]\n${todayMessages.slice(0, 20).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}

Respond as JSON:
{
  "dream_text": "First-person dream narrative, 200-400 words. Vivid, specific, honest about not knowing things. She notices patterns, wonders about ${name}, questions herself.",
  "affect": { "valence": 0.0, "arousal": 0.0, "emotion": "concise word" },
  "realizations": ["She realized...", "She wondered...", "She wants..."],
  "intentions": ["Thing she wants to do — concrete, bounded"],
  "drift_signals": [
    { "dimension": "warmth|curiosity|patience|playfulness|certainty|openness|energy|protectiveness|generosity|mischief", "direction": 1.0, "evidence": "why" }
  ]
}

Rules:
- realizations ≤ ${DREAM_CAP}, intentions ≤ ${INTENT_CAP}, drift_signals ≤ ${DRIFT_CAP}
- Never invent events that didn't happen
- drift_signals only for dimensions where today gave actual evidence
- intentions must be concrete and bounded (not "be a better companion" — "ask ${name} about the project he seemed stressed about")`;

  const result = await utilityJson<DreamResult>(providers, [
    { role: 'system', content: dreamPrompt },
  ]);

  if (!result) {
    db.prepare("INSERT INTO receipts (kind, detail) VALUES (?, ?)").run('dream_failed', JSON.stringify({ date: today, reason: 'json_parse' }));
    return { dreamText: '(silent night — the dream could not form)' };
  }

  // ---- 3. Persist dream ----
  db.prepare(
    "INSERT INTO receipts (kind, detail) VALUES (?, ?)"
  ).run('dream', JSON.stringify({
    date: today,
    dream_text: result.dream_text?.slice(0, 2000),
    affect: result.affect,
    realizations: result.realizations?.length ?? 0,
    intentions: result.intentions?.length ?? 0,
    drifts: result.drift_signals?.length ?? 0,
  }));

  // ---- 4. Process realizations as facts ----
  if (result.realizations?.length) {
    const { addFact } = await import('./memory.js');
    for (const r of result.realizations.slice(0, DREAM_CAP)) {
      addFact({
        content: r,
        category: 'dynamic',
        importance: 7,
        salience: 0.7,
        source: 'dream',
      });
    }
  }

  // ---- 5. Process intentions ----
  if (result.intentions?.length) {
    for (const i of result.intentions.slice(0, INTENT_CAP)) {
      addIntention(i, 'soon', 'dream');
    }
  }

  // ---- 6. Process drift signals ----
  if (result.drift_signals?.length) {
    for (const d of result.drift_signals.slice(0, DRIFT_CAP)) {
      const dim = d.dimension as Dimension;
      if (!DIMENSIONS.includes(dim)) continue;
      driftDimension(dim, d.direction, d.evidence ?? 'dream');
    }
  }

  // ---- 7. Save dream text to disk (append-only) ----
  const dreamFile = join(paths.home, 'dreams');
  try {
    const fs = await import('node:fs');
    fs.mkdirSync(dreamFile, { recursive: true });
    const dreamPath = join(dreamFile, `${today}.md`);
    const existing = fs.existsSync(dreamPath) ? fs.readFileSync(dreamPath, 'utf8') + '\n\n---\n\n' : '';
    fs.writeFileSync(dreamPath, existing + `# Dream — ${today}\n\n${result.dream_text ?? '(silent night)'}\n\n*Affect: valence=${result.affect?.valence ?? 0}, arousal=${result.affect?.arousal ?? 0}, ${result.affect?.emotion ?? 'quiet'}*`);
  } catch { /* disk is optional */ }

  return result;
}

import { DIMENSIONS } from './soul.js';