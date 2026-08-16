import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bashTool, editTool, readTool, writeTool } from '../src/tools/index.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mortis-tools-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('read tool', () => {
  it('returns file contents', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'hello')
    expect(await readTool.execute({ path })).toBe('hello')
  })

  it('truncates files beyond 64 KiB', async () => {
    const path = join(tmp, 'big.txt')
    writeFileSync(path, 'a'.repeat(70_000))
    const result = await readTool.execute({ path })
    expect(result.length).toBeLessThan(70_000)
    expect(result).toContain('truncated')
  })

  it('returns an error message for missing files', async () => {
    const result = await readTool.execute({ path: join(tmp, 'nope.txt') })
    expect(result).toContain('error reading')
  })
})

describe('write tool', () => {
  it('writes and overwrites content', async () => {
    const path = join(tmp, 'a.txt')
    expect(await writeTool.execute({ path, content: 'one' })).toContain('wrote')
    expect(await writeTool.execute({ path, content: 'two' })).toContain('wrote')
    expect(await readTool.execute({ path })).toBe('two')
  })
})

describe('edit tool', () => {
  it('replaces a unique match', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'foo bar baz')
    expect(await editTool.execute({ path, old_string: 'bar', new_string: 'qux' })).toContain('edited')
    expect(await readTool.execute({ path })).toBe('foo qux baz')
  })

  it('errors when old_string is missing', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'foo')
    expect(await editTool.execute({ path, old_string: 'nope', new_string: 'x' })).toContain('not found')
  })

  it('errors when old_string matches multiple times', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'a a a')
    const result = await editTool.execute({ path, old_string: 'a', new_string: 'b' })
    expect(result).toContain('matches 3 times')
    expect(await readTool.execute({ path })).toBe('a a a')
  })
})

describe('bash tool', () => {
  it('runs a command and returns its output', async () => {
    const result = await bashTool.execute({ command: 'echo hi' })
    expect(result.trim()).toBe('hi')
  })

  it('includes stderr in the result', async () => {
    const result = await bashTool.execute({ command: 'echo out; echo err 1>&2' })
    expect(result).toContain('out')
    expect(result).toContain('err')
  })

  it('reports non-zero exit codes with output', async () => {
    const result = await bashTool.execute({ command: 'echo boom 1>&2; exit 3' })
    expect(result).toContain('command failed')
    expect(result).toContain('boom')
  })

  it('times out long-running commands', async () => {
    const start = Date.now()
    const result = await bashTool.execute({ command: 'sleep 10', timeout: 1 })
    expect(result).toContain('command failed')
    expect(Date.now() - start).toBeLessThan(5000)
  }, 10_000)
})
