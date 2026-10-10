import { afterEach, describe, expect, test } from 'bun:test';

import {
  type AnalyticsClient,
  POSTHOG_KEY,
  analyticsEnabled,
  identifyUser,
  resetAnalytics,
  resetAnalyticsForTests,
  startAnalytics,
  trackPageview,
} from './analytics';

function fake() {
  const calls: Array<[string, ...unknown[]]> = [];
  const client: AnalyticsClient = {
    init: (...a) => calls.push(['init', ...a]),
    identify: (...a) => void calls.push(['identify', ...a]),
    capture: (...a) => void calls.push(['capture', ...a]),
    reset: () => void calls.push(['reset']),
  };
  return { calls, client, load: async () => client };
}

afterEach(resetAnalyticsForTests);

describe('shell analytics', () => {
  test('only app.cedarpad.com reports — not admin, preview, localhost or a lookalike', () => {
    expect(analyticsEnabled('app.cedarpad.com')).toBe(true);
    for (const h of ['admin.cedarpad.com', 'agent-canvas-preview.james-99a.workers.dev', 'localhost', 'app.cedarpad.com.evil.io', 'cedarpad.com']) {
      expect(analyticsEnabled(h)).toBe(false);
    }
  });

  test('on another host nothing loads, and the calls are no-ops', async () => {
    const f = fake();
    let loaded = false;
    await startAnalytics('localhost', async () => {
      loaded = true;
      return f.client;
    });
    identifyUser({ id: 'u1' });
    trackPageview({ stage: 'canvas' });
    expect(loaded).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test('on the app host it inits once with the project key, masked replay and manual pageviews', async () => {
    const f = fake();
    await startAnalytics('app.cedarpad.com', f.load);
    await startAnalytics('app.cedarpad.com', f.load);
    const inits = f.calls.filter((c) => c[0] === 'init');
    expect(inits).toHaveLength(1);
    expect(inits[0]?.[1]).toBe(POSTHOG_KEY);
    expect(inits[0]?.[2]).toMatchObject({
      api_host: 'https://m.zabaca.com',
      person_profiles: 'identified_only',
      capture_pageview: false,
      session_recording: { maskAllInputs: true },
    });
  });

  test('calls made before the library finishes loading are delivered once it does', async () => {
    const f = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = startAnalytics('app.cedarpad.com', async () => {
      await gate;
      return f.client;
    });
    trackPageview({ stage: 'canvas', canvas_id: 'cv1', workspace_id: 'w1' });
    identifyUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    release();
    await started;
    await Promise.resolve();
    expect(f.calls.slice(1)).toEqual([
      ['capture', '$pageview', { stage: 'canvas', canvas_id: 'cv1', workspace_id: 'w1' }],
      ['identify', 'u1', { email: 'a@b.c', name: 'A' }],
    ]);
  });

  test('a blocked load is swallowed', async () => {
    await expect(startAnalytics('app.cedarpad.com', async () => Promise.reject(new Error('blocked')))).resolves.toBeUndefined();
    expect(() => trackPageview({ stage: 'settings' })).not.toThrow();
  });

  test('sign-out resets the person', async () => {
    const f = fake();
    await startAnalytics('app.cedarpad.com', f.load);
    resetAnalytics();
    expect(f.calls.at(-1)).toEqual(['reset']);
  });
});
