import { describe, it, expect } from 'vitest'
import { interpret } from './keymap'
import type { Node } from './contract'

function n(id: string, parentId: string | null = null): Node {
  return {
    id,
    parentId,
    position: 'a0',
    kind: 'content',
    content: '',
    metadata: {},
    completed: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('keymap', () => {
  const base = { node: n('cur', 'p1'), parent: n('p1'), prevSibling: null, prevSiblingLastChildId: null }

  it('Enter creates a new sibling after current', () => {
    const out = interpret({ key: 'Enter', shiftKey: false }, { ...base, isContentEmpty: false })
    expect(out).toEqual({ kind: 'create-sibling', afterId: 'cur', parentId: 'p1' })
  })

  it('Tab nests under prevSibling', () => {
    const ctx = { ...base, prevSibling: n('prev'), prevSiblingLastChildId: 'last', isContentEmpty: false }
    const out = interpret({ key: 'Tab', shiftKey: false }, ctx)
    expect(out).toEqual({ kind: 'nest', nodeId: 'cur', newParentId: 'prev', prevSiblingId: 'last' })
  })

  it('Tab is a no-op at first child', () => {
    const out = interpret({ key: 'Tab', shiftKey: false }, { ...base, isContentEmpty: false })
    expect(out).toEqual({ kind: 'noop' })
  })

  it('Shift+Tab outdents to grandparent, after parent', () => {
    const out = interpret({ key: 'Tab', shiftKey: true }, { ...base, isContentEmpty: false })
    expect(out).toEqual({ kind: 'outdent', nodeId: 'cur', newParentId: null, prevSiblingId: 'p1' })
  })

  it('Shift+Tab is a no-op at root', () => {
    const ctx = { node: n('cur', null), parent: null, prevSibling: null, prevSiblingLastChildId: null, isContentEmpty: false }
    const out = interpret({ key: 'Tab', shiftKey: true }, ctx)
    expect(out).toEqual({ kind: 'noop' })
  })

  it('Backspace on empty deletes', () => {
    const out = interpret({ key: 'Backspace', shiftKey: false }, { ...base, isContentEmpty: true })
    expect(out).toEqual({ kind: 'delete-empty', nodeId: 'cur' })
  })

  it('Backspace on non-empty is a no-op', () => {
    const out = interpret({ key: 'Backspace', shiftKey: false }, { ...base, isContentEmpty: false })
    expect(out).toEqual({ kind: 'noop' })
  })
})
