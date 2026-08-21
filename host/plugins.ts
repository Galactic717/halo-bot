import type { McpServerSpec } from './mcp.ts';

/**
 * The marketplace shelves, in the order they appear.
 * They live here rather than beside the catalogue because the renderer imports this module, and
 * the catalogue reads `process` to build its command lines.
 */
export const PLUGIN_CATEGORIES = [
  'Agent Orchestration',
  'Canvas',
  'Customer Support',
  'Data Analytics',
  'Design',
  'Finance And Legal',
  'Inbox And Collaboration',
  'Infrastructure',
  'MCP',
  'Payments',
  'Productivity',
  'Research',
  'Sales',
  'Scheduling',
] as const;

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** The chips above the shelves. "All" and "Featured" are views, not categories. */
export const PLUGIN_FILTERS = ['All', 'Featured', ...PLUGIN_CATEGORIES] as const;
export type PluginFilter = (typeof PLUGIN_FILTERS)[number];

/** How many of a shelf's plugins the "All" view shows before it defers to "View all". */
export const SHELF_LIMIT = 4;

export interface PluginShelf {
  /** Category name, "Featured", or "Results" for a search. */
  title: string;
  plugins: McpServerSpec[];
  /** Plugins beyond the ones shown; zero means there is nothing more to see. */
  hidden: number;
  /** The chip "View all" switches to, when there is one. */
  filter?: PluginFilter;
}

/**
 * Subsequence match with a score, the way the original's search behaves: an exact name wins,
 * then a prefix, then a name substring, then anything the query threads through in order.
 */
export function fuzzyScore(query: string, name: string, description = ''): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const haystack = name.toLowerCase();

  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 900 - haystack.length;
  if (haystack.includes(needle)) return 700 - haystack.indexOf(needle);
  if (description.toLowerCase().includes(needle)) return 500;

  // Every character of the query, in order, somewhere in the name: "gcal" finds "Google Calendar".
  let at = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) return 0;
    gaps += found - at;
    at = found + 1;
  }
  return Math.max(1, 300 - gaps);
}

function matches(spec: McpServerSpec, filter: PluginFilter): boolean {
  if (filter === 'All') return true;
  if (filter === 'Featured') return spec.featured === true;
  return spec.category === filter;
}

/**
 * What the marketplace shows for one chip and one query.
 * A query flattens the shelves into a single ranked "Results" list, exactly like the original;
 * without one, "All" lays the categories out in order and every other chip shows its own list.
 */
export function shelves(catalog: McpServerSpec[], filter: PluginFilter, query: string): PluginShelf[] {
  const scoped = catalog.filter((spec) => matches(spec, filter));
  const needle = query.trim();

  if (needle) {
    const ranked = scoped
      .map((spec) => ({ spec, score: fuzzyScore(needle, spec.name, spec.description) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.spec.name.localeCompare(b.spec.name))
      .map((row) => row.spec);
    return [{ title: 'Results', plugins: ranked, hidden: 0 }];
  }

  if (filter !== 'All') {
    return [{ title: filter, plugins: scoped, hidden: 0 }];
  }

  const out: PluginShelf[] = [];
  const featured = scoped.filter((spec) => spec.featured);
  if (featured.length > 0) {
    out.push({
      title: 'Featured',
      plugins: featured.slice(0, SHELF_LIMIT),
      hidden: Math.max(0, featured.length - SHELF_LIMIT),
      filter: 'Featured',
    });
  }
  for (const category of PLUGIN_CATEGORIES) {
    const plugins = scoped.filter((spec) => spec.category === category);
    if (plugins.length === 0) continue;
    out.push({
      title: category,
      plugins: plugins.slice(0, SHELF_LIMIT),
      hidden: Math.max(0, plugins.length - SHELF_LIMIT),
      filter: category as PluginCategory,
    });
  }
  return out;
}

/** Installed plugins for the "Your plugins" view, filtered by the same search box. */
export function filterInstalled(installed: McpServerSpec[], query: string): McpServerSpec[] {
  const needle = query.trim();
  if (!needle) return [...installed].sort((a, b) => a.name.localeCompare(b.name));
  return installed
    .map((spec) => ({ spec, score: fuzzyScore(needle, spec.name, spec.description) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.spec.name.localeCompare(b.spec.name))
    .map((row) => row.spec);
}
