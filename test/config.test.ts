import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, ensureFileConfig, readFileConfig, resolveConfig, resolveModelRef, writeFileConfig } from '../src/config.js'

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

  it('reads the filesystem section from the config file', () => {
    writeFileConfig({
      baseUrl: 'http://x/v1',
      model: 'm',
      filesystem: { scratchDir: '/scratch', rules: [{ path: '/data', access: 'rw' }] },
    })
    expect(resolveConfig().filesystem).toEqual({
      scratchDir: '/scratch',
      rules: [{ path: '/data', access: 'rw' }],
    })
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
describe('provider and model aliases', () => {
  const longcatAlias = 'longcat/longcat-2.0'
  const opencodeAlias = 'opencode/gpt-5.5-pro'

  function writeMultiProviderConfig(): void {
    writeFileConfig({
      model: longcatAlias,
      apiKey: 'fallback-key',
      providers: {
        longcat: {
          type: 'openai',
          apiKey: 'longcat-key',
          baseUrl: 'https://api.longcat.chat/openai/v1',
        },
        opencode: {
          type: 'openai',
          apiKey: 'opencode-key',
          baseUrl: 'https://opencode.ai/zen/v1',
        },
      },
      models: {
        [longcatAlias]: {
          provider: 'longcat',
          model: 'LongCat-2.0',
          maxContextSize: 1_048_576,
          maxOutputSize: 131_072,
          capabilities: ['thinking', 'tool_use'],
          displayName: 'LongCat-2.0',
        },
        [opencodeAlias]: {
          provider: 'opencode',
          model: 'gpt-5.5-pro',
          maxContextSize: 1_050_000,
          maxInputSize: 922_000,
          maxOutputSize: 128_000,
          capabilities: ['image_in', 'always_thinking', 'tool_use'],
          displayName: 'GPT-5.5 Pro',
          supportEfforts: ['medium', 'high', 'xhigh'],
        },
      },
    })
  }

  it('resolves the main-agent alias through its provider', () => {
    writeMultiProviderConfig()
    const config = resolveConfig()
    expect(config.model).toBe(longcatAlias)
    expect(resolveModelRef(undefined, config)).toMatchObject({
      alias: longcatAlias,
      provider: 'longcat',
      type: 'openai',
      baseUrl: 'https://api.longcat.chat/openai/v1',
      model: 'LongCat-2.0',
      apiKey: 'longcat-key',
      maxContextSize: 1_048_576,
      maxOutputSize: 131_072,
      capabilities: ['thinking', 'tool_use'],
      displayName: 'LongCat-2.0',
    })
  })

  it('resolves a persona model alias through its own provider', () => {
    writeMultiProviderConfig()
    const personaModel = resolveModelRef(opencodeAlias, resolveConfig())
    expect(personaModel).toMatchObject({
      alias: opencodeAlias,
      provider: 'opencode',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'gpt-5.5-pro',
      apiKey: 'opencode-key',
      maxContextSize: 1_050_000,
      maxInputSize: 922_000,
      maxOutputSize: 128_000,
      capabilities: ['image_in', 'always_thinking', 'tool_use'],
      displayName: 'GPT-5.5 Pro',
      supportEfforts: ['medium', 'high', 'xhigh'],
    })
  })

  it('CLI --model selects any configured model alias', () => {
    writeMultiProviderConfig()
    const config = resolveConfig({ model: opencodeAlias })
    expect(config.model).toBe(opencodeAlias)
    expect(resolveModelRef(undefined, config)).toMatchObject({
      provider: 'opencode',
      model: 'gpt-5.5-pro',
    })
  })

  it('falls back to top-level settings for a literal model', () => {
    const config = resolveConfig({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder',
      apiKey: 'local-key',
      thinkingEffort: 'medium',
    })
    expect(resolveModelRef(undefined, config)).toEqual({
      alias: 'qwen2.5-coder',
      type: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder',
      apiKey: 'local-key',
      thinkingEffort: 'medium',
    })
  })

  it('uses the top-level key when a provider does not define one', () => {
    const config = resolveConfig({
      model: 'remote',
      apiKey: 'fallback-key',
      providers: {
        remote: { type: 'openai', baseUrl: 'https://api.example.com/v1' },
      },
      models: {
        remote: { provider: 'remote', model: 'remote-model' },
      },
    })
    expect(resolveModelRef(undefined, config)).toMatchObject({
      apiKey: 'fallback-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'remote-model',
    })
  })

  it('rejects a model alias that references an unknown provider', () => {
    const config = resolveConfig({
      model: 'broken',
      models: {
        broken: { provider: 'missing', model: 'missing-model' },
      },
    })
    expect(() => resolveModelRef(undefined, config)).toThrow('unknown provider')
  })

  it('does not auto-persist provider API keys', () => {
    const config = resolveConfig({
      model: 'remote',
      providers: {
        remote: { type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'provider-secret' },
      },
      models: {
        remote: { provider: 'remote', model: 'remote-model' },
      },
    })
    ensureFileConfig(config)
    expect(readFileConfig().providers).toEqual({
      remote: { type: 'openai', baseUrl: 'https://api.example.com/v1' },
    })
  })
})
