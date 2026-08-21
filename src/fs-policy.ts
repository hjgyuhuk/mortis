/**
 * Filesystem permission policy: five zones with explicit precedence.
 *
 *   1. custom    user rules (config.json `filesystem.rules` / CLI flags):
 *                absolute directories with r | rw | deny. Longest prefix
 *                wins; a custom rule overrides every built-in zone.
 *   2. secrets   ~/.ssh and ~/.mortis — deny (overridable via custom rules)
 *   3. workspace git root of the working directory — rw
 *   4. scratch   /tmp by default — rw
 *   5. outside   everything else — read-only
 *
 * read/write/edit are strictly enforced. bash cannot be constrained by path
 * rules (no sandbox); only its working directory is checked against deny
 * zones.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export type Access = 'r' | 'rw' | 'deny'
export type Zone = 'custom' | 'workspace' | 'scratch' | 'outside' | 'secrets'
export type Intent = 'read' | 'write'

/** A custom rule: everything under `path` gets `access`. `~` expands. */
export interface FsRule {
  path: string
  access: Access
}

export interface FilesystemPolicyOptions {
  /** Root of the workspace (rw zone). */
  workspaceRoot: string
  /** Scratch directory (rw zone); default /tmp. */
  scratchRoot?: string
  /** Custom rules, highest precedence; longest prefix wins. */
  rules?: readonly FsRule[]
  /** Built-in deny prefixes; defaults to ~/.ssh and ~/.mortis. Pass [] to disable. */
  builtinSecrets?: readonly string[]
}

export interface PolicyDecision {
  allowed: boolean
  zone: Zone
  /** The matched custom rule's access, when zone is custom. */
  access?: Access
  /** Human-readable denial for the model, set when not allowed. */
  reason?: string
}

const DEFAULT_SCRATCH = '/tmp'

/** Expand a leading ~ to the home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Lexical absolute path (~ expanded, resolved against cwd). */
function lexical(path: string): string {
  return resolve(expandHome(path))
}

/**
 * Canonical path, resolving symlinks even when the target does not exist
 * yet: realpath the deepest existing ancestor, then expand symlink
 * components of the remaining tail (covers dangling links on write).
 */
function canonical(path: string): string {
  const absolute = lexical(path)
  let existing = absolute
  const missing: string[] = []
  while (true) {
    try {
      existing = realpathSync(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return absolute
      missing.unshift(basename(existing))
      existing = parent
    }
  }
  let current = existing
  for (const segment of missing) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        current = resolve(dirname(current), readlinkSync(current))
      }
    } catch {
      // Nothing exists at this component; later segments keep appending.
    }
  }
  return current
}

/** True when target is root itself or inside root (directory-prefix match). */
function isUnder(target: string, root: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return target.startsWith(prefix)
}

/** Validate raw rule objects (e.g. from JSON) into FsRule; throws with context. */
export function parseRules(raw: unknown): FsRule[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('filesystem.rules must be an array')
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`invalid filesystem rule: ${JSON.stringify(entry)}`)
    }
    const { path, access } = entry as { path?: unknown; access?: unknown }
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`invalid filesystem rule path: ${JSON.stringify(entry)}`)
    }
    if (access !== 'r' && access !== 'rw' && access !== 'deny') {
      throw new Error(`invalid filesystem rule access "${String(access)}" for ${path}`)
    }
    return { path, access }
  })
}

/** Merge config and CLI rules: same normalized path, CLI wins. */
export function mergeRules(configRules: readonly FsRule[], cliRules: readonly FsRule[]): FsRule[] {
  const merged = new Map<string, FsRule>()
  for (const rule of [...configRules, ...cliRules]) {
    const path = lexical(rule.path)
    merged.set(path, { path, access: rule.access })
  }
  return [...merged.values()]
}

export class FilesystemPolicy {
  private readonly workspaceRoot: string
  private readonly scratchRoot: string
  private readonly secrets: string[]
  /** Longest prefix first. */
  private readonly rules: readonly { path: string; access: Access }[]

