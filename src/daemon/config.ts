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
  ui: { skinDark: string; skinLight: string };
  user: { name: string };
  memory: {
    captureEvery: number;   // user turns between capture∘curate passes
    recentWindow: number;   // verbatim messages in the prompt
    foldChunk: number;      // messages folded into one episode
    coreBudget: number;     // chars — the always-visible tier-1 budget
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
  ui: { skinDark: 'forge', skinLight: 'daybreak' },
  user: { name: 'the user' },
  memory: { captureEvery: 8, recentWindow: 40, foldChunk: 30, coreBudget: 2200 },
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
  if (typeof raw.user?.name === 'string') cfg.user.name = raw.user.name;
  if (typeof raw.memory?.capture_every === 'number') cfg.memory.captureEvery = raw.memory.capture_every;
  if (typeof raw.memory?.recent_window === 'number') cfg.memory.recentWindow = raw.memory.recent_window;
  if (typeof raw.memory?.fold_chunk === 'number') cfg.memory.foldChunk = raw.memory.fold_chunk;
  if (typeof raw.memory?.core_budget === 'number') cfg.memory.coreBudget = raw.memory.core_budget;
  return cfg;
}
