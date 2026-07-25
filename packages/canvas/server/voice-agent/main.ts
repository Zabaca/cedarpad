// The huddle agent worker (ADR-0017): the agent's ears and mouth in a canvas voice room.
// Spawned by the bridge per huddle (server/bridge.ts supervisor), joins the room directly
// with an edge-minted token (no dispatch registration — room↔container affinity by
// construction), and exits when the last human leaves (liveness.ts).
//
// Pipeline: LiveKit Inference STT/TTS (model strings — billed through LiveKit, no vendor
// keys) around a Claude brain on the subscription OAuth token: the stock Anthropic plugin
// with a pre-configured client (Bearer + oauth beta header; spiked 2026-07-18 — the
// prefixed-string identity form returns 200). ANTHROPIC_API_KEY, if present, wins.
import Anthropic from '@anthropic-ai/sdk';
import { initializeLogger, llm, voice } from '@livekit/agents';
import * as anthropic from '@livekit/agents-plugin-anthropic';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { z } from 'zod';
import { createLiveness } from './liveness.ts';
import { appendUtterance, transcriptPath } from './transcript.ts';
import { CANVAS_ID_HEADER } from '../../shared/bridge-wire.ts';

const CANVAS = process.env.HUDDLE_CANVAS ?? 'default';
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? '';
const TOKEN = process.env.LIVEKIT_AGENT_TOKEN ?? '';
const BRIDGE = process.env.BRIDGE_ORIGIN ?? 'http://127.0.0.1:4511';
const AGENT_IDENTITY = 'cedar';
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// Direct room join bypasses the framework's cli.runApp entry, which is what normally
// initializes its logger — AgentSession construction throws without this.
initializeLogger({ pretty: false, level: 'info' });

