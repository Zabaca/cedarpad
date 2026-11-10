# Recovered Components — 2026-07-29

These three files are the **only surviving copies** of Component source that R2 no
longer holds. They are here because a temp directory is not a backup, and this
repository is the most durable place available until #365 restores them properly.

Do not treat this directory as a component tier. Nothing resolves it, nothing
compiles it. It is an incident artifact with exactly one consumer: the migration
slice, [#365](https://github.com/Zabaca/cedarpad/issues/365), which reads these
bytes and writes them as Records. Delete the directory once that has run and the
Components render from the store.

## What happened

On 2026-07-29 at 09:39 UTC, `canvas-components.tar`, `custom.tar` and `skills.tar`
were each overwritten with an empty archive (10,240 bytes — six directory entries,
zero files) within a 700 ms window. R2 has no object versioning, so the previous
objects were gone the moment they were replaced.

Root cause was an inversion, not a bug in the tar code: the container filesystem
was authoritative and R2 a periodic snapshot of it, so a boot that failed to
restore came up empty and the next flush tarred that emptiness over the only copy.
A failed *read* became a destructive *write*. See
[ADR-0022](../../../adr/0022-workspace-content-is-records-not-files.md).

## Where these came from

Not from a backup — there wasn't one. They were reconstructed by mining
`sessions.tar` for `write_component` tool calls and taking the last complete
source payload for each name.

That is why there are three files and not five. Two other components (their names are withheld for publication) were also destroyed, and no `write_component` call for either
appears in any retained transcript. They are permanently lost. The Standup
canvas will still show two dead cards after #365; that is expected, and the cards
should be removed rather than waited on.

## Fidelity

Each file is the last-written source, so it is exactly what the store would have
held at the time of loss. Verified: none of the three import a sibling data file,
so restoring them does not depend on [#360](https://github.com/Zabaca/cedarpad/issues/360).
They were own-tier on the Standup canvas.

**Which is `cv_edd9bab6-8bae-4a7a-a694-9abfa9965db9`**, not `cv_4bfb07e3-cd4e-4fc8-a3ed-54a4b20d483b`
as #365 and the notes above it assumed. That assumption came from `cv_4bfb07e3` having a
present-but-empty `components/` directory in `canvas-components.tar` — which is not evidence
of loss, because it is also what a canvas that never had components looks like, and the
directories in that archive are only whichever ones happened to exist on the container
filesystem at flush time. The registry made it worse: `cv_4bfb07e3` is named "Cedarpad", and
`cv_edd9bab6` is the actual "Standup".

The evidence that settles it is **placed instances**, because a placed card resolves against
its own canvas's tier — so wherever the cards are is where the source has to live. Read from
the live room documents (`GET /api/canvas-sync/:id/snapshot`; the R2 blobs are stale, the
Durable Object has been authoritative since ADR-0019) on 2026-07-29, `cv_edd9bab6` holds one
card each of `AudioMeeting`, `ChatRoom`, `ComponentCatalog` and the two components whose
names are withheld for publication, and `cv_4bfb07e3` holds none of them.

Two of the three are byte-identical to what was recovered. `ComponentCatalog.tsx`
is **not**: as recovered it fetched `/api/custom/component-catalog`, a custom handler
destroyed in the same flush and a feature since removed ([#357](https://github.com/Zabaca/cedarpad/issues/357)),
so restoring those bytes unchanged would have put back a card that throws on mount.
The handler was a thin proxy, so #365 repointed the two calls at its live targets —
the now edge-served `GET /api/components` ([#363](https://github.com/Zabaca/cedarpad/issues/363))
and the bridge's `POST /api/components/place` — and changed nothing else. The diff is
in the #365 PR; the pre-repoint bytes (6,463) are in this file's git history.

| File | Bytes | sha256 (first 16) | Fidelity |
| --- | --- | --- | --- |
| `AudioMeeting.tsx` | 13,410 | `eac89ecdfd6c6d2f` | as recovered |
| `ChatRoom.tsx` | 16,076 | `96e443566b60eab1` | as recovered |
| `ComponentCatalog.tsx` | 6,947 | `e68a1618c4351f71` | recovered, then repointed (#365) |

The lengths and hashes above are **pinned** in `packages/canvas/server/record-migration.ts`
and checked before anything is written: the migration refuses to run against bytes it was
not shown. Editing a file here without updating that pin fails the check, by design.

## `MartSessionSummary.tsx` — recovered, deliberately NOT in the migration

| File | Bytes | sha256 (first 16) | Fidelity |
| --- | --- | --- | --- |
| `MartSessionSummary.tsx` | 2,600 | `465db953a8e699d3` | recovered from a `Read` tool result |

A **sixth** casualty, found while checking the fifth. It is not in
`MIGRATION_PLAN` and its bytes are not pinned — see
[#381](https://github.com/Zabaca/cedarpad/issues/381).

**Where it lived is unambiguous.** Transcripts name the path
`src/canvas-cv_69599bdb-b6bc-4cee-b1d5-398e4fbe2ef7/components/MartSessionSummary.tsx`
— the own tier of a *third* canvas, neither of the two above. That canvas's whole
directory is gone from `canvas-components.tar`.

**How it was recovered differs from the other four, and that matters.** There is no
`write_component` call for it in any retained transcript — it was only ever `Read`,
`place_component`ed and `read_component`ed. So the source here comes from a `Read`
tool *result*, reconstructed by stripping `cat -n` line numbering.

That is weaker provenance than a write payload, so it was checked rather than assumed:
no truncation markers, and the file closes naturally at line 51 with a balanced
`}`. It appears complete. But a `Read` result is a copy of the file *at read time*,
not the last write — if the Component was edited afterwards, this is the earlier version
and nothing retained would show it.

**The tier is unsettled, which is why it is out of scope.** The R2 snapshot of
`cv_69599bdb` holds 2 `MartSessionSummary` cards, agreeing with the file path. A live
read during #365 instead reported the cards on `cv_4bfb07e3`. Those two disagree and the
disagreement is **not resolved** — R2 is stale, but the file path corroborates R2. Do not
restore this one until someone checks the live document for both canvases.

It is here because `sessions.tar` is the only thing holding it, and
[#366](https://github.com/Zabaca/cedarpad/issues/366) deletes that archive.
