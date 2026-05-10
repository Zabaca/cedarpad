import { generateKeyBetween } from 'fractional-indexing'

export function firstKey(): string {
  return generateKeyBetween(null, null)
}

export function keyBetween(prev: string | null, next: string | null): string {
  return generateKeyBetween(prev, next)
}
