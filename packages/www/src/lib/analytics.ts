// PostHog for the marketing site: pageviews, autocapture and session replay (inputs
// masked), on the site's own hostnames and nowhere else — dev, `astro preview`, CI and any
// lookalike host never load the library. Layout.astro hands these values to its inline
// snippet, so the allowlist the browser checks is this one list, not a copy of it.

/** The hostnames that report. Spelt out, not suffix-matched. */
export const ANALYTICS_HOSTS: readonly string[] = ['cedarpad.com', 'www.cedarpad.com']

export const POSTHOG_KEY = 'phc_zdrtBTi2f7hyq7D9odeyG5MKRnuVPy9sed5ajPHDHnJ9'

export const POSTHOG_OPTIONS = {
  // zabaca's managed PostHog reverse proxy (also serves the library and recorder assets).
  api_host: 'https://m.zabaca.com',
  ui_host: 'https://us.posthog.com',
  defaults: '2026-05-30',
  person_profiles: 'identified_only',
  session_recording: { maskAllInputs: true },
} as const

export function analyticsEnabled(hostname: string): boolean {
  return ANALYTICS_HOSTS.includes(hostname)
}
