// ADR-0017: the bridge owns the agent worker's lifecycle. One worker per canvas,
// single-flight (a join while one is alive answers "joined" instead of spawning a
// twin); the handle is dropped on exit so the next join spawns fresh; a hard
// max-duration kill is the absurdity backstop. Container shutdown reaps children
// for free.

export type WorkerHandle = { kill: () => void; onExit: (cb: () => void) => void };
export type SpawnWorker<TArg = unknown> = (canvasId: string, arg?: TArg) => WorkerHandle;

export function createHuddleSupervisor<TArg = unknown>(opts: {
  spawn: SpawnWorker<TArg>;
  maxDurationMs: number;
}): {
  ensure: (canvasId: string, arg?: TArg) => { joined: boolean };
} {
  const alive = new Map<string, WorkerHandle>();

  return {
    ensure(canvasId, arg) {
      if (alive.has(canvasId)) return { joined: true };
      const handle = opts.spawn(canvasId, arg);
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
