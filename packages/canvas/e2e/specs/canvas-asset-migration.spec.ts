/**
 * #321 — the migration's asset upload, proved over real HTTP against a real bucket.
 *
 * `scripts/migrate-canvas-rooms.ts --target memory` hosts a room with NO bucket, so every
 * existing test proves the DOCUMENT is right while the bytes have nowhere to land. And the
 * failure mode is invisible at the record level: after #290 an asset record carries only a
 * URL, so a silently-failed PUT still validates, still loads, and shows a canvas of broken
 * images. Only the bytes can catch it.
 *
 * So this drives the real script against the real edge Worker (`wrangler dev`, miniflare's
 * local R2 — never Cloudflare, never production) and asserts four things:
 *
 *   1. the bytes come back out of the bucket, and a BROWSER decodes them as an image;
 *   2. the asset is PUT *before* the snapshot naming it — recorded, not assumed;
 *   3. the object key is deterministic, so re-running the import (which IS the rollback
 *      story, ADR-0019) overwrites rather than orphaning a fresh object;
 *   4. a failed PUT aborts that canvas instead of loading a document with no pixels.
 *
 * (2) and (4) run through a recording/faulting proxy in front of the edge — the script
 * sees an ordinary origin, and the request sequence is observed from the wire.
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCAL_DEV_PLATFORM_SECRET } from '../../shared/platform-rpc.ts';
import { EDGE_BASE_URL, OWNER_STATE, expect, test } from '../fixtures/test.ts';

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** A real 7×5 red PNG. Real dimensions matter: the browser assertion reads them back. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAAEklEQVR4nGP4z8CAibAIUUUUAKEvIt57lX2fAAAAAElFTkSuQmCC';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

/**
 * The migration authenticates from BETTER_AUTH_SECRET now (#329) — no cookie anywhere.
 * Local dev's secret follows the same precedence the generated wrangler config uses:
 * `web-poc/.dev.vars` if this worktree has one, otherwise the checked-in local default.
 */
function operatorSecret(): string {
  const devVars = join(PACKAGE_DIR, 'web-poc', '.dev.vars');
  if (existsSync(devVars)) {
    const m = /^BETTER_AUTH_SECRET\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(devVars, 'utf8'));
    if (m?.[1]) return m[1];
  }
  return LOCAL_DEV_PLATFORM_SECRET;
}

/** A local stand-in for the blob bucket `dump` reads: one canvas holding one image shape. */
function writeBlobRoot(canvasId: string, shapeId: string): string {
  // Slice-unique, per-run: two agents (or two runs) must never share a dump path.
  const root = mkdtempSync(join(tmpdir(), 'cedarpad-321-'));
  const dir = join(root, 'blob', 'workspaces', 'default', 'canvases', canvasId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'canvas-state.json'),
    JSON.stringify({
      version: 1,
      shapes: [
        {
          id: shapeId,
          type: 'image',
          x: 100,
          y: 100,
          w: 140,
          h: 100,
          color: 'black',
          alt: 'migration proof',
          src: `data:image/png;base64,${PNG_BASE64}`,
        },
      ],
    }),
  );
  return root;
}

/**
 * Run the real migration script. ASYNC deliberately: the recording proxy below lives in
 * THIS process, so a blocking `spawnSync` would starve its event loop and every request
 * the script makes would time out (measured — that is exactly what happened first).
 */
