// ADR-0017: the bridge owns the agent worker's lifecycle. One worker per canvas,
// single-flight (a join while one is alive answers "joined" instead of spawning a
// twin); the handle is dropped on exit so the next join spawns fresh; a hard
// max-duration kill is the absurdity backstop. Container shutdown reaps children
// for free.

export type WorkerHandle = { kill: () => void; onExit: (cb: () => void) => void };
export type SpawnWorker = (canvasId: string) => WorkerHandle;

export function createHuddleSupervisor(opts: { spawn: SpawnWorker; maxDurationMs: number }): {
  ensure: (canvasId: string) => { joined: boolean };
} {
  const alive = new Map<string, WorkerHandle>();

  return {
    ensure(canvasId) {
      if (alive.has(canvasId)) return { joined: true };
      const handle = opts.spawn(canvasId);
      alive.set(canvasId, handle);
      const maxTimer = setTimeout(() => handle.kill(), opts.maxDurationMs);
      handle.onExit(() => {
        clearTimeout(maxTimer);
        alive.delete(canvasId);
      });
      return { joined: false };
    },
  };
}
