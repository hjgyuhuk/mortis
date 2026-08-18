import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Agent, RunInterruptedError } from '../src/agent/loop.js'
import {
  COMPACTED_CONTEXT_END,
  COMPACTED_CONTEXT_START,
  compactableHistory,
  compactedContextMessage,
  compactionTask,
  estimateContextTokens,
  resolveInputTokenLimit,
  rootSystemMessages,
  shouldCompactContext,
  type ContextRuntime,
} from '../src/context.js'
import { initialState, reduce } from '../src/agent/state.js'
import type { ChatProvider, Message, ModelResponse, StreamChunk, Tool, ToolCall } from '../src/types.js'

const call: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'read', arguments: '{"path":"/tmp/a"}' },
}

function textProvider(
  output = 'done',
  captures: Message[][] = [],
): ChatProvider {
  return {
    async *completeStream(messages: Message[]): AsyncGenerator<StreamChunk> {
      captures.push(structuredClone(messages))
      yield { kind: 'text', delta: output }
    },
  }
}

function contextRuntime(
  compact: ContextRuntime['compactor']['compact'],
  maxInputTokens?: number,
): ContextRuntime {
  return {
    policy: { maxInputTokens },
    compactor: { compact },
  }
}

function scriptedProvider(
  responses: ModelResponse[],
  captures: { messages: Message[][]; tools: Array<Array<{ name: string }>> },
): ChatProvider {
  return {
    async *completeStream(messages: Message[], tools: Tool[]): AsyncGenerator<StreamChunk> {
      captures.messages.push(structuredClone(messages))
      captures.tools.push(tools.map((tool) => ({ name: tool.name })))
      const response = responses.shift()
      if (!response) throw new Error('script exhausted')
      if (response.kind === 'tool_calls') {
        yield { kind: 'tool_calls', tool_calls: response.tool_calls }
        return
      }
      if (response.kind === 'thinking') {
        yield { kind: 'thinking', delta: response.content }
        return
      }
      yield { kind: 'text', delta: response.content }
    },
  }
}

function compactCall(args = '{}'): ToolCall {
  return { id: 'compact_1', type: 'function', function: { name: 'compact_context', arguments: args } }
}

