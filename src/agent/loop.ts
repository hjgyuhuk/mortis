/**
 * The agent loop: a small state machine driven by model decisions.
 *
 *   State → think → Decision → act (effects) → results → reduce → State
 *
 * The loop stays serial and minimal; concurrency lives inside act(), the
 * run scope owns effect lifetimes, and every state change goes through
 * reduce(). Cancellation is mapped per layer: effects see a native
 * AbortError, the loop converts it to RunInterruptedError, the UI converts
 * that to a user-facing notice.
 */

import type { ChatProvider, Decision, Effect, Message, Tool, ToolCall } from '../types.js'
import type { AgentEventListener } from './events.js'
import { Scope } from './scope.js'
import { initialState, reduce, type AgentState, type StateEvent } from './state.js'

const DEFAULT_MAX_TURNS = 20

/** The run was cancelled; the state was finalized and stays usable. */
export class RunInterruptedError extends Error {
  constructor(reason: string) {
    super(`run interrupted: ${reason}`)
    this.name = 'RunInterruptedError'
  }
}

export interface AgentOptions {
  provider: ChatProvider
  tools: Tool[]
  /** Maximum number of model requests per run. */
  maxTurns?: number
  /** System prompt for a fresh state; ignored when `state` is provided. */
  systemPrompt: string
  /** Initial state (e.g. a hydrated session). */
  state?: AgentState
  /** Domain-event observer (used by the TUI). */
  onEvent?: AgentEventListener
  /** Notified after every state transition; observers must not mutate state. */
  onTransition?: (state: AgentState) => void
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Summarize tool arguments for events: single line, truncated. */
function summarizeJson(json: string, maxLength = 120): string {
  const singleLine = json.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine
}

export class Agent {
  private readonly provider: ChatProvider
  private readonly tools: Tool[]
  private readonly maxTurns: number
  private readonly toolByName: Map<string, Tool>
  private readonly onEvent?: AgentEventListener
  private readonly onTransition?: (state: AgentState) => void
  private readonly agentScope = new Scope()
  private state: AgentState
  private currentRun: Scope | null = null

  constructor(options: AgentOptions) {
    this.provider = options.provider
    this.tools = options.tools
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.toolByName = new Map(options.tools.map((tool) => [tool.name, tool]))
    this.onEvent = options.onEvent
    this.onTransition = options.onTransition
    this.state = options.state ?? initialState(options.systemPrompt)
  }

  /** Current state as plain data; read-only for observers. */
  get snapshot(): AgentState {
    return this.state
  }

  /** Cancel the in-flight run, if any. The session stays usable afterwards. */
  abort(reason = 'cancelled'): void {
    this.currentRun?.abort(reason)
  }

  /** Run one turn. Returns the assistant's final text answer. */
  async run(userMessage: string): Promise<string> {
    this.transition({ type: 'user_message', content: userMessage })

    const runScope = this.agentScope.fork()
    this.currentRun = runScope
    try {
      for (let turn = 0; turn < this.maxTurns; turn++) {
        this.onEvent?.({ kind: 'model_request' })
        const decision = await this.think(runScope)

        if (decision.type === 'execute') {
          await this.act(decision.effects, runScope)
          continue
        }
        if (decision.type === 'respond') {
          this.transition({ type: 'assistant_message', content: decision.content })
          continue
        }
        if (decision.type === 'wait') {
          this.transition({ type: 'awaiting_user', reason: decision.reason })
          return decision.reason
        }
        return decision.result
      }
      // Turn budget exhausted: leave a resumable state, then fail the run.
      this.transition({ type: 'run_interrupted', reason: `exceeded ${this.maxTurns} turns` })
      throw new Error(`agent exceeded ${this.maxTurns} turns without finishing`)
    } catch (error) {
      if (isAbortError(error)) {
        const reason = runScope.abortReason || 'cancelled'
        this.transition({ type: 'run_interrupted', reason })
        this.onEvent?.({ kind: 'run_interrupted', reason })
        throw new RunInterruptedError(reason)
      }
      throw error
    } finally {
      this.currentRun = null
      runScope.dispose()
    }
  }

  /** The only place state changes: apply an event via the reducer. */
  private transition(event: StateEvent): void {
    this.state = reduce(this.state, event)
    this.onTransition?.(this.state)
  }

  /**
   * Consume the next model response, record it, and classify it into a
   * decision. Text-only maps to finish; tool calls map to execute.
   */
  private async think(scope: Scope): Promise<Decision> {
    const messages: Message[] = [...this.state.messages]
    let content = ''
    let thinking = ''
    let toolCalls: ToolCall[] = []
    for await (const chunk of this.provider.completeStream(messages, this.tools, scope.signal)) {
      if (chunk.kind === 'text') {
        content += chunk.delta
        this.onEvent?.({ kind: 'assistant_text', content })
      } else if (chunk.kind === 'thinking') {
        // Reasoning is display-only: the wire format forbids sending it back
        // and a resume does not need it, so it never enters the state.
        thinking += chunk.delta
        this.onEvent?.({ kind: 'assistant_thinking', content: thinking })
      } else {
        toolCalls = chunk.tool_calls
      }
    }

    if (toolCalls.length > 0) {
      this.transition({ type: 'assistant_message', content: content || null, toolCalls })
      return { type: 'execute', effects: toolCalls.map((call) => ({ kind: 'tool_call', call })) }
    }
    if (content) {
      this.transition({ type: 'assistant_message', content })
      return { type: 'finish', result: content }
    }
    throw new Error('model returned neither text nor tool calls')
  }

  /**
   * Execute effects concurrently, commit results in declaration order.
   * One effect failing never discards the others' results; an abort is not a
   * failure — it propagates so run() can finalize the state.
   */
  private async act(effects: Effect[], runScope: Scope): Promise<void> {
    const settled = await Promise.allSettled(
      effects.map((effect) => this.runEffect(effect, runScope)),
    )

    for (let index = 0; index < effects.length; index++) {
      const call = effects[index]!.call
      const outcome = settled[index]!
      if (outcome.status === 'rejected') {
        if (isAbortError(outcome.reason)) throw outcome.reason
        const content = `error: ${(outcome.reason as Error).message}`
        this.transition({ type: 'tool_error', toolCallId: call.id, content })
        this.onEvent?.({ kind: 'tool_result', toolCallId: call.id, content, isError: true })
        continue
      }
      this.transition({ type: 'tool_result', toolCallId: call.id, content: outcome.value })
      this.onEvent?.({ kind: 'tool_result', toolCallId: call.id, content: outcome.value, isError: false })
    }
  }

  /** Execute one effect in its own scope; resolves to a result string. */
  private async runEffect(effect: Effect, runScope: Scope): Promise<string> {
    if (effect.kind !== 'tool_call') {
      throw new Error(`unknown effect kind: ${JSON.stringify(effect)}`)
    }
    const call = effect.call
    const tool = this.toolByName.get(call.function.name)
    this.onEvent?.({
      kind: 'tool_start',
      toolCallId: call.id,
      toolName: call.function.name,
      argsSummary: summarizeJson(call.function.arguments),
    })
    if (!tool) return `error: unknown tool "${call.function.name}"`

    const effectScope = runScope.fork()
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>
      return await tool.execute(args, { signal: effectScope.signal })
    } catch (error) {
      if (isAbortError(error)) throw error
      return `tool ${tool.name} failed: ${(error as Error).message}`
    } finally {
      effectScope.dispose()
    }
  }
}
