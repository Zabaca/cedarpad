# Rescued agent auto-memory

Eight files, 11 KB, recovered from `workspaces/default/sessions.tar` on 2026-07-29 while
reviewing [#356](https://github.com/Zabaca/cedarpad/issues/356).

## Why these are here

They persisted **by accident**. The `sessions` tarball sink swept
`~/.claude/projects` wholesale, and the container's Claude auto-memory happens to live
under that path. Nothing ever decided that agent memory should be durable — it rode along
in an archive built for transcripts.

#356 makes Transcripts per-session objects and retires the sessions sink, which means the
sweep stops. These files stop persisting across a container recycle from the moment it
deploys. That is a real behaviour change, and it is recorded here rather than discovered
later as a mystery.

Nothing was destroyed: `sessions.tar` still exists in R2 and still holds all of this.
These copies exist so the content survives independently of an archive that
[#366](https://github.com/Zabaca/cedarpad/issues/366) is going to retire.

## Directory names

Each directory is a Claude project slug — the working directory with slashes replaced by
dashes. `-app-agent-canvas` is the canvas chat agent; `…--dev-agent-hub` is the dev-agent.
The leading dash is part of the slug, not a typo.

## What is actually in them

Two are worth reading rather than filing.

**`project_promote_component_not_durable.md`** is a first-hand production bug report about
`promote_component`, written by the agent that hit it. It records that promotion reported
success while the shared-tier write never landed, and — the sharp part — that because
promote *removes* the own-tier copy first, resolution then fell through to a same-named
Component in the read-only platform library. Three placed cards silently started rendering
an unrelated component with different props. No error was thrown.

This was sent to the agent implementing
[#359](https://github.com/Zabaca/cedarpad/issues/359) (three-tier resolution, promote,
adopt) as the incident behind that slice's atomicity requirement. It is the reason
"atomic promote" means *never remove tier 1 until tier 2 is durable*, rather than "roll
back on failure" — a failed promote does not land in neither tier, it lands on a
plausible, wrong card.

**`feedback_dont_bury_the_lead.md`** is a standing style rule a user gave the agent:
headings state the conclusion, not the topic. Losing it would silently revert a
preference someone took the trouble to teach.

The rest are memory indexes and two dev-agent notes.

## The open question

Should agent auto-memory be durable *on purpose*?

It is not a Record — we do not own its schema, the Claude Agent SDK does. By ADR-0022's
own dividing line that makes it a File, and the per-session Transcript object is the
precedent for how a File persists now.

Doing nothing is a defensible answer: memory is derived, an agent rebuilds it, and no user
asked for it to survive. But it should be an answer someone gives, not a side effect of
retiring a tarball. Until then, these eight files are the only copies outside an archive
we are deleting.
