#!/usr/bin/env node
// heph — thin client. The daemon owns everything; this renders it.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { ensureHome, loadToken, paths } from '../daemon/paths.js';
import type { DaemonState, ResolvedSkin, RpcResponse } from '../shared/protocol.js';

// ---- ansi -------------------------------------------------------------------

const TTY = process.stdout.isTTY === true;
const fg = (hex: string) => {
  if (!TTY) return '';
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
};
const RESET = TTY ? '\x1b[0m' : '';
const DIM = TTY ? '\x1b[2m' : '';

const FORGE_VERBS = ['stoking', 'hammering', 'quenching', 'casting', 'tempering', 'annealing'];

// ---- rpc client -------------------------------------------------------------

class Client {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onEvent: (event: string, params: Record<string, unknown>) => void = () => {};

  async connect(port: number, token: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      const frame = JSON.parse(data.toString()) as RpcResponse & { event?: string; params?: Record<string, unknown> };
      if (frame.event) {
        this.onEvent(frame.event, frame.params ?? {});
        return;
      }
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      else waiter.resolve(frame.result);
    });
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  close(): void {
    this.ws.close();
  }
}

// ---- daemon discovery / spawn ----------------------------------------------

function readState(): DaemonState | null {
  try {
    return JSON.parse(readFileSync(paths.state, 'utf8')) as DaemonState;
  } catch {
    return null;
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<DaemonState> {
  const state = readState();
  if (state && (await healthy(state.port))) return state;

  const entry = fileURLToPath(new URL('../daemon/index.js', import.meta.url));
  if (!existsSync(entry)) {
    throw new Error(`daemon not running and no built entry at ${entry} — run \`npm run build\` (or \`npm run daemon\` in dev)`);
  }
  spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    const s = readState();
    if (s && (await healthy(s.port))) return s;
  }
  throw new Error(`daemon did not come up — check ${paths.logs}/daemon.log`);
}

// ---- spinner (doctrine: width-padded, nothing jitters) ----------------------

function spinner(verbs: string[]): { stop: () => void } {
  if (!TTY) return { stop: () => {} };
  const width = Math.max(...verbs.map(v => v.length));
  let i = 0;
  const timer = setInterval(() => {
    const verb = verbs[i % verbs.length].padEnd(width);
    process.stdout.write(`\r${DIM}${verb}${'.'.repeat((i % 3) + 1).padEnd(3)}${RESET}`);
    i++;
  }, 350);
  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write('\r' + ' '.repeat(width + 4) + '\r');
    },
  };
}

// ---- commands ---------------------------------------------------------------

async function withClient<T>(fn: (c: Client, skin: ResolvedSkin) => Promise<T>): Promise<T> {
  const state = await ensureDaemon();
  const client = new Client();
  await client.connect(state.port, loadToken());
  const info = await client.request<{ skins: { dark: string } }>('daemon.info');
  const skin = await client.request<ResolvedSkin>('skins.get', { name: info.skins.dark });
  try {
    return await fn(client, skin);
  } finally {
    client.close();
  }
}

async function cmdChat(message?: string, project?: string): Promise<void> {
  await withClient(async (client, skin) => {
    const accent = fg(skin.palette.accent);
    const muted = fg(skin.palette.fgMuted);
    let sessionId: number | undefined;

    const ask = async (text: string): Promise<void> => {
      const spin = spinner(skin.verbs ?? FORGE_VERBS);
      let first = true;
      client.onEvent = (event, params) => {
        if (event !== 'chat.delta') return;
        if (first) {
          spin.stop();
          first = false;
        }
        process.stdout.write(String(params.text));
      };
      try {
        const result = await client.request<{ sessionId: number; usage: { inputTokens?: number; outputTokens?: number } }>(
          'chat.send',
          { text, sessionId, ...(project ? { project } : {}) },
        );
        sessionId = result.sessionId;
        const u = result.usage;
        const usageNote = u.inputTokens != null ? ` ${muted}· ${u.inputTokens}→${u.outputTokens ?? '?'} tok${RESET}` : '';
        process.stdout.write(`\n${usageNote}\n`);
      } finally {
        spin.stop();
      }
    };

    if (message) {
      await ask(message);
      return;
    }

    console.log(`${accent}HEPHAESTUS${RESET} ${muted}· the forge is lit · /quit to leave${RESET}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${accent}❯${RESET} ` });
    rl.prompt();
    for await (const line of rl) {
      const text = line.trim();
      if (text === '/quit' || text === '/exit') break;
      if (text) await ask(text);
      rl.prompt();
    }
    rl.close();
  });
}

