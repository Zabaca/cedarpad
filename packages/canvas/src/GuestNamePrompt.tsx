import React from 'react';

import type { CurrentUser } from './identity';

/**
 * The arrival prompt a share-link guest sees before they touch the canvas (#320).
 *
 * The name has to come from the GUEST: a link is minted and forwarded, so the inviter
 * does not know who will open it. Without one, every outsider shows up in presence as an
 * identical "Guest", which defeats the point of marking them — a member is meant to
 * notice *who* is editing and decide whether to revoke.
 *
 * Purely a display name: it is client-supplied and unverified, and nothing is authorized
 * by it. Identity for authorization is the per-connection `guest:<sessionId>` the Durable
 * Object mints. Ask-once — `setDisplayName` persists it browser-wide.
 */
export function GuestNamePrompt({ user, onName }: { user: CurrentUser | null; onName: (name: string) => void }) {
  const field = React.useRef<HTMLInputElement>(null);
  const [sent, setSent] = React.useState(false);
  // Null identity = still resolving; an existing name = already asked (this browser, or
  // any component that asked first). `sent` closes the prompt on submit rather than
  // waiting for identity to come back around, so it never blinks.
  if (!user || user.name || sent) return null;
  return (
    <div className="guest-name-prompt">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = field.current?.value.trim();
          if (!name) return;
          onName(name);
          setSent(true);
        }}
      >
        <label htmlFor="guest-name">Your name, so people can see who is here</label>
        <input id="guest-name" ref={field} autoFocus placeholder="Name" />
        <button type="submit">Join</button>
      </form>
    </div>
  );
}
