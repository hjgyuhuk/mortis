import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Agent, RunInterruptedError } from '../src/agent/loop.js'
import {
  COMPACTED_CONTEXT_END,
  COMPACTED_CONTEXT_START,
  buildCompactionTask,
  compactableHistory,
  compactedContextMessage,
  compactionTask,
  estimateContextTokens,
  estimateTextTokens,
  resolveInputTokenLimit,
  rootSystemMessages,
  shouldCompactContext,
  splitCompactionHistory,
  type ContextRuntime,
} from '../src/context.js'
import { collectDangling, initialState, reduce } from '../src/agent/state.js'
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
  options: { keep?: number; tokenLimit?: number } = {},
): ContextRuntime {
  return {
    policy: { maxInputTokens, keepRecentMessages: options.keep },
    compactor: { compact },
    compactorTokenLimit: options.tokenLimit,
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

/** Provider that reports a measured prompt-token count before each answer. */
function usageProvider(responses: Array<{ content: string; usage?: number }>): ChatProvider {
  return {
    async *completeStream(): AsyncGenerator<StreamChunk> {
      const response = responses.shift()
      if (!response) throw new Error('script exhausted')
      if (response.usage) yield { kind: 'usage', promptTokens: response.usage }
      yield { kind: 'text', delta: response.content }
    },
  }
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
    const tools: Tool[] = []
    const expected = Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') / 2)
    expect(estimateContextTokens(messages, tools)).toBe(expected)
    expect(shouldCompactContext(messages, tools, { maxInputTokens: Math.ceil(expected / 0.8) })).toBe(true)
    expect(shouldCompactContext(messages, tools, { maxInputTokens: expected + 1 })).toBe(true)
    expect(shouldCompactContext(messages, tools, {})).toBe(false)
  })
})

