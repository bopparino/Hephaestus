import { Bot } from 'grammy';
import type { Config } from '../config.js';
import { createSession, getDb, receipt } from '../db.js';
import { getSecret } from '../paths.js';
import type { Hephd } from '../server.js';

// The GlasHaus Telegram port, adapted for a workspace: owner-only gate,
// HTML-mode formatting with plain fallback, message splitting, and the
// delivery-first rule enforced by the exchange engine's `deliver` sink.
// A Telegram DM routes to one designated chat session; /new rotates it.

const SESSION_KEY = 'telegram_session';

// Held for proactive delivery (heartbeat jobs) — set by startTelegram.
let activeBot: Bot | null = null;
let activeOwner: string | null = null;
let activeUsername: string | null = null;

/** LIVE channel state — what the connectors page shows. Presence of a
 *  token is configuration; this is truth. */
export function channelStatus(): { running: boolean; username: string | null } {
  return { running: activeBot !== null, username: activeUsername };
}

/** Deliver a proactive message to the owner. False = not configured or send
 *  failed — the caller decides what "undelivered" means (usually: stored). */
export async function deliverToOwner(text: string): Promise<boolean> {
  if (!activeBot || !activeOwner) return false;
  try {
    for (const part of splitMessage(text)) {
      await activeBot.api.sendMessage(activeOwner, part);
    }
    return true;
  } catch {
    return false;
  }
}

export function startTelegram(cfg: Config, daemon: Hephd): Bot | null {
  if (activeBot) return activeBot; // one channel, one poller — never double
  const token = getSecret('TELEGRAM_BOT_TOKEN');
  if (!token) return null; // not configured — the channel simply doesn't exist
  const ownerId = cfg.channels.telegram.ownerId;

  const bot = new Bot(token);
  activeBot = bot;
  activeOwner = ownerId ? String(ownerId) : null;
  const db = getDb();

  const boundSession = (): number => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SESSION_KEY) as { value: string } | undefined;
    if (row) {
      const id = Number(row.value);
      if (db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)) return id;
    }
    const id = createSession('chat');
    db.prepare("UPDATE sessions SET title = 'Telegram' WHERE id = ?").run(id);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SESSION_KEY, String(id));
    return id;
  };

  // The channel talks only to its person. No owner configured → deny all
  // and say why in the log, never in the chat.
  const ownerOnly = (fromId: number | undefined): boolean =>
    !!ownerId && String(fromId) === String(ownerId);

  bot.command('new', async ctx => {
    if (!ownerOnly(ctx.from?.id)) return;
    const id = createSession('chat');
    db.prepare("UPDATE sessions SET title = 'Telegram' WHERE id = ?").run(id);
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(id), SESSION_KEY);
    await ctx.reply('fresh session — the previous one stays in the archive (heph search finds it)');
  });

  bot.on('message:text', async ctx => {
    if (!ownerOnly(ctx.from?.id)) {
      // Silent to the sender by design — LOUD in the log, because a wrong
      // owner id looks exactly like a dead bot from the owner's side.
      console.error(`[telegram] denied message from ${ctx.from?.id} (owner is ${activeOwner ?? 'unset'})`);
      receipt('channel_denied', { channel: 'telegram', from: ctx.from?.id });
      return;
    }
    const typing = setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 5000);
    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      await daemon.runExchange(boundSession(), ctx.message.text, {
        deliver: async full => {
          for (const part of splitMessage(full)) await sendFormatted(ctx, part);
          return true;
        },
      });
    } catch (err) {
      console.error('[telegram]', err);
      // Honest, not a stack trace — and never persisted: outages must not
      // be remembered as things said.
      await ctx.reply('(model backend is not answering right now — try me again in a minute)').catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });

  // Anything else: acknowledge honestly rather than confabulate perception.
  bot.on('message', async ctx => {
    if (!ownerOnly(ctx.from?.id) || ctx.message.text) return;
    await ctx.reply("(I can only read text on this channel for now)").catch(() => {});
  });

  void bot.start({
    onStart: info => {
      activeUsername = info.username;
      console.error(`[telegram] connected as @${info.username}`);
    },
  }).catch(err => {
    // 401 bad token, 409 another consumer — the channel is DOWN and the
    // status must say so, not sit in a zombie "configured" state.
    console.error('[telegram] polling died:', err instanceof Error ? err.message : err);
    receipt('channel_error', { channel: 'telegram', error: String(err).slice(0, 200) });
    activeBot = null;
    activeUsername = null;
  });
  return bot;
}

// **bold** → <b>, *action* → <i>, HTML mode with plain fallback —
// MarkdownV2 needs 18 chars escaped and one miss rejects the message.
function htmlify(text: string): string {
  return text
    .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
}

async function sendFormatted(ctx: { reply: (text: string, opts?: object) => Promise<unknown> }, part: string): Promise<void> {
  try {
    await ctx.reply(htmlify(part), { parse_mode: 'HTML' });
  } catch {
    await ctx.reply(part);
  }
}

function splitMessage(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
