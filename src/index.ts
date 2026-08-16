/**
 * Public library surface: types, state, the agent, provider, tools, sessions.
 */

export { Agent, RunInterruptedError, type AgentOptions } from './agent/loop.js'
export type { AgentEvent, AgentEventListener } from './agent/events.js'
export { initialState, reduce, isSendable, type AgentState, type AgentStatus, type StateEvent } from './agent/state.js'
export { Scope } from './agent/scope.js'
export { OpenAIProvider, type OpenAIProviderOptions } from './provider/openai.js'
export { builtinTools } from './tools/index.js'
export {
  ensureFileConfig,
  resolveConfig,
  defaultSystemPrompt,
  configDir,
  configPath,
  type Config,
} from './config.js'
export { AgentTui, type AgentTuiOptions } from './tui/index.js'
export { loadAgentsMd, findGitRoot } from './instructions.js'
export {
  hydrateState,
  latestSession,
  saveSession,
  serializeState,
  sessionsDir,
  SNAPSHOT_VERSION,
  type SessionSnapshot,
} from './session.js'
export type {
  ChatProvider,
  Decision,
  Effect,
  Message,
  ModelResponse,
  StreamChunk,
  Tool,
  ToolCall,
  ToolContext,
} from './types.js'
