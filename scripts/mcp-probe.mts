import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpManager } from '../host/mcp.ts';

const settingsPath = join(process.env.APPDATA ?? '', 'Halo Bot', 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { plugins: any[] };
console.log('installed plugins:', settings.plugins.map((p) => p.id).join(', ') || '(none)');

const manager = new McpManager(() => settings.plugins);
await manager.startAll();
console.log('statuses:', JSON.stringify(manager.statuses()));
console.log('tools exposed to bots:');
for (const tool of manager.toolSchemas()) console.log(' -', tool.name, '—', tool.description.slice(0, 70));
manager.stopAll();
process.exit(0);