describe('runtime-owned context compaction', () => {
  it('compacts directly on a manual request without any model round-trip', async () => {
    const calls: Message[][] = []
    const compact = vi.fn(async () => 'manual summary')
    const agent = new Agent({
      provider: textProvider('unused', calls),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact, undefined, { keep: 0 }),
    })

    await agent.run('earlier request')
    calls.length = 0
    await expect(agent.requestContextCompaction()).resolves.toBe(true)

    expect(compact).toHaveBeenCalledTimes(1)
    expect(compact).toHaveBeenCalledWith(expect.stringContaining('earlier request'), expect.any(AbortSignal))
    expect(calls).toHaveLength(0)
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      compactedContextMessage('manual summary'),
    ])
    expect(agent.snapshot.status).toBe('done')
  })

  it('compacts at the threshold before the model request, then resumes the task', async () => {
    const captures = { messages: [] as Message[][], tools: [] as Array<Array<{ name: string }>> }
    const compact = vi.fn(async () => '## Conclusion\nGoal: continue safely.')
    const agent = new Agent({
      provider: scriptedProvider([{ kind: 'text', content: 'done' }], captures),
      tools: [],
      systemPrompt: 'root system',
      context: contextRuntime(compact, 1, { keep: 0 }),
    })

    await expect(agent.run('original user request')).resolves.toBe('done')

    expect(compact).toHaveBeenCalledTimes(1)
    // The first model request already sees the compacted history, and no
    // compact_context tool ever exists for the model.
    expect(captures.messages[0]).toEqual([
      { role: 'system', content: 'root system' },
      compactedContextMessage('## Conclusion\nGoal: continue safely.'),
    ])
    expect(captures.tools[0]).toEqual([])
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
    expect((error as Error).message).toContain('before runtime compaction could run')
    expect(compact).not.toHaveBeenCalled()
  })

  it('discards the lease when the compact persona fails', async () => {
    const compact = vi.fn(async (): Promise<string> => {
      throw new Error('compact model unavailable')
    })
    const agent = new Agent({
      provider: textProvider('prior answer'),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact, undefined, { keep: 0 }),
    })

    await agent.run('original')
    await expect(agent.requestContextCompaction()).rejects.toThrow('compact model unavailable')
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'prior answer' },
    ])

    compact.mockResolvedValueOnce('recovered summary')
    await expect(agent.requestContextCompaction()).resolves.toBe(true)
    expect(agent.snapshot.messages).toEqual([
      { role: 'system', content: 'root' },
      compactedContextMessage('recovered summary'),
    ])
  })

  it('discards the lease when the compact persona returns an empty summary', async () => {
    const compact = vi.fn()
      .mockResolvedValueOnce('   ')
      .mockResolvedValueOnce('recovered summary')
    const agent = new Agent({
      provider: textProvider('prior answer'),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact, undefined, { keep: 0 }),
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
    let compactStarted!: () => void
    const started = new Promise<void>((resolve) => { compactStarted = resolve })
    const compact = vi.fn((_task: string, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      compactStarted()
      signal?.addEventListener('abort', () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const agent = new Agent({
      provider: textProvider('prior answer'),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(compact, undefined, { keep: 0 }),
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

  it('prefers measured prompt tokens over the byte estimate', () => {
    const policy = { maxInputTokens: 100 }
    const tiny: Message[] = [{ role: 'user', content: 'hi' }]
    expect(shouldCompactContext(tiny, [], policy)).toBe(false)
    expect(shouldCompactContext(tiny, [], policy, 90)).toBe(true)
    expect(shouldCompactContext(tiny, [], policy, 10)).toBe(false)
  })

  it('keeps a verbatim tail and commits it after the summary', () => {
    const kept: Message[] = [
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ]
    let state = reduce(initialState('root'), { type: 'user_message', content: 'old' })
    state = reduce(state, { type: 'assistant_message', content: 'old answer' })
    state = reduce(state, { type: 'user_message', content: 'recent question' })
    state = reduce(state, { type: 'assistant_message', content: 'recent answer' })
    state = reduce(state, { type: 'context_compacted', summary: 'summary', kept })

    expect(state.messages).toEqual([
      { role: 'system', content: 'root' },
      compactedContextMessage('summary'),
      ...kept,
    ])
  })

  it('does not re-compact from stale measured tokens after a manual compaction', async () => {
    const responses = [
      { usage: 900, content: 'first answer' },
      { content: 'second answer' },
    ]
    const compact = vi.fn(async () => 'summary')
    const agent = new Agent({
      provider: usageProvider(responses),
      tools: [],
      systemPrompt: 'root',
      // Threshold 800: the first run finishes with a measured 900 but never
      // crosses the check again; the manual compaction must clear it.
      context: contextRuntime(compact, 1000, { keep: 0 }),
    })

    await agent.run('first')
    await expect(agent.requestContextCompaction()).resolves.toBe(true)
    const afterManual = compact.mock.calls.length

    await agent.run('second')
    expect(compact.mock.calls.length).toBe(afterManual)
  })

  it('hands the pre-compact messages to the archive observer', async () => {
    const archived: Message[][] = []
    const agent = new Agent({
      provider: textProvider('answer'),
      tools: [],
      systemPrompt: 'root',
      context: contextRuntime(vi.fn(async () => 'summary'), undefined, { keep: 0 }),
      onBeforeCompact: (messages) => archived.push([...messages]),
    })

    await agent.run('original')
    await expect(agent.requestContextCompaction()).resolves.toBe(true)

    expect(archived).toEqual([[
      { role: 'system', content: 'root' },
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'answer' },
    ]])
  })
})

describe('splitCompactionHistory', () => {
  const history: Message[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: null, tool_calls: [{ ...call, id: 'call_2' }] },
    { role: 'tool', tool_call_id: 'call_2', content: 'result2' },
  ]

  it('only cuts where the kept tail is self-contained', () => {
    // The ideal cut keeps 1 message but lands between call_2 and its
    // result; the split walks back to the last safe boundary.
    const { prefix, kept } = splitCompactionHistory(history, 1)
    expect(prefix).toEqual(history.slice(0, 5))
    expect(kept).toEqual(history.slice(5))
    expect(collectDangling(kept).size).toBe(0)
  })

  it('keeps everything when the history is shorter than the tail budget', () => {
    const { prefix, kept } = splitCompactionHistory(history, 100)
    expect(prefix).toEqual([])
    expect(kept).toEqual(history)
  })
})

describe('buildCompactionTask', () => {
  it('truncates the transcript to the persona token budget, oldest first', () => {
    const prefix: Message[] = [
      { role: 'user', content: 'x'.repeat(2000) },
      { role: 'user', content: 'tail marker' },
    ]
    const limit = estimateTextTokens(compactionTask([prefix[1]!]))
    const { task, dropped } = buildCompactionTask(prefix, limit)

    expect(dropped).toBe(1)
    expect(task).toContain('tail marker')
    expect(task).not.toContain('xxx')
  })

  it('throws when even a single message cannot fit the budget', () => {
    const prefix: Message[] = [{ role: 'user', content: 'x'.repeat(2000) }]
    expect(() => buildCompactionTask(prefix, 1)).toThrow('exceeds the compact persona context limit')
  })
})
