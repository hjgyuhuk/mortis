/**
 * OpenAI-compatible chat provider.
 *
 * Talks to any endpoint that implements the OpenAI chat completions API
 * (`POST /chat/completions`), including OpenAI, local servers (Ollama,
 * vLLM), and gateways. The base URL and model are configurable.
 *
 * Requests always ask for a stream. Responses arrive as Server-Sent Events
 * (`text/event-stream`); text deltas are forwarded as-is and tool-call index
 * fragments are stitched together before the final tool_calls chunk.
 */

import type { ChatProvider, Message, StreamChunk, Tool, ToolCall } from '../types.js'

export interface OpenAIProviderOptions {
  /** Base URL of the OpenAI-compatible endpoint, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /** The model name to request. */
  model: string
  /** API key; optional for local servers that do not require one. */
  apiKey?: string
  /** Reasoning effort sent as `thinking_effort` when set (e.g. 'low' | 'medium' | 'high'). */
  thinkingEffort?: string
}

interface WireMessage {
  role: string
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireChunkToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface WireStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      /** DeepSeek-R1 style reasoning stream, adopted by many gateways. */
      reasoning_content?: string | null
      /** OpenRouter style alias for the same. */
      reasoning?: string | null
      tool_calls?: WireChunkToolCall[]
    }
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: WireToolCall[]
    }
  }>
}

const DONE_MARKER = '[DONE]'

/** Translate our internal message to the wire shape. */
function toWireMessage(message: Message): WireMessage {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content }
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls?.map(toWireToolCall),
      }
    case 'tool':
      return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content }
    default:
      return assertNever(message)
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected message role: ${JSON.stringify(value)}`)
}

function toWireToolCall(call: ToolCall): WireToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments },
  }
}

function toWireTool(tool: Tool): WireTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

/** Accumulate incremental tool-call index fragments into complete calls. */
interface PartialToolCall {
  id?: string
  name?: string
  arguments: string
}

class ToolCallBuilder {
  private readonly byIndex = new Map<number, PartialToolCall>()

  add(call: WireChunkToolCall): void {
    const index = call.index ?? 0
    let entry = this.byIndex.get(index)
    if (!entry) {
      entry = { arguments: '' }
      this.byIndex.set(index, entry)
    }
    if (call.id != null) entry.id = call.id
    if (call.function?.name != null) entry.name = call.function.name
    if (call.function?.arguments != null) {
      entry.arguments += call.function.arguments
    }
  }

  build(): WireToolCall[] {
    const stacks = [...this.byIndex.entries()].sort((a, b) => a[0] - b[0])
    const calls: WireToolCall[] = []
    for (const [, call] of stacks) {
      if (!call.id || !call.name) continue
      calls.push({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })
    }
    return calls
  }
}

/**
 * Parse an SSE byte stream into its `data:` payloads. Emits the raw payload
 * characters, stopping at the OpenAI `[DONE]` marker; throws on a non-SSE
 * content type so callers can fall back to plain JSON.
 */
async function* ssePayloads(response: Response): AsyncGenerator<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    throw new Error('not an SSE response')
  }
  const body = response.body
  if (!body) {
    throw new Error('response has no body')
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE lines are separated by \n; events end with a blank line. Fix the
      // last partial line in the buffer before splitting.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '')
        if (trimmed === '') continue
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trimStart()
          if (payload === DONE_MARKER) return
          if (payload) yield payload
        }
      }
    }
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, '')
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trimStart()
        if (payload !== DONE_MARKER && payload) yield payload
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export class OpenAIProvider implements ChatProvider {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey?: string
  private readonly thinkingEffort?: string

  constructor(options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.model
    this.apiKey = options.apiKey
    this.thinkingEffort = options.thinkingEffort
  }

  async *completeStream(messages: Message[], tools: Tool[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWireMessage),
      stream: true,
    }
    // OpenAI rejects an empty `tools` array, so only send it when non-empty.
    if (tools.length > 0) body['tools'] = tools.map(toWireTool)
    if (this.thinkingEffort) body['thinking_effort'] = this.thinkingEffort

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`provider request failed (${response.status}): ${text}`)
    }

    const builder = new ToolCallBuilder()
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.toLowerCase().includes('text/event-stream')) {
      let yieldedText = false
      for await (const payload of ssePayloads(response)) {
        signal?.throwIfAborted()
        let chunk: WireStreamChunk
        try {
          chunk = JSON.parse(payload) as WireStreamChunk
        } catch {
          throw new Error(`provider sent invalid SSE JSON: ${payload.slice(0, 200)}`)
        }
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (reasoning) {
          yield { kind: 'thinking', delta: reasoning }
        }
        if (delta.content) {
          yieldedText = true
          yield { kind: 'text', delta: delta.content }
        }
        if (delta.tool_calls?.length) {
          for (const call of delta.tool_calls) builder.add(call)
        }
      }
      const toolCalls = builder.build()
      if (toolCalls.length > 0) {
        yield { kind: 'tool_calls', tool_calls: toolCalls }
        return
      }
      if (!yieldedText) throw new Error('provider returned an empty response')
      return
    }

    // Non-SSE endpoint (e.g. a gateway that ignores `stream: true`): read the
    // whole JSON and translate one message as a single chunk.
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: WireToolCall[] } }>
    }
    const message = data.choices?.[0]?.message
    if (message?.reasoning_content) {
      yield { kind: 'thinking', delta: message.reasoning_content }
    }
    if (message?.tool_calls?.length) {
      message.tool_calls.forEach((call, index) =>
        builder.add({
          index,
          id: call.id,
          function: { name: call.function.name, arguments: call.function.arguments },
        }),
      )
      yield { kind: 'tool_calls', tool_calls: builder.build() }
      return
    }
    if (message?.content) {
      yield { kind: 'text', delta: message.content }
      return
    }
    throw new Error('provider returned an empty response')
  }
}