import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { paths } from './paths.js';
import { receipt } from './db.js';

// Procedural memory — the routing triad's third leg (FORGE_NOTES §2.5):
// facts → memory, procedures → skills, task progress → the transcript.
// Format-compatible with the agentskills.io standard: a directory per
// skill holding SKILL.md with YAML frontmatter (name, description).

export interface SkillMeta {
  name: string;
  description: string;
}

const skillsDir = () => join(paths.home, 'skills');

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  try {
    return { meta: (parse(match[1]) as Record<string, unknown>) ?? {}, body: match[2] };
  } catch {
    return { meta: {}, body: raw };
  }
}

export function listSkills(): SkillMeta[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  const skills: SkillMeta[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { meta } = parseFrontmatter(readFileSync(file, 'utf8'));
    skills.push({
      name: String(meta.name ?? name),
      description: String(meta.description ?? '(no description)'),
    });
  }
  return skills;
}

export function readSkill(name: string): string | null {
  // Directory name is the identity; reject path tricks before touching fs.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  const file = join(skillsDir(), name, 'SKILL.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Create or update a skill. Curation archives, never deletes — an update
 *  keeps the old body as SKILL.md.<timestamp>.bak beside it. */
export function saveSkill(name: string, description: string, body: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error('skill name must be kebab-case: lowercase letters, digits, hyphens');
  }
  const dir = join(skillsDir(), name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  const existed = existsSync(file);
  if (existed) {
    writeFileSync(join(dir, `SKILL.md.${Date.now()}.bak`), readFileSync(file));
  }
  const doc = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
  writeFileSync(file, doc);
  receipt('skill_save', { name, updated: existed, chars: body.length });
  return existed ? `updated skill "${name}" (previous body archived)` : `created skill "${name}"`;
}
