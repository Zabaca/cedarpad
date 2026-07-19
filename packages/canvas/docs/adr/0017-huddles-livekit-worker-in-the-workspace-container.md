# Huddles: a LiveKit voice room per canvas, agent worker colocated in the workspace container

Status: accepted (design). Prototype scope in issue #222; decided 2026-07-18.

A **huddle** is a voice room on a canvas: workspace members (and permitted guests) talk over
the board while the workspace's agent listens as a participant and acts on the canvas
mid-conversation. Media is WebRTC via LiveKit Cloud (rooms are named by canvas id); the
agent's ears/mouth are an **agent worker** — a Node `@livekit/agents` process running the
STT → Claude → TTS loop — spawned **inside the workspace container**, next to the bridge.

## Why

The positioning thesis is that alignment needs a medium richer than text; the strongest
expression is the team talking over the board while artifacts appear. That requires
conversation-latency two-way audio, which is WebRTC's domain (message transports — WebSockets,
NATS — guarantee delivery, but real-time voice requires permission to drop; TCP head-of-line
blocking makes them degrade unacceptably under loss). LiveKit was chosen over Cloudflare
Realtime for its mature agents framework and first-party Anthropic plugin (research 2026-07,
issue #222). The open placement question was where the always-on-during-a-huddle agent process
runs.

## Decision

- **Colocated worker, explicit spawn.** The worker runs in the workspace container because it
  *is* that workspace's agent: local (in-container) access to the bridge's canvas tools, scoped
  by construction, dies with the workspace. The bridge spawns one worker per huddle when the
  join flow starts and holds the handle (single-flight per canvas — a join while one is alive
  returns the existing room). We deliberately skip LiveKit's persistent worker-dispatch
  registration: dispatch treats workers as an interchangeable pool, but ours are not — only the
  worker in *this* container holds *this* canvas. Direct room join gives room↔container
  affinity by construction.
- **Humans keep the huddle alive; nothing else does.** The zombie trap is that the agent is
  itself a participant. Layered teardown, none of which counts the agent toward liveness:
  the worker exits when zero humans remain (short grace for rejoins); rooms are created with a
  small `emptyTimeout` so they evaporate after the worker leaves or crashes; the bridge
  enforces a hard max-duration kill and reaps the child on container shutdown.
- **LiveKit signing keys are edge-only** (the ADR-0008 custody pattern). The edge mints the
  human's room token on the session-authed join endpoint and mints the agent's token into the
  spawn poke. The container never holds signing material.
- **The brain is the subscription OAuth token, not an API key.** The voice loop drives the
  streaming Messages API directly with `CLAUDE_CODE_OAUTH_TOKEN` (Bearer +
  `anthropic-beta: oauth-2025-04-20` + the Claude Code identity string as the first system
  block — the lov pattern, spiked 2026-07-18: streaming + tool_use confirmed). Precedence: an
  `ANTHROPIC_API_KEY` in env wins if ever present, so tightened OAuth enforcement is a
  key-mint away from restored service, no code change.
- **Tools are in-process, not MCP.** The worker defines a narrow canvas-scoped toolset
  (`list_components`, `place_component`, `write_component`, `create_shapes`, `read_canvas`)
  as thin wrappers over localhost bridge calls. No OAuth loop, no egress, and a small tool
  list keeps voice turns fast.
- **Addressed-only speech, full-context listening.** Every finalized utterance flows through
  Claude (so "Cedar, do what Khoa just said" works), but the system prompt makes silence the
  default; it speaks/acts only when addressed. Barge-in stays enabled.
- **Vendors: LiveKit Inference for STT/TTS, ours for the LLM.** The pipeline's three stages
  are independently pluggable (Inference model string / vendor plugin with own key / custom
  implementation), so we mix: STT `deepgram/nova-3` and TTS `inworld/inworld-tts-2` served
  and billed through LiveKit Inference (no Deepgram/Cartesia accounts), LLM a custom node on
  the subscription OAuth token. Every slot stays swappable by config — a vendor key restores
  the bring-your-own path with no redesign. (Node plugin parity checked at 1.5.3:
  Anthropic/Deepgram/Cartesia/Silero/turn-detection all exist as fallback plugins.)
  LiveKit's own benchmark shows end-of-turn detection dominating pipeline latency (~2.5s of
  ~2.6s) — model choice is not the latency lever; turn-detection tuning is.
- **Guests can huddle.** `guestHuddle` is a per-link capability like `guestChat`; the join
  endpoint flows through the sole guest gate (ADR-0015), and the guest's LiveKit token carries
  their guest identity for attribution.
- **Transcripts yes, audio no.** The per-speaker transcript already exists as a byproduct of
  listening; the worker appends `{speaker, ts, text}` to a per-huddle JSONL in the workspace.
  Audio recording/egress, summaries, and action items are out of scope until the demo proves
  the moment.

## Consequences

- Step zero is a networking spike: WebRTC from inside a Cloudflare container is unproven; if
  outbound UDP is blocked, LiveKit falls back to TURN/TLS over TCP and the question becomes
  measured latency. If unusable, the worker moves to a separate host with the same code and
  reaches the canvas over MCP instead of localhost — the fallback is a redeploy, not a
  redesign.
- A huddle costs container CPU next to the app stack, and Cedar arrives a couple of seconds
  after the first human (spawn, not pre-registration). Pre-warming on huddle-UI-open is the
  latency lever if it grates.
- The container must be awake for a huddle; wake-on-huddle is the join flow's normal
  container wake, nothing special.
- Two new SOPS secrets: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (edge-only; Inference rides
  the same credentials). One signup (LiveKit Cloud). Zero new Anthropic spend.
- No feature flag: a huddle only exists when a human clicks join, spend stops when the room
  drains, and the join endpoint is members/permitted-guests only — the guardrails are
  structural. Kill switch is removing the button (a deploy).

## Considered and rejected

- **Separate agent host (VPS/Fly or LiveKit hosted agents).** Clean networking, but a second
  deploy target and a public-MCP auth loop before the first demo; kept as the fallback.
- **Persistent dispatch-registered worker.** Instant agent arrival, but the dispatch pool
  routes any worker to any room — wrong-container tool access unless per-workspace dispatch
  rules defeat the scheduler; plus a standing process and WSS churn in every awake container.
- **Claude Agent SDK as the voice brain.** Full parity with chat agents (skills, memory), but
  seconds-per-turn latency breaks conversation; revisit as a hybrid (plugin for talk, workspace
  agent for big build tasks) after the demo.
- **NATS/WebSocket audio transport.** Two-way messaging is not two-way *media*; no UDP loss
  tolerance, no media stack (Opus adaptation, jitter buffers, AEC). Rebuilding WebRTC badly.
- **A new `ANTHROPIC_API_KEY`.** Works, costs money, and the subscription token spike made it
  unnecessary; kept as the documented fallback credential.
