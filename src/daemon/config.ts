import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { paths } from './paths.js';

export interface Config {
  daemon: { port: number };
  models: Record<'chat' | 'agent' | 'utility' | 'embed', string>;
  providers: {
    ollama: { url: string };
    anthropic: { modelDefault: string };
  };
  ui: { skinDark: string; skinLight: string; pet: boolean };
  user: { name: string };
  channels: { telegram: { ownerId: string | null } };
  memory: {
    captureEvery: number;   // user turns between capture∘curate passes
    recentWindow: number;   // verbatim messages in the prompt
    foldChunk: number;      // messages folded into one episode
    coreBudget: number;     // chars — the always-visible tier-1 budget
    compactThreshold: number; // est. tokens before an agent run compacts
  };
  mcp: {
    servers: Record<string, { command: string; args: string[] }>;
  };
  // Voice is chrome, not craft: this colors CHAT ONLY. It is injected into
  // the chat automaton's identity and nowhere else — never the dev or
  // governance charters, never work products.
  voice: {
    tone: string;   // plain | warm | dry
    notes: string;  // freeform: how the workspace should sound in conversation
  };
  permissions: {
    /** ask — every write/exec asks (default). auto — writes flow, exec
     *  still asks. bypass — everything flows. The hardline list blocks in
     *  ALL modes; there is no mode that approves the unapprovable. */
    mode: 'ask' | 'auto' | 'bypass';
  };
}

const DEFAULTS: Config = {
  daemon: { port: 7715 },
  models: {
    // "provider/model"; "ollama/auto" binds to the first chat-capable
    // local model at runtime so a fresh install works with zero editing.
    chat: 'ollama/auto',
    agent: 'ollama/auto',
    utility: 'ollama/auto',
    embed: 'ollama/nomic-embed-text',
  },
  providers: {
    ollama: { url: 'http://127.0.0.1:11434' },
    anthropic: { modelDefault: 'claude-sonnet-5' },
  },
  ui: { skinDark: 'forge', skinLight: 'daybreak', pet: false },
  user: { name: 'the user' },
  channels: { telegram: { ownerId: null } },
  memory: { captureEvery: 8, recentWindow: 40, foldChunk: 30, coreBudget: 2200, compactThreshold: 16000 },
  mcp: { servers: {} },
  voice: { tone: 'plain', notes: '' },
  permissions: { mode: 'ask' },
};

const DEFAULT_TOML = `# Hephaestus — ~/.hephaestus/config.toml
# Model roles bind "provider/model". Providers: ollama, anthropic.
# "ollama/auto" picks the first chat-capable model Ollama reports.

[daemon]
port = 7715

[models]
chat = "ollama/auto"
agent = "ollama/auto"
utility = "ollama/auto"
embed = "ollama/nomic-embed-text"

[providers.ollama]
url = "http://127.0.0.1:11434"

[providers.anthropic]
# API key comes from $ANTHROPIC_API_KEY or ~/.hephaestus/secrets — never here.
model_default = "claude-sonnet-5"

[ui]
skin_dark = "forge"
skin_light = "daybreak"
`;

/** Regenerate config.toml from the live config. Settings-panel writes come
 *  through here; the generated file keeps its guidance comments. */
