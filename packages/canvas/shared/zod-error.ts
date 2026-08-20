import { z } from 'zod';

/** One human-readable line out of a failed `safeParse`: each issue rendered as
 *  `path: message` (or just `message` at the root), joined with `; `. Shared by every
 *  wire boundary that returns an `{ error }` 400 so an agent sees the same style of
 *  message wherever the rejection happened. */
export function zodErrorLine(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}
