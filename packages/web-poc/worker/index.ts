import { Hono } from 'hono'
import { createClient } from '@libsql/client'

type Bindings = {
  TURSO_URL: string
  TURSO_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/api/', (c) => c.json({ name: 'Cloudflare' }))

app.get('/api/health', (c) => c.json({ status: 'ok', ts: Date.now() }))

app.post('/api/echo', async (c) => {
  const youSent = await c.req.json()
  return c.json({ youSent })
})

// libSQL/Turso demo. Identical code locally (local sqld file over HTTP) and in
// prod (remote Turso) — only env.TURSO_URL / env.TURSO_KEY differ.
app.get('/api/visits', async (c) => {
  const client = createClient({
    url: c.env.TURSO_URL,
    authToken: c.env.TURSO_KEY || undefined,
  })
  await client.execute(
    'CREATE TABLE IF NOT EXISTS poc_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER)',
  )
  await client.execute({ sql: 'INSERT INTO poc_visits (ts) VALUES (?)', args: [Date.now()] })
  const result = await client.execute('SELECT COUNT(*) AS count FROM poc_visits')
  const visits = Number(result.rows[0]?.count ?? 0)
  return c.json({ visits })
})

export default app
