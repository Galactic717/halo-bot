import type { Agent, Routine, RoutineTrigger } from './types.ts';

export interface PortableSkill {
  file: string;
  body: string;
}

export interface PortableBot {
  kind: 'halo-bot';
  version: 1;
  agent: Pick<Agent, 'name' | 'title' | 'description' | 'avatar'> & { model?: string };
  memory: string;
  skills: PortableSkill[];
  routines: { name: string; prompt: string; triggers: RoutineTrigger[]; enabled: boolean }[];
}

export function buildPortableBot(input: {
  agent: Agent;
  memory: string;
  skills: PortableSkill[];
  routines: Routine[];
}): PortableBot {
  return {
    kind: 'halo-bot',
    version: 1,
    agent: {
      name: input.agent.name,
      title: input.agent.title,
      description: input.agent.description,
      avatar: { color: input.agent.avatar.color, face: input.agent.avatar.face },
      ...(input.agent.model ? { model: input.agent.model } : {}),
    },
    memory: input.memory,
    skills: input.skills,
    routines: input.routines.map((routine) => ({
      name: routine.name,
      prompt: routine.prompt,
      triggers: routine.triggers,
      enabled: routine.enabled,
    })),
  };
}

/** Returns null for anything that is not a Halo bot file, so a bad import fails loudly but safely. */
export function parsePortableBot(raw: unknown): PortableBot | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'halo-bot') return null;

  const agent = value.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent.name !== 'string' || agent.name.trim().length === 0) return null;

  const skills = Array.isArray(value.skills)
    ? (value.skills as Record<string, unknown>[])
        .filter((skill) => typeof skill?.file === 'string' && typeof skill?.body === 'string')
        .map((skill) => ({ file: String(skill.file), body: String(skill.body) }))
    : [];

  const routines = Array.isArray(value.routines)
    ? (value.routines as Record<string, unknown>[])
        .filter((routine) => typeof routine?.name === 'string' && Array.isArray(routine.triggers) && routine.triggers.length > 0)
        .map((routine) => ({
          name: String(routine.name),
          prompt: String(routine.prompt ?? ''),
          triggers: routine.triggers as RoutineTrigger[],
          enabled: routine.enabled !== false,
        }))
    : [];

  return {
    kind: 'halo-bot',
    version: 1,
    agent: {
      name: String(agent.name),
      title: String(agent.title ?? ''),
      description: String(agent.description ?? ''),
      avatar: {
        color: String((agent.avatar as Record<string, unknown>)?.color ?? 'blue'),
        face: Number((agent.avatar as Record<string, unknown>)?.face ?? 0),
      },
      ...(typeof agent.model === 'string' && agent.model ? { model: agent.model } : {}),
    },
    memory: typeof value.memory === 'string' ? value.memory : '',
    skills,
    routines,
  };
}
