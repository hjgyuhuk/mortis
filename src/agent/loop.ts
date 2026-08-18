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

import {
  COMPACT_CONTEXT_TOOL,
  compactableHistory,
  compactContextTool,
  shouldCompactContext,
  type ContextRuntime,
} from '../context.js'
import type {
  ChatProvider,
  ContextCompactReason,
  Decision,
  Effect,
  Message,
  Tool,
  ToolCall,
} from '../types.js'
import type { AgentEventListener } from './events.js'
import { Scope } from './scope.js'
import { initialState, reduce, type AgentState, type StateEvent } from './state.js'

const DEFAULT_MAX_TURNS = 20

/** A private, single-use authority. It is never serialized or shown to a model. */
interface ContextLease {
  readonly reason: ContextCompactReason
  /** History at grant time; direct-action control calls never enter it. */
  readonly history: readonly Message[]
}

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
  /** Optional compact-persona dependency for lease-authorized compaction. */
  context?: ContextRuntime
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Match only provider responses that explicitly report an input/context limit. */
function isContextLimitError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { status?: unknown }).status
  if (status !== 400 && status !== 413) return false
  return /context|token|maximum length|input length|too large|limit/i.test(error.message)
}

/** Add actionable guidance without dropping the provider's HTTP status. */
function contextLimitGuidance(error: Error): Error {
  const guided = new Error(
    'provider rejected the context before main-agent compaction could run; configure model input limits and compact before the threshold: ' +
    error.message,
  )
  const status = (error as Error & { status?: unknown }).status
  if (typeof status === 'number') Object.assign(guided, { status })
  return guided
}

