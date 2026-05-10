import { describe, it, expect } from 'vitest'
import { keyBetween, firstKey } from './ordering.ts'

describe('ordering', () => {
  it('keyBetween(null, null) returns a deterministic first key', () => {
    expect(keyBetween(null, null)).toBe(firstKey())
  })

  it("keyBetween(null, 'a0') returns a key strictly less than 'a0'", () => {
    const k = keyBetween(null, 'a0')
    expect(k < 'a0').toBe(true)
  })

  it("keyBetween('a0', null) returns a key strictly greater than 'a0'", () => {
    const k = keyBetween('a0', null)
    expect(k > 'a0').toBe(true)
  })

  it("keyBetween('a0', 'a1') returns a key strictly between them", () => {
    const k = keyBetween('a0', 'a1')
    expect(k > 'a0').toBe(true)
    expect(k < 'a1').toBe(true)
  })

  it('throws when prev >= next', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow()
    expect(() => keyBetween('a0', 'a0')).toThrow()
  })

  it('100 random insertions stay sorted', () => {
    const keys: string[] = []
    keys.push(keyBetween(null, null))
    for (let i = 0; i < 99; i++) {
      // Insert at a random position
      const pos = Math.floor(Math.random() * (keys.length + 1))
      const prev = pos === 0 ? null : keys[pos - 1]!
      const next = pos === keys.length ? null : keys[pos]!
      const k = keyBetween(prev, next)
      keys.splice(pos, 0, k)
    }
    const sorted = [...keys].sort()
    expect(keys).toEqual(sorted)
  })
})
