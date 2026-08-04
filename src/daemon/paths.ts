import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const HOME = process.env.HEPHAESTUS_HOME ?? join(homedir(), '.hephaestus');

export const paths = {
  home: HOME,
  config: join(HOME, 'config.toml'),
  secrets: join(HOME, 'secrets'),
  token: join(HOME, 'daemon.token'),
  state: join(HOME, 'daemon.json'),
  db: join(HOME, 'core.db'),
  skins: join(HOME, 'skins'),
  fonts: join(HOME, 'fonts'),
  logs: join(HOME, 'logs'),
};

export function ensureHome(): void {
  for (const dir of [HOME, paths.skins, paths.fonts, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Loopback auth token — created 0600 on first touch, stable after. */
export function loadToken(): string {
  if (!existsSync(paths.token)) {
    writeFileSync(paths.token, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  }
  return readFileSync(paths.token, 'utf8').trim();
}

/** KEY=VALUE secrets file; env always wins so keys never need to touch disk. */
export function getSecret(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (!existsSync(paths.secrets)) return undefined;
  for (const line of readFileSync(paths.secrets, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim();
  }
  return undefined;
}
