# Async agent pipeline

Intake never blocks on the agent. Adding/reprocessing an observation or problem, or synthesizing a
problem from observations, **enqueues a job and returns immediately**; a worker processes it at its
own pace and the UI updates via realtime.

## Pieces

- **Queue** — `agent_jobs` (`packages/db/schema.ts`). A row per job: `kind`
  (`observation_intake` | `problem_intake` | `synthesis`), `status`
  (`queued → running → done|failed`), `payload` (intake: `{ targetId }`; synthesis:
  `{ workspaceId, observationIds, hint, createdBy, projectTags }`), and `result` (synthesis stores
  `{ problemId }`). Separate from `agent_runs`, which stays the per-pass audit log the pipeline writes.
- **Intake** (`apps/api/src/index.ts`) — `createObservation` / `createProblem` /
  `reprocess*` enqueue an intake job and return the record (201/200). `synthesize` enqueues a
  synthesis job and returns **`202 { jobId }`** (the problem doesn't exist yet).
- **Worker** (`apps/api/src/worker.ts` + `scripts/worker.ts`) — claims the oldest `queued` job and
  runs the matching pipeline (unchanged), which writes its `agent_run` and publishes
  `*.processed` / `problem.synthesized`. `drainAgentJobs()` is also imported by tests to process
  inline. The dev server (`scripts/dev-server.ts`) auto-spawns the worker (`WORKER_DISABLED=1` to opt out).
- **UI** — the Capture modal closes on submit; detail views show an "Agent is processing…" banner
  while the run is active; `useWorkspaceRealtime` invalidates queries on the completion event, so
  links/solutions/the synthesized problem appear automatically.

## Why a worker (and not `await` in the request)

The bridge (manual testing) makes a reasoner call take as long as a human; even with a real LLM it's
seconds. Awaiting that on the HTTP path blocks the modal and means an API restart orphans an in-flight
submission. Decoupling fixes both and lets the agent "pick up at its own pace."

## Production

The same `agent_jobs` queue, drained by a Cloudflare-native consumer (the dev worker is the local
stand-in):

| Option | What | Notes |
| --- | --- | --- |
| **Cron Trigger Worker** | scheduled Worker polls `queued` jobs | simplest; mirrors the dev worker 1:1 |
| **Cloudflare Queues** | intake `env.QUEUE.send({ jobId })` → consumer Worker | push-based, retries + dead-letter |
| **Cloudflare Workflows** | durable step pipeline (embed→classify→synthesize) | checkpoint/retry; most robust |
| `ctx.waitUntil()` | finish the pipeline in the same invocation after responding | lightweight, **not durable** |

The consumer uses the real LLM key (no bridge). The UI is pushed updates by the same Ably `publish`.
The **external API agent** is a separate service authenticating with `x-api-key`, polling
`/v1/problems` (or webhook/queue-triggered) for problems needing a solution and POSTing solutions
back — naturally async, never on the intake path.
