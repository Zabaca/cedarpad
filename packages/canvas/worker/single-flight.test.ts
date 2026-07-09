import { describe, expect, test } from 'bun:test';

import { singleFlight } from './single-flight.ts';

// A promise whose resolution we control, so we can hold several callers concurrently in-flight and
// observe how many times the underlying fn actually ran.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  test('collapses concurrent callers for the same key onto ONE fn invocation', async () => {
    const map = new Map<string, Promise<string>>();
    const d = deferred<string>();
    let runs = 0;
    const fn = () => {
      runs += 1;
      return d.promise;
    };

    // Five concurrent cold requests, as a page load would fire them.
    const callers = [0, 1, 2, 3, 4].map(() => singleFlight(map, 'canvas', fn));
    expect(runs).toBe(1); // the boot ran exactly once despite five callers
    expect(new Set(callers).size).toBe(1); // they all got the SAME promise

    d.resolve('up');
    expect(await Promise.all(callers)).toEqual(['up', 'up', 'up', 'up', 'up']);
  });

  test('clears on settle so the NEXT cold cycle starts a fresh boot', async () => {
    const map = new Map<string, Promise<string>>();
    let runs = 0;
    const fn = () => {
      runs += 1;
      return Promise.resolve('up');
    };

    await singleFlight(map, 'canvas', fn);
    expect(map.has('canvas')).toBe(false); // entry removed after it settled
    await singleFlight(map, 'canvas', fn);
    expect(runs).toBe(2); // a fresh boot ran the second time (not a stale resolved promise)
  });

  test('different keys run independently (a product boot never blocks the dev-agent boot)', () => {
    const map = new Map<string, Promise<string>>();
    let runs = 0;
    const fn = () => {
      runs += 1;
      return deferred<string>().promise; // never settles
    };
    singleFlight(map, 'canvas', fn);
    singleFlight(map, 'dev-agent', fn);
    expect(runs).toBe(2);
    expect(map.size).toBe(2);
  });

  test('a rejected boot propagates to all awaiters AND clears, so a retry can boot again', async () => {
    const map = new Map<string, Promise<string>>();
    const d = deferred<string>();
    let runs = 0;
    const fn = () => {
      runs += 1;
      return runs === 1 ? d.promise : Promise.resolve('up');
    };

    const a = singleFlight(map, 'canvas', fn);
    const b = singleFlight(map, 'canvas', fn);
    expect(runs).toBe(1);
    d.reject(new Error('boot failed'));

    await expect(a).rejects.toThrow('boot failed');
    await expect(b).rejects.toThrow('boot failed'); // the shared failure reached the second caller
    expect(map.has('canvas')).toBe(false); // cleared, so the container isn't stuck un-bootable
    await expect(singleFlight(map, 'canvas', fn)).resolves.toBe('up'); // retry boots fresh
    expect(runs).toBe(2);
  });
});
