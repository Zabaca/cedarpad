import { z } from 'zod';

/**
 * What a guest may do on the canvas they were invited to (#320).
 *
 * ONE module, three callers. `worker/guest-gate.ts` (the edge HTTP door), the sync
 * handshake (`worker/sync-api.ts` → the Durable Object) and `server/bridge.ts` all derive
 * their answer from `guestCapabilities`. That is the entire point: #297 existed because
 * those three each decided for themselves and drifted apart — the gate went on
 * authorizing routes the room had stopped answering, and the routes that survived wrote
 * to the room under the CONTAINER's service credential. A guest's permissions are a
 * property of the LINK, so they are computed once, here, from the link row.
 *
 * ADR-0008 makes the Workspace the trust boundary and a guest is not a member, so these
 * capabilities are their own model rather than a subset of a member's. They are also
 * three separate grants rather than one ordered level, because they are different KINDS
 * of risk: using a component, editing the document, and authoring executable source that
 * hot-reloads into a member's authenticated browser.
 */
export const GuestCapabilities = z
  .object({
    /** Use a live component — click the button, submit the form. */
    interact: z.boolean(),
    /** Edit the canvas document: create, move, delete shapes. */
    editCanvas: z.boolean(),
    /** Author component source, own (canvas-scoped) tier only. Never promote/adopt: those
     *  reach the workspace-shared tier, which is outside the invite. */
    editSource: z.boolean(),
    /** Start and drive the guest's OWN canvas-scoped conversation (#220 slice 6). */
    chat: z.boolean(),
    /** Join the canvas's voice huddle (ADR-0017). */
    huddle: z.boolean(),
  })
  .strict();
export type GuestCapabilities = z.infer<typeof GuestCapabilities>;

/** Default-deny, spelled out. Every failure to establish capabilities lands here. */
export const NO_GUEST_CAPABILITIES: GuestCapabilities = {
  interact: false,
  editCanvas: false,
  editSource: false,
  chat: false,
  huddle: false,
};

/**
 * The grants this decision reads. Both a `share_links` row and the guest-session cookie
 * satisfy it structurally, which is what lets the same function answer for the live row
 * (the authoritative source) and for a cookie-only caller.
 *
 * Every capability flag is OPTIONAL and absence means DENIED — rows and cookies minted
 * before #320 carry none of them, and they must not read as granted. The column defaults
 * (and the migration's backfill) are what actually turn `guest_interact` on for a real row.
 */
export interface GuestGrants {
  guestChat?: boolean;
  guestHuddle?: boolean;
  guestInteract?: boolean;
  guestEdit?: boolean;
  guestEditSource?: boolean;
  /** Set = component-scoped link (PRD #221): an artifact was shared, not a conversation. */
  shapeId?: string | null;
}

export function guestCapabilities(link: GuestGrants): GuestCapabilities {
  return {
    interact: !!link.guestInteract,
    editCanvas: !!link.guestEdit,
    editSource: !!link.guestEditSource,
    // A component-scoped link shares one artifact; the chat surface is not part of it
    // (PRD #221), regardless of what the row says.
    chat: !!link.guestChat && !link.shapeId,
    huddle: !!link.guestHuddle,
  };
}

/**
 * The receiving half of the contract: capabilities cross two process boundaries as a
 * header (edge → bridge, edge → Durable Object) and are parsed on arrival, never trusted
 * because the hop was trusted (CLAUDE.md §7). Anything that does not parse is no
 * capabilities at all — the same failure mode as no header.
 */
export function readGuestCapabilities(header: string | null): GuestCapabilities {
  if (!header) return NO_GUEST_CAPABILITIES;
  try {
    const parsed = GuestCapabilities.safeParse(JSON.parse(header));
    return parsed.success ? parsed.data : NO_GUEST_CAPABILITIES;
  } catch {
    return NO_GUEST_CAPABILITIES;
  }
}
