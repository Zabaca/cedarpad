# Renderer/Engine Send-Prompt Dispatch Duplication

This project accepts that the three-way send-prompt dispatch decision (root-level
"Or" bootstrap / bearer-parent-send / stamp-then-send) is implemented in two
places: `threadEngine.sendPrompt` (sidecar-side, TDD-covered) and the renderer's
`Tree.tsx` `handleSendPrompt` (inline reimplementation).

## Why this is out of scope

The duplication exists because the renderer talks to the thread engine over an
RPC boundary, and the actual SDK call is a separate streaming RPC method that
can't carry the engine's live values directly. Unifying the two would mean
either adding a new non-streaming RPC method or reshaping the existing
streaming method's flow — a real change to the RPC contract surface, not a
pure refactor.

Not blocking: neither the "Or" bootstrap flow nor the follow-up-prompt flow is
broken today, and both are covered by e2e specs. The duplication is a
maintenance/DRY concern, not a live bug.

## Prior requests

- #35 — "Unify renderer send-prompt dispatch with threadEngine.sendPrompt"
