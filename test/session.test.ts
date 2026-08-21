import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hydrateState,
  latestSession,
  savePreCompactArchive,
  saveSession,
  serializeState,
  sessionsDir,
  type SessionSnapshot,
} from '../src/session.js'
import { initialState, reduce } from '../src/agent/state.js'

const originalHome = process.env.HOME
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mortis-session-home-'))
  process.env.HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = originalHome
})

function sampleState() {
  let state = initialState('sys')
  state = reduce(state, { type: 'user_message', content: 'hi' })
  state = reduce(state, { type: 'assistant_message', content: 'answer' })
  return state
}

describe('serializeState / hydrateState', () => {
  it('round-trips messages and resets status to idle', () => {
    let running = reduce(sampleState(), { type: 'user_message', content: 'again' })
    expect(running.status).toBe('running')
    const snapshot = serializeState(running, 'm')
    const state = hydrateState(snapshot)
    expect(state?.status).toBe('idle')
    expect(state?.messages).toEqual(running.messages)
    expect(snapshot.version).toBe(1)
    expect(typeof snapshot.savedAt).toBe('string')
  })

  it('rejects unknown snapshot versions', () => {
    expect(hydrateState({ version: 2, model: 'm', messages: [], savedAt: 'x' })).toBeNull()
    expect(hydrateState({ version: '1', model: 'm', messages: [], savedAt: 'x' })).toBeNull()
  })

  it('rejects malformed snapshots', () => {
    expect(hydrateState(null)).toBeNull()
    expect(hydrateState('nope')).toBeNull()
    expect(hydrateState({ version: 1, model: 'm', savedAt: 'x' })).toBeNull()
    expect(
      hydrateState({ version: 1, model: 'm', messages: [{ role: 'bogus' }], savedAt: 'x' }),
    ).toBeNull()
  })
})

describe('saveSession / latestSession', () => {
  it('saves and reads back the latest checkpoint', () => {
    const snapshot = serializeState(sampleState(), 'm')
    const path = saveSession(snapshot)
    expect(path).toBe(join(sessionsDir(), 'latest.json'))

    const loaded = latestSession()
    expect(loaded?.model).toBe('m')
    expect(loaded?.messages).toEqual(sampleState().messages)
    expect(hydrateState(loaded as SessionSnapshot)?.messages).toEqual(sampleState().messages)
  })

  it('leaves no temp file behind after an atomic save', () => {
    saveSession(serializeState(sampleState(), 'm'))
    expect(existsSync(join(sessionsDir(), 'latest.json.tmp'))).toBe(false)
    expect(latestSession()).not.toBeNull()
  })

  it('archives pre-compact messages to a separate forensic file', () => {
    const messages = sampleState().messages
    savePreCompactArchive(messages, 'm')
    expect(existsSync(join(sessionsDir(), 'latest.json'))).toBe(false)
    const parsed: unknown = JSON.parse(readFileSync(join(sessionsDir(), 'latest.pre-compact.json'), 'utf8'))
    expect(parsed).toMatchObject({ version: 1, model: 'm', messages })
  })

  it('returns null when no checkpoint exists', () => {
    expect(latestSession()).toBeNull()
  })

  it('returns null for a corrupt checkpoint instead of crashing', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(join(sessionsDir(), 'latest.json'), '{oops')
    expect(latestSession()).toBeNull()
  })

  it('returns null when the checkpoint is from a future version', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(
      join(sessionsDir(), 'latest.json'),
      JSON.stringify({ version: 99, model: 'm', messages: [], savedAt: 'x' }),
    )
    expect(latestSession()).toBeNull()
  })
})
