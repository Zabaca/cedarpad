/**
 * cedarpad sidecar server.
 *
 * NDJSON RPC over stdio. One JSON object per line on stdin (request), one
 * per line on stdout (response). All log output goes to stderr so it never
 * collides with the wire format.
 *
 * The Tauri shell spawns this process and pipes stdin/stdout to it.
 */
import { Methods, RpcRequestSchema, type RpcResponse, type MethodName } from '../../src/contract.ts'
import { handlers } from './handlers.ts'

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
