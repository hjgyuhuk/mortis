/**
 * Session persistence: versioned snapshots at the boundary.
 *
 * AgentState is the internal model; SessionSnapshot is the on-disk format.
 * The two are separated so evolving the state never breaks old sessions —
 * hydrate validates the version and shape, and unknown future versions are
 * skipped instead of crashing. Checkpoints are written by an onTransition
 * observer outside the agent core, so a crash loses at most the transition
 * in flight.
 *
 * Each session owns `sessions/<id>.json`; `sessions/index.json` records one
 * entry per session (title, model, last save) and the latest-session pointer.
 * The legacy single-slot `latest.json` stays readable as session id 'latest'.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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

/** One index row per session, updated on every checkpoint. */
export interface SessionIndexEntry {
  id: string
  /** First user message, single line, truncated. */
  title: string
  model: string
  savedAt: string
}

export function sessionsDir(): string {
  return join(homedir(), '.mortis', 'sessions')
}

/** A fresh short session id for a new conversation. */
export function newSessionId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function sessionPath(id: string): string {
  return id === 'latest' ? join(sessionsDir(), 'latest.json') : join(sessionsDir(), `${id}.json`)
}

function indexPath(): string {
  return join(sessionsDir(), 'index.json')
}

interface SessionIndex {
  version: 1
  latestId: string | null
  sessions: SessionIndexEntry[]
}

function readIndex(): SessionIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(), 'utf8')) as SessionIndex
    if (parsed.version === 1 && Array.isArray(parsed.sessions)) return parsed
  } catch {
    // Missing or corrupt index falls back to an empty one.
  }
  return { version: 1, latestId: null, sessions: [] }
}

function writeIndexAtomic(index: SessionIndex): void {
  mkdirSync(sessionsDir(), { recursive: true })
  const temp = indexPath() + '.tmp'
  writeFileSync(temp, JSON.stringify(index, null, 2) + '\n')
  renameSync(temp, indexPath())
}

/** Derive the index title from the first user message. */
function titleOf(snapshot: SessionSnapshot): string {
  const first = snapshot.messages.find((message) => message.role === 'user')
  const text = (first?.content ?? '(empty)').replace(/\s+/g, ' ').trim()
  return text.length > 60 ? text.slice(0, 60) + '…' : text
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

/**
 * Write a checkpoint for one session and upsert its index entry, both
 * atomically. A crash can leave a stale index at worst, never a truncated
 * file.
 */
export function saveSession(snapshot: SessionSnapshot, id: string): string {
  const path = writeSnapshotAtomic(sessionPath(id), snapshot)
  const index = readIndex()
  const entry: SessionIndexEntry = {
    id,
    title: titleOf(snapshot),
    model: snapshot.model,
    savedAt: snapshot.savedAt,
  }
  index.sessions = [entry, ...index.sessions.filter((session) => session.id !== id)]
  index.latestId = id
  writeIndexAtomic(index)
  return path
}

/** Read one session's latest checkpoint; null when missing or invalid. */
export function loadSession(id: string): SessionSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionPath(id), 'utf8'))
    return hydrateState(parsed) === null ? null : (parsed as SessionSnapshot)
  } catch {
    return null
  }
}

/** Index entries, newest save first. */
export function listSessions(): SessionIndexEntry[] {
  return readIndex().sessions
}

/** Id of the most recent session; 'latest' covers the legacy single-slot file. */
export function latestSessionId(): string | null {
  if (existsSync(indexPath())) return readIndex().latestId
  return existsSync(join(sessionsDir(), 'latest.json')) ? 'latest' : null
}

/** Read the most recent session's checkpoint; null when none exists. */
export function latestSession(): SessionSnapshot | null {
  const id = latestSessionId()
  return id ? loadSession(id) : null
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