  constructor(options: FilesystemPolicyOptions) {
    this.workspaceRoot = canonical(options.workspaceRoot)
    this.scratchRoot = canonical(options.scratchRoot ?? DEFAULT_SCRATCH)
    this.secrets = (options.builtinSecrets ?? [join(homedir(), '.ssh'), join(homedir(), '.mortis')]).map(canonical)
    this.rules = parseRules(options.rules)
      .map((rule) => ({ path: canonical(rule.path), access: rule.access }))
      .sort((a, b) => b.path.length - a.path.length)
  }

  /** Which zone does a path fall into? */
  classify(path: string): Zone {
    return this.classifyCanonical(canonical(path))
  }

  /**
   * Zone summary for sandbox generation: writable roots (workspace, scratch,
   * custom rw) and denied roots (secrets, custom deny), deduplicated.
   */
  zones(): { writable: readonly string[]; denied: readonly string[] } {
    const writable = new Set<string>([this.workspaceRoot, this.scratchRoot])
    const denied = new Set<string>(this.secrets)
    for (const rule of this.rules) {
      if (rule.access === 'rw') writable.add(rule.path)
      else if (rule.access === 'deny') denied.add(rule.path)
    }
    return { writable: [...writable], denied: [...denied] }
  }

  /** Decide whether an intent on a path is allowed. */
  check(path: string, intent: Intent): PolicyDecision {
    const target = canonical(path)
    const rule = this.matchRule(target)
    if (rule) {
      const allowed = rule.access === 'rw' || (rule.access === 'r' && intent === 'read')
      return {
        allowed,
        zone: 'custom',
        access: rule.access,
        reason: allowed ? undefined : this.denial(path, intent, 'custom', rule.access),
      }
    }

    const zone = this.classifyCanonical(target)
    const access: Access = zone === 'secrets' ? 'deny' : zone === 'outside' ? 'r' : 'rw'
    const allowed = access === 'rw' || (access === 'r' && intent === 'read')
    return { allowed, zone, access, reason: allowed ? undefined : this.denial(path, intent, zone, access) }
  }

  /** One-paragraph description of the zones, for the system prompt. */
  describe(): string {
    const lines = [
      'Filesystem policy:',
      `- workspace ${this.workspaceRoot}: read/write`,
      `- scratch ${this.scratchRoot}: read/write`,
      `- denied: ${this.secrets.join(', ')} (never read or write)`,
      '- everything else: read-only',
    ]
    if (this.rules.length > 0) {
      const rules = this.rules.map((rule) => `${rule.path} (${rule.access})`).join(', ')
      lines.push(`- custom rules (highest precedence): ${rules}`)
    }
    lines.push(
      'Write only inside workspace, scratch, and custom rw directories.',
      'Shell commands are not path-restricted: keep the working directory out of denied areas.',
    )
    return lines.join('\n')
  }

  private matchRule(target: string): { path: string; access: Access } | undefined {
    return this.rules.find((rule) => isUnder(target, rule.path))
  }

  /** Zone of an already-canonical path — no repeated realpath walk. */
  private classifyCanonical(target: string): Zone {
    if (this.matchRule(target)) return 'custom'
    if (this.secrets.some((secret) => isUnder(target, secret))) return 'secrets'
    if (isUnder(target, this.workspaceRoot)) return 'workspace'
    if (isUnder(target, this.scratchRoot)) return 'scratch'
    return 'outside'
  }

  private denial(path: string, intent: Intent, zone: Zone, access: Access): string {
    const writable = `writable: workspace ${this.workspaceRoot}, scratch ${this.scratchRoot}`
    if (zone === 'custom') {
      return access === 'deny'
        ? `permission denied: ${path} is denied by a custom rule (${intent} intent); ${writable}`
        : `permission denied: ${path} is read-only under a custom rule (${intent} intent); ${writable}`
    }
    if (zone === 'secrets') {
      return `permission denied: ${path} is in the secrets zone; ${writable}`
    }
    return `permission denied: ${path} is outside the workspace (read-only, ${intent} intent); ${writable}`
  }
}

/** A permissive policy: everything read-write, no built-in secrets. */
export function openPolicy(): FilesystemPolicy {
  return new FilesystemPolicy({ workspaceRoot: '/', builtinSecrets: [] })
}
