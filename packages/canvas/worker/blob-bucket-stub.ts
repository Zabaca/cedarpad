// A stand-in for the R2 binding the workspace-blob door uses (worker/workspace-blobs-api.ts), for
// tests only. It speaks the same three calls with the same shapes (`get` and `head` with a size,
// `get` and `put` over streams) and records every key it is asked for, so a test can prove what was
// NOT touched, and whether a body was ever read.

export function bucketStub(seed: Record<string, string> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const touched: string[] = [];
  const stub = {
    objects,
    touched,
    /** How many `put` calls reached the bucket. */
    puts: 0,
    bucket: {
      get: async (key: string) => {
        touched.push(key);
        const v = objects.get(key);
        if (v === undefined) return null;
        return { size: v.byteLength, body: new Blob([v as BlobPart]).stream() as ReadableStream<Uint8Array> };
      },
      head: async (key: string) => {
        touched.push(key);
        const v = objects.get(key);
        return v === undefined ? null : { size: v.byteLength };
      },
      put: async (key: string, value: ReadableStream<Uint8Array>) => {
        touched.push(key);
        stub.puts += 1;
        objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
      },
    },
  };
  return stub;
}

/** A request body that reports whether anything ever pulled from it. */
export function trackedBody(bytes: number) {
  const state = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(new Uint8Array(Math.min(bytes, 1024)));
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}
