import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// What the container does at boot (#366, ADR-0022 decision 5): it starts the dev stack, and
// nothing else. It reads no blob, extracts no tarball, and pre-populates no file.
//
// THIS IS THE MECHANISM OF THE 2026-07-29 LOSS, not a tidy-up. A boot restore that failed was
// swallowed ("starting with none"), the container came up with an empty tree, and the next
// full-replace flush tarred that emptiness over the only copy. The sinks are gone too, so the
// write half no longer exists — but the restore has its own, separate reason to go: component
// and skill resolution is FILE-FIRST, and a tarball that pre-populated the filesystem would
// shadow a newer Record on every cold boot. That is backwards from "the row is the truth".
// With no restore, a file exists only because materialization put it there from a Record, so
// file-first is a cache hit rather than a stale answer.
//
// Asserted against the SOURCE because `container-start.ts` is a top-level-await entry point:
// importing it would spawn the dev stack, so no test can exercise it directly and nothing else
// in the suite can see this file at all. `dev-worker-config.test.ts` reads wrangler.jsonc for
// the same reason — the thing under test is a file the runtime consumes, not a module.
const source = readFileSync(fileURLToPath(new URL('../scripts/container-start.ts', import.meta.url)), 'utf8');

describe('the container boot path fetches nothing', () => {
  test('boot opens no blob store and names no archive key', () => {
    expect(source).not.toMatch(/blob-store|BlobStore|selectBackend/);
    expect(source).not.toMatch(/\.tar\b/);
  });

  test('boot extracts no tarball onto the filesystem', () => {
    expect(source).not.toMatch(/overlay|extractOverlay|extractCanvasDirs/);
  });

  // The exact 2026-07-29 shape: a read that failed, logged, and continued with an empty tree.
  // There is no read left to fail open, and this is what keeps it that way.
  test('boot swallows no load failure, because it performs no load', () => {
    expect(source).not.toMatch(/starting with none/);
    expect(source).not.toMatch(/restored from R2/);
  });
});
