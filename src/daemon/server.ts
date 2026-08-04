import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import { createSession, getDb, receipt, saveMessage } from './db.js';
import { loadSkins } from './skins.js';
import { Providers } from '../providers/roles.js';
import { ProviderError } from '../providers/types.js';
import type { ChatMessage } from '../providers/types.js';
import { PROTOCOL_VERSION, type ResolvedSkin, type RpcRequest, type Usage } from '../shared/protocol.js';

const VERSION = '0.0.1';

// Phase 0 identity. Memory, automata charters, and recall bands land in
// Phase 1 — this line exists so the prompt-assembly seam does.
const SYSTEM_PROMPT =
  'You are Hephaestus, a local-first AI workspace. Be direct, concrete, and useful.';

const RECENT_WINDOW = 40;

export class Hephd {
  private http: Server;
  private wss: WebSocketServer;
  private skins: Map<string, ResolvedSkin>;
  private providers: Providers;
  // Directive #2 cousin: one serialized queue per session, sessions concurrent.
  private sessionQueues = new Map<number, Promise<void>>();

  constructor(private cfg: Config, private token: string) {
    this.skins = loadSkins();
    this.providers = new Providers(cfg);
    this.http = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: VERSION, protocol: PROTOCOL_VERSION }));
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const offered = url.searchParams.get('token') ?? '';
      const a = Buffer.from(offered);
      const b = Buffer.from(this.token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        ws.close(4401, 'bad token');
        return;
      }
      ws.on('message', data => void this.onFrame(ws, data.toString()));
    });
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      // Loopback only — the daemon is a resident, not a service.
      this.http.listen(port, '127.0.0.1', () => resolve(port));
    });
  }

  close(): void {
    for (const client of this.wss.clients) client.close(1001, 'daemon shutting down');
    this.wss.close();
    this.http.close();
  }

  private send(ws: WebSocket, frame: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private broadcast(event: string, params: Record<string, unknown>): void {
    for (const client of this.wss.clients) this.send(client, { event, params });
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw);
      if (typeof req.id !== 'number' || typeof req.method !== 'string') throw new Error();
    } catch {
      return; // not a request frame; nothing to answer
    }
    try {
      const result = await this.dispatch(ws, req);
      this.send(ws, { id: req.id, result });
    } catch (err) {
      const code = err instanceof ProviderError ? err.reason : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      this.send(ws, { id: req.id, error: { code, message } });
    }
  }

  private async dispatch(ws: WebSocket, req: RpcRequest): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case 'daemon.info':
        return {
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          pid: process.pid,
          models: this.providers.bindings(),
          skins: { dark: this.cfg.ui.skinDark, light: this.cfg.ui.skinLight },
        };

      case 'session.create':
        return { sessionId: createSession(typeof p.automaton === 'string' ? p.automaton : 'chat') };

      case 'session.list':
        return getDb()
          .prepare('SELECT id, created_at, title, automaton FROM sessions ORDER BY id DESC LIMIT 50')
          .all();

      case 'skins.list':
        return [...this.skins.values()].map(s => ({
          name: s.name, label: s.label, polarity: s.polarity, palette: s.palette,
        }));

      case 'skins.get': {
        const skin = this.skins.get(String(p.name ?? this.cfg.ui.skinDark));
        if (!skin) throw new Error(`no such skin: ${p.name}`);
        return skin;
      }

      case 'chat.send': {
        if (typeof p.text !== 'string' || !p.text.trim()) throw new Error('chat.send needs text');
        const sessionId = typeof p.sessionId === 'number' ? p.sessionId : createSession('chat');
        return this.enqueue(sessionId, () => this.exchange(ws, req.id, sessionId, p.text as string));
      }

      default:
        throw new Error(`unknown method: ${req.method}`);
    }
  }

  /** Per-session serialization — a session is one conversation, in order. */
  private enqueue<T>(sessionId: number, work: () => Promise<T>): Promise<T> {
    const tail = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const run = tail.then(work, work);
    this.sessionQueues.set(sessionId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async exchange(ws: WebSocket, reqId: number, sessionId: number, text: string) {
    saveMessage(sessionId, 'user', text);
    const history = getDb()
      .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, RECENT_WINDOW)
      .reverse() as ChatMessage[];

    const { adapter, model: boundModel } = this.providers.resolve('chat');
    const model = adapter.resolveModel ? await adapter.resolveModel(boundModel) : boundModel;
    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

    const started = Date.now();
    let reply = '';
    const usage: Usage = {};
    for await (const ev of adapter.chat(model, messages)) {
      if (ev.type === 'text') {
        reply += ev.text;
        this.send(ws, { event: 'chat.delta', params: { reqId, text: ev.text } });
      } else if (ev.type === 'usage') {
        if (ev.input != null) usage.inputTokens = ev.input;
        if (ev.output != null) usage.outputTokens = ev.output;
      }
    }

    saveMessage(sessionId, 'assistant', reply, { in: usage.inputTokens, out: usage.outputTokens });
    receipt('model_call', {
      provider: adapter.name, model, role: 'chat',
      ms: Date.now() - started, ...usage,
    }, sessionId);
    this.send(ws, { event: 'chat.done', params: { reqId, sessionId, usage } });
    return { sessionId, text: reply, usage };
  }
}
