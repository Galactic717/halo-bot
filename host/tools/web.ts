// Search, fetch, the bot's own browser, images.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, clip, htmlToText, type Tool } from './core.ts';

export const WEB_TOOLS: Tool[] = [
  {
    schema: {
      name: 'WebSearch',
      description: 'Search the web and get back result titles, urls and snippets.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    async run(ctx, args) {
      const settings = ctx.store.getSettings();
      if (!settings.webSearch.enabled) return { output: 'Web search is disabled in settings.', isError: true };
      const url = `${settings.webSearch.endpoint}${encodeURIComponent(str(args.query))}`;
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 HaloBot' }, signal: ctx.signal });
      if (!res.ok) return { output: `Search failed: ${res.status}`, isError: true };
      const html = await res.text();
      const out: string[] = [];
      const seen = new Set<string>();
      // Two shapes of the same page: the classed result link, and the bare redirect link it degrades to.
      const patterns = [
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
        /<a[^>]+href="(\/\/duckduckgo\.com\/l\/\?uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && out.length < 10) {
          const raw = (m[1] ?? '').replace(/^.*uddg=/, '').split('&')[0] ?? '';
          let url = raw;
          try { url = decodeURIComponent(raw); } catch { /* leave it as sent */ }
          const title = htmlToText(m[2] ?? '');
          if (!url || !title || seen.has(url)) continue;
          seen.add(url);
          out.push(`${out.length + 1}. ${title}\n   ${url}`);
        }
        if (out.length > 0) break;
      }
      if (out.length > 0) return { output: out.join('\n') };
      // No links at all usually means a bot check, not an empty result set. Say which it is.
      const text = htmlToText(html);
      if (/unusual traffic|are you a robot|captcha|challenge/i.test(text)) {
        return {
          output: 'The search engine served a bot check instead of results. Use WebFetch on a specific url, or the Browser tool.',
          isError: true,
        };
      }
      return { output: clip(text.slice(0, 3000)) };
    },
  },

  {
    schema: {
      name: 'WebFetch',
      description: 'Fetch a url and return its readable text.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    async run(ctx, args) {
      const res = await fetch(str(args.url), { headers: { 'user-agent': 'Mozilla/5.0 HaloBot' }, signal: ctx.signal });
      if (!res.ok) return { output: `Fetch failed: ${res.status} ${res.statusText}`, isError: true };
      const type = res.headers.get('content-type') ?? '';
      const body = await res.text();
      return { output: clip(type.includes('html') ? htmlToText(body) : body) };
    },
  },

  {
    schema: {
      name: 'Browser',
      description:
        'Drive the browser on your computer - this is how you use websites and apps the user is already signed into. Actions: navigate, read, snapshot, click, type, press, scroll, back, screenshot. Take a snapshot before you click or type: it lists the controls on the page with a ref each, and acting by ref is what makes the action land on the thing you actually saw.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['navigate', 'read', 'snapshot', 'click', 'type', 'press', 'scroll', 'back', 'screenshot'] },
          url: { type: 'string' },
          ref: { type: 'string', description: 'A ref from the last snapshot, e.g. "e12". Preferred over selector.' },
          selector: { type: 'string', description: 'CSS selector, or visible text. Only when you have no ref.' },
          text: { type: 'string' },
          key: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['action'],
      },
    },
    surface: 'browser',
    async run(ctx, args) {
      const action = str(args.action, 'read');
      await ctx.computer.ensure(ctx.agentId);
      if (action === 'navigate') {
        const r = await ctx.computer.navigate(ctx.agentId, str(args.url));
        return { output: `Now on ${r.title} - ${r.url}` };
      }
      if (action === 'read') return { output: clip(await ctx.computer.readPage(ctx.agentId)) };
      if (action === 'snapshot') return { output: clip(await ctx.computer.snapshot(ctx.agentId)) };
      if (action === 'screenshot') {
        const path = await ctx.computer.screenshot(ctx.agentId);
        return { output: `Screenshot saved to ${path}`, imagePath: path };
      }
      return { output: clip(await ctx.computer.act(ctx.agentId, action, args)) };
    },
  },

  {
    schema: {
      name: 'Screenshot',
      // It captures the browser view and nothing else. The old wording said "your computer's screen",
      // which invited a bot to promise the user a look at their desktop and then hand them a web page.
      description: 'Take a picture of the page your browser is showing and save it into your box. This is your browser, not the user\'s desktop — Halo never captures that.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      await ctx.computer.ensure(ctx.agentId);
      const path = await ctx.computer.screenshot(ctx.agentId);
      return { output: `Screenshot saved to ${path}`, imagePath: path };
    },
  },

  {
    schema: {
      name: 'GenerateImage',
      description:
        'Make a picture from a description — an icon, a mockup, an illustration. Never use it to depict a real person or to fake a real photo; to show something real, find and fetch the actual image instead.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string', description: 'e.g. 1024x1024' },
        },
        required: ['prompt'],
      },
    },
    async run(ctx, args) {
      const provider = ctx.store.getSettings().provider;
      const base = (provider.imageBaseUrl || '').replace(/\/+$/, '');
      if (!base) {
        return {
          output: 'No image endpoint is configured. Tell the user to set one in Settings → Model if they want generated images.',
          isError: true,
        };
      }
      const res = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
        body: JSON.stringify({
          model: provider.imageModel || 'gpt-image-1',
          prompt: str(args.prompt),
          size: str(args.size, '1024x1024'),
          n: 1,
          response_format: 'b64_json',
        }),
        signal: ctx.signal,
      });
      if (!res.ok) return { output: `Image generation failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300), isError: true };
      const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
      const first = json.data?.[0];
      const dir = join(ctx.store.boxDir(ctx.agentId), 'images');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `image-${Date.now()}.png`);
      if (first?.b64_json) {
        writeFileSync(file, Buffer.from(first.b64_json, 'base64'));
      } else if (first?.url) {
        const bytes = await fetch(first.url, { signal: ctx.signal }).then((r) => r.arrayBuffer());
        writeFileSync(file, Buffer.from(bytes));
      } else {
        return { output: 'The image endpoint returned nothing usable.', isError: true };
      }
      return { output: `Image saved to ${file}. Attach it with SendMessage images: ["${file}"]`, imagePath: file };
    },
  },
];
