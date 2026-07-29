# Workspace content is Records, not a filesystem we snapshot

Status: **proposed** (design, grill session 2026-07-29). Not built. Motivated by the data
loss of the same day (see Consequences). Vocabulary: canvas
[CONTEXT.md](../../packages/canvas/CONTEXT.md) — **Record vs File**.

Agent-authored workspace content — **Components**, their **data files**, and **Workspace
skills** — stops being "a directory tree we periodically tar into R2" and becomes **rows in
D1**. The container filesystem becomes a *rendering* of those rows, materialized on demand so
vite can compile. **Session transcripts** deliberately do NOT move: they stay per-session R2
objects. This completes the direction [ADR-0018](./0018-platform-data-layer-on-d1.md) (platform
data → D1) and [ADR-0019](./0019-canvas-sync-on-tldraw-sync.md) (canvas documents → a Durable
Object) already set; the tars were what remained.

## Why

On 2026-07-29 every own-tier component, every custom handler, and every workspace skill in the
production workspace were destroyed in a single flush. Two were unrecoverable. The mechanism:

1. One R2 key held a whole artifact (`workspaces/<ws>/canvas-components.tar`).
2. Saving was a **full replace** of whatever sat on disk (`serialize: () => tarCanvasDirs(SRC_ROOT)`).
3. A failed restore at boot was **swallowed** — `container-start.ts` logged "starting with none"
   and continued.

A boot that restored nothing came up with an empty tree, and the next write tarred that empty
tree over the only copy. An empty-archive guard now blocks that specific shape, but it is a
seatbelt on a design that keeps generating this class of bug.

The tar is not the bug. The bug is the **inversion**: the container filesystem was the
authoritative copy and R2 a periodic snapshot of it, which means **a failed read can become a
destructive write**. Every symptom follows from that one choice — no partial recovery (one
key), no history (full replace), 49 MB per turn for transcripts (snapshotting a whole tree to
capture one appended file), and failure that fails *open*.

Inverting it changes the failure mode from **data loss** to **broken container**: a
materialization that fails yields something loud and rebootable instead of something silent
and permanent. That asymmetry is the entire point.

## Decision

1. **Records, not files.** The authoring surface is already a closed schema — `writeComponent`
   (validated `^[A-Za-z][A-Za-z0-9_-]*$`), `writeDataFile` (closed extension set
   `json|csv|txt|md`), and skills (already a files-only `{name, files:[{path,content}]}` wire
   format). Truth is the row; the file exists only because vite compiles from disk.

   This makes **structural** what `disallowedTools` today only steers. Chat turns drop
   `Write`/`Edit` so that content is authored solely through registered tools (the QABoard
   incident), but `Bash` remains and can still write a file the old tar would faithfully
   persist — unregistered and invisible to `list_components`. Under Records, an artifact with
   no tool has nowhere to live. **Accepted cost:** a Bash-written file works until the next
   recycle, then vanishes.

2. **The dividing line is who owns the schema.** Not size, not mutability.
   - *We* define components/data/skills and own the only door → **Records** (rows).
   - The **Claude Agent SDK** writes transcripts, owns the format, and reads them back on
     `--resume`; we never author a line → **Files** (opaque per-session objects).

   Deriving transcripts from rows would mean round-tripping an undocumented, evolving format
   faithfully enough that resume keeps working — a bet on someone else's file format, and a
   subtly wrong round-trip breaks conversation continuity *silently*. This is also what
   [ADR-0004](./0004-claude-code-sdk-as-transport.md) already says: the JSONL is authoritative,
   the UI is a projection.

