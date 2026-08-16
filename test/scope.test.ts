import { describe, expect, it } from 'vitest'
import { Scope } from '../src/agent/scope.js'

describe('Scope', () => {
  it('child signals fire when the parent aborts, carrying the reason', () => {
    const parent = new Scope()
    const child = parent.fork()
    const grandchild = child.fork()
    let childAborted = false
    child.signal.addEventListener('abort', () => { childAborted = true })

    parent.abort('user interrupt')

    expect(parent.aborted).toBe(true)
    expect(childAborted).toBe(true)
    expect(grandchild.aborted).toBe(true)
    expect(child.abortReason).toBe('user interrupt')
  })

  it('dispose detaches a scope from future parent aborts', () => {
    const parent = new Scope()
    const child = parent.fork()
    child.dispose()
    parent.abort('stop')
    expect(child.aborted).toBe(false)
  })

  it('abort is idempotent and keeps the first reason', () => {
    const scope = new Scope()
    scope.abort('first')
    scope.abort('second')
    expect(scope.aborted).toBe(true)
    expect(scope.abortReason).toBe('first')
  })

  it('aborting one child leaves siblings and the parent alone', () => {
    const parent = new Scope()
    const a = parent.fork()
    const b = parent.fork()
    a.abort('a')
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(false)
    expect(parent.aborted).toBe(false)
  })

  it('signal rejects fetch-style consumers with an AbortError when aborted', async () => {
    const scope = new Scope()
    const pending = new Promise<never>((_, reject) => {
      scope.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
    scope.abort('stop')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
