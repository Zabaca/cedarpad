import { expect, test } from 'bun:test'

import { ANALYTICS_HOSTS, analyticsEnabled, POSTHOG_OPTIONS } from './analytics'

test('only the site’s own hostnames report — not dev, preview or a lookalike', () => {
  expect(ANALYTICS_HOSTS).toEqual(['cedarpad.com', 'www.cedarpad.com'])
  expect(analyticsEnabled('cedarpad.com')).toBe(true)
  expect(analyticsEnabled('www.cedarpad.com')).toBe(true)
  for (const h of [
    'localhost',
    '127.0.0.1',
    'cedarpad-www.james-99a.workers.dev',
    'cedarpad.com.evil.io',
    'app.cedarpad.com',
  ]) {
    expect(analyticsEnabled(h)).toBe(false)
  }
})

test('replay masks inputs and events go through the zabaca proxy', () => {
  expect(POSTHOG_OPTIONS.session_recording.maskAllInputs).toBe(true)
  expect(POSTHOG_OPTIONS.api_host).toBe('https://m.zabaca.com')
})