/** Direct context actions accept no model-controlled input. */
function isCompactContextCall(call: ToolCall): boolean {
  if (call.function.name !== COMPACT_CONTEXT_TOOL) return false
  try {
    const args = JSON.parse(call.function.arguments) as unknown
    return typeof args === 'object' && args !== null && !Array.isArray(args) && Object.keys(args).length === 0
  } catch {
    return false
  }
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
  private readonly context?: ContextRuntime
  private readonly agentScope = new Scope()
  private state: AgentState
  private currentRun: Scope | null = null
  private contextLease: ContextLease | null = null
  /** Suppress a second threshold lease until ordinary State changes again. */
  private thresholdCompactedState: AgentState | null = null

  constructor(options: AgentOptions) {
    this.provider = options.provider
    this.tools = options.tools
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.toolByName = new Map(options.tools.map((tool) => [tool.name, tool]))
    this.onEvent = options.onEvent
    this.onTransition = options.onTransition
    this.context = options.context
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

  /**
   * Let an interactive user request a lease. The main agent must authorize
   * `compact_context`; the command itself never enters State.
   */
  async requestContextCompaction(): Promise<boolean> {
    if (this.currentRun) throw new Error('cannot compact while an agent run is active')
    if (!this.grantContextLease('manual')) return false

    const scope = this.agentScope.fork()
    this.currentRun = scope
    try {
      this.onEvent?.({ kind: 'model_request' })
      const decision = await this.think(scope)
      if (decision.type !== 'execute' || decision.effects.length !== 1 || decision.effects[0]!.kind !== 'context_compact') {
        throw new Error('main agent did not authorize context compaction')
      }
      await this.act(decision.effects, scope)
      return true
    } catch (error) {
      if (isAbortError(error)) {
        const reason = scope.abortReason || 'cancelled'
        this.onEvent?.({ kind: 'run_interrupted', reason })
        throw new RunInterruptedError(reason)
      }
      throw error
    } finally {
      this.contextLease = null
      this.currentRun = null
      scope.dispose()
    }
  }

  /** Run one turn. Returns the assistant's final text answer. */
  async run(userMessage: string): Promise<string> {
    this.transition({ type: 'user_message', content: userMessage })

    const runScope = this.agentScope.fork()
    this.currentRun = runScope
    try {
      for (let turn = 0; turn < this.maxTurns; turn++) {
        this.grantThresholdLease()
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
      if (isContextLimitError(error)) {
        throw contextLimitGuidance(error)
      }
      throw error
    } finally {
      this.contextLease = null
      this.currentRun = null
      runScope.dispose()
    }
  }

  /** The only place state changes: apply an event via the reducer. */
  private transition(event: StateEvent): void {
    this.state = reduce(this.state, event)
    this.onTransition?.(this.state)
  }

  /** Grant one private lease. Only this Agent can turn it into a direct Effect. */
  private grantContextLease(reason: ContextCompactReason): boolean {
    if (!this.context || this.contextLease) return false
    const history = compactableHistory(this.state.messages)
    if (history.length === 0) return false
    this.contextLease = { reason, history }
    return true
  }

  /** Start an automatic lease once per unchanged compacted state. */
  private grantThresholdLease(): void {
    if (!this.context || this.contextLease || this.state === this.thresholdCompactedState) return
    if (shouldCompactContext(this.state.messages, this.tools, this.context.policy)) {
      this.grantContextLease('threshold')
    }
  }

  /** The provider sees only the authorized direct action while a lease exists. */
  private toolsForRequest(): Tool[] {
    return this.contextLease ? [compactContextTool()] : this.tools
  }

  /** Run the main-agent-authorized direct Effect and commit through the reducer. */
  private async runContextCompactEffect(effect: Extract<Effect, { kind: 'context_compact' }>, scope: Scope): Promise<void> {
    const lease = this.contextLease
    const context = this.context
    if (!lease || !context || lease.reason !== effect.reason) {
      throw new Error('context compaction lease is absent or invalid')
    }

    this.onEvent?.({ kind: 'context_compacting', reason: lease.reason })
    const summary = await context.compactor.compact(lease.history, scope.signal)
    this.transition({ type: 'context_compacted', summary })
    this.contextLease = null
    if (effect.reason === 'threshold') this.thresholdCompactedState = this.state
    this.onEvent?.({
      kind: 'context_compacted',
      reason: effect.reason,
      removedMessages: lease.history.length,
    })
  }

  /**
   * Consume the next model response, record it, and classify it into a
   * decision. Text-only maps to finish; tool calls map to execute.
   */
  private async think(scope: Scope): Promise<Decision> {
    const messages: Message[] = [...this.state.messages]
    const tools = this.toolsForRequest()
    const directContextRequest = this.contextLease !== null
    let content = ''
    let thinking = ''
    let toolCalls: ToolCall[] = []
    for await (const chunk of this.provider.completeStream(messages, tools, scope.signal)) {
      if (chunk.kind === 'text') {
        content += chunk.delta
        if (!directContextRequest) this.onEvent?.({ kind: 'assistant_text', content })
      } else if (chunk.kind === 'thinking') {
        // Reasoning is display-only: the wire format forbids sending it back
        // and a resume does not need it, so it never enters the state.
        thinking += chunk.delta
        if (!directContextRequest) this.onEvent?.({ kind: 'assistant_thinking', content: thinking })
      } else {
        toolCalls = chunk.tool_calls
      }
    }

    if (this.contextLease) {
      if (toolCalls.length !== 1 || !isCompactContextCall(toolCalls[0]!)) {
        throw new Error('context compaction lease requires one compact_context call with {} and no other tool calls')
      }
      // Direct actions are not conversation tool calls. Their effect replaces
      // history atomically, so neither a tool call nor a tool result is stored.
      return {
        type: 'execute',
        effects: [{ kind: 'context_compact', call: toolCalls[0]!, reason: this.contextLease.reason }],
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
    const contextEffect = effects.find((effect) => effect.kind === 'context_compact')
    if (contextEffect) {
      if (effects.length !== 1) throw new Error('context_compact cannot run with other effects')
      await this.runContextCompactEffect(contextEffect, runScope)
      return
    }

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
