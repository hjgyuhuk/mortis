/**
 * Public library surface: types, state, the agent, provider, tools, sessions.
 */

export { Agent, RunInterruptedError, type AgentOptions } from './agent/loop.js'
export type { AgentEvent, AgentEventListener } from './agent/events.js'
export { initialState, reduce, isSendable, collectDangling, type AgentState, type AgentStatus, type StateEvent } from './agent/state.js'
export {
  COMPACT_CONTEXT_TOOL,
  COMPACTED_CONTEXT_START,
  COMPACTED_CONTEXT_END,
  DEFAULT_CONTEXT_TRIGGER_RATIO,
  compactableHistory,
  compactContextTool,
  compactedContextMessage,
  compactionTask,
  estimateContextTokens,
  resolveInputTokenLimit,
  rootSystemMessages,
  serializeCompactionHistory,
  shouldCompactContext,
  type ContextCompactor,
  type ContextPolicy,
  type ContextRuntime,
  type ModelContextLimits,
} from './context.js'
export { Scope } from './agent/scope.js'
export { OpenAIProvider, ProviderHttpError, type OpenAIProviderOptions } from './provider/openai.js'
export { createBuiltinTools, builtinTools, askUserTool, DEFAULT_ASK_OPTIONS } from './tools/index.js'
export {
  FilesystemPolicy,
  mergeRules,
  openPolicy,
  parseRules,
  type Access,
  type FilesystemPolicyOptions,
  type FsRule,
  type Intent,
  type PolicyDecision,
  type Zone,
} from './fs-policy.js'
export {
  bwrapArgv,
  createSandbox,
  seatbeltProfile,
  type SandboxRunner,
} from './sandbox.js'
export {
  ensureFileConfig,
  resolveConfig,
  resolveModelRef,
  defaultSystemPrompt,
  configDir,
  configPath,
  type Config,
  type FilesystemConfig,
  type ModelCapability,
  type ModelConfig,
  type ProviderConfig,
  type ResolvedModel,
} from './config.js'
export { AgentTui, OptionsBar } from './tui/index.js'
export type { AgentTuiOptions } from './tui/index.js'
export { loadAgentsMd, findGitRoot } from './instructions.js'
export {
  PERSONAS,
  COMPACT,
  PLANNER,
  ensureDefaultPersonas,
  loadPersonas,
  parsePersonaMarkdown,
  parsePersonaOutput,
  personaTool,
  personasDir,
  runPersona,
  serializePersonaMarkdown,
  type PersonaDefinition,
  type PersonaResult,
} from './persona.js'
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
  ContextCompactReason,
  Decision,
  Effect,
  Message,
  ModelResponse,
  StreamChunk,
  Tool,
  ToolCall,
  ToolContext,
} from './types.js'
