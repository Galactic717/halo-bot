import { createServer, type Server } from 'node:http';

/**
 * A loopback listener that lets something outside Halo start a routine.
 *
 * Grok Bot added a webhook trigger beside its cron and connector triggers
 * (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.4); theirs is a hosted endpoint, ours does not need to be —
 * everything that would call it (Task Scheduler, a build script, a folder watcher, the user's own tools)
 * is on the same machine.
 *
 * Two things keep it honest: it binds 127.0.0.1 only, so nothing off this machine can reach it, and the
 * routine's token is its whole address — an unknown token is a flat 404 with no hint that another token
 * would have worked.
 */

/** Tried first so a URL a user pasted somewhere keeps working across restarts. */
const PREFERRED_PORT = 8477;

export interface WebhookServer {
  /** The port actually bound, or 0 when the listener could not start. */
  port: number;
  url(token: string): string;
  close(): void;
}

export function startWebhookServer(fire: (token: string) => boolean): Promise<WebhookServer> {
  return new Promise((resolve) => {
    let server: Server | undefined;

    const done = (port: number) =>
      resolve({
        port,
        url: (token: string) => (port ? `http://127.0.0.1:${port}/hook/${token}` : ''),
        close: () => server?.close(),
      });

    const listen = (port: number, onFail: () => void) => {
      server = createServer((req, res) => {
        const token = /^\/hook\/([A-Za-z0-9]{8,64})\/?$/.exec((req.url ?? '').split('?')[0] ?? '')?.[1];
        // Reading the body and throwing it away keeps a client from seeing a broken pipe on POST.
        req.resume();
        if (!token || !fire(token)) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('no such hook\n');
          return;
        }
        res.writeHead(202, { 'content-type': 'text/plain' });
        res.end('started\n');
      });
      server.on('error', () => {
        server?.close();
        onFail();
      });
      server.listen(port, '127.0.0.1', () => done((server?.address() as { port: number } | null)?.port ?? 0));
    };

    // Port 0 asks the OS for any free port: better a URL that changes than no webhooks at all.
    listen(PREFERRED_PORT, () => listen(0, () => done(0)));
  });
}
