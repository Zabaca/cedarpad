import { env } from 'cloudflare:workers'
import type { APIRoute } from 'astro'
import { WaitlistRequest, type WaitlistResponse } from '../../lib/waitlist'

// The one dynamic route on the site — everything else is prerendered.
export const prerender = false

function respond(body: WaitlistResponse, status: number): Response {
  return Response.json(body, { status })
}

/**
 * POST /api/waitlist — accepts JSON (the enhanced form) and form-encoded (the
 * no-JS fallback). Form posts get a 303 to a prerendered result page (the
 * homepage is static, so it can't render a query-param banner itself); JSON
 * posts get a WaitlistResponse.
 */
export const POST: APIRoute = async ({ request, url }) => {
  const isForm = (request.headers.get('content-type') ?? '').includes('form')

  let raw: unknown
  try {
    if (isForm) {
      const form = await request.formData()
      raw = { email: form.get('email') }
    } else {
      raw = await request.json()
    }
  } catch {
    return respond({ status: 'invalid', message: 'Malformed request body.' }, 400)
  }

  const redirect = (state: 'ok' | 'invalid' | 'error') =>
    Response.redirect(new URL(`/waitlist/${state}`, url), 303)

  const parsed = WaitlistRequest.safeParse(raw)
  if (!parsed.success) {
    if (isForm) return redirect('invalid')
    return respond({ status: 'invalid', message: "That address doesn't look right." }, 400)
  }

  try {
    await env.DB.prepare('INSERT INTO waitlist (email) VALUES (?)').bind(parsed.data.email).run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // A duplicate email is the expected second-visit path, not a failure — and
    // treating it as `joined` avoids confirming who is already on the list.
    if (!msg.includes('UNIQUE constraint failed')) {
      console.error('waitlist insert failed:', msg)
      if (isForm) return redirect('error')
      return respond(
        { status: 'error', message: 'Our end, not yours. Try again in a moment.' },
        500,
      )
    }
  }

  if (isForm) return redirect('ok')
  return respond({ status: 'joined' }, 201)
}
