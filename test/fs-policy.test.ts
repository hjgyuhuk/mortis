import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FilesystemPolicy,
  mergeRules,
  openPolicy,
  parseRules,
  type FsRule,
} from '../src/fs-policy.js'

const originalHome = process.env.HOME
let home: string
let root: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mortis-fs-home-'))
  root = mkdtempSync(join(tmpdir(), 'mortis-fs-'))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  process.env.HOME = originalHome
})

function zones() {
  const workspace = join(root, 'ws')
  const scratch = join(root, 'scratch')
  const outside = join(root, 'outside')
  const secrets = join(root, 'secrets')
  for (const dir of [workspace, scratch, outside, secrets]) mkdirSync(dir, { recursive: true })
  return { workspace, scratch, outside, secrets }
}

describe('FilesystemPolicy zones', () => {
  it('classifies workspace, scratch, outside, and built-in secrets', () => {
    const { workspace, scratch, outside } = zones()
    const policy = new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: scratch })

    expect(policy.classify(join(workspace, 'src/a.ts'))).toBe('workspace')
    expect(policy.classify(join(scratch, 'draft.md'))).toBe('scratch')
    expect(policy.classify(join(outside, 'file.txt'))).toBe('outside')
    expect(policy.classify(join(home, '.ssh', 'id_rsa'))).toBe('secrets')
    expect(policy.classify(join(home, '.mortis', 'config.json'))).toBe('secrets')
  })

  it('default scratch is /tmp', () => {
    const { workspace } = zones()
    const policy = new FilesystemPolicy({ workspaceRoot: workspace })
    expect(policy.classify('/tmp/mortis-x/y.txt')).toBe('scratch')
  })

  it('read allowed everywhere except deny zones; write only in rw zones', () => {
    const { workspace, scratch, outside } = zones()
    const policy = new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: scratch })

    expect(policy.check(join(workspace, 'f'), 'write').allowed).toBe(true)
    expect(policy.check(join(scratch, 'f'), 'write').allowed).toBe(true)
    expect(policy.check(join(outside, 'f'), 'read').allowed).toBe(true)
    expect(policy.check(join(outside, 'f'), 'write').allowed).toBe(false)
    expect(policy.check(join(home, '.ssh', 'k'), 'read').allowed).toBe(false)
    expect(policy.check(join(home, '.ssh', 'k'), 'write').allowed).toBe(false)
  })

  it('denials carry a readable reason for the model', () => {
    const { workspace, outside } = zones()
    const policy = new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: join(root, 'scratch') })

    const write = policy.check(join(outside, 'f'), 'write')
    expect(write.reason).toContain('permission denied')
    expect(write.reason).toContain('read-only')
    expect(write.reason).toContain(workspace)

    const secret = policy.check(join(home, '.mortis', 'config.json'), 'read')
    expect(secret.reason).toContain('secrets')
  })
})

describe('custom rules (highest precedence)', () => {
  it('denies a directory inside the workspace', () => {
    const { workspace } = zones()
    const locked = join(workspace, 'secrets-env')
    mkdirSync(locked)
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [{ path: locked, access: 'deny' }],
    })
    expect(policy.check(join(locked, 'env'), 'read').allowed).toBe(false)
    expect(policy.classify(join(locked, 'x'))).toBe('custom')
    // Sibling paths stay writable workspace.
    expect(policy.check(join(workspace, 'ok.ts'), 'write').allowed).toBe(true)
  })

  it('grants rw outside the workspace', () => {
    const { workspace, outside } = zones()
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [{ path: outside, access: 'rw' }],
    })
    expect(policy.check(join(outside, 'f'), 'write').allowed).toBe(true)
    expect(policy.classify(join(outside, 'f'))).toBe('custom')
  })

  it('r rules allow reads and deny writes', () => {
    const { workspace, outside } = zones()
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [{ path: outside, access: 'r' }],
    })
    expect(policy.check(join(outside, 'f'), 'read').allowed).toBe(true)
    expect(policy.check(join(outside, 'f'), 'write').allowed).toBe(false)
  })

  it('overrides built-in secrets when explicitly granted', () => {
    const { workspace } = zones()
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [{ path: join(home, '.ssh'), access: 'rw' }],
    })
    expect(policy.check(join(home, '.ssh', 'key'), 'write').allowed).toBe(true)
  })

  it('longest prefix wins among custom rules', () => {
    const { workspace } = zones()
    const base = join(root, 'data')
    const nested = join(base, 'nested')
    mkdirSync(nested, { recursive: true })
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [
        { path: base, access: 'r' },
        { path: nested, access: 'rw' },
      ],
    })
    expect(policy.check(join(nested, 'f'), 'write').allowed).toBe(true)
    expect(policy.check(join(base, 'f'), 'write').allowed).toBe(false)
  })
})

describe('path canonicalization', () => {
  it('resolves symlinks pointing out of the workspace', () => {
    const { workspace, outside } = zones()
    const target = join(outside, 'real.txt')
    writeFileSync(target, 'x')
    const link = join(workspace, 'escape.txt')
    symlinkSync(target, link)

    const policy = new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: join(root, 'scratch') })
    expect(policy.check(link, 'write').allowed).toBe(false)
    expect(policy.classify(link)).toBe('outside')
  })

  it('handles write targets that do not exist yet', () => {
    const { workspace } = zones()
    const policy = new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: join(root, 'scratch') })
    expect(policy.check(join(workspace, 'new', 'deep', 'file.txt'), 'write').allowed).toBe(true)
  })

  it('expands ~ in rule paths', () => {
    const { workspace } = zones()
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [{ path: '~/.private', access: 'deny' }],
    })
    expect(policy.check(join(home, '.private', 'k'), 'read').allowed).toBe(false)
  })
})

describe('mergeRules / parseRules / openPolicy', () => {
  it('CLI rules override config rules on the same path', () => {
    const merged = mergeRules(
      [{ path: '/a', access: 'r' }, { path: '/b', access: 'rw' }],
      [{ path: '/a', access: 'deny' }],
    )
    // Map keeps the original insertion position when overwriting.
    expect(merged).toEqual([
      { path: '/a', access: 'deny' },
      { path: '/b', access: 'rw' },
    ])
  })

  it('parseRules validates shape and access values', () => {
    expect(parseRules(undefined)).toEqual([])
    expect(parseRules([{ path: '/x', access: 'rw' }])).toEqual([{ path: '/x', access: 'rw' }])
    expect(() => parseRules([{ path: '/x', access: 'bogus' }])).toThrow('invalid filesystem rule access')
    expect(() => parseRules([{ access: 'r' }])).toThrow('invalid filesystem rule path')
    expect(() => parseRules('nope')).toThrow('must be an array')
  })

  it('openPolicy allows everything including default secrets', () => {
    const policy = openPolicy()
    expect(policy.check('/etc/passwd', 'write').allowed).toBe(true)
    expect(policy.check(join(home, '.mortis', 'config.json'), 'read').allowed).toBe(true)
  })

  it('describe lists zones and custom rules', () => {
    const { workspace } = zones()
    const policy = new FilesystemPolicy({
      workspaceRoot: workspace,
      rules: [{ path: join(root, 'data'), access: 'rw' }],
    })
    const text = policy.describe()
    expect(text).toContain(workspace)
    expect(text).toContain('read-only')
    expect(text).toContain('custom rules')
    expect(text).toContain(join(root, 'data'))
  })
})
