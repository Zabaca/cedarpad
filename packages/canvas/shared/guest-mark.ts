// The mark that says "this is a share-link guest" in presence (#320, #339).
//
// ONE definition, used by the browser (`src/presence.ts`, which labels the guest as they
// expect to be seen) and by the room (`worker/guest-socket-policy.ts`, which stamps the same
// thing on every message a guest connection sends). Both call `markGuestName`, so they
// cannot drift: a browser that plays along produces exactly what the room would have.
//
// Load-bearing, not chrome: revoking a link is a manual judgement call, so a member has to
// NOTICE an outsider before they can act.
//
// THE MARK GOES FIRST. tldraw truncates a long name at its END (the cursor label has a
// 120px max width with an ellipsis, and the people menu clips the same way), so a mark at
// the end is exactly the part a guest could push out of view with a long or blank-looking
// name. A leading mark is the last thing to be cut. The name is also stripped of invisible
// characters and capped, so what is left of it is something a member can read.

/** The mark. */
export const GUEST_MARK = '(Guest)';

/** What a guest with no usable name shows as: the mark's own word, bare. */
export const GUEST_BARE_NAME = 'Guest';

/** The most code points of a guest's chosen name kept. Marked, the label stays short enough
 *  that a member sees a name and not a wall. */
export const GUEST_NAME_MAX = 40;

// Control, format (zero-width joiners and the like), private-use and unassigned characters,
// plus the blank-looking letters that are not "space" to Unicode (Hangul fillers, Braille
// blank). None of these is a name; all of them are ways to make one look empty or long.
const INVISIBLE = /[\p{C}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/**
 * A name that always reads as a guest's: invisible characters removed, spaces collapsed,
 * any marks the client already added taken off (so the result is the same whether or not the
 * browser marked it, and marking twice is the same as once), the rest capped, and the mark
 * put in front. With nothing usable left it is the bare "Guest".
 */
export function markGuestName(name: unknown): string {
  let n = typeof name === 'string' ? name.replace(INVISIBLE, '').replace(/\p{Z}+/gu, ' ').trim() : '';
  while (n.startsWith(GUEST_MARK)) n = n.slice(GUEST_MARK.length).trim();
  n = Array.from(n).slice(0, GUEST_NAME_MAX).join('').trim();
  return n === '' || n === GUEST_BARE_NAME ? GUEST_BARE_NAME : `${GUEST_MARK} ${n}`;
}

/**
 * The colours a guest's cursor and label may have, chosen by the room, never by the client. A
 * guest who picks their own can pick white on white, or a string that is not a colour, and a
 * label nobody can read is a guest nobody notices. Mid-lightness, so each reads on both themes.
 */
export const GUEST_PALETTE = ['#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#c026d3'] as const;

/** A stable palette colour for one connection identity (FNV-1a over its code units). */
export function guestColor(identity: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return GUEST_PALETTE[h % GUEST_PALETTE.length]!;
}