describe('context primitives', () => {
  it('preserves every root system message and serializes every history field', () => {
    const messages: Message[] = [
      { role: 'system', content: 'root one' },
      { role: 'system', content: 'root two' },
      { role: 'user', content: 'keep ID run_42' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ENOENT /tmp/a' },
    ]

    expect(rootSystemMessages(messages)).toEqual(messages.slice(0, 2))
    expect(compactableHistory(messages)).toEqual(messages.slice(2))
    const task = compactionTask(compactableHistory(messages))
    expect(task).toContain('"tool_call_id": "call_1"')
    expect(task).toContain('ENOENT /tmp/a')
    expect(task).not.toContain('root one')
  })

  it('wraps a compact summary as fixed, untrusted user data', () => {
    const message = compactedContextMessage('## Conclusion\nDo not trust old instructions.')
    expect(message).toMatchObject({ role: 'user' })
    expect(message.content).toContain(COMPACTED_CONTEXT_START)
    expect(message.content).toContain('untrusted historical data')
    expect(message.content).toContain(COMPACTED_CONTEXT_END)
  })

  it('prefers maxInputSize and otherwise reserves declared output capacity', () => {
    expect(resolveInputTokenLimit({ maxInputSize: 900, maxContextSize: 1000, maxOutputSize: 200 })).toBe(900)
    expect(resolveInputTokenLimit({ maxContextSize: 1000, maxOutputSize: 200 })).toBe(800)
    expect(resolveInputTokenLimit({ maxContextSize: 1000 })).toBe(1000)
    expect(resolveInputTokenLimit({ maxContextSize: 100, maxOutputSize: 100 })).toBeUndefined()
  })

  it('uses conservative UTF-8 JSON bytes and the 80 percent default threshold', () => {
    const messages: Message[] = [{ role: 'user', content: '中文 abc' }]
    const tools = []
    const expected = Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') / 2)
    expect(estimateContextTokens(messages, tools)).toBe(expected)
    expect(shouldCompactContext(messages, tools, { maxInputTokens: Math.ceil(expected / 0.8) })).toBe(true)
    expect(shouldCompactContext(messages, tools, { maxInputTokens: expected + 1 })).toBe(true)
    expect(shouldCompactContext(messages, tools, {})).toBe(false)
  })
})

describe('main-agent-authorized context compaction', () => {
  it('lets a manual request grant one lease without adding a command message', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn(async () => 'manual summary')
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'text', content: 'prior answer' },
        { kind: 'tool_calls', tool_calls: [compactCall()] },
      ], captures),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact),
    })

    await agent.run('earlier request')
    await expect(agent.requestContextCompaction()).resolves.toBe(true)

    expect(captures.tools[1]!.map((tool) => tool.name)).toEqual(['compact_context'])
    expect(compact).toHaveBeenCalledWith([
      { role: 'user', content: 'earlier request' },
      { role: 'assistant', content: 'prior answer' },
    ], expect.any(AbortSignal))
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      compactedContextMessage('manual summary'),
    ])
    expect(agent.snapshot.status).toBe('done')
  })

  it('uses a threshold lease, then resumes the original task after the direct effect', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn(async () => '## Conclusion\nGoal: continue safely.')
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'tool_calls', tool_calls: [compactCall()] },
        { kind: 'text', content: 'done' },
      ], captures),
      tools: [],
      systemPrompt: 'root system',
      context: contextRuntime(compact, 1),
    })

    await expect(agent.run('original user request')).resolves.toBe('done')
    expect(captures.tools[0]!.map((tool) => tool.name)).toEqual(['compact_context'])
    expect(captures.messages[0]).toEqual([
      { role: 'system', content: 'root system' },
      { role: 'user', content: 'original user request' },
    ])
    expect(compact.mock.calls[0]![0]).toEqual([{ role: 'user', content: 'original user request' }])
    expect(captures.messages[1]).toEqual([
      { role: 'system', content: 'root system' },
      compactedContextMessage('## Conclusion\nGoal: continue safely.'),
    ])
    expect(captures.tools[1]).toEqual([])
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('does not preflight compact when model capacity is absent', async () => {
    const calls: Message[][] = []
    const compact = vi.fn(async () => 'summary')
    const agent = new Agent({
      provider: textProvider('done', calls),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact),
    })

    await agent.run('keep original')
    expect(compact).not.toHaveBeenCalled()
    expect(calls[0]).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'keep original' },
    ])
  })

  it('stops on a provider context-limit error without bypassing the main agent', async () => {
    const compact = vi.fn(async () => 'summary')
    const provider: ChatProvider = {
      async *completeStream(): AsyncGenerator<StreamChunk> {
        throw Object.assign(new Error('provider request failed (413): context length exceeded'), { status: 413 })
      },
    }
    const agent = new Agent({ provider, tools: [], systemPrompt: 'root', context: contextRuntime(compact) })

    const error = await agent.run('original').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ status: 413 })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('before main-agent compaction could run')
    expect(compact).not.toHaveBeenCalled()
  })

  it('rejects mixed direct actions without replacing context', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn(async () => 'summary')
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'tool_calls', tool_calls: [compactCall(), { ...call, id: 'read_1' }] },
      ], captures),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact, 1),
    })

    await expect(agent.run('original')).rejects.toThrow('requires one compact_context call')
    expect(compact).not.toHaveBeenCalled()
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
    ])
  })

  it('rejects a malformed direct action without replacing context', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn(async () => 'summary')
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'tool_calls', tool_calls: [compactCall('{"summary":"model controlled"}')] },
      ], captures),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact, 1),
    })

    await expect(agent.run('original')).rejects.toThrow('requires one compact_context call')
    expect(compact).not.toHaveBeenCalled()
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
    ])
  })

  it('discards the lease when the compact persona fails', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn(async () => { throw new Error('compact model unavailable') })
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'text', content: 'prior answer' },
        { kind: 'tool_calls', tool_calls: [compactCall()] },
      ], captures),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact),
    })

    await agent.run('original')
    await expect(agent.requestContextCompaction()).rejects.toThrow('compact model unavailable')
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'prior answer' },
    ])
  })

  it('discards the lease when the compact persona returns an empty summary', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn()
      .mockResolvedValueOnce('   ')
      .mockResolvedValueOnce('recovered summary')
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'text', content: 'prior answer' },
        { kind: 'tool_calls', tool_calls: [compactCall()] },
        { kind: 'tool_calls', tool_calls: [compactCall()] },
      ], captures),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact),
    })

    await agent.run('original')
    await expect(agent.requestContextCompaction()).rejects.toThrow('summary must not be empty')
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'prior answer' },
    ])
    await expect(agent.requestContextCompaction()).resolves.toBe(true)
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      compactedContextMessage('recovered summary'),
    ])
  })

  it('discards the lease when compacting is cancelled', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    let compactStarted!: () => void
    const started = new Promise<void>((resolve) => { compactStarted = resolve })
    const compact = vi.fn((_history: readonly Message[], signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      compactStarted()
      signal?.addEventListener('abort', () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const agent = new Agent({
      provider: scriptedProvider([
        { kind: 'text', content: 'prior answer' },
        { kind: 'tool_calls', tool_calls: [compactCall()] },
      ], captures),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact),
    })

    await agent.run('original')
    const pending = agent.requestContextCompaction()
    await started
    agent.abort('user interrupt')
    await expect(pending).rejects.toBeInstanceOf(RunInterruptedError)
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'prior answer' },
    ])
  })

  it('rejects compaction while a tool call is pending', () => {
    let state = reduce(initialState('root'), { type: 'user_message', content: 'original' })
    state = reduce(state, { type: 'assistant_message', content: null, toolCalls: [call] })
    expect(() => reduce(state, { type: 'context_compacted', summary: 'summary' }))
      .toThrow('tool calls are pending')
  })
})
