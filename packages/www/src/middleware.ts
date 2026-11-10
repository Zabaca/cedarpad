import { defineMiddleware } from 'astro:middleware'

// Canonical host: the apex. www.cedarpad.com is bound to this worker only so it
// resolves (it 522'd unbound); anything arriving on it 301s to cedarpad.com with
// path + query preserved.
export const onRequest = defineMiddleware((context, next) => {
  const url = new URL(context.request.url)
  if (url.hostname === 'www.cedarpad.com') {
    url.hostname = 'cedarpad.com'
    return Promise.resolve(Response.redirect(url.toString(), 301))
  }
  return next()
})
