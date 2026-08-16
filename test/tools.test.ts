import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bashTool as makeBash,
  editTool as makeEdit,
  readTool as makeRead,
  writeTool as makeWrite,
  createBuiltinTools,
} from '../src/tools/index.js'
import { FilesystemPolicy, openPolicy, type FsRule } from '../src/fs-policy.js'

const readTool = makeRead(openPolicy())
const writeTool = makeWrite(openPolicy())
const editTool = makeEdit(openPolicy())
const bashTool = makeBash(openPolicy())

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

  it('kills the command when the context signal aborts', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const pending = bashTool.execute(
      { command: 'sleep 30', timeout: 60 },
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 50)

    const result = await pending
    expect(result).toContain('command failed')
    expect(Date.now() - start).toBeLessThan(5000)
  }, 10_000)
})

describe('filesystem policy enforcement', () => {
  function restrictedPolicy(rules: FsRule[] = []) {
    const workspace = join(tmp, 'ws')
    const scratch = join(tmp, 'scratch')
    const outside = join(tmp, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(scratch, { recursive: true })
    mkdirSync(outside, { recursive: true })
    return {
      policy: new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: scratch, rules }),
      workspace,
      scratch,
      outside,
    }
  }

  it('write succeeds inside workspace and scratch, denied outside', async () => {
    const { policy, workspace, scratch, outside } = restrictedPolicy()
    const write = makeWrite(policy)
    expect((await write.execute({ path: join(workspace, 'a.txt'), content: 'x' })).startsWith('wrote')).toBe(true)
    expect((await write.execute({ path: join(scratch, 'b.txt'), content: 'x' })).startsWith('wrote')).toBe(true)
    const denied = await write.execute({ path: join(outside, 'c.txt'), content: 'x' })
    expect(denied).toContain('permission denied')
    expect(denied).toContain('read-only')
  })

  it('read works outside the workspace but is denied in secrets', async () => {
    const { policy, outside } = restrictedPolicy()
    const read = makeRead(policy)
    const outsideFile = join(outside, 'note.txt')
    writeFileSync(outsideFile, 'public data')
    expect(await read.execute({ path: outsideFile })).toBe('public data')

    const secretsDir = join(tmp, 'secrets')
    mkdirSync(secretsDir)
    const locked = new FilesystemPolicy({
      workspaceRoot: join(tmp, 'ws'),
      rules: [{ path: secretsDir, access: 'deny' }],
    })
    const denied = await makeRead(locked).execute({ path: join(secretsDir, 'key.pem') })
    expect(denied).toContain('permission denied')
  })

  it('custom rw rules grant writes outside the workspace', async () => {
    const granted = join(tmp, 'granted')
    mkdirSync(granted)
    const { policy, outside } = restrictedPolicy([{ path: granted, access: 'rw' }])
    const write = makeWrite(policy)
    expect((await write.execute({ path: join(granted, 'ok.txt'), content: 'x' })).startsWith('wrote')).toBe(true)
    expect(await write.execute({ path: join(outside, 'no.txt'), content: 'x' })).toContain('permission denied')
  })

  it('edit is denied outside writable zones', async () => {
    const { policy, outside } = restrictedPolicy()
    const outsideFile = join(outside, 'ro.txt')
    writeFileSync(outsideFile, 'content')
    const result = await makeEdit(policy).execute({ path: outsideFile, old_string: 'content', new_string: 'x' })
    expect(result).toContain('permission denied')
    expect(await readFileAgain(outsideFile)).toBe('content')
  })

  it('bash rejects a working directory inside a denied zone', async () => {
    const secretsDir = join(tmp, 'secrets')
    mkdirSync(secretsDir)
    const { policy } = restrictedPolicy([{ path: secretsDir, access: 'deny' }])
    const bash = makeBash(policy)
    const denied = await bash.execute({ command: 'ls', cwd: secretsDir })
    expect(denied).toContain('permission denied')
    expect((await bash.execute({ command: 'echo ok' })).trim()).toBe('ok')
  })

  it('createBuiltinTools binds all four tools to the policy', () => {
    const { policy } = restrictedPolicy()
    const tools = createBuiltinTools(policy)
    expect(tools.map((tool) => tool.name)).toEqual(['read', 'write', 'edit', 'bash'])
  })
})

async function readFileAgain(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
