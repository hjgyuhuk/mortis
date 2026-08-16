/**
 * Agent state as plain, serializable data, and the reducer that owns it.
 *
 * reduce() is the only state mutation authority: every change is a specific
 * event, and status is derived from events — no transient execution detail
 * (currentTool, currentTurn, ...) lives here. State records what a resume
 * needs, not what the loop is momentarily doing.
 *
 * Invariants (see AGENTS.md):
 * - State is plain, serializable data.
 * - Any state whose status is not 'running' is directly sendable: every
 *   assistant tool_calls message has matching tool results. `run_interrupted`
 *   guarantees this by appending synthetic results for dangling calls — it is
 *   a real transition, not a repair helper.
 */

import type { Message, ToolCall } from '../types.js'

/** Coarse run status — the only runtime semantics State carries. */
export type AgentStatus = 'idle' | 'running' | 'awaiting_user' | 'done'

export interface AgentState {
  readonly messages: readonly Message[]
  readonly status: AgentStatus
}

/** A fresh state with the system prompt, waiting for the first user message. */
export function initialState(systemPrompt: string): AgentState {
  return { messages: [{ role: 'system', content: systemPrompt }], status: 'idle' }
}

/**
 * The only legal state transitions. Deliberately specific — no catch-all
 * event with a string type and unknown payload.
 */
export type StateEvent =
  /** A user submitted a prompt; a run implicitly starts. */
  | { type: 'user_message'; content: string }
  /** The model produced a message; plain text ends the run, tool calls continue it. */
  | { type: 'assistant_message'; content: string | null; toolCalls?: ToolCall[] }
  /** An effect completed with a result for the model. */
  | { type: 'tool_result'; toolCallId: string; content: string }
  /** An effect failed at the effect level (not a tool-reported error text). */
  | { type: 'tool_error'; toolCallId: string; content: string }
  /** The run was cancelled or aborted; dangling tool calls get synthetic results. */
  | { type: 'run_interrupted'; reason: string }
  /** The run paused to wait for the user (e.g. a question or approval). */
  | { type: 'awaiting_user'; reason: string }

/**
 * Append synthetic results for unanswered tool calls. Used by transitions
 * that leave the running status — they must guarantee sendability.
 */
function withDanglingAnswered(messages: readonly Message[], note: string): Message[] {
  const dangling = collectDangling(messages)
  const out = [...messages]
  for (const toolCallId of dangling) {
    out.push({ role: 'tool', tool_call_id: toolCallId, content: `(${note})` })
  }
  return out
}

/** Ids of assistant tool calls that have no matching tool message yet. */
function collectDangling(messages: readonly Message[]): Set<string> {
  const required = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) required.add(call.id)
    }
    if (message.role === 'tool') required.delete(message.tool_call_id)
  }
  return required
}

/** Apply one event, returning the next state. Pure: never mutates the input. */
export function reduce(state: AgentState, event: StateEvent): AgentState {
  switch (event.type) {
    case 'user_message':
      return { messages: [...state.messages, { role: 'user', content: event.content }], status: 'running' }
    case 'assistant_message':
      if (event.toolCalls && event.toolCalls.length > 0) {
        return {
          messages: [
            ...state.messages,
            { role: 'assistant', content: event.content, tool_calls: event.toolCalls },
          ],
          status: 'running',
        }
      }
      return {
        messages: [...state.messages, { role: 'assistant', content: event.content }],
        // A plain answer only counts as done when nothing is dangling —
        // 'done' promises a sendable state.
        status: collectDangling(state.messages).size > 0 ? 'running' : 'done',
      }
    case 'tool_result':
    case 'tool_error':
      return {
        messages: [
          ...state.messages,
          { role: 'tool', tool_call_id: event.toolCallId, content: event.content },
        ],
        status: state.status,
      }
    case 'run_interrupted':
      return {
        messages: withDanglingAnswered(state.messages, `interrupted: ${event.reason}`),
        status: 'idle',
      }
    case 'awaiting_user':
      return {
        messages: [
          ...withDanglingAnswered(state.messages, `pending user: ${event.reason}`),
          { role: 'assistant', content: event.reason },
        ],
        status: 'awaiting_user',
      }
  }
}

/** True when the state can be sent to a provider as-is (tool-call pairing holds). */
export function isSendable(state: AgentState): boolean {
  if (state.status === 'running') return false
  return collectDangling(state.messages).size === 0
}
