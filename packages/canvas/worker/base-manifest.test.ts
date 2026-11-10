import { describe, expect, test } from 'bun:test';

import { platformTierManifest } from '../scripts/gen-base-manifest.ts';
import { BASE_COMPONENTS } from './base-manifest.generated.ts';

// The platform tier is image-only (ADR-0022 decision 8), so the EDGE cannot see it — it
// learns the tier from this committed manifest. A committed generator output rots silently,
// so the check that it has not is a test: regenerate from the image's own directory and
// compare. A platform Component added or removed without regenerating fails HERE, which is
// also what makes the tier's contents a reviewable diff (PRD #354 story 28).
describe('the platform-tier manifest', () => {
  test('the committed copy is exactly what the platform tier generates today', () => {
    expect(BASE_COMPONENTS).toEqual(platformTierManifest());
  });

  test("carries each module's description, taken from its leading comment", () => {
    const md = BASE_COMPONENTS.find((c) => c.name === 'MarkdownCard');
    expect(md?.description).toMatch(/markdown card/i);
  });
});
