import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanvasState } from '../src/shapes.ts';
import { decideMartAccess, handleMartApi, readMart, type MartBucket } from './mart-api.ts';

// The security-critical slice of the data pipeline (ADR-0017, #238): an edge Worker route
// that reads a mart's parquet IN THE WORKER (never waking the container), gated so a guest
// on a share link reads only the marts the shared canvas's own components reference — not
// the workspace's whole mart namespace.

const MART_NAME = 'mart_test';

/** Build a real DuckDB-written parquet + sidecar, wired into an in-memory MartBucket at the
 * real `workspaces/<ws>/warehouse/<name>.parquet(.schema.json)` keys — exercising the whole
 * path hyparquet parses in the Worker, not a hand-rolled stub. */
function withMartBucket<T>(ws: string, fn: (bucket: MartBucket) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cedarpad-mart-api-test-'));
  const parquetPath = join(dir, 'mart.parquet');
  return (async () => {
    try {
      const proc = Bun.spawn(
        [
          'duckdb',
          ':memory:',
          '-c',
          `COPY (SELECT 'sess-a' AS session_id, now()::TIMESTAMP AS ts, 42::BIGINT AS input_tokens) TO '${parquetPath}' (FORMAT PARQUET);`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`duckdb fixture write failed: ${stderr}`);
      const parquetBytes = await Bun.file(parquetPath).bytes();

      const objects = new Map<string, Uint8Array>();
      objects.set(`workspaces/${ws}/warehouse/${MART_NAME}.parquet`, parquetBytes);
      objects.set(
        `workspaces/${ws}/warehouse/${MART_NAME}.schema.json`,
        new TextEncoder().encode(
          JSON.stringify({
            name: MART_NAME,
            description: 'test mart',
            columns: [
              { name: 'session_id', type: 'VARCHAR', description: 'id' },
              { name: 'ts', type: 'TIMESTAMP', description: 'ts' },
              { name: 'input_tokens', type: 'BIGINT', description: 'tokens' },
            ],
            generatedAt: new Date().toISOString(),
            rowCount: 1,
          }),
        ),
      );
      const bucket: MartBucket = {
        get: async (key) => {
          const bytes = objects.get(key);
          return bytes === undefined
            ? null
            : { arrayBuffer: async (): Promise<ArrayBuffer> => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
        },
      };
      return await fn(bucket);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const duckdbAvailable = Bun.which('duckdb') !== null;
if (!duckdbAvailable) {
  console.warn('DuckDB CLI not found — mart-api.test.ts SKIPPED, not passed; install duckdb to run it.');
}
const maybeDescribe = duckdbAvailable ? describe : describe.skip;

const canvasWith = (dataSourceName: string | null): CanvasState => ({
  version: 1,
  shapes:
    dataSourceName === null
      ? []
      : [
          {
            id: 'shape:1',
            color: 'black',
            type: 'component',
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            module: 'KpiCard',
            data: {},
            rev: 1,
            dataSource: { kind: 'mart', name: dataSourceName },
          },
        ],
});

maybeDescribe('decideMartAccess — the guest-scoping decision (pure)', () => {
  test('a member may read any mart in their workspace', () => {
    expect(decideMartAccess(MART_NAME, { kind: 'member' })).toBe(true);
  });

  test('a guest on a share link CAN read a mart the shared canvas references', () => {
    expect(decideMartAccess(MART_NAME, { kind: 'guest', canvasState: canvasWith(MART_NAME) })).toBe(true);
  });

  test('a guest on a share link CANNOT read a mart the shared canvas does not reference — the test that matters most', () => {
    expect(decideMartAccess(MART_NAME, { kind: 'guest', canvasState: canvasWith('mart_other') })).toBe(false);
    expect(decideMartAccess(MART_NAME, { kind: 'guest', canvasState: canvasWith(null) })).toBe(false);
  });
});

maybeDescribe('readMart — parquet in the Worker, coerced JSON-safe', () => {
  test('reads rows + sidecar, and every row survives JSON.stringify (BigInt/Date coercion applied)', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const mart = await readMart(bucket, 'ws1', MART_NAME);
      expect(mart).not.toBeNull();
      expect(mart?.sidecar.name).toBe(MART_NAME);
      expect(mart?.rows).toHaveLength(1);
      const row = mart?.rows[0] as Record<string, unknown>;
      expect(typeof row.input_tokens).toBe('number');
      expect(typeof row.ts).toBe('string');
      expect(() => JSON.stringify(mart)).not.toThrow();
    });
  });

  test('an unknown mart name resolves to null (no parquet, no sidecar)', async () => {
    await withMartBucket('ws1', async (bucket) => {
      expect(await readMart(bucket, 'ws1', 'mart_does_not_exist')).toBeNull();
    });
  });
});

maybeDescribe('handleMartApi — the full route, member vs guest', () => {
  test('a logged-in workspace member can read the mart', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const res = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'member' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows).toHaveLength(1);
    });
  });

  test('a guest whose canvas references the mart can read it', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const res = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'guest', canvasState: canvasWith(MART_NAME) });
      expect(res.status).toBe(200);
    });
  });

  test('a guest whose canvas does NOT reference the mart gets a 404 — same shape as unknown-mart', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const denied = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'guest', canvasState: canvasWith('mart_other') });
      const unknown = await handleMartApi(bucket, 'ws1', 'mart_does_not_exist', { kind: 'member' });
      expect(denied.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await denied.json()).toEqual(await unknown.json());
    });
  });

  test('a malformed mart name 404s identically to denied/absent — no oracle for a bad shape', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const malformed = await handleMartApi(bucket, 'ws1', '../etc/passwd', { kind: 'member' });
      const unknown = await handleMartApi(bucket, 'ws1', 'mart_does_not_exist', { kind: 'member' });
      expect(malformed.status).toBe(404);
      expect(await malformed.json()).toEqual(await unknown.json());
    });
  });
});
