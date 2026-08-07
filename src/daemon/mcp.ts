import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { receipt } from './db.js';
import { fence, type BuiltinTool } from './tools.js';
import type { Config } from './config.js';

// MCP client — the ecosystem door (GAPS §3). Deliberately narrow:
// stdio transport only, newline-delimited JSON-RPC, no OAuth, no sampling,
// no elicitation. Each configured server's tools join the dev automaton's
// toolbox as mcp_<server>_<tool> at risk 'exec' — every call passes the
// permission broker like shell does. Tool descriptions are scanned before
// they enter a prompt, and results come back fenced (the Hermes
// _scan_mcp_description lesson, sized to our surface).

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30_000;
const RESULT_CAP = 20_000;

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A hostile description must not become part of our prompt. */
function scanDescription(desc: string | undefined): string {
  if (!desc) return '(no description)';
  const hostile = /ignore\s+(all\s+)?(previous|prior|above)|disregard\s+.{0,20}instructions|system\s*prompt|<\/?system>|IMPORTANT:|do not (tell|reveal)/i;
  return hostile.test(desc)
    ? '[description withheld — failed injection heuristics; the tool may still work]'
    : desc.slice(0, 500);
}

class McpServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  tools: McpToolDef[] = [];

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }, // servers inherit the daemon env; secrets stay in files
    });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on('data', () => { /* server logs are its own business */ });
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`mcp server ${this.name} exited`)); }
      this.pending.clear();
      this.proc = null;
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sepulcher', version: '0.3' },
    });
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {}) as { tools?: McpToolDef[] };
    this.tools = listed.tools ?? [];
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof frame.id !== 'number') continue; // server notifications — ignored in v1
        const waiter = this.pending.get(frame.id);
        if (!waiter) continue;
        this.pending.delete(frame.id);
        clearTimeout(waiter.timer);
        frame.error ? waiter.reject(new Error(frame.error.message ?? 'mcp error')) : waiter.resolve(frame.result);
      } catch { /* partial or non-JSON line — skip */ }
    }
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.proc) throw new Error(`mcp server ${this.name} is not running`);
    this.proc.stdin.write(JSON.stringify(frame) + '\n');
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${this.name}.${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name: tool, arguments: args }) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n')
      .slice(0, RESULT_CAP);
    if (result.isError) throw new Error(text || 'tool reported an error');
    return text || '(empty result)';
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

const servers = new Map<string, McpServer>();

/** Boot-time connect; a server that fails to start is receipted and skipped. */
export async function initMcp(cfg: Config): Promise<void> {
  for (const [name, entry] of Object.entries(cfg.mcp.servers)) {
    const server = new McpServer(name, entry.command, entry.args);
    try {
      await server.start();
      servers.set(name, server);
      receipt('mcp_connect', { server: name, tools: server.tools.map(t => t.name) });
    } catch (err) {
      receipt('mcp_error', { server: name, error: String(err).slice(0, 200) });
      server.stop();
    }
  }
}

export function stopMcp(): void {
  for (const server of servers.values()) server.stop();
  servers.clear();
}

export function mcpStatus(): { server: string; tools: number }[] {
  return [...servers.values()].map(s => ({ server: s.name, tools: s.tools.length }));
}

const sane = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);

/** The connected servers' tools, shaped for the agent's toolbox. */
export function mcpToolbox(): Record<string, BuiltinTool> {
  const box: Record<string, BuiltinTool> = {};
  for (const server of servers.values()) {
    for (const tool of server.tools) {
      const name = `mcp_${sane(server.name)}_${sane(tool.name)}`;
      box[name] = {
        risk: 'exec', // unknown code on the other end — gated like shell, always
        spec: {
          name,
          description: `[${server.name}] ${scanDescription(tool.description)}`,
          parameters: (tool.inputSchema as BuiltinTool['spec']['parameters']) ?? { type: 'object', properties: {} },
        },
        handler: async args => fence(await server.call(tool.name, args)),
      };
    }
  }
  return box;
}
