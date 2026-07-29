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

That is why there are three files and not five. `HenryAccessExplorer` and
`HenryScenarioMap` were also destroyed, and no `write_component` call for either
appears in any retained transcript. They are permanently lost. The Hudson Standup
canvas will still show two dead cards after #365; that is expected, and the cards
should be removed rather than waited on.

## Fidelity

Each file is the last-written source, so it is exactly what the store would have
held at the time of loss. Verified: none of the three import a sibling data file,
so restoring them does not depend on [#360](https://github.com/Zabaca/cedarpad/issues/360).
They were own-tier on the Hudson Standup canvas.

| File | Bytes |
| --- | --- |
| `AudioMeeting.tsx` | 13,410 |
| `ChatRoom.tsx` | 16,076 |
| `ComponentCatalog.tsx` | 6,463 |
