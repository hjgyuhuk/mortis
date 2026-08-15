/**
 * The agent loop.
 *
 * The core of the harness: send the conversation to the provider, execute any
 * requested tool calls, feed the results back, and repeat until the model
 * answers with text or the turn budget is exhausted.
 */

import type { ChatProvider, Message, Tool, ToolCall } from '../types.js'
import type { AgentEventListener } from './events.js'

export interface AgentOptions {
  provider: ChatProvider
  tools: Tool[]
  /** Maximum number of model requests per run. */
  maxTurns?: number
  /** System prompt prepended to every run. */
  systemPrompt: string
  /** Optional observer of loop events (used by the TUI). */
  onEvent?: AgentEventListener
}

const DEFAULT_MAX_TURNS = 20

/** Summarize tool arguments for display: single line, truncated. */
function summarizeJson(json: string, maxLength = 120): string {
  const singleLine = json.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine
}

export class Agent {
  private readonly provider: ChatProvider
  private readonly tools: Tool[]
  private readonly maxTurns: number
  private readonly messages: Message[]
  private readonly toolByName: Map<string, Tool>
  private readonly onEvent?: AgentEventListener

  constructor(options: AgentOptions) {
    this.provider = options.provider
    this.tools = options.tools
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.messages = [{ role: 'system', content: options.systemPrompt }]
    this.toolByName = new Map(options.tools.map((tool) => [tool.name, tool]))
    this.onEvent = options.onEvent
  }

  /** Run one turn. Returns the assistant's final text answer. */
  async run(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage })

    for (let turn = 0; turn < this.maxTurns; turn++) {
      this.onEvent?.({ kind: 'model_request' })

      // Consume the streamed response: accumulate any text deltas and collect
      // tool requests. Text deltas are streamed to the observer as they arrive
      // so the TUI can render incrementally.
      let content = ''
      let toolCalls: ToolCall[] = []
      for await (const chunk of this.provider.completeStream(this.messages, this.tools)) {
        if (chunk.kind === 'text') {
          content += chunk.delta
          this.onEvent?.({ kind: 'assistant_delta', content })
        } else {
          toolCalls = chunk.tool_calls
        }
      }

      if (toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content })
        return content
      }

      // Tool calls: record them, execute, and append the results.
      this.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

      for (const call of toolCalls) {
        const tool = this.toolByName.get(call.function.name)
        if (tool) {
          this.onEvent?.({
            kind: 'tool_start',
            toolCallId: call.id,
            toolName: tool.name,
            argsSummary: summarizeJson(call.function.arguments),
          })
        } else {
          this.onEvent?.({
            kind: 'tool_start',
            toolCallId: call.id,
            toolName: call.function.name,
            argsSummary: '(unknown tool)',
          })
        }
        const result = tool
          ? await this.executeTool(tool, call.function.arguments)
          : `error: unknown tool "${call.function.name}"`
        this.onEvent?.({
          kind: 'tool_result',
          toolCallId: call.id,
          resultSummary: summarizeJson(JSON.stringify(result), 200),
        })
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
    }

    throw new Error(`agent exceeded ${this.maxTurns} turns without finishing`)
  }

  private async executeTool(tool: Tool, argumentsJson: string): Promise<string> {
    try {
      const args = JSON.parse(argumentsJson) as Record<string, unknown>
      return await tool.execute(args)
    } catch (error) {
      return `tool ${tool.name} failed: ${(error as Error).message}`
    }
  }
}