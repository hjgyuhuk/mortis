import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/agent/loop.js'
import { initialState, isSendable, reduce } from '../src/agent/state.js'
import type { ChatProvider, Message, ModelResponse, StreamChunk, Tool, ToolCall } from '../src/types.js'

/** Deterministic provider driven by a script of responses. */
class ScriptedProvider implements ChatProvider {
  calls: Message[][] = []

  constructor(private responses: ModelResponse[]) {}

  async *completeStream(messages: Message[], _tools: Tool[]): AsyncGenerator<StreamChunk> {
    this.calls.push(structuredClone(messages))
    const next = this.responses.shift()
    if (!next) throw new Error('script exhausted')
    if (next.kind === 'text') {
      for (const part of splitIntoDeltas(next.content)) {
        yield { kind: 'text', delta: part }
      }
      return
    }
    if (next.kind === 'thinking') {
      for (const part of splitIntoDeltas(next.content)) {
        yield { kind: 'thinking', delta: part }
      }
      return
    }
    yield { kind: 'tool_calls', tool_calls: next.tool_calls }
  }
}

/** Split text into word-ish deltas to exercise the streaming path. */
function splitIntoDeltas(text: string): string[] {
  return text.length <= 20 ? [text] : text.match(/[\s\S]{1,20}/g) ?? [text]
}

const makeCall = (id: string, name: string, args: string): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
})

