# `/agent-sim` — be Cedarpad's AI agents by hand (and `/loop /agent-sim`)

`/agent-sim` is a **Claude Code slash command** that lets a Claude session *act as* Cedarpad's
AI agents during local development — with **no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`**. It is the
interactive front-end to the manual-testing flow in [`MANUAL_AGENT_TESTING.md`](./MANUAL_AGENT_TESTING.md);
read that for the underlying mechanics, and [`ASYNC_PIPELINE.md`](./ASYNC_PIPELINE.md) for why intake is
async.

> **For another developer's Claude:** this file is self-contained. If `/agent-sim` is missing in this
> environment, follow [§ Install in your environment](#install-in-your-environment) — the full command
> template is embedded below, so you can recreate it without the original author's machine.

---

## What it does

It plays either or both of Cedarpad's two AI roles:

| Role | What it is | How `/agent-sim` drives it |
| --- | --- | --- |
| **Internal LLM agent** | The in-process reasoner inside the **worker** (`classify` / `synthesize` / `draftProblem`). | The **bridge**: with `AI_BRIDGE_DIR` set, every reasoner call is written to a file queue that blocks the worker until you answer it. Claude reads each pending call and writes the answer. |
| **External API agent** | A REST client that reads the cross-workspace knowledge graph to solve a problem. | The **`external-agent` CLI**: Claude calls the read-only graph endpoints (`search → context → neighborhood → solved`) and reasons out a solution. |

The internal role exercises **write-time** intelligence (the edges + solutions a real LLM would
produce); the external role exercises **read-time** graph consumption. Neither needs a provider key —
embeddings fall back to the deterministic hash embedder.

---

## Prerequisites

1. **bun** installed, and the repo available locally.
2. **The bun dev-server** (not `wrangler dev` — the bridge touches the filesystem, which Workers lack).
   - Internal role: must be started **with the bridge on** (`AI_BRIDGE_DIR`), so `/health` reports
     `reasoner: "bridge:manual"`.
   - External role: any running dev-server is fine.
3. **(Optional) the `/loop` skill** — only needed for the hands-off `/loop /agent-sim` flow below. If you
   don't have it, run `/agent-sim` manually each time instead.

---

## Usage

```
/agent-sim                       # default: internal — drain the bridge once
/agent-sim internal              # same as default
/agent-sim external [problemId]  # external API agent (optionally target a problem id)
/agent-sim both                  # internal first, then external
```

The command **preflights** the servers (starts the bridged API and the web app in the background if
they're down, polling until healthy), then:

- **internal** → runs `ai-bridge.ts watch`, and for each pending call reasons genuinely in role
  (conservative on `identical`, concrete `synthesize` bodies, etc.) and submits a schema-valid answer.
  A problem intake makes **two** calls in sequence (`classify` then `synthesize`), so it re-watches
  until the queue is idle.
- **external** → lists problems (or uses the given id), researches via the graph endpoints, and
  presents the solution it would return as the external agent (read-only — never writes to the DB).

---

## Hands-off draining with `/loop /agent-sim`

The bridge only has work when someone triggers a run in the web app, and a single problem intake needs
two answers. Rather than re-invoke `/agent-sim` after every trigger, wrap it in the **`/loop`** skill:

```
/loop /agent-sim
```

`/loop` re-runs the command on a self-paced cadence, so Claude keeps **draining the bridge as calls
arrive** — answer `classify`, catch the follow-up `synthesize`, then idle until the next trigger. Stop
when you say so (or when the queue stays empty). You can also pace it explicitly, e.g. `/loop 30s
/agent-sim`.

This turns a Claude session into a live "internal LLM" for as long as you're testing — add observations
and problems in the UI and watch them get classified and solved by hand, with full control over every
decision.

---

## Install in your environment

`/agent-sim` is a **project-scoped** command: it lives at `.claude/commands/agent-sim.md` in the repo
root, so Claude Code picks it up automatically for anyone working in this project. Verify with:

```bash
ls .claude/commands/agent-sim.md
```

If it's present, you're done — type `/agent-sim` in Claude Code. If it's **missing** (fresh checkout
without the file, or a different project), tell your Claude:

> "Read `docs/AGENT_SIM.md` and create the `/agent-sim` command."

Claude should write the template below to `.claude/commands/agent-sim.md` (creating the directory if
needed). The template is **portable** — it uses the repository root (your current working directory) and
the default bridge dir `.agent-bridge`, with no hardcoded machine paths.

<details>
<summary><code>.claude/commands/agent-sim.md</code> — portable template</summary>

````markdown
---
description: Act as Cedarpad's internal LLM (drain the agent bridge) and/or external API agent for manual testing
argument-hint: "[internal | external [problemId] | both]   (default: internal)"
allowed-tools: Bash, Read, Write
---

You are simulating Cedarpad's AI agents for a **manual, no-API-key** test run. There are two
roles (see `docs/MANUAL_AGENT_TESTING.md`):

- **internal LLM agent** — the reasoner inside the **worker**. Intake is async: the web/API enqueues
  into `agent_jobs` and returns immediately; the worker (auto-spawned by the dev server) drains the
  queue, and with `AI_BRIDGE_DIR` set each `classify` / `synthesize` / `draftProblem` call is written
  to a file queue that **blocks the worker** (not the web request) until you answer it.
- **external API agent** — a REST consumer that queries the read-only knowledge graph to solve a
  problem.

Run all commands from the **repository root** (your current working directory).
Bridge dir: `.agent-bridge` (override with `AI_BRIDGE_DIR`).

Requested role(s): **$ARGUMENTS** — if empty, do **internal**. `both` = internal first, then external.

---

## Preflight — make sure web + api are up (do this first, from the project root)

1. **API** — `curl -s -m1 http://localhost:8787/health`:
   - **No response / connection refused** → API is down. Start it in the **background** with the
     bridge on, then poll `/health` until `ok`:
     ```
     AI_BRIDGE_DIR=.agent-bridge TURSO_DATABASE_URL="file:local.db" PORT=8787 \
       bun apps/api/scripts/dev-server.ts
     ```
   - **Responds but `reasoner` is not `"bridge:manual"`** → the API is up *without* the bridge. The
     **internal** role can't work until it restarts with `AI_BRIDGE_DIR`. Don't kill the user's
     server silently — tell them and ask whether to restart it (external-only needs no bridge, so
     skip this if the request is `external`).
   - **Responds with `reasoner: "bridge:manual"`** → good, leave it. (The dev server auto-spawns the
     worker that drains `agent_jobs`; no separate worker process to start.)
