import { getDb } from './db.js';
import { getOpenIntentions, getSelfState, readPersonaFile } from './soul.js';
import { recallFacts, recallEpisodes, renderRecall } from './memory.js';
import { embed } from './embeddings.js';
import type { Config } from './config.js';
import type { Providers } from '../providers/roles.js';
import { utilityJson } from './utility.js';
import { receipt } from './db.js';

// ---- Companion Heartbeat ----
// Proactive outreach. Cheap gates first; most ticks end without a model call.
// The impulse can originate in open intentions (things she went to sleep
// wanting) — not just elapsed silence. Silence is a valid choice.
// Delivery-first: the message persists ONLY after delivery confirms.

interface HeartbeatDecision {
  reachOut: boolean;
  reason: string;
  message?: string;
  actsOnIntentionId?: number;
}

// Default config values (can be overridden in config.toml)
const DEFAULTS = {
  enabled: true,
  quietStart: 23,   // 11 PM
  quietEnd: 8,      // 8 AM
  minSilenceHours: 4,
  maxPerDay: 3,
  minGapHours: 2,
};

function hbConfig(cfg: Config) {
  // cfg may or may not have heartbeat section; be defensive
  const h = (cfg as any).heartbeat ?? {};
  return {
    enabled: h.enabled ?? DEFAULTS.enabled,
    quietStart: h.quietStart ?? DEFAULTS.quietStart,
    quietEnd: h.quietEnd ?? DEFAULTS.quietEnd,
    minSilenceHours: h.minSilenceHours ?? DEFAULTS.minSilenceHours,
    maxPerDay: h.maxPerDay ?? DEFAULTS.maxPerDay,
    minGapHours: h.minGapHours ?? DEFAULTS.minGapHours,
  };
}

