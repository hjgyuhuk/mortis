/**
 * OS-level sandbox for shell commands.
 *
 * Path checks can never constrain arbitrary shell — the kernel must. Rules
 * are generated from the FilesystemPolicy:
 *
 * - macOS: `sandbox-exec` (Seatbelt). A global `file-write*` deny with
 *   subpath allows for each writable root (verified: specific allows
 *   override the global deny; paths must be canonical because /tmp is
 *   /private/tmp). Denied roots get `file-read*` denies.
 * - Linux: bubblewrap. Read-only root bind, writable roots bind-mounted rw,
 *   denied roots masked with an empty tmpfs.
 *
 * When no sandbox is available (or it is disabled), callers must report
 * honestly that bash is unsandboxed rather than pretending otherwise.
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { FilesystemPolicy } from './fs-policy.js'

export interface SandboxRunner {
  /** Wrap a shell command into a sandboxed exec argv. */
  wrap(command: string): { file: string; args: string[] }
}

/** Quote a path inside a Seatbelt profile string literal. */
function seatbeltString(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The macOS Seatbelt profile derived from the policy. */
export function seatbeltProfile(policy: FilesystemPolicy): string {
  const { writable, denied } = policy.zones()
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
  ]
  for (const root of writable) {
    lines.push(`(allow file-write* (subpath "${seatbeltString(root)}"))`)
  }
  for (const root of denied) {
    lines.push(`(deny file-read* (subpath "${seatbeltString(root)}"))`)
  }
  return lines.join('\n')
}

/** The Linux bubblewrap argv for a command, derived from the policy. */
export function bwrapArgv(policy: FilesystemPolicy, command: string): string[] {
  const { writable, denied } = policy.zones()
  const args = ['--ro-bind', '/', '/']
  for (const root of writable) {
    args.push('--bind', root, root)
  }
  // Mask denied roots after the writable binds so a deny inside a writable
  // root still hides the real contents.
  for (const root of denied) {
    args.push('--tmpfs', root)
  }
  args.push('--dev', '/dev', '--proc', '/proc', '/bin/sh', '-c', command)
  return args
}

function commandExists(file: string): boolean {
  const result = spawnSync(file, ['--version'], { stdio: 'ignore' })
  return result.error === undefined && typeof result.status === 'number'
}

/**
 * Build a sandbox runner for this platform, or null when unavailable or
 * disabled. Detection happens once per call; callers cache the result.
 */
export function createSandbox(policy: FilesystemPolicy, enabled = true): SandboxRunner | null {
  if (!enabled) return null
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) return null
    const profile = seatbeltProfile(policy)
    return {
      wrap: (command: string) => ({
        file: '/usr/bin/sandbox-exec',
        args: ['-p', profile, '/bin/sh', '-c', command],
      }),
    }
  }
  if (process.platform === 'linux') {
    if (!commandExists('bwrap')) return null
    return {
      wrap: (command: string) => ({ file: 'bwrap', args: bwrapArgv(policy, command) }),
    }
  }
  return null
}