function migrate(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', 'scripts/migrate-canvas-rooms.ts', ...args], {
      cwd: PACKAGE_DIR,
      // The credential rides in the ENVIRONMENT, never on the command line (#329).
      env: { ...process.env, BETTER_AUTH_SECRET: operatorSecret() },
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

/** dump + the object key the migration derives, which callers assert on directly. */
async function dumpCanvas(canvasId: string, shapeId: string): Promise<{ dumpDir: string; key: string }> {
  const root = writeBlobRoot(canvasId, shapeId);
  const dumpDir = join(root, 'dump');
  const dumped = await migrate(['dump', '--from', join(root, 'blob'), '--out', dumpDir]);
  expect(dumped.out).toContain('dumped 1 canvas');
  expect(dumped.code).toBe(0);
  const index = JSON.parse(readFileSync(join(dumpDir, 'assets', canvasId, 'index.json'), 'utf8')) as Array<{
    key: string;
  }>;
  expect(index).toHaveLength(1);
  return { dumpDir, key: index[0]!.key };
}

/**
 * A proxy in front of the edge that RECORDS every request line, and can fail the asset PUT.
 * The migration only ever sees an origin, so nothing about the script is mocked — this
 * observes the wire, which is the only place request ORDER exists.
 */
async function recordingProxy(opts: { failAssetPut?: boolean } = {}): Promise<{
  origin: string;
  log: string[];
  close: () => Promise<void>;
}> {
  const log: string[] = [];
  const edge = new URL(EDGE_BASE_URL);
  const server: Server = createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    if (opts.failAssetPut && req.method === 'PUT' && req.url?.startsWith('/api/canvas-assets/')) {
      req.resume();
      res.writeHead(500).end('injected bucket failure');
      return;
    }
    const upstream = httpRequest(
      {
        hostname: edge.hostname,
        port: edge.port,
        path: req.url,
        method: req.method,
        // The Worker is host-sensitive (it 301s an unrecognised host, and the redirect
        // sheds the session cookie — measured). A proxy presents the UPSTREAM's host.
        headers: { ...req.headers, host: edge.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end('proxy error'));
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const newCanvas = async (owner: { post: (url: string, o: object) => Promise<{ ok(): boolean; json(): Promise<unknown> }> }, name: string) => {
  const created = await owner.post('/api/canvases', { data: { name: `${name}-${Date.now()}` } });
  expect(created.ok()).toBeTruthy();
  return (await created.json() as { id: string }).id;
};

test.use({ storageState: OWNER_STATE });

test('an image survives blob → dump → load → room, and the browser decodes the bytes', async ({ page, owner }) => {
  const canvasId = await newCanvas(owner, 'asset-migration');
  const shapeId = `shape:${crypto.randomUUID()}`;
  const { dumpDir, key } = await dumpCanvas(canvasId, shapeId);

  const loaded = await migrate(['load', '--dump', dumpDir, '--target', EDGE_BASE_URL]);
  console.log('LOAD', loaded.out);
  expect(loaded.code).toBe(0);

  // 1) The bucket has the bytes, byte for byte, read back through the real endpoint.
  const fetched = await owner.get(`/api/canvas-assets/${canvasId}/${key}`);
  expect(fetched.status()).toBe(200);
  expect(Buffer.compare(await fetched.body(), PNG_BYTES)).toBe(0);

  // 2) The room's asset record names that URL, not a data URL (#290) — and the script's
  //    own `verify` agrees the canvas matches its blob shape for shape.
  const snapshot = await owner.get(`/api/canvas-sync/${canvasId}/snapshot`);
  expect(snapshot.status()).toBe(200);
  const documents = ((await snapshot.json()) as { documents: Array<{ state: Record<string, unknown> }> }).documents;
  const asset = documents.find((d) => d.state.typeName === 'asset');
  expect((asset?.state.props as { src: string }).src).toBe(`/api/canvas-assets/${canvasId}/${key}`);

  const verified = await migrate(['verify', '--dump', dumpDir, '--target', EDGE_BASE_URL]);
  console.log('VERIFY', verified.out);
  expect(verified.code).toBe(0);

  // 3) The browser: a broken image is invisible at the record level, so let Chrome decode
  //    it. Same-origin through the pad's own origin (vite proxies /api/canvas-assets to the
  //    edge), carrying the owner's real session cookie.
  await page.goto(`/w/default/canvas/${canvasId}/pad`);
  await page.waitForSelector('.tl-canvas', { timeout: 30_000 });
  const decoded = await page.evaluate(
    (url) =>
      new Promise<{ w: number; h: number } | string>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve('BROKEN');
        img.src = url;
      }),
    `/api/canvas-assets/${canvasId}/${key}`,
  );
  console.log('BROWSER DECODE', JSON.stringify(decoded));
  expect(decoded).toEqual({ w: 7, h: 5 });
});

test('the asset is PUT before the snapshot that names it', async ({ owner }) => {
  const canvasId = await newCanvas(owner, 'asset-order');
  const { dumpDir, key } = await dumpCanvas(canvasId, `shape:${crypto.randomUUID()}`);
  const proxy = await recordingProxy();
  try {
    const loaded = await migrate(['load', '--dump', dumpDir, '--target', proxy.origin]);
    expect(loaded.code).toBe(0);
    console.log('WIRE', JSON.stringify(proxy.log));
    const put = proxy.log.indexOf(`PUT /api/canvas-assets/${canvasId}/${key}`);
    const post = proxy.log.indexOf(`POST /api/canvas-sync/${canvasId}/snapshot`);
    expect(put).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThanOrEqual(0);
    expect(put).toBeLessThan(post);
  } finally {
    await proxy.close();
  }
});

test('re-running the import reuses the same object key — no orphaned duplicate', async ({ owner }) => {
  const canvasId = await newCanvas(owner, 'asset-idempotent');
  const shapeId = `shape:${crypto.randomUUID()}`;

  // Two INDEPENDENT dumps of the same blob, so the key is re-derived from scratch each
  // time — a uuid-per-upload key (what the client mints) would differ here.
  const first = await dumpCanvas(canvasId, shapeId);
  const second = await dumpCanvas(canvasId, shapeId);
  expect(second.key).toBe(first.key);
  expect(first.key).toBe(`${shapeId.replace('shape:', '')}.png`);

  const proxy = await recordingProxy();
  try {
    const one = await migrate(['load', '--dump', first.dumpDir, '--target', proxy.origin]);
    expect(one.code).toBe(0);
    // --force: the room now has shapes, and the room's 409 guard is the thing being got past.
    const two = await migrate(['load', '--dump', second.dumpDir, '--target', proxy.origin, '--force']);
    console.log('SECOND LOAD', two.out);
    expect(two.code).toBe(0);

    const puts = proxy.log.filter((l) => l.startsWith('PUT /api/canvas-assets/'));
    console.log('PUTS', JSON.stringify(puts));
    expect(puts).toEqual([
      `PUT /api/canvas-assets/${canvasId}/${first.key}`,
      `PUT /api/canvas-assets/${canvasId}/${first.key}`,
    ]);
  } finally {
    await proxy.close();
  }

  // And the object at that one key is still the right bytes after the second write.
  const fetched = await owner.get(`/api/canvas-assets/${canvasId}/${first.key}`);
  expect(fetched.status()).toBe(200);
  expect(Buffer.compare(await fetched.body(), PNG_BYTES)).toBe(0);
});

test('a failed asset PUT fails the canvas instead of loading a document with no pixels', async ({ owner }) => {
  const canvasId = await newCanvas(owner, 'asset-failure');
  const { dumpDir, key } = await dumpCanvas(canvasId, `shape:${crypto.randomUUID()}`);
  const proxy = await recordingProxy({ failAssetPut: true });
  try {
    const loaded = await migrate(['load', '--dump', dumpDir, '--target', proxy.origin]);
    console.log('FAILED LOAD', loaded.out);
    expect(loaded.code).toBe(1);
    expect(loaded.out).toContain(`${canvasId}/${key}: asset upload failed 500`);
    // The snapshot must NEVER be posted: a document naming an object that isn't there is
    // the broken-image canvas this whole spec exists to prevent.
    expect(proxy.log.some((l) => l.startsWith('POST /api/canvas-sync/'))).toBe(false);
  } finally {
    await proxy.close();
  }

  // The room is still empty — an empty room is recoverable; a half-loaded one is not.
  const after = await owner.get(`/api/canvas-sync/${canvasId}/snapshot`);
  expect(after.status()).toBe(200);
  const documents = ((await after.json()) as { documents: Array<{ state: Record<string, unknown> }> }).documents;
  expect(documents.filter((d) => d.state.typeName === 'shape')).toHaveLength(0);
});
