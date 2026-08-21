/**
 * Session persistence: versioned snapshots at the boundary.
 *
 * AgentState is the internal model; SessionSnapshot is the on-disk format.
 * The two are separated so evolving the state never breaks old sessions —
 * hydrate validates the version and shape, and unknown future versions are
 * skipped instead of crashing. Checkpoints are written by an onTransition
 * observer outside the agent core, so a crash loses at most the transition
 * in flight.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message } from './types.js'
import type { AgentState } from './agent/state.js'

export const SNAPSHOT_VERSION = 1

export interface SessionSnapshot {
  version: 1
  model: string
  messages: Message[]
  /** ISO timestamp of the last transition included. */
  savedAt: string
}

export function sessionsDir(): string {
  return join(homedir(), '.mortis', 'sessions')
}

function snapshotPath(): string {
  return join(sessionsDir(), 'latest.json')
}

/** Project the internal state onto the persistence format. */
export function serializeState(state: AgentState, model: string): SessionSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    model,
    messages: [...state.messages],
    savedAt: new Date().toISOString(),
  }
}

/**
 * Validate a snapshot and rebuild a state from it. Returns null for anything
 * malformed or from an unknown snapshot version. Resumed sessions never
 * start mid-run: status is always reset to idle (run_interrupted semantics
 * were applied before the checkpoint was written).
 */
export function hydrateState(snapshot: unknown): AgentState | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const candidate = snapshot as Partial<SessionSnapshot>
  if (candidate.version !== SNAPSHOT_VERSION) return null
  if (typeof candidate.model !== 'string' || !Array.isArray(candidate.messages)) return null
  for (const message of candidate.messages) {
    const role = (message as { role?: unknown } | null)?.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null
  }
  return { messages: candidate.messages as Message[], status: 'idle' }
}

/** Overwrite the latest checkpoint on disk atomically; returns the path written. */
export function saveSession(snapshot: SessionSnapshot): string {
  return writeSnapshotAtomic(snapshotPath(), snapshot)
}

/** Path of the pre-compact forensic archive (one overwrite per compaction). */
export function preCompactArchivePath(): string {
  return join(sessionsDir(), 'latest.pre-compact.json')
}

/**
 * Archive the messages a compaction is about to replace. Compaction is
 * irreversible in State by design; this file is the only recovery artifact.
 * One file, overwritten each time — no revision store.
 */
export function savePreCompactArchive(messages: readonly Message[], model: string): string {
  const snapshot: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    model,
    messages: [...messages],
    savedAt: new Date().toISOString(),
  }
  return writeSnapshotAtomic(preCompactArchivePath(), snapshot)
}

function writeSnapshotAtomic(path: string, snapshot: SessionSnapshot): string {
  mkdirSync(sessionsDir(), { recursive: true })
  // Write to a sibling temp file, then rename: a crash mid-write can never
  // leave a truncated JSON file behind.
  const temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n')
  renameSync(temp, path)
  return path
}

/** Read the latest checkpoint; null when missing or invalid. */
export function latestSession(): SessionSnapshot | null {
  const path = snapshotPath()
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (hydrateState(parsed) === null) return null
    return parsed as SessionSnapshot
  } catch {
    return null
  }
}
