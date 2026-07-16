# Guest share links flow through the sole gate as scoped sessions

Status: accepted (design). Amends PRD #42's sole-gate model; does not replace it.

A canvas share link is a member-minted, revocable capability row (`share_links` in Turso).
Visiting `/share/<linkId>` validates the row and mints a real **guest session** carrying
`{linkId, canvasId, permissions}`. Every subsequent guest request flows through the existing
edge auth gate — the gate learns to *accept* guest sessions and confine them to an explicit
per-canvas path allowlist. There is no second auth path and no unauthenticated path to the
container.

## Why

We want "send someone a link, they see (and collaborate on) one canvas, not the workspace
shell" — but PRD #42's design goal is explicit: unauthenticated requests must never reach the
container (no pre-auth source disclosure, no anonymous cold-boot of a paid container). A naive
public link breaks both properties.

## Decision

- **Link = capability, session = credential.** The link URL is used once, at the door; after
  that the guest holds a session cookie like any member. Revoking the link kills its sessions
  at next gate check.
- **Sole gate preserved.** The gate remains the single choke point. Guest confinement is an
  edge allowlist (that canvas's sync, data, component-module, and permitted chat paths);
  everything else — canvas list, inbox, MCP, other canvas ids — is rejected at the edge. The
  container keeps its trusting-behind-the-gate model.
- **A valid link is authorization to wake the container.** A member deliberately minted it;
  guest traffic is sanctioned traffic. Cost exposure is bounded by revocation.
- **Guests are the existing per-browser guest identity** (#211) plus a display-name prompt —
  no new identity concept.

## Consequences

- Guests can read the TSX source of components the shared canvas resolves (own → shared →
  platform) — rendering requires serving those modules. This is a deliberate, scoped
  relaxation of #42's "no pre-auth source disclosure": it is post-auth (guest session) and
  limited to one canvas's component closure.
- The gate's allowlist is the security boundary; every new container route is guest-denied by
  default until explicitly allowlisted.
- Member conversations are always view-only to guests. A link may grant "guests can start
  their own conversation", scoped to that canvas with canvas-scoped agent tools; no turn
  budget in v1 (revocation is the brake).

## Considered and rejected

- **Token-in-every-URL / signed JWT:** leaks via referrers and logs, or makes revocation only
  as good as the expiry window; both end up needing the DB check anyway.
- **A second, unauthenticated render path** (static snapshot from R2 for cold containers):
  a whole parallel render mode, and full collaboration degrades silently when no member is
  around.
- **Container-side scope enforcement:** puts the boundary in the component with the most
  routes to miss, and breaks the container's assumption that all traffic is gated.
