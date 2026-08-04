import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep, relative } from 'node:path';
import type { ToolSpec } from '../providers/types.js';
import { addFact } from './memory.js';
import { receipt } from './db.js';
import { listSkills, readSkill, saveSkill } from './skills-lib.js';

const execFileAsync = promisify(execFile);

// The narrow waist: few tools, small schemas — every core tool costs
// tokens on every call (the Hermes lesson). Capability arrives later as
// MCP servers and skills, not as more built-ins.

export type Risk = 'read' | 'write' | 'exec';

export interface ToolContext {
  root: string;        // project root — fs tools are confined to it
  sessionId: number;
}

export interface BuiltinTool {
  spec: ToolSpec;
  risk: Risk;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const RESULT_CAP = 24_000; // chars per tool result — the window is finite

function cap(text: string): string {
  return text.length > RESULT_CAP
    ? text.slice(0, RESULT_CAP) + `\n[truncated — ${text.length} chars total]`
    : text;
}

/** Confinement: every fs path resolves inside the project root, or the call
 *  dies before touching disk. The shell can't be confined this way — that's
 *  what the approval gate is for. */
function confine(root: string, p: string): string {
  const abs = resolve(root, p);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  return abs;
}

export const TOOLS: Record<string, BuiltinTool> = {
  fs_read: {
    risk: 'read',
    spec: {
      name: 'fs_read',
      description: 'Read a file inside the project root. Returns the text content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'path relative to project root' } },
        required: ['path'],
      },
    },
    async handler(args, ctx) {
      return cap(readFileSync(confine(ctx.root, String(args.path)), 'utf8'));
    },
  },

  fs_write: {
    risk: 'write',
    spec: {
      name: 'fs_write',
      description: 'Write (create or overwrite) a file inside the project root with the given content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    async handler(args, ctx) {
      const abs = confine(ctx.root, String(args.path));
      mkdirSync(dirname(abs), { recursive: true });
      const existed = existsSync(abs);
      writeFileSync(abs, String(args.content));
      // Artifact receipt — the shell's Artifacts view is a query over these.
      receipt('artifact', {
        path: abs, rel: relative(ctx.root, abs), root: ctx.root,
        bytes: String(args.content).length, updated: existed,
      }, ctx.sessionId);
      return `${existed ? 'overwrote' : 'created'} ${relative(ctx.root, abs)} (${String(args.content).length} chars)`;
    },
  },

  fs_list: {
    risk: 'read',
    spec: {
      name: 'fs_list',
      description: 'List files under a directory in the project root (recursive, skips node_modules/.git, max 200 entries).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'directory, default "."' } },
      },
    },
    async handler(args, ctx) {
      const start = confine(ctx.root, String(args.path ?? '.'));
      const out: string[] = [];
      const walk = (dir: string) => {
        if (out.length >= 200) return;
        for (const name of readdirSync(dir).sort()) {
          if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else out.push(`${relative(ctx.root, full)} (${st.size}b)`);
          if (out.length >= 200) return;
        }
      };
      walk(start);
      return cap(out.join('\n') || '(empty)');
    },
  },

  fs_grep: {
    risk: 'read',
    spec: {
      name: 'fs_grep',
      description: 'Search file contents in the project root for a pattern (fixed string or regex). Returns matching lines with file:line.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'directory to search, default "."' },
        },
        required: ['pattern'],
      },
    },
    async handler(args, ctx) {
      const dir = confine(ctx.root, String(args.path ?? '.'));
      try {
        const { stdout } = await execFileAsync('grep', [
          '-rn', '--include=*', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
          '-E', String(args.pattern), dir,
        ], { maxBuffer: 1024 * 1024, timeout: 15_000 });
        return cap(stdout.split('\n').map(l => l.replace(dir + sep, '')).join('\n'));
      } catch (err: any) {
        if (err.code === 1) return '(no matches)';
        throw err;
      }
    },
  },

  shell: {
    risk: 'exec',
    spec: {
      name: 'shell',
      description: 'Run a shell command with cwd at the project root. Use for builds, tests, git. Output is stdout+stderr, truncated.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    async handler(args, ctx) {
      try {
        const { stdout, stderr } = await execFileAsync('/bin/zsh', ['-c', String(args.command)], {
          cwd: ctx.root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
        });
        return cap([stdout, stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)');
      } catch (err: any) {
        // Non-zero exit is information, not an exception — the agent needs
        // to see the failure output to fix it.
        const out = [err.stdout, err.stderr].filter(Boolean).join('\n--- stderr ---\n');
        return cap(`[exit ${err.code ?? 'signal ' + err.signal}]\n${out || err.message}`);
      }
    },
  },

  memory_save: {
    risk: 'read', // writes memory, not the world — receipted, soft-deletable
    spec: {
      name: 'memory_save',
      description: 'Save a durable fact to workspace memory. Declarative, timeless phrasing ("Austin prefers X", never "Always do X"). Facts only — not task progress, not procedures.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          category: { type: 'string', enum: ['user', 'project', 'decision', 'preference', 'reference', 'general'] },
          importance: { type: 'number', description: '1-10' },
        },
        required: ['content'],
      },
    },
    async handler(args, ctx) {
      const id = addFact({
        content: String(args.content),
        category: typeof args.category === 'string' ? args.category : 'general',
        importance: typeof args.importance === 'number' ? args.importance : 6,
        source: 'tool',
        sourceSession: ctx.sessionId,
      });
      return `saved fact #${id}`;
    },
  },
};

TOOLS.skills_list = {
  risk: 'read',
  spec: {
    name: 'skills_list',
    description: 'List available skills (saved procedures). Check before starting a multi-step task — a known procedure beats improvisation.',
    parameters: { type: 'object', properties: {} },
  },
  async handler() {
    const skills = listSkills();
    return skills.length
      ? skills.map(s => `${s.name} — ${s.description}`).join('\n')
      : '(no skills saved yet)';
  },
};

TOOLS.skill_view = {
  risk: 'read',
  spec: {
    name: 'skill_view',
    description: 'Read a skill by name — the full procedure document.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  async handler(args) {
    return readSkill(String(args.name)) ?? `no such skill: ${args.name}`;
  },
};

TOOLS.skill_save = {
  risk: 'write',
  spec: {
    name: 'skill_save',
    description: 'Save a reusable PROCEDURE as a skill (kebab-case name). Procedures only — how to do something worth repeating. Facts belong in memory_save; task progress belongs nowhere (the transcript has it). Updates archive the previous body.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case identifier' },
        description: { type: 'string', description: 'one line: when to reach for this skill' },
        body: { type: 'string', description: 'the procedure, markdown' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  async handler(args) {
    return saveSkill(String(args.name), String(args.description), String(args.body));
  },
};

export function toolSpecs(names: string[]): ToolSpec[] {
  return names.filter(n => TOOLS[n]).map(n => TOOLS[n].spec);
}
