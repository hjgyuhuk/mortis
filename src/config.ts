/**
 * Configuration for the agent: which OpenAI-compatible endpoint and model to
 * use. Resolution order: CLI > environment > `~/.mortis/config.json` > defaults.
 */

import { homedir } from 'node:os'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface Config {
  /** Base URL of the OpenAI-compatible endpoint. */
  baseUrl: string
  /** Model name. */
  model: string
  /** Optional API key. */
  apiKey?: string
}

/** Path to the configuration directory. */
export function configDir(): string {
  return join(homedir(), '.mortis')
}

/** Path to the config file inside the configuration directory. */
export function configPath(): string {
  return join(configDir(), 'config.json')
}

/**
 * Read config from `~/.mortis/config.json`; returns an empty object when the
 * file is missing or invalid.
 */
export function readFileConfig(): Partial<Config> {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    return { baseUrl: parsed.baseUrl, model: parsed.model, apiKey: parsed.apiKey }
  } catch (error) {
    throw new Error(`invalid config at ${path}: ${(error as Error).message}`)
  }
}

/** Write config to `~/.mortis/config.json`, creating the directory if needed. */
export function writeFileConfig(config: Partial<Config>): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n')
}

/**
 * Ensure `~/.mortis/config.json` exists, writing `config` (the resolved
 * config, including defaults) when the file or directory is missing. Call at
 * startup so the config is always on disk.
 */
export function ensureFileConfig(config: Config): Config {
  if (!existsSync(configPath())) {
    writeFileConfig(config)
  }
  return config
}

/**
 * Resolve configuration with the given overrides (from the CLI). Precedence:
 * CLI overrides, then environment variables, then the config file, then
 * defaults.
 */
export function resolveConfig(overrides: Partial<Config> = {}): Config {
  const file = readFileConfig()
  const baseUrl = overrides.baseUrl ?? process.env.MORTIS_BASE_URL ?? file.baseUrl ?? 'https://api.openai.com/v1'
  const model = overrides.model ?? process.env.MORTIS_MODEL ?? file.model ?? 'gpt-4o-mini'
  const apiKey = overrides.apiKey ?? process.env.MORTIS_API_KEY ?? file.apiKey
  return { baseUrl, model, apiKey }
}

/** Default system prompt describing the agent's tools and behavior. */
export function defaultSystemPrompt(): string {
  return [
    'You are Mortis, a coding agent. You help the user solve tasks in their repository.',
    'Use the available tools (read, write, edit, bash) to inspect and modify files.',
    'Prefer reading files before editing them. When the task is done, answer with a',
    'concise summary of what you changed.',
  ].join('\n')
}