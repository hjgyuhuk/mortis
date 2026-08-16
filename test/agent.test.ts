import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/agent/loop.js'
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
      resultSummary: '"done"',
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
})