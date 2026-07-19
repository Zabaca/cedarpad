// ADR-0017 teardown invariant: humans keep the huddle alive; nothing else does.
// Track joins/leaves; when the set of NON-agent participants drains, arm a grace
// timer and call onExit — a rejoin within the grace cancels it. The agent's own
// presence deliberately never counts (the classic zombie is the agent keeping the
// room "occupied" forever).

export function createLiveness(opts: {
  graceMs: number;
  isAgent: (identity: string) => boolean;
  onExit: () => void;
}): { join: (identity: string) => void; leave: (identity: string) => void; dispose: () => void } {
  const humans = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    join(identity) {
      if (opts.isAgent(identity)) return;
      humans.add(identity);
      cancel();
    },
    leave(identity) {
      humans.delete(identity);
      if (humans.size === 0 && !timer) timer = setTimeout(opts.onExit, opts.graceMs);
    },
    dispose: cancel,
  };
}
