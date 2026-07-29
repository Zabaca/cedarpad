import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MartSidecarSchema } from '../shared/mart-contract.ts';
import { hasDuckdbCli, MART_NAME, materializeSessionEventsMart, readMartParquet } from './session-events-mart.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/sessions');

/** A unique, empty work dir per test — worktree-safe (CLAUDE.md §6): a parallel copy of this
 * test suite in another worktree/process gets its own dir, never a shared fixed /tmp path. */
const withWorkDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'cedarpad-mart-test-'));
  try {
    await fn(dir);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
};

// A skip must be impossible to mistake for a pass (no CI runs `bun test` — a dev's local
// machine is the sole enforcement here): warn loudly, naming exactly what didn't run.
const duckdbAvailable = hasDuckdbCli();
if (!duckdbAvailable) {
  console.warn(
    'DuckDB CLI not found — 4 warehouse tests in session-events-mart.test.ts SKIPPED, not ' +
      'passed; install duckdb (e.g. `brew install duckdb`) to run them.',
  );
}
const maybeDescribe = duckdbAvailable ? describe : describe.skip;

maybeDescribe('materializeSessionEventsMart — the first mart, end to end', () => {
  test('transforms the fixture session transcripts into a declared, schema-conformant mart', async () => {
    await withWorkDir(async (workDir) => {
      const { parquet, sidecar } = await materializeSessionEventsMart(FIXTURE_DIR, workDir);

      expect(parquet.byteLength).toBeGreaterThan(0);
      expect(MartSidecarSchema.parse(sidecar).name).toBe(MART_NAME);
      // 2 main-agent assistant turns from sess-aaa (the sidechain one is excluded) + 1 from
      // sess-bbb = 3. Non-assistant record types (mode/user/file-history-snapshot) excluded too.
      expect(sidecar.rowCount).toBe(3);
      expect(sidecar.description).toMatch(/container/i);
    });
  });

  test('reading the parquet back yields the expected rows and column types', async () => {
    await withWorkDir(async (workDir) => {
      await materializeSessionEventsMart(FIXTURE_DIR, workDir);
      const rows = await readMartParquet(join(workDir, `${MART_NAME}.parquet`));

      expect(rows).toHaveLength(3);
      const bySession = Object.fromEntries(rows.map((r) => [`${r.session_id}-${r.ts}`, r]));
      const first = rows.find((r) => r.session_id === 'sess-aaa' && r.model === 'claude-sonnet-5' && r.input_tokens === 10);
      expect(first).toBeDefined();
      expect(first!.output_tokens).toBe(20);
      expect(first!.cache_creation_input_tokens).toBe(5);

      const other = rows.find((r) => r.session_id === 'sess-bbb');
      expect(other).toBeDefined();
      expect(other!.model).toBe('claude-opus-5');
      expect(other!.input_tokens).toBe(5);

      // column types survive the round trip: BIGINT columns parse as JS numbers (not strings,
      // not a raw bigint the row would fail to JSON.stringify — ADR-0017 consequences).
      for (const r of rows) {
        expect(typeof r.input_tokens).toBe('number');
        expect(typeof r.output_tokens).toBe('number');
        expect(typeof r.session_id).toBe('string');
        expect(() => JSON.stringify(r)).not.toThrow();
      }
      void bySession;
    });
  });

  test('excludes sidechain (subagent) turns from the fixture', async () => {
    await withWorkDir(async (workDir) => {
      await materializeSessionEventsMart(FIXTURE_DIR, workDir);
      const rows = await readMartParquet(join(workDir, `${MART_NAME}.parquet`));
      expect(rows.some((r) => r.input_tokens === 999)).toBe(false);
    });
  });

  test('rerunning is idempotent: the same source transcripts re-derive the same rows', async () => {
    await withWorkDir(async (workDir) => {
      const first = await materializeSessionEventsMart(FIXTURE_DIR, join(workDir, 'run1'));
      const second = await materializeSessionEventsMart(FIXTURE_DIR, join(workDir, 'run2'));
      expect(second.sidecar.rowCount).toBe(first.sidecar.rowCount);

      const rows1 = await readMartParquet(join(workDir, 'run1', `${MART_NAME}.parquet`));
      const rows2 = await readMartParquet(join(workDir, 'run2', `${MART_NAME}.parquet`));
      const strip = (rs: Record<string, unknown>[]) => rs.map((r) => ({ ...r, generatedAt: undefined }));
      expect(strip(rows2)).toEqual(strip(rows1));
    });
  });
});

describe('hasDuckdbCli', () => {
  test('reports a boolean without throwing', () => {
    expect(typeof hasDuckdbCli()).toBe('boolean');
  });
});
