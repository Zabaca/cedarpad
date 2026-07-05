# Configuration Model

> How Cedarpad separates **configuration-as-code** (non-secret, in git) from **secrets** (encrypted, runtime-injected). Status as of 2026-06-23.

## Two deliberately separate planes

| Plane | File | Nature | Source of truth | Examples |
|-------|------|--------|-----------------|----------|
| **Configuration-as-code** | `packages/config/src/configuration.ts` | Non-secret, version-controlled, typed (`readonly`) | Git | active AI provider + model ids, embedding dimensions, similarity thresholds, page size |
| **Secrets / runtime bindings** | `packages/config/src/env.ts` (validator) | Secret, zod-validated at runtime | SOPS `secrets.yaml` → Wrangler / `.dev.vars` | Turso URL + token, provider API keys, Ably key, Better Auth secret |

There is **no database-backed configuration** — an explicit project requirement ("AVOID: database style configurations"). All non-secret settings are a single typed source file; all secrets are encrypted at rest and injected at runtime.

## Configuration-as-code — `configuration.ts`

A single typed, frozen object plus one exported constant:

```ts
export const EMBEDDING_DIMENSIONS = 1536;

export const configuration: AppConfiguration = {
  ai: {
    provider: "anthropic",            // active chat/reasoning provider
    chatModel: "claude-sonnet-4-6",
    embeddingProvider: "openai",      // embeddings can use a different provider
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  },
  similarity: {
    topK: 8,                          // nearest neighbours retrieved per intake
    identicalThreshold: 0.92,         // cosine ≥ ⇒ "identical"
    partialThreshold: 0.78,           // cosine ≥ ⇒ "partial"
    classificationMode: "hybrid",     // llm | hybrid | heuristic
    recencyWindowMs: null,            // null = scan full corpus; set to bound the
                                      // find-similar scan to recent rows (Turso cost lever)
  },
  graph: {
    defaultK: 8,
    defaultHops: 2,
    maxHops: 3,                       // hard cap — bounds traversal latency
    maxNodes: 100,
    summary: { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, maxMembers: 50 },
  },
  defaultPageSize: 25,
};
```

The graph knowledge layer is **cross-workspace by design** — similarity, traversal, solved-neighbour and cluster-summary reads all span every workspace so solutions are reused. There is no caller-selectable scope (the old `GraphScope`/`defaultScope` are gone). Ordinary listing of observations/problems is likewise cross-workspace by default; a principal is bounded only by its access allowlist (default = all) and may narrow a list with `?workspaceId=`. "Project" is a weightless meta tag, not a hierarchy level.

Backed by `readonly` interfaces (`AiModelConfig`, `SimilarityConfig`, `AppConfiguration`) so every field is type-checked and immutable.

`similarity.recencyWindowMs` is the config side of the pre-prod Turso scaling work (shipped 2026-06-29): find-similar is an exact brute-force cosine scan, and on production (stateless Cloudflare Workers → Turso) every scanned row is a metered read. Setting this to a window (ms) bounds the scan to recent rows; `null` (default) scans the full corpus. It's a flag to flip once Turso's rows-read signal warrants — heavier levers (smaller embedding dim, IVF bucketing) are on hold. Full analysis: `SIMILARITY_SCALING.md`.

### Who consumes it

| Consumer | Reads |
|----------|-------|
| `apps/api/src/index.ts` | `similarity.topK`, `defaultPageSize`, `ai` (provider label) |
| `apps/api/src/agent.ts` | `ai` + `similarity` + `graph` — selects real-provider vs heuristic reasoner/embedder, the link thresholds, and graph traversal bounds |
| `packages/db/src/schema.ts` | `EMBEDDING_DIMENSIONS` → the `F32_BLOB(1536)` vector columns on `observations`, `problems`, and `solutions` |
| `packages/ai/src/provider.ts` | the `AiModelConfig` / `AiProvider` types |
| `apps/api/scripts/seed.ts` | `ai.embeddingDimensions` |

## Secrets / runtime bindings — `env.ts`

Secrets never live in `configuration.ts`. They are validated at runtime from the environment (Worker bindings in production, `.dev.vars` locally):

```ts
export const envSchema = z.object({
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ABLY_API_KEY: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url().optional(),
});
export function loadEnv(source: Record<string, unknown>): Env { … }
```

Flow: `secrets.example.yaml` → `secrets.yaml` (SOPS-encrypted, committed) → `bun run secrets:push` (`scripts/push-secrets.sh`) → `wrangler secret put` per key. Locally, `apps/api/.dev.vars` (gitignored) provides the same values.

## How the two planes interact at runtime

`configuration.ts` declares **intent** ("use Anthropic for chat, OpenAI for embeddings"); `env.ts` provides the **credentials** to act on it. `apps/api/src/agent.ts` combines them: it reads `configuration.ai`/`configuration.similarity`, then checks whether the matching key exists in `env` — using the real provider when a key is present and falling back to the no-key heuristic reasoner / hash embedder otherwise. So the app runs fully offline with zero secrets, and "upgrades" to real models purely by supplying keys, with no config change.

## The one coupling to know about

`EMBEDDING_DIMENSIONS` is imported into the **DB schema** at compile time (it fixes `F32_BLOB(N)`). Changing it is therefore a **code change + a re-embed migration**, not a runtime toggle — which is exactly the point of configuration-as-code: the change is versioned, reviewed, and migration-gated. This is called out in `configuration.ts` and `IMPLEMENTATION_PLAN.md`.

## How to change configuration

- **Non-secret setting** (model, threshold, topK, page size): edit `configuration.ts`, commit. If you change `EMBEDDING_DIMENSIONS`, also write + run a re-embed migration.
- **Secret** (key/token): edit `secrets.yaml` via SOPS, then `bun run secrets:push` (prod) or update `.dev.vars` (local). Never put secrets in `configuration.ts`.

## Key files

- `packages/config/src/configuration.ts` — config-as-code object + types.
- `packages/config/src/env.ts` — runtime secret/binding validator.
- `secrets.example.yaml`, `.sops.yaml`, `scripts/push-secrets.sh` — secret encryption + push pipeline.
- `apps/api/.dev.vars.example` — local dev bindings template.
