# Tenancy: a Workspace is a deployment (control plane), not a shared multi-tenant plane

Status: accepted (design). Extends [ADR-0007](./0007-workspace-platform-topology.md); revises its
"single-tenant, multi-tenant deferred" stance. Vocabulary: root [CONTEXT.md](../../CONTEXT.md)
("Tenancy" section).

A **Workspace** is the platform's unit of isolation, tenancy, and membership — all at once:
- a **deployment** (its own isolated stack: container + Turso DB + R2), provisioned/routed by a
  **control plane** (the shared edge layer);
- an **org/tenant** — it *is* the Better Auth **organization** (members + invitations); you invite
  people **directly to a Workspace**;
- the **RCE trust boundary** — its container runs the unsandboxed agent, shared among that
  workspace's trusted members.

There is **no separate "Team" layer**. When cedarpad serves more than one Workspace, each gets its
own isolated deployment; we do **not** build a shared multi-tenant plane.

## Why

The agent is a **full, unsandboxed Claude Code agent (RCE)** in the workspace container (ADR-0001
accepts this because it's James-only). That single fact inverts the usual SaaS calculus:

- **Physical isolation (deployment per Workspace) sidesteps the hardest problem.** One workspace's
  RCE agent can never reach another's data/infra — there's no shared plane to escape into. We
  **never build agent sandboxing**. The deployment *is* the trust boundary.
- **A shared multi-tenant plane would force RCE sandboxing** against untrusted members — the
  biggest, most safety-critical build in the vision, catastrophic (cross-tenant RCE) if wrong.

"Invite my team" doesn't require solving tenancy: a Workspace's members are all *trusted* invitees,
so the shared RCE agent is acceptable (ADR-0001's "just me" widens to "this workspace's members").
The infra already fits: `zbc apply production canvas` provisions one deployment; the control plane
is "provision one of these per Workspace."

## Decision

- **Workspace = deployment = org/tenant = membership unit.** The Better Auth `organization` plugin
  (already wired in web-poc as the singular `workspace`/org table with members + invitations)
  **is** the Workspace. This **collapses the #57 split** — the org-"workspace" and the platform
  "workspace" are the same concept.
- **Control plane** = the shared edge layer (auth, provisioning, routing) that creates/upgrades/
  tears-down per-Workspace deployments.
- **Data is per-Workspace (its own database)** in the target — so the cross-workspace
  `workspace_id` scoping (#57) largely **dissolves** (the DB *is* the workspace). The *vendor* is
  downstream of this decision, not part of it: this ADR originally read "its own Turso DB —
  idiomatic for Turso", which made a tenancy decision look vendor-dependent. [ADR-0018](./0018-platform-data-layer-on-d1.md)
  moves the store to **D1** (a static binding per Workspace deployment) without changing anything
  here.
- **Open public signup** (if ever) rides the same control plane — auto-provision an isolated
  workspace-deployment per signup — never a shared plane.

## Relationship to what's built (the 20 shipped slices)

Today is the **single-deployment approximation**: one edge Worker + per-workspace **containers** +
per-workspace R2, but **one shared Turso DB with `workspace_id` scoping** (#43/#57). That's the
one-deployment starting point. The control plane later **promotes** each Workspace to a real
isolated deployment (its own database — D1 per [ADR-0018](./0018-platform-data-layer-on-d1.md)), at
which point `workspace_id` scoping becomes vestigial.
The per-workspace sandbox ids / R2 prefixes (ADR-0007) are already the right grain.

## Consequences

- **N deployments to run + upgrade.** A schema/image change fans out across every Workspace's
  deployment; the control plane owns that. Less cost-efficient than sharing infra — accepted for an
  RCE product with relatively few, high-value workspaces.
- **No cross-Workspace features on shared data** without a separate shared service — acceptable.
- **The control plane is new, unbuilt surface** — the fast-follow when Workspace #2 needs real
  isolation. Membership/invites come free from the org plugin.
- **`workspace_id` scoping is transitional** — correct for the shared-DB present, vestigial once
  per-workspace DBs land. Don't over-invest in it.

## Considered and rejected

- **Shared multi-tenant plane** (`tenant_id` + RBAC + row isolation) — forces RCE sandboxing against
  untrusted members; the cost-efficiency win doesn't justify betting the security model on flawless
  sandboxing.
- **A separate "Team" layer that owns many workspaces** — rejected in favor of the Workspace *being*
  the org/membership unit ("create a workspace, invite my team" = invite to the workspace). Revisit
  only if a reusable people-pool / single-billing-entity across workspaces becomes a real need.
- **Stay single-tenant indefinitely** — rejected: team collaboration now + more workspaces later is
  the vision; the boundary must be defined so scoping is built correctly.
