import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, ensureFileConfig, readFileConfig, resolveConfig, writeFileConfig } from '../src/config.js'

const originalHome = process.env.HOME
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mortis-home-'))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = originalHome
  delete process.env.MORTIS_BASE_URL
  delete process.env.MORTIS_MODEL
  delete process.env.MORTIS_API_KEY
  delete process.env.MORTIS_THINKING_EFFORT
})

describe('config', () => {
  it('resolves thinkingEffort with CLI > env > file precedence', () => {
    writeFileConfig({ baseUrl: 'http://x/v1', model: 'm', thinkingEffort: 'low' })
    expect(resolveConfig().thinkingEffort).toBe('low')

    process.env.MORTIS_THINKING_EFFORT = 'high'
    expect(resolveConfig().thinkingEffort).toBe('high')

    expect(resolveConfig({ thinkingEffort: 'medium' }).thinkingEffort).toBe('medium')
  })

  it('reads defaults when no config file exists', () => {
    const config = resolveConfig()
    expect(config.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.model).toBe('gpt-4o-mini')
    expect(config.apiKey).toBeUndefined()
    expect(config.thinkingEffort).toBeUndefined()
  })

  it('reads from ~/.mortis/config.json', () => {
    writeFileConfig({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', apiKey: 'abc' })
    expect(resolveConfig()).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder',
      apiKey: 'abc',
    })
  })

  it('gives CLI overrides precedence over the config file', () => {
    writeFileConfig({ baseUrl: 'http://file/v1', model: 'file-model' })
    const config = resolveConfig({ baseUrl: 'http://cli/v1', apiKey: 'cli-key' })
    expect(config.baseUrl).toBe('http://cli/v1')
    expect(config.model).toBe('file-model')
    expect(config.apiKey).toBe('cli-key')
  })

  it('gives environment variables precedence over the config file', () => {
    writeFileConfig({ baseUrl: 'http://file/v1', model: 'file-model' })
    process.env.MORTIS_BASE_URL = 'http://env/v1'
    const config = resolveConfig()
    expect(config.baseUrl).toBe('http://env/v1')
    expect(config.model).toBe('file-model')
  })

  it('writes the config file with a directory it creates', () => {
    writeFileConfig({ baseUrl: 'http://x/v1', model: 'm' })
    expect(readFileConfig()).toEqual({ baseUrl: 'http://x/v1', model: 'm', apiKey: undefined })
  })

  it('creates the directory and file when missing', () => {
    const config = resolveConfig()
    const result = ensureFileConfig(config)
    expect(result).toEqual(config)
    expect(existsSync(configPath())).toBe(true)
    expect(readFileConfig()).toEqual(config)
  })

  it('does not persist the apiKey when creating the initial config', () => {
    const config = resolveConfig({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'sk-secret' })
    ensureFileConfig(config)
    expect(config.apiKey).toBe('sk-secret')
    expect(existsSync(configPath())).toBe(true)
    expect(readFileConfig().apiKey).toBeUndefined()
  })

  it('does not overwrite an existing config file', () => {
    writeFileConfig({ baseUrl: 'http://existing/v1', model: 'existing-model' })
    const config = resolveConfig()
    ensureFileConfig(config)
    expect(readFileConfig()).toEqual({ baseUrl: 'http://existing/v1', model: 'existing-model', apiKey: undefined })
  })

  it('throws when the config file is invalid JSON', () => {
    const path = configPath()
    mkdirSync(home + '/.mortis')
    writeFileSync(path, '{oops')
    expect(() => resolveConfig()).toThrow('invalid config')
  })

  it('builds configPath under ~/.mortis', () => {
    expect(configPath()).toBe(join(home, '.mortis', 'config.json'))
  })
})