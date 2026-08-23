# Infra

The cedarpad-side consumer of `zbc` modules: per-environment infrastructure instances applied via `bun run apply <env>`.

## Language

**Module**:
A reusable infrastructure primitive — a zod `configSchema` + `apply`/`destroy` logic, defined via `defineModule`. Lives under `packages/infra/modules/<name>/` (consumed from zbc; not authored here). Embodies the **infrastructure-as-code** principle.
_Avoid_: provider, plugin, resource type

**Environment**:
A directory under `packages/infra/environments/<env>/` holding all **Instance** files for one deployment target (`production`, `preview`). Embodies the **configuration-as-code** principle.
_Avoid_: stage, target, deployment

**Instance**:
A **Module** bound to specific config for one **Environment** — e.g. `cloudflareModule.instance({ name: 'canvas', config: {...} })`. The unit `zbc apply` operates on.
_Avoid_: resource, deployment

## Relationships

- An **Environment** contains many **Instances**
- An **Instance** is one **Module** + config + optional `imports` from other **Instances**
- **Modules** are IaC; **Instances** in **Environments** are CaC
