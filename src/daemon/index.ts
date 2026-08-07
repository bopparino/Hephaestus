import { writeFileSync, unlinkSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome, loadToken, paths } from './paths.js';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { Hephd } from './server.js';
import { startTelegram } from './channels/telegram.js';
import type { DaemonState } from '../shared/protocol.js';

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.error(stamped);
  try {
    appendFileSync(join(paths.logs, 'daemon.log'), stamped + '\n');
  } catch { /* logging must never kill the daemon */ }
}

async function alreadyRunning(): Promise<DaemonState | null> {
  if (!existsSync(paths.state)) return null;
  try {
    const state = JSON.parse(readFileSync(paths.state, 'utf8')) as DaemonState;
    const res = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? state : null;
  } catch {
    return null; // stale state file — a crashed daemon must not block the next
  }
}

async function main(): Promise<void> {
  ensureHome();
  const existing = await alreadyRunning();
  if (existing) {
    log(`hephd already running (pid ${existing.pid}, port ${existing.port})`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const token = loadToken();
  getDb(); // first touch creates the schema complete

  const daemon = new Hephd(cfg, token);
  const port = await daemon.listen(cfg.daemon.port);
  const state: DaemonState = { pid: process.pid, port, startedAt: new Date().toISOString() };
  writeFileSync(paths.state, JSON.stringify(state));
  log(`hephd listening on 127.0.0.1:${port} — the void is warm`);

  const telegram = startTelegram(cfg, daemon);
  if (telegram) log('telegram channel up (owner-gated)');
  else log('telegram channel not configured (TELEGRAM_BOT_TOKEN absent) — skipping');

  const shutdown = (signal: string) => {
    log(`${signal} — banking the coals`);
    void telegram?.stop();
    daemon.close();
    try {
      unlinkSync(paths.state);
    } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
