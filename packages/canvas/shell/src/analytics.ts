// Browser analytics for the shell: PostHog pageviews, the signed-in person, and session
// replay with inputs masked. The usage events that matter most (a chat sent, a component
// written…) are counted at the edge instead (worker/analytics.ts), where nothing blocks them.
//
// It loads on exactly one hostname. Spelt out, not suffix-matched, so a lookalike host
// cannot report as this one — and so admin.cedarpad.com, the preview Worker, localhost and
// every test run never load the library at all. That is also what keeps the bundle's
// PostHog chunk off the critical path: it is imported only once the host check passes.

/** The only hostname that reports. */
export const ANALYTICS_HOST = 'app.cedarpad.com';

export const POSTHOG_KEY = 'phc_zdrtBTi2f7hyq7D9odeyG5MKRnuVPy9sed5ajPHDHnJ9';

/** zabaca's managed PostHog reverse proxy (also serves the replay/recorder assets). */
export const POSTHOG_OPTIONS = {
  api_host: 'https://m.zabaca.com',
  ui_host: 'https://us.posthog.com',
  defaults: '2026-05-30',
  person_profiles: 'identified_only',
  // Pageviews are captured on the shell's own transitions (stage, canvas), not inferred from
  // history: the canvas stage rewrites its query string with replaceState as it goes.
  capture_pageview: false,
  session_recording: { maskAllInputs: true },
} as const;

/** The slice of posthog-js this module calls — a port, so tests drive it with a fake. */
export interface AnalyticsClient {
  init(key: string, options: Record<string, unknown>): unknown;
  identify(id: string, props?: Record<string, unknown>): void;
  capture(event: string, props?: Record<string, unknown>): void;
  reset(): void;
}

export function analyticsEnabled(hostname: string): boolean {
  return hostname === ANALYTICS_HOST;
}

let client: AnalyticsClient | null = null;
let starting: Promise<void> | null = null;

/** Load and initialise PostHog if this host reports. Idempotent; never throws. */
export function startAnalytics(
  hostname: string = window.location.hostname,
  load: () => Promise<AnalyticsClient> = async () => (await import('posthog-js')).default as unknown as AnalyticsClient,
): Promise<void> {
  if (!analyticsEnabled(hostname)) return Promise.resolve();
  starting ??= load()
    .then((ph) => {
      ph.init(POSTHOG_KEY, { ...POSTHOG_OPTIONS });
      client = ph;
    })
    .catch(() => {
      // An ad blocker or an offline desk: the app works the same, it just isn't counted.
    });
  return starting;
}

/** The signed-in member: keyed on the user id, with email and name as person properties. */
export function identifyUser(user: { id: string; email?: string | null; name?: string | null }): void {
  whenReady((c) => c.identify(user.id, { email: user.email ?? undefined, name: user.name ?? undefined }));
}

/** One shell pageview, tagged with where in the shell it is. */
export function trackPageview(props: { stage: string; canvas_id?: string | null; workspace_id?: string }): void {
  const tags: Record<string, unknown> = { stage: props.stage };
  if (props.canvas_id) tags.canvas_id = props.canvas_id;
  if (props.workspace_id) tags.workspace_id = props.workspace_id;
  whenReady((c) => c.capture('$pageview', tags));
}

/** On sign-out: forget the person, so the next one on this browser starts fresh. */
export function resetAnalytics(): void {
  client?.reset();
}

/** Run once PostHog is up — the first pageview fires before the async load finishes. A
 *  no-op when this host doesn't report (nothing was ever started). */
function whenReady(fn: (c: AnalyticsClient) => void): void {
  if (client) return fn(client);
  void starting?.then(() => {
    if (client) fn(client);
  });
}

/** Test-only: drop the loaded client so each test starts from nothing. */
export function resetAnalyticsForTests(): void {
  client = null;
  starting = null;
}
