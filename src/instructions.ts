/**
 * AGENTS.md discovery and loading.
 *
 * Reads global (`~/.mortis/AGENTS.md`) and project-level instruction files,
 * concatenates them with source annotations, and returns the combined content
 * for injection into the system prompt.
 */

import { readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { configDir } from './config.js'

/** Walk upward from `dir` looking for a `.git` entry; return its parent. */
export function findGitRoot(dir: string): string | null {
  let current = resolve(dir)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Read a file if it exists and is non-empty; return trimmed content or null. */
function readNonEmptyFile(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
  } catch {
    return null
  }
  const content = readFileSync(path, 'utf8').trim()
  return content.length > 0 ? content : null
}

/**
 * Discover and load AGENTS.md files for the given working directory.
 *
 * Discovery order (first non-empty content wins per slot):
 * 1. `~/.mortis/AGENTS.md` (global)
 * 2. `<projectRoot>/AGENTS.md` then subdirectories down to `cwd`
 *
 * Each file is annotated with `<!-- From: path -->`. Returns empty string
 * when no instruction files are found.
 */
export function loadAgentsMd(cwd: string): string {
  const parts: string[] = []

  const collect = (path: string): void => {
    const content = readNonEmptyFile(path)
    if (content) parts.push(`<!-- From: ${path} -->\n${content}`)
  }

  // Global
  collect(join(configDir(), 'AGENTS.md'))

  // Project: projectRoot → cwd
  const projectRoot = findGitRoot(cwd) ?? resolve(cwd)
  const dirs = dirsRootToLeaf(projectRoot, resolve(cwd))
  for (const dir of dirs) {
    collect(join(dir, 'AGENTS.md'))
  }

  return parts.join('\n\n')
}

/** Return directories from projectRoot down to cwd (inclusive). */
function dirsRootToLeaf(root: string, leaf: string): string[] {
  const dirs: string[] = []
  let current = leaf
  while (true) {
    dirs.push(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs.slice().reverse()
}
