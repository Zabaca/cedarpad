// The huddle brain's request builder (ADR-0017): raw streaming /v1/messages.
// Auth precedence: an API key wins if present; otherwise the
// Claude subscription OAuth token (claude setup-token) with the oauth beta header —
// spiked 2026-07-18: streaming + tool_use round-trips work. If Anthropic tightens OAuth
// enforcement, minting an API key restores service with no code change.

export const VOICE_MODEL = 'claude-sonnet-5';
// The OAuth path requires this exact identity as the first system block.
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
export type Msg = { role: 'user' | 'assistant'; content: unknown };

export function buildClaudeRequest(
  auth: { apiKey?: string; oauthToken?: string },
  system: string,
  messages: Msg[],
  tools: Tool[],
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  let sys: unknown = system;
  if (auth.apiKey) {
    headers['x-api-key'] = auth.apiKey;
  } else if (auth.oauthToken) {
    headers.authorization = `Bearer ${auth.oauthToken}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    sys = [
      { type: 'text', text: CC_IDENTITY },
      { type: 'text', text: system },
    ];
  } else {
    throw new Error('no Anthropic credential configured');
  }
  return {
    headers,
    body: JSON.stringify({ model: VOICE_MODEL, max_tokens: 1000, stream: true, system: sys, messages, tools }),
  };
}
