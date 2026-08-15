import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findGitRoot, loadAgentsMd } from '../src/instructions.js'

const originalHome = process.env.HOME
let home: string
let tmp: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mortis-home-'))
  tmp = mkdtempSync(join(tmpdir(), 'mortis-test-'))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  process.env.HOME = originalHome
})

describe('findGitRoot', () => {
  it('returns null when no .git exists', () => {
    const sub = join(tmp, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    expect(findGitRoot(sub)).toBeNull()
  })

  it('finds .git in the directory itself', () => {
    mkdirSync(join(tmp, '.git'))
    expect(findGitRoot(tmp)).toBe(tmp)
  })

  it('finds .git in a parent directory', () => {
    const sub = join(tmp, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(tmp, '.git'))
    expect(findGitRoot(sub)).toBe(tmp)
  })
})

describe('loadAgentsMd', () => {
  it('returns empty string when no files exist', () => {
    expect(loadAgentsMd(tmp)).toBe('')
  })

  it('loads global AGENTS.md', () => {
    mkdirSync(join(home, '.mortis'))
    writeFileSync(join(home, '.mortis', 'AGENTS.md'), 'global rules')
    const result = loadAgentsMd(tmp)
    expect(result).toContain('global rules')
    expect(result).toContain('<!-- From:')
  })

  it('loads project AGENTS.md', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), 'project rules')
    const result = loadAgentsMd(tmp)
    expect(result).toContain('project rules')
  })

  it('loads both global and project with correct order', () => {
    mkdirSync(join(home, '.mortis'))
    writeFileSync(join(home, '.mortis', 'AGENTS.md'), 'global')
    writeFileSync(join(tmp, 'AGENTS.md'), 'project')
    const result = loadAgentsMd(tmp)
    const globalIdx = result.indexOf('global')
    const projectIdx = result.indexOf('project')
    expect(globalIdx).toBeLessThan(projectIdx)
  })

  it('walks from project root down to cwd', () => {
    const sub = join(tmp, 'src', 'app')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(tmp, '.git'))
    writeFileSync(join(tmp, 'AGENTS.md'), 'root rules')
    writeFileSync(join(sub, 'AGENTS.md'), 'app rules')
    const result = loadAgentsMd(sub)
    const rootIdx = result.indexOf('root rules')
    const appIdx = result.indexOf('app rules')
    expect(rootIdx).toBeLessThan(appIdx)
  })

  it('skips empty files', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '   ')
    expect(loadAgentsMd(tmp)).toBe('')
  })

  it('annotates each file with its path', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), 'hello')
    const result = loadAgentsMd(tmp)
    expect(result).toContain(`<!-- From: ${join(tmp, 'AGENTS.md')} -->`)
  })
})

describe('defaultSystemPrompt with agentsMd', () => {
  it('includes agentsMd when provided', async () => {
    const { defaultSystemPrompt } = await import('../src/config.js')
    const prompt = defaultSystemPrompt('custom instructions')
    expect(prompt).toContain('custom instructions')
    expect(prompt).toContain('Mortis')
  })

  it('works without agentsMd', async () => {
    const { defaultSystemPrompt } = await import('../src/config.js')
    const prompt = defaultSystemPrompt()
    expect(prompt).toContain('Mortis')
    expect(prompt).not.toContain('<!-- From:')
  })
})
