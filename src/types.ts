/**
 * Shared types for the agent loop, provider, and tools.
 *
 * These mirror the wire vocabulary of an OpenAI-compatible chat API so the
 * provider layer can translate them directly.
 */

/** A single message in the conversation. */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** A tool the model may call. */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * Execute the tool with parsed arguments. Returns text for the model —
   * including on failure; never throws for tool-level errors. Cancellation
   * (AbortError) does propagate.
   */
  execute(args: Record<string, unknown>, context?: ToolContext): Promise<string>
}

/** Runtime context handed to tools; the signal fires when the run is cancelled. */
export interface ToolContext {
  signal?: AbortSignal
}

/** A side effect the agent intends to perform. Tools never mutate state. */
export type Effect =
  | { kind: 'tool_call'; call: ToolCall }
  // Future kinds slot in here: sub_agent, permission, sleep, human approval.
  // Context compaction is a runtime-owned direct action, not a model Decision.

/** Why the runtime granted the main agent one context-compact lease. */
export type ContextCompactReason = 'manual' | 'threshold'

/**
 * The model's intent for the next step. A decision describes; the runtime
 * executes. It is an interpretation of the model output, not the raw output.
 */
export type Decision =
  /** Intermediate text; the loop continues with another model request. */
  | { type: 'respond'; content: string }
  /** Run effects concurrently, commit results in declaration order. */
  | { type: 'execute'; effects: Effect[] }
  /** Pause the run and wait for the user. */
  | { type: 'wait'; reason: string }
  /** The final answer; the run ends. */
  | { type: 'finish'; result: string }

/** A single model response, either text or tool calls. */
export type ModelResponse =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }
  | { kind: 'tool_calls'; tool_calls: ToolCall[] }

/** One chunk of a streamed model response. */
export type StreamChunk =
  | { kind: 'text'; delta: string }
  /** Model reasoning (e.g. `reasoning_content` deltas); display-only. */
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool_calls'; tool_calls: ToolCall[] }
  /** Provider-reported prompt token count for the request just answered. */
  | { kind: 'usage'; promptTokens: number }

/** The provider abstraction — one method, the streamed chat completion. */
export interface ChatProvider {
  /**
   * Send the conversation and stream the next model response. A text reply
   * arrives as one or more text deltas; a tool request is emitted once, after
   * any text deltas, as a single tool_calls chunk. The optional signal
   * cancels the request; cancellation rejects with a standard AbortError.
   */
  completeStream(messages: Message[], tools: Tool[], signal?: AbortSignal): AsyncIterable<StreamChunk>
}
