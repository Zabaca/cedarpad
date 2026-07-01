// Example custom handler (ADR 0002). Reached at /api/custom/hello. Copy this shape
// for new handlers: export default a function that takes the Request and returns a
// Response (or any JSON-serializable value). You may call outbound — fetch a
// third-party API, hit a DB, or call the core canvas at `${CANVAS_BRIDGE}/api/canvas`
// (CANVAS_BRIDGE is in env). You CANNOT touch the CanvasStore directly (different
// process); go through the core's HTTP API for canvas reads/writes.
export default async function hello(req: Request): Promise<Response> {
  const name = new URL(req.url).searchParams.get('name') ?? 'world';
  return Response.json({ hello: name, method: req.method, at: new Date().toISOString() });
}