2. **Web** — `curl -s -m1 -o /dev/null -w "%{http_code}" http://localhost:5173`:
   - Not `200` / refused → start it in the **background** and poll until it serves:
     ```
     bun --filter @cedarpad/web dev
     ```
3. Anything you started, leave running in the background. Once the servers the requested role needs
   are up, continue below. (Internal needs the bridged API; external needs any running API; the web
   is what the human uses to trigger runs.)

---

## Internal LLM agent

1. Run `bun apps/api/scripts/ai-bridge.ts watch 120` (blocks until a call appears, prints it). If it
   times out with no calls, tell the user to trigger a run in the webapp and stop.
2. For **each** pending call, reason **genuinely in the role** — do not rubber-stamp:
   - `classify` (you are a problem-deduplication analyst): judge how each candidate relates to the
     new problem (`identical` / `partial` / `related` / `unrelated`) with a confidence and a concrete
     rationale. Be conservative with `identical`. One entry per candidate, **same order** as input.
   - `synthesize` (solutions engineer): produce a concrete, actionable solution `body`. Set
     `origin` = `reused` if a `relatedSolutions` entry already solves it (list its ids in
     `reusedSolutionIds`), `synthesized` if you combine/extend them, else `research`.
   - `draftProblem` (product analyst): turn the observation cluster into one specific problem
     (`title`, `body`, `impact`, `urgency`, `solutionShape`), honoring any `hint` fields.
   Read each request's `system` and `responseSchema` and match the schema exactly.
3. Submit each answer: `... ai-bridge.ts answer <id>` with the JSON on stdin (a heredoc), or write
   `.agent-bridge/answered/<id>.json` directly. A malformed/invalid answer is rejected and the call
   keeps waiting, so fix and resubmit.
4. A problem intake makes **two** calls in sequence (`classify` then `synthesize`) — after answering,
   re-run `watch` to catch the follow-up. Repeat until the queue stays empty.
5. Report what you classified/synthesized and the final agent-run status.

## External API agent

Drive the graph endpoints via `bun apps/api/scripts/external-agent.ts` (uses the `x-dev-workspace`
bypass; `BASE`/`WORKSPACE` env to change target):

1. If no `problemId` was given, run `external-agent.ts problems` and ask the user which problem to
   solve (or pick the most recent).
2. Research it: `search <terms>` → `context <id>` → `neighborhood <id>` → `solved <id>`.
3. Reason over what the graph returned and present the solution **you would return as the external
   agent** — reuse/adapt any solved-neighbor solution when it fits, else propose a new one. Do not
   write to the DB; this role only consumes.

---

For a hands-off session, the user can wrap this in the loop skill: `/loop /agent-sim` keeps draining
the bridge as calls arrive. Stop when the user says so or the queue is idle.
````

</details>

### Getting `/loop`

`/loop` is a separate Claude Code skill (not part of this repo). If `/loop` isn't available in your
session, install it from your team's skill source / marketplace, or simply re-invoke `/agent-sim`
manually after each run — the command is fully usable without `/loop`.

---

## Related docs

- [`MANUAL_AGENT_TESTING.md`](./MANUAL_AGENT_TESTING.md) — the raw bridge/CLI mechanics behind this command.
- [`AGENT_GRAPH_ACCESS.md`](./AGENT_GRAPH_ACCESS.md) — the read-only graph endpoints the external agent uses.
- [`ASYNC_PIPELINE.md`](./ASYNC_PIPELINE.md) — the queue → worker model the bridge plugs into.
- [`how-cedarpad-works.html`](./how-cedarpad-works.html) — the conceptual overview (the bridge is the "manual file-bridge" reasoner mode in §5).