async function cmdSkins(): Promise<void> {
  await withClient(async client => {
    const skins = await client.request<{ name: string; label: string; polarity: string; palette: Record<string, string> }[]>('skins.list');
    for (const polarity of ['dark', 'light']) {
      console.log(`\n${DIM}${polarity.toUpperCase()}${RESET}`);
      for (const s of skins.filter(x => x.polarity === polarity)) {
        const chips = Object.values(s.palette).map(hex => `${fg(hex)}██${RESET}`).join('');
        console.log(`  ${chips}  ${s.label.padEnd(14)} ${DIM}${s.name}${RESET}`);
      }
    }
  });
}

async function cmdInfo(): Promise<void> {
  await withClient(async client => {
    const info = await client.request('daemon.info');
    console.log(JSON.stringify(info, null, 2));
  });
}

async function cmdMemory(args: string[]): Promise<void> {
  await withClient(async (client, skin) => {
    const accent = fg(skin.palette.accent);
    const muted = fg(skin.palette.fgMuted);
    const [sub, ...rest] = args;

    if (sub === 'save') {
      const text = rest.join(' ').trim();
      if (!text) throw new Error('usage: heph memory save "<fact>"');
      const { id } = await client.request<{ id: number }>('memory.save', { content: text });
      console.log(`${muted}saved #${id}${RESET}`);
      return;
    }
    if (sub === 'forget') {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error('usage: heph memory forget <id>');
      await client.request('memory.forget', { id });
      console.log(`${muted}#${id} deactivated (soft — nothing is ever deleted)${RESET}`);
      return;
    }

    interface FactRow { id: number; scope: string; category: string; content: string; importance: number; core: number; updated_at: string }
    const { budget, coreUsed, facts } = await client.request<{ budget: number; coreUsed: number; facts: FactRow[] }>('memory.list');
    const core = facts.filter(f => f.core);
    const deep = facts.filter(f => !f.core);
    console.log(`${accent}MEMORY CORE${RESET} ${muted}[${Math.round((coreUsed / budget) * 100)}% — ${coreUsed}/${budget} chars]${RESET}`);
    for (const f of core) console.log(`  ${accent}#${f.id}${RESET} ${f.content}`);
    if (!core.length) console.log(`  ${muted}(empty — the capture pass promotes what earns the budget)${RESET}`);
    console.log(`\n${accent}DEEP MEMORY${RESET} ${muted}(${deep.length} shown, newest/heaviest first)${RESET}`);
    for (const f of deep.slice(0, 25)) {
      console.log(`  ${muted}#${f.id} [${f.category}·i${f.importance}]${RESET} ${f.content}`);
    }
  });
}

async function cmdSearch(query: string): Promise<void> {
  await withClient(async (client, skin) => {
    const accent = fg(skin.palette.accent);
    const muted = fg(skin.palette.fgMuted);
    interface Hit { sessionId: number; title: string | null; opening: { role: string; content: string }[]; window: { role: string; content: string }[]; closing: { role: string; content: string }[] }
    const hits = await client.request<Hit[]>('search.messages', { query });
    if (!hits.length) {
      console.log(`${muted}nothing in the transcripts — note: this is evidence about past conversations, not the world${RESET}`);
      return;
    }
    for (const hit of hits) {
      console.log(`\n${accent}session ${hit.sessionId}${RESET} ${muted}${hit.title ?? ''}${RESET}`);
      const line = (m: { role: string; content: string }) =>
        console.log(`  ${muted}${m.role === 'user' ? '❯' : '⏵'}${RESET} ${m.content.slice(0, 110).replaceAll('\n', ' ')}`);
      hit.opening.forEach(line);
      if (hit.opening.length) console.log(`  ${muted}⋯${RESET}`);
      hit.window.forEach(line);
      if (hit.closing.length) console.log(`  ${muted}⋯${RESET}`);
      hit.closing.forEach(line);
    }
  });
}

async function cmdNightly(): Promise<void> {
  await withClient(async (client, skin) => {
    const muted = fg(skin.palette.fgMuted);
    console.log(`${muted}running the nightly pass (folding, consolidation, embeddings, backup)…${RESET}`);
    const summary = await client.request('maintenance.run');
    console.log(JSON.stringify(summary, null, 2));
  });
}

