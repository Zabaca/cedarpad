import { describe, it, expect } from 'vitest'
import type { Node, BlockMetadata } from '../contract'
import { groupBlocksForRender, type RenderItem } from './blockGrouping'

function makeNode(
  id: string,
  meta: BlockMetadata['payload'] | null,
  parentId: string | null = 'p1',
): Node {
  return {
    id,
    parentId,
    position: 'a0',
    kind: meta ? 'block' : 'content',
    content: '',
    metadata: meta ? { role: 'block', payload: meta } : {},
    completed: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function textBlock(id: string, text = 'hi'): Node {
  return makeNode(id, { kind: 'text', text })
}

function toolUseBlock(id: string, toolUseId: string, toolName = 'Read'): Node {
  return makeNode(id, { kind: 'tool_use', toolName, toolUseId, input: { path: 'x' } })
}

function toolResultBlock(id: string, toolUseId: string, output = 'ok'): Node {
  return makeNode(id, { kind: 'tool_result', toolUseId, output })
}

describe('groupBlocksForRender', () => {
  it('returns empty for empty input', () => {
    const out = groupBlocksForRender([])
    expect(out).toEqual([])
  })

  it('passes through a single text block as a single render item', () => {
    const t = textBlock('t1')
    const out = groupBlocksForRender([t])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: 'single', node: t } satisfies RenderItem)
  })

  it('pairs adjacent tool_use + tool_result with matching tool_use_id', () => {
    const tu = toolUseBlock('b1', 'tu_1')
    const tr = toolResultBlock('b2', 'tu_1')
    const out = groupBlocksForRender([tu, tr])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: 'pair', toolUse: tu, toolResult: tr } satisfies RenderItem)
  })

  it('does not pair tool_use + tool_result with non-matching id', () => {
    const tu = toolUseBlock('b1', 'tu_1')
    const tr = toolResultBlock('b2', 'tu_2')
    const out = groupBlocksForRender([tu, tr])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ kind: 'single', node: tu })
    expect(out[1]).toEqual({ kind: 'single', node: tr })
  })

  it('handles multiple pairs interleaved with text blocks in order', () => {
    const text1 = textBlock('t1', 'thinking…')
    const tu1 = toolUseBlock('b1', 'tu_a')
    const tr1 = toolResultBlock('b2', 'tu_a')
    const text2 = textBlock('t2', 'next')
    const tu2 = toolUseBlock('b3', 'tu_b')
    const tr2 = toolResultBlock('b4', 'tu_b')
    const out = groupBlocksForRender([text1, tu1, tr1, text2, tu2, tr2])
    expect(out).toEqual([
      { kind: 'single', node: text1 },
      { kind: 'pair', toolUse: tu1, toolResult: tr1 },
      { kind: 'single', node: text2 },
      { kind: 'pair', toolUse: tu2, toolResult: tr2 },
    ])
  })

  it('renders a lone tool_use (no following tool_result) as a single item', () => {
    const tu = toolUseBlock('b1', 'tu_1')
    const text = textBlock('t1')
    const out = groupBlocksForRender([tu, text])
    expect(out).toEqual([
      { kind: 'single', node: tu },
      { kind: 'single', node: text },
    ])
  })

  it('renders a lone trailing tool_use as a single item', () => {
    const tu = toolUseBlock('b1', 'tu_1')
    const out = groupBlocksForRender([tu])
    expect(out).toEqual([{ kind: 'single', node: tu }])
  })

  it('renders a tool_result with no preceding tool_use as a single item (defensive)', () => {
    const tr = toolResultBlock('b1', 'tu_1')
    const out = groupBlocksForRender([tr])
    expect(out).toEqual([{ kind: 'single', node: tr }])
  })
})
