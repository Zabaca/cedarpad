// Resolves the chat's friendly model selection (sonnet/opus/haiku, or an explicit id)
// into the SDK model string. Lifted out of runChat() (server/agent.ts) so the mapping
// can be unit-tested without the SDK — model-resolution.test.ts imports from here.

export const MODEL = process.env.CANVAS_MODEL ?? 'sonnet';

// 1M context is selected via the `[1m]` model suffix (the same one the Claude Code CLI
// uses; works on subscription auth — the `betas` option does NOT). BILLING: on
// Max/Team/Enterprise, Opus 1M is INCLUDED FREE but Sonnet 1M costs usage credits; on
// Pro both cost credits. So auto-upgrade OPUS only (free); leave sonnet/haiku standard
// to avoid silently billing 1M-sonnet on the default model. Want sonnet-1M? select
// `sonnet[1m]` explicitly (the suffix passes straight through untouched).
const FREE_1M_MODELS = new Set(['opus', 'claude-opus-4-8']);
const withContext = (m: string): string => (FREE_1M_MODELS.has(m) ? `${m}[1m]` : m);

// The chat sends friendly family aliases (sonnet/opus/haiku). The SDK's bundled `sonnet` alias
// still resolves to claude-sonnet-4-6, so pin it to the explicit Sonnet 5 id to run the canvas
// agent on Sonnet 5. `opus`/`haiku` aliases already track the latest, and any explicit id (or a
// `[1m]` suffix) isn't in the map and passes through untouched.
const ALIAS_TO_ID: Record<string, string> = { sonnet: 'claude-sonnet-5' };
// The SDK model string for a selected alias: pin the alias to an explicit id, then apply the 1M
// context suffix (opus-only, free).
export const resolveModelForSdk = (m: string): string => withContext(ALIAS_TO_ID[m] ?? m);
