import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';
import type { Skill } from './types.ts';

/**
 * Skills are reusable recipes ("use this when …"), separate from routines:
 * a routine fires on a schedule, a skill is looked up when it applies.
 */
export class SkillStore {
  private dir: string;

  constructor(store: Store, agentId: string) {
    this.dir = join(store.agentDir(agentId), 'skills');
    mkdirSync(this.dir, { recursive: true });
  }

  private slug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'skill';
  }

  list(): Skill[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((file) => {
        const raw = readFileSync(join(this.dir, file), 'utf8');
        const name = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? file.replace(/\.md$/, '');
        const description = /^>\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? '';
        const body = raw.replace(/^#.*$/m, '').replace(/^>.*$/m, '').trim();
        return { id: file.replace(/\.md$/, ''), name, description, body, updatedAt: 0 };
      });
  }

  read(nameOrId: string): Skill | undefined {
    const key = this.slug(nameOrId);
    return this.list().find((s) => s.id === key || this.slug(s.name) === key);
  }

  write(name: string, description: string, body: string): Skill {
    const id = this.slug(name);
    const content = `# ${name.trim()}\n> ${description.trim()}\n\n${body.trim()}\n`;
    writeFileSync(join(this.dir, `${id}.md`), content, 'utf8');
    return { id, name: name.trim(), description: description.trim(), body: body.trim(), updatedAt: Date.now() };
  }

  delete(nameOrId: string): boolean {
    const skill = this.read(nameOrId);
    if (!skill) return false;
    rmSync(join(this.dir, `${skill.id}.md`), { force: true });
    return true;
  }
}