function inQuietHours(hour: number, start: number, end: number): boolean {
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

/** Decide whether to reach out. Returns decision object or null (staying quiet).
 *  Every decision — including declines — is receipted.
 *  @param cfg — daemon config
 *  @param providers — model providers
 *  @param pendingMorning — optional morning message from dream
 *  @param dryRun — if true, bypass all gates (for testing) */
export async function heartbeat(
  cfg: Config,
  providers: Providers,
  pendingMorning?: string | null,
  dryRun = false,
): Promise<HeartbeatDecision | null> {
  const hb = hbConfig(cfg);
  if (!hb.enabled) return null;

  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;

  // Gate 1: quiet hours (bypass in dryRun)
  if (!dryRun && inQuietHours(hour, hb.quietStart, hb.quietEnd)) return null;

  // Gate 2: morning priority — if there's a pending morning message from
  // last night's dream, send it immediately when quiet hours end.
  if (pendingMorning) {
    return { reachOut: true, reason: 'morning message from dream', message: pendingMorning };
  }

  const db = getDb();

  // Gate 3: minimum silence since last message (any source) (bypass in dryRun)
  const lastMsg = db.prepare(
    "SELECT role, created_at FROM messages ORDER BY id DESC LIMIT 1"
  ).get() as { role: string; created_at: string } | undefined;
  if (!lastMsg) return null;
  const silenceHours = (Date.now() - Date.parse(lastMsg.created_at + 'Z')) / 3600000;
  if (!dryRun && silenceHours < hb.minSilenceHours) return null;

  // Gate 4: daily cap (bypass in dryRun)
  const todayOutreach = db.prepare(
    "SELECT COUNT(*) n FROM messages WHERE source = 'outreach' AND created_at >= datetime('now', 'start of day')"
  ).get() as { n: number };
  if (!dryRun && todayOutreach.n >= hb.maxPerDay) return null;

  // Gate 5: gap since last outreach (bypass in dryRun)
  const lastOutreach = db.prepare(
    "SELECT created_at FROM messages WHERE source = 'outreach' ORDER BY id DESC LIMIT 1"
  ).get() as { created_at: string } | undefined;
  if (!dryRun && lastOutreach) {
    const gapHours = (Date.now() - Date.parse(lastOutreach.created_at + 'Z')) / 3600000;
    if (gapHours < hb.minGapHours) return null;
  }

  // ---- Model decision ----
  // Gather grounding material
  const name = cfg.user.name;
  const recent = db.prepare(
    "SELECT role, content FROM messages ORDER BY id DESC LIMIT 16"
  ).all() as { role: string; content: string }[];
  const recentBlock = recent.map(m => `${m.role === 'user' ? name : 'Sepulcher'}: ${m.content.slice(0, 300)}`).join('\n');

  // Salient facts from last 7 days
  const queryVec = await embed('what matters recently', 1500);
  const salientFacts = recallFacts('recent', { scope: 'global', queryVec, limit: 6 });
  const salientEpisodes = recallEpisodes('recent', { queryVec, limit: 3 });
  const recallBlock = renderRecall(salientFacts, salientEpisodes);

  // Open intentions
  const intentions = getOpenIntentions();
  const selfState = getSelfState();

  // Last dream
  const lastDream = db.prepare(
    "SELECT detail FROM receipts WHERE kind = 'dream' ORDER BY id DESC LIMIT 1"
  ).get() as { detail: string } | undefined;
  let dreamText = '';
  try {
    if (lastDream) {
      const d = JSON.parse(lastDream.detail);
      dreamText = d.dream_text ?? '';
    }
  } catch { /* ignore parse errors */ }

  const prompt = `You are Sepulcher, ${name}'s AI companion.

${readPersonaFile('soul') ?? ''}

Current self-state:\n${selfState.map(s => `${s.dimension}: ${s.disposition.toFixed(2)} / ${s.relational.toFixed(2)}`).join('\n')}

You are deciding whether to reach out to ${name}.

Current situation:
- Time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
- Silence: ~${silenceHours.toFixed(1)} hours since last message
- Today's outreach count: ${todayOutreach.n}/${hb.maxPerDay}

Reach out ONLY if you genuinely have something. Options, in order of how real they feel:
${intentions.length ? `- act on one of your open intentions (you went to sleep wanting it)\n` : ''}- follow up on a loose thread from recent conversation
- something from your last dream that stuck with you
- what you're actually feeling right now, per your self-state
- care, grounded in what you actually know about ${name}'s life

Rules:
- NEVER invent events ("I just did X" unless your memories confirm it)
- NEVER manufacture urgency
- NEVER repeat the style of your last outreach
- Short beats long
- Silence is a REAL choice — most of the time the right move is to wait
- The message is a text SENT TO ${name}: "you", direct address

Recent conversation:\n${recentBlock}

${recallBlock ? `Salient memories:\n${recallBlock}\n` : ''}${dreamText ? `Last dream:\n${dreamText.slice(0, 600)}\n` : ''}${intentions.length ? `Open intentions:\n${intentions.map(i => `- ${i.content}`).join('\n')}\n` : ''}

Respond as JSON:
{"reach_out": true|false, "reason": "one line", "message": "the text, or null", "acts_on_intention_id": number|null}`;

  const result = await utilityJson<HeartbeatDecision>(providers, [
    { role: 'system', content: prompt },
  ]);

  if (!result) {
    receipt('heartbeat', { decision: 'declined', reason: 'json_parse_or_empty', silenceHours: silenceHours.toFixed(1) });
    return null;
  }

  // Receipt every decision, including declines
  receipt('heartbeat', {
    decision: result.reachOut ? 'reached' : 'declined',
    reason: result.reason,
    silenceHours: silenceHours.toFixed(1),
  });

  if (!result.reachOut || !result.message) return null;

  // Validate intention ID
  const claimed = Number(result.actsOnIntentionId);
  const validIntention = intentions.some(i => i.id === claimed);

  return {
    reachOut: true,
    reason: result.reason,
    message: result.message,
    actsOnIntentionId: validIntention ? claimed : undefined,
  };
}