// A transient LLM/TTS failure (a 429 burst, a network blip) surfaces as an UNCAUGHT
// throw out of the framework's retry loop and killed the whole worker — cedar silently
// vanished mid-huddle with nothing to respawn it until the next join. One bad turn must
// cost one reply, not the huddle: log and keep listening.
process.on('uncaughtException', (e) => console.error('[voice-agent] survived uncaught:', e?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[voice-agent] survived rejection:', (e as Error)?.message ?? e));

if (!LIVEKIT_URL || !TOKEN) {
  console.error('[voice-agent] LIVEKIT_URL and LIVEKIT_AGENT_TOKEN are required');
  process.exit(1);
}

// --- bridge tools: thin canvas-scoped wrappers over localhost bridge calls ------------
const bridge = async (path: string, init?: RequestInit): Promise<unknown> => {
  const res = await fetch(`${BRIDGE}${path}`, {
    ...init,
    headers: { [CANVAS_ID_HEADER]: CANVAS, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`bridge ${path}: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
};

const tools = {
  list_components: llm.tool({
    description: 'List the component library available to place on the canvas.',
    parameters: z.object({}),
    execute: async () => bridge('/api/components'),
  }),
  place_component: llm.tool({
    description: 'Place a library component on the shared canvas at (x, y).',
    parameters: z.object({
      module: z.string().describe('component module name from list_components'),
      x: z.number(),
      y: z.number(),
      w: z.number().optional(),
      h: z.number().optional(),
    }),
    execute: async (args) => bridge('/api/components/place', { method: 'POST', body: JSON.stringify(args) }),
  }),
  write_component: llm.tool({
    description: 'Write (create or overwrite) a component module in the canvas library. TSX source with a default export.',
    parameters: z.object({ module: z.string(), source: z.string() }),
    execute: async (args) =>
      bridge(`/api/components/${encodeURIComponent(args.module)}`, {
        method: 'PUT',
        body: JSON.stringify({ source: args.source }),
      }),
  }),
  read_canvas: llm.tool({
    description:
      'Read a compact summary of the canvas: every shape with id, type, position, and a text preview. No raw component data.',
    parameters: z.object({}),
    // The raw canvas state can be hundreds of KB (component data blobs) — feeding it to
    // a voice turn wedges the conversation. Summarize hard: geometry + text preview only.
    execute: async () => {
      const state = (await bridge('/api/canvas')) as { shapes?: Array<Record<string, unknown>> };
      const shapes = (state.shapes ?? []).slice(0, 300).map((s) => ({
        id: s.id,
        type: s.type,
        x: s.x,
        y: s.y,
        ...(s.w != null ? { w: s.w, h: s.h } : {}),
        ...(typeof s.module === 'string' ? { module: s.module } : {}),
        ...(typeof s.text === 'string' && s.text ? { text: s.text.slice(0, 120) } : {}),
        ...(typeof s.title === 'string' && s.title ? { title: s.title } : {}),
      }));
      return { shapeCount: state.shapes?.length ?? 0, shapes };
    },
  }),
  create_shapes: llm.tool({
    description: 'Create simple shapes/notes on the canvas. Each shape: {type: "note"|"text", x, y, text}.',
    parameters: z.object({
      shapes: z.array(z.object({ type: z.enum(['note', 'text']), x: z.number(), y: z.number(), text: z.string() })),
    }),
    execute: async (args) => bridge('/api/canvas/shapes', { method: 'POST', body: JSON.stringify(args) }),
  }),
};

// --- brain ----------------------------------------------------------------------------
// OAuth contract (isolated live, 2026-07-18): the subscription path requires the CC
// identity as its OWN first system block — a single string with anything appended gets
// an instant 429 ("rate_limit_error" in name only). The plugin sends instructions as a
// string, so wrap the client to rewrite any string system into the two-block form.
function withBlockSystem(client: Anthropic): Anthropic {
  const raw = client.messages.create.bind(client.messages);
  // biome-ignore lint/suspicious/noExplicitAny: thin transport shim over the SDK's own types
  (client.messages as any).create = (body: any, opts?: any) => {
    const sys = body?.system;
    const blocks: Array<{ type: 'text'; text: string }> =
      typeof sys === 'string' ? [{ type: 'text', text: sys }] : Array.isArray(sys) ? [...sys] : [];
    if (blocks.length > 0) {
      const first = blocks[0]?.text ?? '';
      const rest = first.startsWith(CC_IDENTITY) ? first.slice(CC_IDENTITY.length).trimStart() : first;
      body = {
        ...body,
        system: [
          { type: 'text', text: CC_IDENTITY },
          ...(rest ? [{ type: 'text', text: rest }] : []),
          ...blocks.slice(1),
        ],
      };
    }
    return raw(body, opts);
  };
  return client;
}

const auth = process.env.ANTHROPIC_API_KEY
  ? { apiKey: process.env.ANTHROPIC_API_KEY }
  : {
      client: withBlockSystem(
        new Anthropic({
          apiKey: null,
          authToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
        }),
      ),
    };

const instructions = `${CC_IDENTITY}

You are Cedar, the workspace's voice agent, sitting in a live huddle on canvas ${CANVAS}.
Humans are talking to EACH OTHER by default. Stay silent unless directly addressed
("Cedar, ...") or clearly asked to do something. When silent, respond with an empty
message — say nothing at all. When addressed: be brief and conversational (one or two
spoken sentences), act through your canvas tools when asked to build or place things,
and confirm what you did in a few words. Never read out code, JSON, or long lists.`;

// --- session --------------------------------------------------------------------------
const room = new Room();
await room.connect(LIVEKIT_URL, TOKEN, { autoSubscribe: true, dynacast: false });
console.log(`[voice-agent] joined room for canvas ${CANVAS} as ${AGENT_IDENTITY}`);

const liveness = createLiveness({
  graceMs: 60_000,
  isAgent: (id) => id === AGENT_IDENTITY,
  onExit: () => {
    console.log('[voice-agent] last human left — exiting');
    void room.disconnect().finally(() => process.exit(0));
  },
});
for (const p of room.remoteParticipants.values()) liveness.join(p.identity);
room.on(RoomEvent.ParticipantConnected, (p) => liveness.join(p.identity));
room.on(RoomEvent.ParticipantDisconnected, (p) => liveness.leave(p.identity));

// No local VAD: Silero runs ONNX inference on the container's CPU and falls behind the
// live stream under load ("inference is slower than realtime" flood — diagnosed live
// 2026-07-18: the pipeline backs up, end-of-turn never fires, cedar goes silent while
// staying connected). Deepgram's server-side endpointing does turn detection instead —
// zero local audio inference.
const session = new voice.AgentSession({
  stt: 'deepgram/nova-3',
  tts: 'inworld/inworld-tts-2',
  llm: new anthropic.LLM({ model: 'claude-sonnet-5', ...auth }),
  turnHandling: { turnDetection: 'stt' },
});

// Transcript (ADR-0017): every finalized utterance — human or agent — appends a JSONL
// line. A byproduct of listening; audio is never recorded.
const transcriptFile = transcriptPath(process.env.CANVAS_CWD ?? process.cwd(), CANVAS);
session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
  const item = ev.item;
  if (!('textContent' in item) || !item.textContent) return;
  const speaker = item.role === 'assistant' ? AGENT_IDENTITY : 'human';
  appendUtterance(transcriptFile, { speaker, ts: Date.now(), text: item.textContent });
});

await session.start({
  agent: new voice.Agent({ instructions, tools }),
  room,
});
console.log('[voice-agent] session started — listening');
