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
  const base = {
    node: n('cur', 'p1'),
    parent: n('p1'),
    prevSibling: null,
    prevSiblingLastChildId: null,
  }

  it('Enter creates a new sibling after current', () => {
    const out = interpret({ key: 'Enter', shiftKey: false }, { ...base, isContentEmpty: false })
    expect(out).toEqual({ kind: 'create-sibling', afterId: 'cur', parentId: 'p1' })
  })

  it('Tab nests under prevSibling', () => {
    const ctx = {
      ...base,
      prevSibling: n('prev'),
      prevSiblingLastChildId: 'last',
      isContentEmpty: false,
    }
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
    const ctx = {
      node: n('cur', null),
      parent: null,
      prevSibling: null,
      prevSiblingLastChildId: null,
      isContentEmpty: false,
    }
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

  it('Cmd+. zooms into the focused node', () => {
    const out = interpret(
      { key: '.', shiftKey: false, metaKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'zoom-in', nodeId: 'cur' })
  })

  it('Cmd+, zooms out one level', () => {
    const out = interpret(
      { key: ',', shiftKey: false, metaKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'zoom-out' })
  })

  it('plain "." is a no-op (regular typing must not zoom)', () => {
    const out = interpret({ key: '.', shiftKey: false }, { ...base, isContentEmpty: false })
    expect(out).toEqual({ kind: 'noop' })
  })

  // ---- v1.1: Cmd+Enter is the sole conversation-starting verb ----

  it('Cmd+Enter on a non-root Content Node sends it as a Prompt', () => {
    const out = interpret(
      { key: 'Enter', shiftKey: false, metaKey: true },
      { ...base, isContentEmpty: false, contentText: 'what is in README?' },
    )
    expect(out).toEqual({ kind: 'send-prompt', nodeId: 'cur', prompt: 'what is in README?' })
  })

  it('Ctrl+Enter sends as Prompt (Linux/Windows)', () => {
    const out = interpret(
      { key: 'Enter', shiftKey: false, ctrlKey: true },
      { ...base, isContentEmpty: false, contentText: 'hello' },
    )
    expect(out).toEqual({ kind: 'send-prompt', nodeId: 'cur', prompt: 'hello' })
  })

  it('Cmd+Enter on a non-root Content Node with empty text is a no-op', () => {
    const out = interpret(
      { key: 'Enter', shiftKey: false, metaKey: true },
      { ...base, isContentEmpty: true, contentText: '   ' },
    )
    expect(out).toEqual({ kind: 'noop' })
  })

  it('Cmd+Enter on a root-level (parent=null) Content Node is "Or" bootstrap — still send-prompt with empty text', () => {
    const ctx = {
      node: n('root', null),
      parent: null,
      prevSibling: null,
      prevSiblingLastChildId: null,
      isContentEmpty: true,
      contentText: '',
    }
    const out = interpret({ key: 'Enter', shiftKey: false, metaKey: true }, ctx)
    expect(out).toEqual({ kind: 'send-prompt', nodeId: 'root', prompt: '' })
  })

  it('Cmd+Shift+T (the v1 start-thread chord) is now a no-op (binding removed)', () => {
    const out = interpret(
      { key: 't', shiftKey: true, metaKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'noop' })
  })

  it('Cmd+Shift+. cancels the streaming prompt when one is provided', () => {
    const out = interpret(
      { key: '.', shiftKey: true, metaKey: true },
      { ...base, isContentEmpty: false, streamingPromptId: 'prompt-1' },
    )
    expect(out).toEqual({ kind: 'cancel-prompt', promptNodeId: 'prompt-1' })
  })

  it('Cmd+Shift+. with no streaming prompt is a no-op', () => {
    const out = interpret(
      { key: '.', shiftKey: true, metaKey: true },
      { ...base, isContentEmpty: false, streamingPromptId: null },
    )
    expect(out).toEqual({ kind: 'noop' })
  })

  it('Cmd+. (no shift) still zooms in even when a prompt is streaming', () => {
    const out = interpret(
      { key: '.', shiftKey: false, metaKey: true },
      { ...base, isContentEmpty: false, streamingPromptId: 'prompt-1' },
    )
    expect(out).toEqual({ kind: 'zoom-in', nodeId: 'cur' })
  })

  // ---- v1.1: Cmd+Shift+B is the single branch verb ----

  it('Cmd+Shift+B on a Content Node fires branch-prompt with the source id', () => {
    const out = interpret(
      { key: 'b', shiftKey: true, metaKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'branch-prompt', sourceNodeId: 'cur' })
  })

  it('Cmd+Shift+B accepts upper-case B (WebKit reports the shifted form)', () => {
    const out = interpret(
      { key: 'B', shiftKey: true, metaKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'branch-prompt', sourceNodeId: 'cur' })
  })

  it('Ctrl+Shift+B (Linux/Windows) also fires branch-prompt', () => {
    const out = interpret(
      { key: 'b', shiftKey: true, ctrlKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'branch-prompt', sourceNodeId: 'cur' })
  })

  it('plain Cmd+B (no Shift) is a no-op (we reserve Shift+B for the branch verb)', () => {
    const out = interpret(
      { key: 'b', shiftKey: false, metaKey: true },
      { ...base, isContentEmpty: false },
    )
    expect(out).toEqual({ kind: 'noop' })
  })

  it('Cmd+Shift+B on a Block Node is a no-op (block-level branching is removed)', () => {
    const blockNode: Node = {
      id: 'blk',
      parentId: 'p1',
      position: 'a0',
      kind: 'block',
      content: '',
      metadata: {},
      completed: false,
      createdAt: 0,
      updatedAt: 0,
    }
    const ctx = {
      node: blockNode,
      parent: n('p1'),
      prevSibling: null,
      prevSiblingLastChildId: null,
      isContentEmpty: false,
    }
    const out = interpret({ key: 'b', shiftKey: true, metaKey: true }, ctx)
    expect(out).toEqual({ kind: 'noop' })
  })
})
