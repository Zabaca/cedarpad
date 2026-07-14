import { z } from 'zod'

// The waitlist contract (guideline #7): the ONE definition of what crosses the
// form -> endpoint boundary. Both sides import from here and parse at the edge.

export const WaitlistRequest = z.object({
  // Normalize BEFORE validating — "Founder@X.com " should join as founder@x.com,
  // not bounce off z.email() for its trailing space.
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
})
export type WaitlistRequest = z.infer<typeof WaitlistRequest>

// `joined` covers both first-time inserts and repeat submissions: a duplicate
// email is the expected second-visit behavior of `email UNIQUE`, not an error,
// and collapsing the two also avoids leaking who is on the list.
export const WaitlistResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('joined') }),
  z.object({ status: z.literal('invalid'), message: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
])
export type WaitlistResponse = z.infer<typeof WaitlistResponse>
