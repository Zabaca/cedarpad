import { useState } from 'react'

export function App() {
  // Counter state proves HMR preserves component state across worker edits.
  const [count, setCount] = useState(0)
  const [name, setName] = useState<string | null>(null)

  async function fetchName() {
    const res = await fetch('/api/')
    const data = (await res.json()) as { name: string }
    setName(data.name)
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1>cedarpad web-poc</h1>
      <button onClick={fetchName}>fetch /api/</button>
      <p>name: {name ?? '(unfetched)'}</p>
      <hr />
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
      <p>Edit worker/index.ts — this counter keeps its value (HMR).</p>
    </main>
  )
}
