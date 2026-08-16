import { describe, expect, it } from 'vitest'
import { initialState, isSendable, reduce, type AgentStatus, type StateEvent } from '../src/agent/state.js'
import type { ToolCall } from '../src/types.js'

const makeCall = (id: string, name = 'bash'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
})

const STATUSES: AgentStatus[] = ['idle', 'running', 'awaiting_user', 'done']

describe('reduce', () => {
  it('starts idle with the system prompt', () => {
    const state = initialState('sys')
    expect(state.messages).toEqual([{ role: 'system', content: 'sys' }])
    expect(state.status).toBe('idle')
    expect(isSendable(state)).toBe(true)
  })

  it('user_message starts a run', () => {
    const state = reduce(initialState('sys'), { type: 'user_message', content: 'hi' })
    expect(state.messages.at(-1)).toEqual({ role: 'user', content: 'hi' })
    expect(state.status).toBe('running')
  })

  it('plain assistant message finishes the run', () => {
    const state = reduce(initialState('sys'), { type: 'assistant_message', content: 'answer' })
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'answer' })
    expect(state.status).toBe('done')
    expect(isSendable(state)).toBe(true)
  })

  it('assistant message with tool calls keeps the run going', () => {
    const state = reduce(initialState('sys'), {
      type: 'assistant_message',
      content: null,
      toolCalls: [makeCall('c1')],
    })
    expect(state.status).toBe('running')
    // Running states are exempt; a dangling call alone does not violate it.
    expect(isSendable(state)).toBe(false)
  })

  it('tool_result and tool_error commit as tool messages', () => {
    let state = reduce(initialState('sys'), {
      type: 'assistant_message',
      content: null,
      toolCalls: [makeCall('c1'), makeCall('c2')],
    })
    state = reduce(state, { type: 'tool_result', toolCallId: 'c1', content: 'ok' })
    state = reduce(state, { type: 'tool_error', toolCallId: 'c2', content: 'error: boom' })
    expect(state.messages.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: 'error: boom' },
    ])
  })

  it('run_interrupted fills dangling calls with synthetic results and goes idle', () => {
    let state = reduce(initialState('sys'), { type: 'user_message', content: 'x' })
    state = reduce(state, {
      type: 'assistant_message',
      content: null,
      toolCalls: [makeCall('c1'), makeCall('c2')],
    })
    state = reduce(state, { type: 'tool_result', toolCallId: 'c1', content: 'ok' })
    state = reduce(state, { type: 'run_interrupted', reason: 'user interrupt' })

    expect(state.status).toBe('idle')
    expect(isSendable(state)).toBe(true)
    expect(state.messages.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: '(interrupted: user interrupt)' },
    ])
  })

  it('awaiting_user records the reason and stays sendable', () => {
    let state = reduce(initialState('sys'), {
      type: 'assistant_message',
      content: null,
      toolCalls: [makeCall('c1')],
    })
    state = reduce(state, { type: 'awaiting_user', reason: 'which file?' })
    expect(state.status).toBe('awaiting_user')
    expect(isSendable(state)).toBe(true)
    expect(state.messages.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '(pending user: which file?)' },
    ])
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'which file?' })
  })

  it('never mutates the input state', () => {
    const before = initialState('sys')
    const after = reduce(before, { type: 'user_message', content: 'hi' })
    expect(before.messages).toHaveLength(1)
    expect(before.status).toBe('idle')
    expect(after.messages).toHaveLength(2)
  })
})

describe('state invariants (property-style)', () => {
  /** Deterministic PRNG so failures reproduce. */
  function mulberry32(seed: number): () => number {
    return () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomEvent(random: () => number, ids: string[]): StateEvent {
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)]!
    switch (Math.floor(random() * 6)) {
      case 0:
        return { type: 'user_message', content: 'hi' }
      case 1:
        return { type: 'assistant_message', content: 'text' }
      case 2:
        return { type: 'assistant_message', content: null, toolCalls: [makeCall(pick(ids))] }
      case 3:
        return { type: 'tool_result', toolCallId: pick(ids), content: 'ok' }
      case 4:
        return { type: 'run_interrupted', reason: 'random' }
      default:
        return { type: 'awaiting_user', reason: 'why' }
    }
  }

  it('random event sequences keep status valid, states sendable outside running, and data serializable', () => {
    const random = mulberry32(42)
    const ids = ['c1', 'c2', 'c3']
    let state = initialState('sys')
    for (let step = 0; step < 200; step++) {
      state = reduce(state, randomEvent(random, ids))
      expect(STATUSES).toContain(state.status)
      if (state.status !== 'running') {
        expect(isSendable(state)).toBe(true)
      }
      expect(structuredClone(state)).toEqual(state)
    }
  })
})
