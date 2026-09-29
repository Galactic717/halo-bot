// The user's own n8n workflows.
import { activateWorkflow, getWorkflow, listExecutions, listWorkflows, runWorkflow, saveWorkflow } from '../n8n.ts';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, clip, type Tool } from './core.ts';

export const AUTOMATION_TOOLS: Tool[] = [

  // ---- the user's own automation -------------------------------------------------
  //
  // Halo will never have a Calendar tool, a Notion tool and a Shopify tool that are as good as the
  // real ones. A lot of people already keep those, wired up and authorised, in an n8n instance. A bot
  // that can read, write and fire an n8n workflow inherits every service they have already connected,
  // and the credentials stay in n8n rather than arriving here. See host/n8n.ts.

  {
    schema: {
      name: 'N8nWorkflows',
      description:
        "List the workflows on the user's n8n, with their ids and whether they are active. Read this before " +
        'you touch anything: the id is what every other n8n tool takes.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      return { output: clip(await listWorkflows(ctx.store.getSettings(), ctx.signal)) };
    },
  },

  {
    schema: {
      name: 'N8nWorkflow',
      description:
        'Read one workflow as JSON — its nodes, its connections and its webhook paths. Read it before you edit ' +
        'it, and send the whole thing back to N8nSaveWorkflow so you change it rather than replace it.',
      parameters: { type: 'object', properties: { workflow_id: { type: 'string' } }, required: ['workflow_id'] },
    },
    async run(ctx, args) {
      return { output: clip(await getWorkflow(ctx.store.getSettings(), str(args.workflow_id), ctx.signal)) };
    },
  },

  {
    schema: {
      name: 'N8nSaveWorkflow',
      description:
        "Create a workflow on the user's n8n, or replace an existing one. Needs approval. The workflow is n8n's " +
        'own JSON: nodes and connections. A new one arrives inactive — say so, and let the user activate it.',
      parameters: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: "The workflow JSON: { name, nodes, connections }." },
          name: { type: 'string', description: 'Overrides the name inside the JSON.' },
          workflow_id: { type: 'string', description: 'Set to replace an existing workflow; omit to create one.' },
        },
        required: ['workflow'],
      },
    },
    surface: 'automation',
    async run(ctx, args) {
      return {
        output: await saveWorkflow(
          ctx.store.getSettings(),
          {
            workflow: str(args.workflow),
            ...(str(args.name) ? { name: str(args.name) } : {}),
            ...(str(args.workflow_id) ? { workflowId: str(args.workflow_id) } : {}),
          },
          ctx.signal,
        ),
      };
    },
  },

  {
    schema: {
      name: 'N8nActivateWorkflow',
      description: 'Turn a workflow on or off. Needs approval: an active workflow keeps running after you stop.',
      parameters: {
        type: 'object',
        properties: { workflow_id: { type: 'string' }, active: { type: 'boolean' } },
        required: ['workflow_id'],
      },
    },
    surface: 'automation',
    async run(ctx, args) {
      return {
        output: await activateWorkflow(ctx.store.getSettings(), str(args.workflow_id), args.active !== false, ctx.signal),
      };
    },
  },

  {
    schema: {
      name: 'N8nRunWorkflow',
      description:
        'Fire a workflow by calling its webhook, and get back what it answered. Needs approval. n8n has no ' +
        '"run this" API — a workflow starts from its trigger — so this only works on one with a Webhook node, ' +
        'and the path is the one that node shows.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The webhook path from the Webhook node, or a full url.' },
          method: { type: 'string', description: 'POST unless the node says otherwise.' },
          body: { type: 'string', description: 'JSON body to send.' },
          test: { type: 'boolean', description: 'Use the test webhook, which needs "Test workflow" pressed in n8n.' },
        },
        required: ['path'],
      },
    },
    surface: 'automation',
    async run(ctx, args) {
      return {
        output: clip(
          await runWorkflow(
            ctx.store.getSettings(),
            {
              path: str(args.path),
              ...(str(args.method) ? { method: str(args.method) } : {}),
              ...(str(args.body) ? { body: str(args.body) } : {}),
              ...(args.test === true ? { test: true } : {}),
            },
            ctx.signal,
          ),
        ),
      };
    },
  },

  {
    schema: {
      name: 'N8nExecutions',
      description: 'Recent executions, newest first — how you check whether the workflow you built actually ran.',
      parameters: { type: 'object', properties: { workflow_id: { type: 'string' } } },
    },
    async run(ctx, args) {
      return {
        output: clip(await listExecutions(ctx.store.getSettings(), str(args.workflow_id) || undefined, ctx.signal)),
      };
    },
  },
];
