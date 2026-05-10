# Everything-as-code, single-tenant

cedarpad commits to three foundational principles, recorded together because they describe a single coherent stance: the source tree is the source of truth for what runs and how it's configured.

## 1. Single-tenant application

One shared deployment per environment. No multi-tenancy code paths — no `tenant_id` columns, no per-org row scoping, no per-customer infrastructure. `production` is one running system serving all users; `preview` is one ephemeral system per PR.

If per-customer isolation is ever required, it's a new architectural decision (own ADR), not a config change.

## 2. Infrastructure as code

Every provisioned resource is a zbc **Module** + **Instance** under `packages/infra/`. No exceptions:

- No clicking in the Vercel (or any provider) dashboard to create or modify resources
- No out-of-band CLI invocations (`turso db create`, etc.) against production state
- No parallel infrastructure tooling (Terraform, Pulumi, Ansible) running alongside zbc

If a Module is missing for something we need, the work is to write the Module, not to provision out-of-band "just this once."

## 3. Configuration as code

Configuration lives in source. Three layers:

- **Environment / deployment config** — Instance files under `packages/infra/environments/<env>/`. Promoting a value from `preview` to `production` is a PR editing the production Instance, never a dashboard toggle or CLI command.
- **Application config** — TypeScript constants and modules inside the application package. Not env-driven, not loaded from a config service, not stored in a DB row. If a value is set at build or deploy time, it's code.
- **Runtime configuration** — permitted only when there is a *named product requirement* that defines why it must change without a deploy (incident kill-switches, controlled rollouts that operations actually flip, per-user preferences). "It might need to change someday" doesn't qualify. Default is always code.

## Trade-offs accepted

- No runtime tunability without a deploy, except for the narrow runtime-config carve-out
- No operator-controlled config without building a deliberate UI for it
- Slower provider onboarding (must write a Module first)
- Per-customer needs would require a separate architectural decision

In return: type-safety end-to-end, git history for every production-affecting change, a single source of truth, no drift between dashboards and code.
