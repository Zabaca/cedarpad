/**
 * cedarpad sidecar server.
 *
 * NDJSON RPC over stdio. One JSON object per line on stdin (request), one
 * per line on stdout (response). All log output goes to stderr so it never
 * collides with the wire format.
 *
 * The Tauri shell spawns this process and pipes stdin/stdout to it.
 */
import { Methods, RpcRequestSchema, RunnerEventSchema, type RpcResponse, type MethodName } from '../../src/contract.ts'
import { handlers, getSdkRunnerForWorkspace } from './handlers.ts'

function send(resp: RpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + '\n')
}

function log(...args: unknown[]): void {
  process.stderr.write('[sidecar] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n')
}

async function dispatch(line: string): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (e) {
    log('parse error', String(e))
    return
  }

  const req = RpcRequestSchema.safeParse(raw)
  if (!req.success) {
    send({ kind: 'err', id: 'unknown', error: { code: 'BAD_REQUEST', message: req.error.message } })
    return
  }

  const method = req.data.method as MethodName
  const spec = Methods[method]
  if (!spec) {
    send({ kind: 'err', id: req.data.id, error: { code: 'UNKNOWN_METHOD', message: `no method ${method}` } })
    return
  }

  const inputParse = spec.input.safeParse(req.data.params)
  if (!inputParse.success) {
    send({ kind: 'err', id: req.data.id, error: { code: 'BAD_INPUT', message: inputParse.error.message } })
    return
  }

  // Streaming method — special-cased because its return is an AsyncIterable
  // of events, not a plain promise. The wire shape: zero or more
  // {kind:'stream', id, event} frames followed by exactly one terminal
  // {kind:'ok', id, result} frame, all sharing the request id.
  if (method === 'sdk.sendPrompt') {
    const params = inputParse.data as {
      workspaceId: string
      threadRootId: string
      prompt: string
      repoPath: string
    }
    try {
      const runner = await getSdkRunnerForWorkspace(params.workspaceId)
      let lastTurnId = ''
      let reason: 'done' | 'cancelled' | 'error' = 'done'
      for await (const event of runner.sendPrompt({
        threadId: params.threadRootId,
        prompt: params.prompt,
        repoPath: params.repoPath,
      })) {
        const evParse = RunnerEventSchema.safeParse(event)
        if (!evParse.success) {
          log('skipping malformed runner event', evParse.error.message)
          continue
        }
        send({ kind: 'stream', id: req.data.id, event: evParse.data })
        if (evParse.data.kind === 'turn-complete') lastTurnId = evParse.data.turnId
        if (evParse.data.kind === 'error') reason = 'error'
      }
      const result = { turnId: lastTurnId, reason }
      const outputParse = spec.output.safeParse(result)
      if (!outputParse.success) {
        send({ kind: 'err', id: req.data.id, error: { code: 'BAD_OUTPUT', message: outputParse.error.message } })
        return
      }
      send({ kind: 'ok', id: req.data.id, result: outputParse.data })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ kind: 'err', id: req.data.id, error: { code: 'HANDLER_ERROR', message } })
    }
    return
  }

  const handler = handlers[method]
  if (!handler) {
    send({ kind: 'err', id: req.data.id, error: { code: 'NOT_IMPLEMENTED', message: `${method} has no handler` } })
    return
  }

  try {
    const result = await handler(inputParse.data as never)
    const outputParse = spec.output.safeParse(result)
    if (!outputParse.success) {
      send({ kind: 'err', id: req.data.id, error: { code: 'BAD_OUTPUT', message: outputParse.error.message } })
      return
    }
    send({ kind: 'ok', id: req.data.id, result: outputParse.data })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send({ kind: 'err', id: req.data.id, error: { code: 'HANDLER_ERROR', message } })
  }
}

// Read NDJSON from stdin
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  let idx: number
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line) void dispatch(line)
  }
})

process.stdin.on('end', () => {
  log('stdin closed; exiting')
  process.exit(0)
})

log('ready')
