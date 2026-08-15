/**
 * Events emitted by the agent loop, consumed by the TUI (or any observer).
 */

/** A tool call began. */
export type AgentEvent =
  | { kind: 'model_request' }
  | { kind: 'assistant_delta'; content: string }
  | { kind: 'tool_start'; toolCallId: string; toolName: string; argsSummary: string }
  | { kind: 'tool_result'; toolCallId: string; resultSummary: string }

/** Observer notified after each model response and tool execution. */
export type AgentEventListener = (event: AgentEvent) => void