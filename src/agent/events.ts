import type { ContextCompactReason } from '../types.js'

/**
 * Domain events emitted by the agent loop.
 *
 * These describe what happened in the agent's domain (a model request, a
 * tool finishing) — not how to display it. UI concerns (spinner text, row
 * truncation, markdown rendering) live in the TUI, which derives them from
 * these events.
 */

/** A tool call began. */
export type AgentEvent =
  | { kind: 'model_request' }
  /** The Agent is asking the compact persona to summarize active history. */
  | { kind: 'context_compacting'; reason: ContextCompactReason }
  /** The reducer replaced non-system history with an untrusted summary record. */
  | { kind: 'context_compacted'; reason: ContextCompactReason; removedMessages: number }
  /** Accumulated model reasoning so far, streamed before the answer. */
  | { kind: 'assistant_thinking'; content: string }
  /** Accumulated assistant text so far, as it streams in. */
  | { kind: 'assistant_text'; content: string }
  | { kind: 'tool_start'; toolCallId: string; toolName: string; argsSummary: string }
  /** A tool finished; content is the full result (or error text) for the model. */
  | { kind: 'tool_result'; toolCallId: string; content: string; isError: boolean }
  | { kind: 'run_interrupted'; reason: string }

/** Observer notified after each model response and tool execution. */
export type AgentEventListener = (event: AgentEvent) => void