async function cmdDev(args: string[]): Promise<void> {
  let root = process.cwd();
  let allowAll = false;
  const taskParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-C') root = args[++i];
    else if (args[i] === '--allow') allowAll = true;
    else taskParts.push(args[i]);
  }
  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('usage: heph dev [-C root] [--allow] "<task>"');

  await withClient(async (client, skin) => {
    const accent = fg(skin.palette.accent);
    const muted = fg(skin.palette.fgMuted);
    const danger = fg(skin.palette.danger);
    const positive = fg(skin.palette.positive);

    console.log(`${accent}DEV AUTOMATON${RESET} ${muted}· ${root}${allowAll ? ' · session-granted: fs_write, shell' : ''}${RESET}\n`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    client.onEvent = (event, params) => {
      if (event === 'agent.delta') {
        process.stdout.write(String(params.text));
      } else if (event === 'agent.tool') {
        const mark = params.ok ? `${positive}⚒${RESET}` : `${danger}⚒${RESET}`;
        console.log(`\n${mark} ${muted}${params.name}${RESET} ${String(params.summary)} ${muted}(${params.ms}ms)${RESET}`);
      } else if (event === 'approval.request') {
        console.log(`\n${danger}⚠ approval needed${RESET} — ${accent}${params.tool}${RESET} [${params.risk}]`);
        console.log(`  ${String(params.summary)}`);
        rl.question(`  ${muted}[y]es once / [s]ession / [a]lways / [n]o:${RESET} `, answer => {
          const decision =
            answer.trim().toLowerCase() === 'y' ? 'allow-once'
            : answer.trim().toLowerCase() === 's' ? 'allow-session'
            : answer.trim().toLowerCase() === 'a' ? 'allow-always'
            : 'deny';
          void client.request('approval.respond', { approvalId: params.approvalId, decision });
        });
      }
    };

    try {
      const result = await client.request<{ iterations: number; toolCalls: number }>('agent.run', {
        task, root, sessionGrantAll: allowAll,
      });
      console.log(`\n${muted}— ${result.iterations} iteration(s), ${result.toolCalls} tool call(s) · every one receipted (heph receipts)${RESET}`);
    } finally {
      rl.close();
    }
  });
}

async function cmdReceipts(): Promise<void> {
  await withClient(async (client, skin) => {
    const accent = fg(skin.palette.accent);
    const muted = fg(skin.palette.fgMuted);
    interface Receipt { id: number; created_at: string; session_id: number | null; kind: string; detail: string }
    const receipts = await client.request<Receipt[]>('receipts.list', { limit: 30 });
    for (const receipt of [...receipts].reverse()) {
      console.log(`${muted}#${receipt.id} ${receipt.created_at}${RESET} ${accent}${receipt.kind}${RESET} ${receipt.detail.slice(0, 140)}`);
    }
  });
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  ensureHome();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd ?? 'chat') {
    case 'daemon':
      await import('../daemon/index.js'); // foreground, logs to stderr
      break;
    case 'chat': {
      let project: string | undefined;
      const pIdx = rest.indexOf('--project');
      if (pIdx !== -1) {
        project = rest[pIdx + 1];
        rest.splice(pIdx, 2);
      }
      const mIdx = rest.indexOf('-m');
      await cmdChat(mIdx !== -1 ? rest.slice(mIdx + 1).join(' ') : undefined, project);
      break;
    }
    case 'project': {
      await withClient(async (client, skin) => {
        const accent = fg(skin.palette.accent);
        const muted = fg(skin.palette.fgMuted);
        if (rest[0] === 'add') {
          const name = rest[1];
          const root = rest[2] ?? process.cwd();
          if (!name) throw new Error('usage: heph project add <name> [root]');
          await client.request('project.add', { name, root });
          console.log(`${muted}registered ${name} → ${root}${RESET}`);
          return;
        }
        const projects = await client.request<{ name: string; root: string }[]>('project.list');
        if (!projects.length) console.log(`${muted}(no projects — heph project add <name> [root])${RESET}`);
        for (const proj of projects) console.log(`${accent}${proj.name}${RESET} ${muted}${proj.root}${RESET}`);
      });
      break;
    }
    case 'skins':
      await cmdSkins();
      break;
    case 'info':
      await cmdInfo();
      break;
    case 'memory':
      await cmdMemory(rest);
      break;
    case 'search':
      if (!rest.length) throw new Error('usage: heph search <query>');
      await cmdSearch(rest.join(' '));
      break;
    case 'nightly':
      await cmdNightly();
      break;
    case 'dev':
      await cmdDev(rest);
      break;
    case 'receipts':
      await cmdReceipts();
      break;
    case 'ui': {
      const state = await ensureDaemon();
      const url = `http://127.0.0.1:${state.port}/#${loadToken()}`;
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
      console.log(`shell: ${url.split('#')[0]} (token in fragment)`);
      break;
    }
    case 'skills':
      await withClient(async (client, skin) => {
        const accent = fg(skin.palette.accent);
        const muted = fg(skin.palette.fgMuted);
        const skills = await client.request<{ name: string; description: string }[]>('skills.list');
        if (!skills.length) console.log(`${muted}(no skills yet — the dev automaton proposes them, or drop SKILL.md dirs in ~/.hephaestus/skills)${RESET}`);
        for (const s of skills) console.log(`${accent}${s.name}${RESET} — ${s.description}`);
      });
      break;
    default:
      console.log('usage: heph [chat [-m msg] [--project <p>] | dev [-C root] [--allow] "task" | ui | project [add] | receipts | skills | memory [save|forget] | search <q> | nightly | daemon | skins | info]');
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`heph: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