describe('Agent loop', () => {
  it('returns text after a single turn', async () => {
    const provider = new ScriptedProvider([{ kind: 'text', content: 'hello' }])
    const agent = new Agent({ provider, tools: [], systemPrompt: 'sys' })
    const result = await agent.run('hi')

    expect(result).toBe('hello')
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.[0]).toEqual({ role: 'system', content: 'sys' })
    expect(provider.calls[0]?.[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('executes tool calls and feeds results back before answering', async () => {
    const fakeBash: Tool = {
      name: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute(args) {
        return `result(${args.command as string})`
      },
    }
    const provider = new ScriptedProvider([
      { kind: 'tool_calls', tool_calls: [makeCall('call_1', 'bash', '{"command":"pwd"}')] },
      { kind: 'text', content: 'done' },
    ])
    const agent = new Agent({ provider, tools: [fakeBash], systemPrompt: 'sys' })

    const result = await agent.run('list files')

    expect(result).toBe('done')
    expect(provider.calls).toHaveLength(2)
    const secondCall = provider.calls[1]!
    expect(secondCall[2]).toEqual({ role: 'assistant', content: null, tool_calls: [makeCall('call_1', 'bash', '{"command":"pwd"}')] })
    expect(secondCall[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result(pwd)' })
  })

  it('reports unknown tools instead of crashing', async () => {
    const provider = new ScriptedProvider([
      { kind: 'tool_calls', tool_calls: [makeCall('call_1', 'nope', '{}')] },
      { kind: 'text', content: 'ok' },
    ])
    const agent = new Agent({ provider, tools: [], systemPrompt: 'sys' })

    await agent.run('x')

    const toolMsg = provider.calls[1]![3]
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'error: unknown tool "nope"' })
  })

  it('throws when the turn budget runs out', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 20 }, () => ({
        kind: 'tool_calls' as const,
        tool_calls: [makeCall('call_1', 'bash', '{}')],
      })),
    )
    const fakeBash: Tool = {
      name: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'ok'
      },
    }
    const agent = new Agent({ provider, tools: [fakeBash], systemPrompt: 'sys' })

    await expect(agent.run('x')).rejects.toThrow('exceeded 20 turns')
  })

  it('catches malformed tool arguments', async () => {
    const fakeBash: Tool = {
      name: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'ok'
      },
    }
    const provider = new ScriptedProvider([
      { kind: 'tool_calls', tool_calls: [makeCall('call_1', 'bash', '{not json')] },
      { kind: 'text', content: 'ok' },
    ])
    const agent = new Agent({ provider, tools: [fakeBash], systemPrompt: 'sys' })

    await agent.run('x')

    const toolMsg = provider.calls[1]![3]
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(toolMsg!.content).toContain('tool bash failed')
  })

  it('emits loop events to the onEvent observer', async () => {
    const fakeBash: Tool = {
      name: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'done'
      },
    }
    const provider = new ScriptedProvider([
      { kind: 'tool_calls', tool_calls: [makeCall('call_1', 'bash', '{"command":"pwd"}')] },
      { kind: 'text', content: 'final' },
    ])
    const onEvent = vi.fn()
    const agent = new Agent({ provider, tools: [fakeBash], systemPrompt: 'sys', onEvent })

    await agent.run('go')

    expect(onEvent).toHaveBeenNthCalledWith(1, { kind: 'model_request' })
    expect(onEvent).toHaveBeenNthCalledWith(2, {
      kind: 'tool_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      argsSummary: '{"command":"pwd"}',
    })
    expect(onEvent).toHaveBeenNthCalledWith(3, {
      kind: 'tool_result',
      toolCallId: 'call_1',
      content: 'done',
      isError: false,
    })
    expect(onEvent).toHaveBeenNthCalledWith(4, { kind: 'model_request' })
    expect(onEvent).toHaveBeenNthCalledWith(5, { kind: 'assistant_text', content: 'final' })
    expect(onEvent).toHaveBeenCalledTimes(5)
  })

  it('streams assistant text as deltas', async () => {
    const provider = new ScriptedProvider([{ kind: 'text', content: 'Hello, streaming world!' }])
    const onEvent = vi.fn()
    const agent = new Agent({ provider, tools: [], systemPrompt: 'sys', onEvent })

    const result = await agent.run('go')

    expect(result).toBe('Hello, streaming world!')
    expect(onEvent).toHaveBeenNthCalledWith(1, { kind: 'model_request' })
    const deltas = onEvent.mock.calls.filter(([e]) => e.kind === 'assistant_text')
    expect(deltas.length).toBeGreaterThan(1)
    const last = deltas[deltas.length - 1]
    expect(last?.[0]).toEqual({ kind: 'assistant_text', content: 'Hello, streaming world!' })
  })

  it('emits cumulative thinking events without persisting reasoning', async () => {
    const provider: ChatProvider = {
      async *completeStream() {
        yield { kind: 'thinking', delta: 'think ' }
        yield { kind: 'thinking', delta: 'hard' }
        yield { kind: 'text', delta: 'answer' }
      },
    }
    const onEvent = vi.fn()
    const agent = new Agent({ provider, tools: [], systemPrompt: 'sys', onEvent })

    const result = await agent.run('q')

    expect(result).toBe('answer')
    const thinkingEvents = onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 'assistant_thinking')
    expect(thinkingEvents.map((event) => (event.kind === 'assistant_thinking' ? event.content : ''))).toEqual([
      'think ',
      'think hard',
    ])
    // Reasoning is display-only: it never enters the state.
    expect(JSON.stringify(agent.snapshot.messages)).not.toContain('think')
    expect(agent.snapshot.messages.at(-1)).toEqual({ role: 'assistant', content: 'answer' })
  })

  it('aborts an in-flight model request and stays resumable', async () => {
    let calls = 0
    const provider: ChatProvider = {
      async *completeStream(_messages: Message[], _tools: Tool[], signal?: AbortSignal) {
        calls++
        if (calls === 1) {
          yield { kind: 'text', delta: 'par' }
          await new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => {
              const error = new Error('The operation was aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
        }
        yield { kind: 'text', delta: 'recovered' }
      },
    }
    const agent = new Agent({ provider, tools: [], systemPrompt: 'sys' })

    const first = agent.run('x')
    await new Promise((resolve) => setTimeout(resolve, 0))
    agent.abort('user interrupt')
    await expect(first).rejects.toThrow('run interrupted: user interrupt')

    expect(agent.snapshot.status).toBe('idle')
    expect(isSendable(agent.snapshot)).toBe(true)

    const answer = await agent.run('again')
    expect(answer).toBe('recovered')
    expect(calls).toBe(2)
  })

  it('aborts a running tool and commits synthetic results for dangling calls', async () => {
    const hangingTool: Tool = {
      name: 'hang',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute(_args, context) {
        return await new Promise<string>((_resolve, reject) => {
          context?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      },
    }
    const provider = new ScriptedProvider([
      { kind: 'tool_calls', tool_calls: [makeCall('c1', 'hang', '{}')] },
      { kind: 'text', content: 'never reached' },
    ])
    const agent = new Agent({ provider, tools: [hangingTool], systemPrompt: 'sys' })

    const run = agent.run('x')
    await new Promise((resolve) => setTimeout(resolve, 0))
    agent.abort('user interrupt')
    await expect(run).rejects.toThrow('run interrupted: user interrupt')

    expect(agent.snapshot.status).toBe('idle')
    expect(isSendable(agent.snapshot)).toBe(true)
    expect(agent.snapshot.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '(interrupted: user interrupt)',
    })
  })

  it('executes parallel tool calls concurrently but commits in declaration order', async () => {
    const delayTool: Tool = {
      name: 'delay',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute(args) {
        await new Promise((resolve) => setTimeout(resolve, Number(args.ms)))
        return String(args.tag)
      },
    }
    const provider = new ScriptedProvider([
      {
        kind: 'tool_calls',
        tool_calls: [
          makeCall('c1', 'delay', '{"ms":60,"tag":"A"}'),
          makeCall('c2', 'delay', '{"ms":10,"tag":"B"}'),
          makeCall('c3', 'delay', '{"ms":30,"tag":"C"}'),
        ],
      },
      { kind: 'text', content: 'done' },
    ])
    const agent = new Agent({ provider, tools: [delayTool], systemPrompt: 'sys' })

    await agent.run('go')

    // B finishes first, but results are committed A → B → C.
    const tools = provider.calls[1]!.filter((m) => m.role === 'tool')
    expect(tools.map((m) => m.content)).toEqual(['A', 'B', 'C'])
  })

  it('sends an append-only history: each request extends the previous one', async () => {
    const fakeTool: Tool = {
      name: 'bash',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'ok'
      },
    }
    const provider = new ScriptedProvider([
      { kind: 'tool_calls', tool_calls: [makeCall('c1', 'bash', '{"command":"ls"}')] },
      { kind: 'text', content: 'first done' },
      { kind: 'text', content: 'second done' },
    ])
    const agent = new Agent({ provider, tools: [fakeTool], systemPrompt: 'sys' })

    await agent.run('one')
    await agent.run('two')

    // Every provider request must start with the exact previous request's
    // messages — the prefix provider caching matches on.
    for (let i = 1; i < provider.calls.length; i++) {
      const previous = provider.calls[i - 1]!
      const current = provider.calls[i]!
      expect(current.length).toBeGreaterThanOrEqual(previous.length)
      expect(current.slice(0, previous.length)).toEqual(previous)
    }
    expect(provider.calls).toHaveLength(3)
  })

  it('continues from a restored state', async () => {
    let prior = initialState('sys')
    prior = reduce(prior, { type: 'user_message', content: 'earlier' })
    prior = reduce(prior, { type: 'assistant_message', content: 'prior answer' })

    const provider = new ScriptedProvider([{ kind: 'text', content: 'next' }])
    const agent = new Agent({ provider, tools: [], systemPrompt: 'ignored', state: prior })

    const answer = await agent.run('continue')
    expect(answer).toBe('next')
    expect(provider.calls[0]?.[1]).toEqual({ role: 'user', content: 'earlier' })
    expect(provider.calls[0]?.[2]).toEqual({ role: 'assistant', content: 'prior answer' })
    expect(provider.calls[0]?.[3]).toEqual({ role: 'user', content: 'continue' })
  })
})