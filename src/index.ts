/**
 * Public library surface: the agent, provider, and tools.
 */

export { Agent, type AgentOptions } from './agent/loop.js'
export type { AgentEvent, AgentEventListener } from './agent/events.js'
export { OpenAIProvider, type OpenAIProviderOptions } from './provider/openai.js'
export { builtinTools } from './tools/index.js'
export { ensureFileConfig, resolveConfig, defaultSystemPrompt, configDir, configPath, type Config } from './config.js'
export { AgentTui } from './tui/index.js'
export type { ChatProvider, Message, ModelResponse, Tool, ToolCall } from './types.js'