3. **D1 is the store, and the limits decided it — not taste.** Max row/string **2 MB** (a 20 KB
   component or a 1 MB data file fits), max DB **10 GB** (a workspace's corpus is 1–2 MB), and
   **Time Travel gives 30-day point-in-time restore, which R2 has no equivalent for at all** —
   confirmed by inspecting the bucket after the loss. **Bound parameters are mandatory**: the
   max SQL statement is **100 KB**, so an inlined 1 MB data file would fail.

4. **Explicit version rows, not Time Travel as undo.** `wrangler d1 time-travel` restores a
   *whole database* — using it to recover one component would also roll back auth sessions,
   conversations, and the canvas registry. There is a surgical path (fork at a timestamp,
   extract the row) but it needs prod credentials and someone who knows the trick. Every write
   appends a version instead: ~270 KB/month at the measured rate (46 writes/month, 5.8 KB
   median), which makes "restore this component" a product feature rather than an incident
   procedure — and finally records **who** changed a component, which nothing does today.

5. **Materialization is on demand; there is no boot restore.** A vite middleware resolves
   `/src/canvas-<id>/components/<Name>.tsx` by querying D1 on a miss, writing the file, then
   serving. This **deletes** the failure mode rather than guarding it: there can be no
   "boot restored nothing" bug where there is no boot restore. It also drops the restore-and-write
   step from cold boot, already a live latency concern. Two existing behaviours make it fit:
   `componentUrls()` walks own → shared → base, so a 404 is already normal and expected; and
   `component-loader.ts` already retries with backoff, so a transient miss lands in a window
   the client handles.

6. **Custom handlers are dropped**, not migrated. They never had an authoring door — no
   `write_custom_handler` exists in the 18-tool surface, and chat turns drop `Write`/`Edit`, so
   the only mechanism was `Bash`. They persisted purely because the tar swept the directory.
   Production held zero of them. Removing the feature is honest; giving it a tool can be a
   deliberate act later.
   _Correction (#357, verified against production R2 before deleting)_: "zero" is right about
   **agent-authored** handlers but wrong about the archive — `workspaces/default/custom.tar` holds
   one file, `hello.ts`, byte-identical (sha256 `d15df2ad…`) to the image seed at
   `server/custom/hello.ts`. Nothing a user wrote; the removal stands.

7. **Transcripts: one R2 object per session, materialized on resume.** After a turn, PUT only
   the file that turn touched — `ChatMeta` already holds `chatId → sessionId`, so the target is
   always known. Before resuming session X, GET that one file. Cold boot downloads nothing.
   Today's monolith re-uploads **49 MB every turn** to capture ~650 KB of change; this is a ~75×
   reduction and retires the last tar. A D1 **read-model projection** (so the edge can render a
   transcript without waking a container) is deliberately deferred to its own decision.

8. **The platform tier stays image-only.** Base components are neither Record nor File: they are
   deploy-gated code, identical across workspaces, versioned with the image that expects them.
   Moving them into D1 would demote platform code to workspace data and break the
   **gated-layer rule**. The edge learns the base tier from a **build-time manifest** generated
   from `src/canvas-components/` — which also makes adding or removing a platform component a
   reviewable diff instead of an invisible filesystem fact.

9. **Deleting a canvas soft-deletes its own-tier records**, reclaimed only by an explicit purge.
   Today *nothing* removes a canvas's component dir — the source survives by accident and leaks
   forever. A hard cascade would make one click destroy source permanently, which is the shape
   that just cost us two components; soft-delete keeps decision 4's recoverability honest.

## Consequences

- **Authoring gains a network dependency.** Writes go container → platform RPC → edge → D1, and
  the container deliberately holds no database credential (ADR-0018). If the edge is
  unreachable, `write_component` now **fails** where today it would succeed to disk. That is a
  real availability downgrade and the right trade: today's write succeeds, reports success, and
  can evaporate on the next bad boot. A write that fails loudly beats one that lies.
- **The disk write becomes best-effort.** Because of decision 5, writing the file at author time
  is only an HMR trigger; if it fails, the next fetch materializes it. Correctness no longer
  depends on it.
- **The migration will never be cheaper.** `canvas-components.tar`, `custom.tar` and
  `skills.tar` are all empty right now, so the backfill is the two surviving shared components
  plus whatever is restored from transcripts. The outage performed the "drain the old store"
  step for us.
- **`write_data`'s 1 MB cap loses its stated reason** — `DATA_MAX_BYTES` is commented "the
  components sink tars the whole dir on every flush". With per-row writes that justification is
  gone; the cap should be re-derived from D1's 2 MB row limit, not inherited.
- **`custom.tar` / `skills.tar` may be self-perpetuating empties.** The image ships
  `server/custom/hello.ts`, yet the stored archive is empty — suggesting a restore can clear a
  directory the image populated. The empty-archive guard freezes that state rather than
  repairing it; this needs its own look during implementation.
  _Correction (#357)_: `custom.tar` is **not** empty — as of 2026-07-29T18:14:01Z it is 10,240
  bytes holding exactly the image seed, i.e. the boot restore + flush round-tripped the image's
  own file rather than clearing it. Whatever remains of this hypothesis has to be re-tested
  against `skills.tar`; the `custom.tar` half of it is disproven.
- **What this does NOT fix**: the swallowed restore failure in `container-start.ts` is removed
  by decision 5 rather than repaired, so any *remaining* restore path (transcripts) must not
  reintroduce fail-open.
