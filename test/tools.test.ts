import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bashTool as makeBash,
  editTool as makeEdit,
  readTool as makeRead,
  writeTool as makeWrite,
  grepTool as makeGrep,
  globTool as makeGlob,
  createBuiltinTools,
  globToRegExp,
  type ApprovalRequest,
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
  it('returns file contents as numbered lines', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'hello')
    expect(await readTool.execute({ path })).toBe('1\thello')
  })

  it('pages from a 1-based line offset', async () => {
    const path = join(tmp, 'lines.txt')
    writeFileSync(path, 'one\ntwo\nthree')
    expect(await readTool.execute({ path, offset: 2 })).toBe('2\ttwo\n3\tthree')
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
    expect(await readTool.execute({ path })).toBe('1\ttwo')
  })
})

describe('edit tool', () => {
  it('replaces a unique match', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'foo bar baz')
    expect(await editTool.execute({ path, old_string: 'bar', new_string: 'qux' })).toContain('edited')
    expect(await readTool.execute({ path })).toBe('1\tfoo qux baz')
  })

  it('errors when old_string is missing', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'foo')
    expect(await editTool.execute({ path, old_string: 'nope', new_string: 'x' })).toContain('not found')
  })

  it('writes replacement patterns like $& literally', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'price')
    await editTool.execute({ path, old_string: 'price', new_string: '$& $` $$' })
    expect(await readTool.execute({ path })).toBe('1\t$& $` $$')
  })

  it('errors when old_string matches multiple times', async () => {
    const path = join(tmp, 'a.txt')
    writeFileSync(path, 'a a a')
    const result = await editTool.execute({ path, old_string: 'a', new_string: 'b' })
    expect(result).toContain('matches 3 times')
    expect(await readTool.execute({ path })).toBe('1\ta a a')
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

  it('truncates oversized output', async () => {
    const result = await bashTool.execute({ command: 'yes x | head -c 200000' })
    expect(result.length).toBeLessThan(200000)
    expect(result).toContain('truncated')
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

describe('grep tool', () => {
  const grepTool = makeGrep(openPolicy())

  it('returns path:line matches for a regex', async () => {
    writeFileSync(join(tmp, 'a.ts'), 'const alpha = 1\nconst beta = 2\n')
    const result = await grepTool.execute({ pattern: 'alpha', path: tmp })
    expect(result).toContain(`${join(tmp, 'a.ts')}:1:`)
    expect(result).toContain('const alpha = 1')
  })

  it('filters by glob and caps matches', async () => {
    writeFileSync(join(tmp, 'a.ts'), 'hit\n')
    writeFileSync(join(tmp, 'b.md'), 'hit\n')
    const filtered = await grepTool.execute({ pattern: 'hit', path: tmp, glob: '*.md' })
    expect(filtered).toContain('b.md')
    expect(filtered).not.toContain('a.ts')

    writeFileSync(join(tmp, 'c.txt'), 'hit\nhit\nhit\n')
    const capped = await grepTool.execute({ pattern: 'hit', path: tmp, head_limit: 2 })
    expect(capped).toContain('capped at 2')
  })

  it('reports invalid patterns and denied roots', async () => {
    expect(await grepTool.execute({ pattern: '(' })).toContain('invalid pattern')
    const locked = new FilesystemPolicy({ workspaceRoot: join(tmp, 'ws'), rules: [{ path: tmp, access: 'deny' }] })
    const denied = await makeGrep(locked).execute({ pattern: 'x', path: tmp })
    expect(denied).toContain('permission denied')
  })
})

describe('glob tool', () => {
  const globTool = makeGlob(openPolicy())

  it('matches nested paths and bare suffixes', async () => {
    mkdirSync(join(tmp, 'sub'), { recursive: true })
    writeFileSync(join(tmp, 'a.ts'), '')
    writeFileSync(join(tmp, 'sub', 'b.ts'), '')
    writeFileSync(join(tmp, 'c.md'), '')

    const ts = await globTool.execute({ pattern: '*.ts', path: tmp })
    expect(ts).toContain('a.ts')
    expect(ts).toContain(join('sub', 'b.ts'))
    expect(ts).not.toContain('c.md')

    const nested = await globTool.execute({ pattern: 'sub/*.ts', path: tmp })
    expect(nested).toContain(join('sub', 'b.ts'))
    expect(nested).not.toContain('a.ts')
  })

  it('translates glob metacharacters', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false)
    expect(globToRegExp('**/*.ts').test('a/b.ts')).toBe(true)
    expect(globToRegExp('a?c').test('abc')).toBe(true)
    expect(globToRegExp('a.c').test('abc')).toBe(false)
  })
})

describe('approval gate', () => {
  it('blocks write/edit/bash when the gate rejects', async () => {
    const gate = async (): Promise<boolean> => false
    const write = makeWrite(openPolicy(), gate)
    const edit = makeEdit(openPolicy(), gate)
    const bash = makeBash(openPolicy(), null, gate)

    expect(await write.execute({ path: join(tmp, 'a.txt'), content: 'x' })).toContain('the user rejected writing')
    expect(await edit.execute({ path: join(tmp, 'a.txt'), old_string: 'a', new_string: 'b' })).toContain('the user rejected editing')
    expect(await bash.execute({ command: 'echo hi' })).toContain('the user rejected running')
  })

  it('passes request details and lets approvals through', async () => {
    const requests: ApprovalRequest[] = []
    const gate = async (request: ApprovalRequest): Promise<boolean> => {
      requests.push(request)
      return true
    }
    const write = makeWrite(openPolicy(), gate)
    const path = join(tmp, 'ok.txt')

    expect((await write.execute({ path, content: 'x' })).startsWith('wrote')).toBe(true)
    expect(requests[0]).toMatchObject({ tool: 'write', title: `write ${path}` })
    expect(await readTool.execute({ path })).toBe('1\tx')
  })
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
    expect(await read.execute({ path: outsideFile })).toBe('1\tpublic data')

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

  it('createBuiltinTools binds all six tools to the policy', () => {
    const { policy } = restrictedPolicy()
    const tools = createBuiltinTools(policy)
    expect(tools.map((tool) => tool.name)).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'glob'])
  })
})

async function readFileAgain(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
