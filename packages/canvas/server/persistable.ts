// One sink for every durable artifact (ADR 0003). Components, skills, and chat metadata
// each register as a Persistable; every save flows through one
// attempt → record-health → log wrapper so a silent failure (the class of bug that hid
// the dead sessions watcher) is visible at /api/status for all of them. Only the wrapper and
// the health map are shared — each artifact keeps its own serialize (tar vs JSON) and guard.
//
// GUARDS ARE NOT OPTIONAL FOR FULL-REPLACE ARTIFACTS. This comment used to say "canvas
// keeps its degraded/empty-write protection" — that guard was deleted with the old sync
// plane (ADR-0019 / #297, see blob-store.ts), the sentence was left behind, and for a
// while it read as though something here was still protecting the tars. Nothing was. On
// 2026-07-29 an empty flush destroyed every own-tier component, custom handler and
// workspace skill. Every tar artifact now registers `refuseEmptyTarball`
// (persist-guards.ts); a new one must too.

export type SaveResult = 'none' | 'ok' | 'skipped' | 'failed';

/** A durable artifact. `serialize` produces the value to save; an optional `guard`
 *  returning false skips the save (e.g. canvas refusing to blank known-good data, or a
 *  dirty-check on an unchanged dir); `save` writes it to the backend. */
export interface Persistable<T = unknown> {
  name: string;
  serialize: () => Promise<T> | T;
  guard?: (value: T) => boolean | Promise<boolean>;
  save: (value: T) => Promise<void>;
}

export interface Health {
  name: string;
  pending: boolean;
  lastResult: SaveResult;
  savedAt: number | null;
  lastError: string | null;
}

export class PersistSink {
  private readonly entries = new Map<string, { p: Persistable; health: Health }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly debounceMs = 0) {}

  register<T>(p: Persistable<T>): void {
    this.entries.set(p.name, { p: p as Persistable, health: { name: p.name, pending: false, lastResult: 'none', savedAt: null, lastError: null } });
  }

  /** Debounced flush (coalesces a burst into one write). The timer is a thin wrapper over
   *  flush(); flush() is the tested path. */
  schedule(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    e.health.pending = true;
    const prev = this.timers.get(name);
    if (prev) clearTimeout(prev);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        void this.flush(name);
      }, this.debounceMs),
    );
  }

  /** Serialize → guard → save, recording health. Never throws (a failed save is recorded,
   *  not propagated): the next trigger retries, and the tar/state always captures latest. */
  async flush(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    e.health.pending = true;
    try {
      const value = await e.p.serialize();
      if (e.p.guard && !(await e.p.guard(value))) {
        e.health.lastResult = 'skipped';
        return;
      }
      await e.p.save(value);
      e.health.lastResult = 'ok';
      e.health.savedAt = Date.now();
      e.health.lastError = null;
    } catch (err) {
      e.health.lastResult = 'failed';
      e.health.lastError = String((err as Error)?.message ?? err);
      console.error(`[persist] ${name} save failed; next trigger retries:`, err);
    } finally {
      e.health.pending = false;
    }
  }

  healthSnapshot(): Health[] {
    return [...this.entries.values()].map((e) => e.health);
  }
}
