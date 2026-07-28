import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanvasState } from '../src/shapes.ts';
import { decideMartAccess, handleMartApi, martsForGuestCanvas, readMart, type MartBucket } from './mart-api.ts';
import { SYNC_USER_HEADER } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

// The security-critical slice of the data pipeline (ADR-0017, #238): an edge Worker route
// that reads a mart's parquet IN THE WORKER (never waking the container), gated so a guest
// on a share link reads only the marts the shared canvas's own components reference — not
// the workspace's whole mart namespace.

const MART_NAME = 'mart_test';

/** Build a real DuckDB-written parquet + sidecar, wired into an in-memory MartBucket at the
 * real `workspaces/<ws>/warehouse/<name>.parquet(.schema.json)` keys — exercising the whole
 * path hyparquet parses in the Worker, not a hand-rolled stub. */
function withMartBucket<T>(
  ws: string,
  fn: (bucket: MartBucket) => Promise<T>,
  /** A `canvas-state.json` blob to plant alongside the mart — the STALE representation
   *  (#289). Present only so a test can prove the guest path no longer reads it. */
  staleCanvasState?: { canvasId: string; state: CanvasState },
): Promise<T> {
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
      if (staleCanvasState) {
        objects.set(
          `workspaces/${ws}/canvases/${staleCanvasState.canvasId}/canvas-state.json`,
          new TextEncoder().encode(JSON.stringify(staleCanvasState.state)),
        );
      }
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

/** One component record as it lives IN THE ROOM (ADR-0019) — the authoritative form. */
const componentRecord = (martName: string) => ({
  typeName: 'shape',
  id: 'shape:1',
  type: 'component',
  props: { w: 1, h: 1, module: 'KpiCard', data: {}, rev: 1, dataSource: { kind: 'mart', name: martName } },
});

/** A stand-in for the `CANVAS_SYNC` binding whose room answers `/snapshot` with `records`,
 *  recording what the caller asked for so the route's request shape can be asserted. */
function roomWith(records: unknown[]) {
  const seen: { name?: string; url?: string; method?: string; user?: string | null } = {};
  return {
    seen,
    idFromName(name: string) {
      seen.name = name;
      return { name };
    },
    get(_id: { name: string }) {
      return {
        fetch: async (request: Request) => {
          seen.url = request.url;
          seen.method = request.method;
          seen.user = request.headers.get(SYNC_USER_HEADER);
          return Response.json({ documents: records.map((state) => ({ state, lastChangedClock: 1 })) });
        },
      };
    },
  };
}

maybeDescribe('decideMartAccess — the guest-scoping decision (pure)', () => {
  test('a member may read any mart in their workspace', () => {
    expect(decideMartAccess(MART_NAME, { kind: 'member' })).toBe(true);
  });

  test('a guest on a share link CAN read a mart the shared canvas references', () => {
    expect(decideMartAccess(MART_NAME, { kind: 'guest', marts: new Set([MART_NAME]) })).toBe(true);
  });

  test('a guest on a share link CANNOT read a mart the shared canvas does not reference — the test that matters most', () => {
    expect(decideMartAccess(MART_NAME, { kind: 'guest', marts: new Set(['mart_other']) })).toBe(false);
    expect(decideMartAccess(MART_NAME, { kind: 'guest', marts: new Set() })).toBe(false);
  });
});

maybeDescribe('martsForGuestCanvas — the guest scope, resolved from the canvas ROOM', () => {
  test('addresses the canvas\'s own room and stamps the reader identity', async () => {
    const room = roomWith([componentRecord(MART_NAME)]);
    expect(await martsForGuestCanvas(room, 'canvas1', 'guest:link1')).toEqual(new Set([MART_NAME]));
    expect(room.seen.name).toBe(syncRoomName('canvas1'));
    expect(room.seen.method).toBe('GET');
    expect(new URL(room.seen.url as string).pathname).toBe('/api/canvas-sync/canvas1/snapshot');
    expect(room.seen.user).toBe('guest:link1');
  });

  test('fails closed: a room that does not answer grants nothing', async () => {
    const broken = {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
    };
    expect(await martsForGuestCanvas(broken, 'canvas1', 'guest:link1')).toEqual(new Set());
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
      const res = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'guest', marts: new Set([MART_NAME]) });
      expect(res.status).toBe(200);
    });
  });

  test('a guest whose canvas does NOT reference the mart gets a 404 — same shape as unknown-mart', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const denied = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'guest', marts: new Set(['mart_other']) });
      const unknown = await handleMartApi(bucket, 'ws1', 'mart_does_not_exist', { kind: 'member' });
      expect(denied.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await denied.json()).toEqual(await unknown.json());
    });
  });

  test('a guest is authorized against the ROOM, not the stale canvas-state.json blob (#289)', async () => {
    // The staleness the DO cutover introduced: the shape referencing the mart was REMOVED
    // from the canvas (the room no longer has it) but `canvas-state.json` still names it.
    // Reading R2 here grants a mart the canvas no longer references — this test fails
    // against `loadCanvasStateFromBucket`.
    await withMartBucket(
      'ws1',
      async (bucket) => {
        const marts = await martsForGuestCanvas(roomWith([]), 'canvas1', 'guest:link1');
        const res = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'guest', marts });
        expect(res.status).toBe(404);
      },
      { canvasId: 'canvas1', state: canvasWith(MART_NAME) },
    );
  });

  test('a guest whose ROOM still holds the referencing shape reads the mart', async () => {
    await withMartBucket('ws1', async (bucket) => {
      const marts = await martsForGuestCanvas(roomWith([componentRecord(MART_NAME)]), 'canvas1', 'guest:link1');
      const res = await handleMartApi(bucket, 'ws1', MART_NAME, { kind: 'guest', marts });
      expect(res.status).toBe(200);
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
