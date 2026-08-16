import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemPolicy } from '../src/fs-policy.js'
import { bwrapArgv, createSandbox, seatbeltProfile } from '../src/sandbox.js'
import { bashTool as makeBash } from '../src/tools/index.js'

let root: string

beforeEach(() => {
  // Canonicalize: on macOS tmpdir() (/var/folders/...) is a symlink to
  // /private/var/folders/... and both profile and argv use canonical paths.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mortis-sandbox-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makePolicy(rules: { path: string; access: 'r' | 'rw' | 'deny' }[] = []) {
  const workspace = join(root, 'ws')
  const scratch = join(root, 'scratch')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(scratch, { recursive: true })
  return new FilesystemPolicy({ workspaceRoot: workspace, scratchRoot: scratch, rules })
}

describe('profile and argv generation', () => {
  it('seatbelt profile denies all writes, allows writable roots, denies reads on denied roots', () => {
    const granted = join(root, 'granted')
    const locked = join(root, 'locked')
    mkdirSync(granted)
    mkdirSync(locked)
    const policy = makePolicy([
      { path: granted, access: 'rw' },
      { path: locked, access: 'deny' },
    ])
    const profile = seatbeltProfile(policy)
    expect(profile).toContain('(version 1)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain(`(allow file-write* (subpath "${join(root, 'ws')}"))`)
    expect(profile).toContain(`(allow file-write* (subpath "${join(root, 'scratch')}"))`)
    expect(profile).toContain(`(allow file-write* (subpath "${granted}"))`)
    expect(profile).toContain(`(deny file-read* (subpath "${locked}"))`)
  })

  it('bwrap argv binds writable roots read-write and masks denied roots', () => {
    const granted = join(root, 'granted')
    const locked = join(root, 'locked')
    mkdirSync(granted)
    mkdirSync(locked)
    const policy = makePolicy([
      { path: granted, access: 'rw' },
      { path: locked, access: 'deny' },
    ])
    const argv = bwrapArgv(policy, 'echo hi')
    expect(argv.slice(0, 3)).toEqual(['--ro-bind', '/', '/'])
    expect(argv).toContain('--bind')
    expect(argv.join(' ')).toContain(`--bind ${granted} ${granted}`)
    // Denied tmpfs comes after writable binds so deny-in-writable still masks.
    expect(argv.join(' ').indexOf(`--tmpfs ${locked}`)).toBeGreaterThan(argv.join(' ').indexOf(`--bind ${granted}`))
    expect(argv.slice(-3)).toEqual(['/bin/sh', '-c', 'echo hi'])
  })

  it('createSandbox returns null when disabled and a runner on darwin', () => {
    const policy = makePolicy()
    expect(createSandbox(policy, false)).toBeNull()
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      const runner = createSandbox(policy, true)
      expect(runner).not.toBeNull()
      const wrapped = runner!.wrap('echo ok')
      expect(wrapped.file).toBe('/usr/bin/sandbox-exec')
      expect(wrapped.args[0]).toBe('-p')
      expect(wrapped.args.at(-1)).toBe('echo ok')
    }
  })
})

const darwinSandbox =
  process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

describe.skipIf(!darwinSandbox)('seatbelt enforcement (macOS only)', () => {
  it('confines writes to writable zones and blocks reads of denied roots', async () => {
    const denied = join(root, 'denied')
    const writable = join(root, 'scratch')
    mkdirSync(denied)
    writeFileSync(join(denied, 'secret.txt'), 'secret')
    const policy = makePolicy([{ path: denied, access: 'deny' }])
    const sandbox = createSandbox(policy, true)!
    const bash = makeBash(policy, sandbox)

    // Write inside scratch: allowed.
    const inside = await bash.execute({ command: `echo ok > ${writable}/sb.txt` })
    expect(inside).not.toContain('command failed')
    expect(existsSync(join(writable, 'sb.txt'))).toBe(true)

    // Write outside every writable zone: kernel-denied.
    const outside = await bash.execute({ command: `echo bad > ${root}/outside.txt` })
    expect(outside).toContain('command failed')
    expect(existsSync(join(root, 'outside.txt'))).toBe(false)

    // Read a denied root: kernel-denied.
    const secret = await bash.execute({ command: `cat ${denied}/secret.txt` })
    expect(secret).toContain('command failed')

    // Ordinary commands still work.
    expect((await bash.execute({ command: 'echo hello' })).trim()).toBe('hello')
  }, 15_000)
})