export function saveConfig(cfg: Config): void {
  const toml = `# Hephaestus — ~/.hephaestus/config.toml
# Model roles bind "provider/model". Providers: ollama, anthropic.
# "ollama/auto" picks the first chat-capable model Ollama reports.

[daemon]
port = ${cfg.daemon.port}

[models]
chat = ${JSON.stringify(cfg.models.chat)}
agent = ${JSON.stringify(cfg.models.agent)}
utility = ${JSON.stringify(cfg.models.utility)}
embed = ${JSON.stringify(cfg.models.embed)}

[providers.ollama]
url = ${JSON.stringify(cfg.providers.ollama.url)}

[providers.anthropic]
# API key comes from $ANTHROPIC_API_KEY or ~/.hephaestus/secrets — never here.
model_default = ${JSON.stringify(cfg.providers.anthropic.modelDefault)}

[ui]
skin_dark = ${JSON.stringify(cfg.ui.skinDark)}
skin_light = ${JSON.stringify(cfg.ui.skinLight)}
pet = ${cfg.ui.pet}

[user]
name = ${JSON.stringify(cfg.user.name)}
${cfg.channels.telegram.ownerId ? `
[channels.telegram]
owner_id = ${JSON.stringify(cfg.channels.telegram.ownerId)}
` : ''}
[voice]
# Chat register only — work products always stay neutral (voice is chrome).
tone = ${JSON.stringify(cfg.voice.tone)}
notes = ${JSON.stringify(cfg.voice.notes)}

[permissions]
# ask (everything asks) | auto (writes flow, exec asks) | bypass (all flows).
# The hardline list blocks in every mode.
mode = ${JSON.stringify(cfg.permissions.mode)}

[memory]
capture_every = ${cfg.memory.captureEvery}
recent_window = ${cfg.memory.recentWindow}
fold_chunk = ${cfg.memory.foldChunk}
core_budget = ${cfg.memory.coreBudget}
compact_threshold = ${cfg.memory.compactThreshold}
${Object.entries(cfg.mcp.servers).map(([name, s]) => `
[mcp.servers.${name}]
command = ${JSON.stringify(s.command)}
args = [${s.args.map(a => JSON.stringify(a)).join(', ')}]
`).join('')}`;
  writeFileSync(paths.config, toml);
}

/** First run writes the annotated default; after that the file is truth. */
export function loadConfig(): Config {
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, DEFAULT_TOML);
    return structuredClone(DEFAULTS);
  }
  const raw = parse(readFileSync(paths.config, 'utf8')) as Record<string, any>;
  const cfg = structuredClone(DEFAULTS);
  if (typeof raw.daemon?.port === 'number') cfg.daemon.port = raw.daemon.port;
  for (const role of ['chat', 'agent', 'utility', 'embed'] as const) {
    if (typeof raw.models?.[role] === 'string') cfg.models[role] = raw.models[role];
  }
  if (typeof raw.providers?.ollama?.url === 'string') cfg.providers.ollama.url = raw.providers.ollama.url;
  if (typeof raw.providers?.anthropic?.model_default === 'string') {
    cfg.providers.anthropic.modelDefault = raw.providers.anthropic.model_default;
  }
  if (typeof raw.ui?.skin_dark === 'string') cfg.ui.skinDark = raw.ui.skin_dark;
  if (typeof raw.ui?.skin_light === 'string') cfg.ui.skinLight = raw.ui.skin_light;
  if (typeof raw.ui?.pet === 'boolean') cfg.ui.pet = raw.ui.pet;
  if (typeof raw.user?.name === 'string') cfg.user.name = raw.user.name;
  const rawOwner = raw.channels?.telegram?.owner_id;
  if (typeof rawOwner === 'string' || typeof rawOwner === 'number') {
    cfg.channels.telegram.ownerId = String(rawOwner);
  }
  if (typeof raw.memory?.capture_every === 'number') cfg.memory.captureEvery = raw.memory.capture_every;
  if (typeof raw.memory?.recent_window === 'number') cfg.memory.recentWindow = raw.memory.recent_window;
  if (typeof raw.memory?.fold_chunk === 'number') cfg.memory.foldChunk = raw.memory.fold_chunk;
  if (typeof raw.memory?.core_budget === 'number') cfg.memory.coreBudget = raw.memory.core_budget;
  if (typeof raw.memory?.compact_threshold === 'number') cfg.memory.compactThreshold = raw.memory.compact_threshold;
  const voice = raw.voice as { tone?: unknown; notes?: unknown } | undefined;
  if (typeof voice?.tone === 'string') cfg.voice.tone = voice.tone;
  if (typeof voice?.notes === 'string') cfg.voice.notes = voice.notes;
  const perms = raw.permissions as { mode?: unknown } | undefined;
  if (perms?.mode === 'ask' || perms?.mode === 'auto' || perms?.mode === 'bypass') cfg.permissions.mode = perms.mode;
  // [mcp.servers.<name>] command = "npx", args = ["-y", "@scope/server", ...]
  const mcpServers = (raw.mcp as { servers?: Record<string, { command?: unknown; args?: unknown }> } | undefined)?.servers ?? {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (typeof entry?.command === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      cfg.mcp.servers[name] = {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      };
    }
  }
  return cfg;
}
