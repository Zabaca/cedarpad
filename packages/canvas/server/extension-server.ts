// Isolated process for agent-authored backend handlers (ADR 0002). The core bridge
// proxies /api/custom/* here. Each handler is server/custom/<name>.ts exporting
//   export default (req: Request) => Response | Promise<Response> | any
// Handlers are dynamically imported with an mtime cache-bust, so creating or editing
// one hot-reloads WITHOUT a restart, and a throw is caught → 500 (one bad handler
// can't take the server down). This process holds NO canvas state — if a handler
// fatally crashes it, dev.ts restarts just this process; the canvas is untouched.
//
// Contract: a handler gets the raw Request, may call outbound (third-party APIs,
// DBs, the core's own http://<CANVAS_BRIDGE>/api/canvas — passed as env), and
// returns a Response (or any JSON-serializable value, wrapped in Response.json).
export {};

import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CUSTOM_PORT ?? 4512);
const CUSTOM_DIR = fileURLToPath(new URL('./custom/', import.meta.url));
const NAME = /^[A-Za-z0-9_-]+$/; // validated handler name, no path escape

Bun.serve({
  port: PORT,
  idleTimeout: 0, // long-lived handlers (SSE, slow upstreams) shouldn't be cut off
  async fetch(req) {
    const url = new URL(req.url);
    const m = /^\/api\/custom\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
    if (!m) return new Response('not found', { status: 404 });
    const name = m[1] ?? '';
    if (!NAME.test(name)) return new Response('bad handler name', { status: 400 });

    const file = `${CUSTOM_DIR}${name}.ts`;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      return new Response(`no custom handler "${name}"`, { status: 404 });
    }
    try {
      const mod = (await import(`${file}?v=${mtimeMs}`)) as { default?: unknown };
      if (typeof mod.default !== 'function') {
        return new Response(`handler "${name}" must \`export default\` a function`, { status: 500 });
      }
      const out = await (mod.default as (r: Request) => unknown)(req);
      return out instanceof Response ? out : Response.json(out ?? null);
    } catch (e) {
      return new Response(`custom handler "${name}" error:\n${String((e as Error)?.stack ?? e)}`, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
});
console.log(`[custom] extension server on http://localhost:${PORT}`);
