import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPACT,
  PLANNER,
  ensureDefaultPersonas,
  loadPersonas,
  parsePersonaMarkdown,
  parsePersonaOutput,
  personaTool,
  personasDir,
  runPersona,
  serializePersonaMarkdown,
} from '../src/persona.js'
import type { ChatProvider, Message, ModelResponse, StreamChunk, Tool } from '../src/types.js'

const FULL_OUTPUT = `## Conclusion
Use a two-pass approach.

## Evidence
- fact: the input is small
- assumption: the API is stable

## Proposal
1. Scan the tree
2. Emit the report

## Uncertainty
Rate limits are unknown.

## Effort
medium — half a day`

describe('parsePersonaOutput', () => {
  it('splits all five sections', () => {
    const result = parsePersonaOutput('planner', FULL_OUTPUT)
    expect(result.persona).toBe('planner')
    expect(result.conclusion).toContain('two-pass')
    expect(result.evidence).toContain('assumption')
    expect(result.proposal).toContain('Scan the tree')
    expect(result.uncertainty).toContain('Rate limits')
    expect(result.effort).toContain('medium')
    expect(result.raw).toBe(FULL_OUTPUT)
  })

  it('missing sections stay undefined', () => {
    const result = parsePersonaOutput('planner', '## Conclusion\nshort answer\n')
    expect(result.conclusion).toBe('short answer')
    expect(result.evidence).toBeUndefined()
    expect(result.proposal).toBeUndefined()
  })

  it('output without known headings falls back to conclusion = raw', () => {
    const result = parsePersonaOutput('planner', 'just a plain answer')
    expect(result.conclusion).toBe('just a plain answer')
    expect(result.evidence).toBeUndefined()
  })
})

function scriptedProvider(chunks: StreamChunk[], captures?: { messages: Message[][]; tools: Tool[][] }): ChatProvider {
  return {
    async *completeStream(messages: Message[], tools: Tool[], signal?: AbortSignal) {
      captures?.messages.push(structuredClone(messages))
      captures?.tools.push(structuredClone(tools))
      for (const chunk of chunks) {
        if (signal?.aborted) {
          const error = new Error('The operation was aborted')
          error.name = 'AbortError'
          throw error
        }
        yield chunk
      }
    },
  }
}

describe('runPersona', () => {
  it('streams domain events and returns the parsed result with no tools', async () => {
    const captures: { messages: Message[][]; tools: Tool[][] } = { messages: [], tools: [] }
    const provider = scriptedProvider(
      [
        { kind: 'thinking', delta: 'con' },
        { kind: 'thinking', delta: 'sidering' },
        { kind: 'text', delta: FULL_OUTPUT },
      ],
      captures,
    )
    const onEvent = vi.fn()
    const result = await runPersona(PLANNER, 'plan a release', { provider, onEvent })

    expect(result.persona).toBe('planner')
    expect(result.conclusion).toContain('two-pass')
    expect(result.raw).toBe(FULL_OUTPUT)

    expect(captures.tools[0]).toEqual([])
    const [system, user] = captures.messages[0]!
    expect(system).toMatchObject({ role: 'system' })
    expect(system!.content).toContain('You are Planner')
    expect(system!.content).toContain('Never write complete implementation code')
    expect(system!.content).toContain('## Conclusion')
    expect(user).toEqual({ role: 'user', content: 'plan a release' })

    expect(onEvent).toHaveBeenNthCalledWith(1, { kind: 'model_request' })
    const thinkingEvents = onEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'assistant_thinking')
    expect(thinkingEvents.at(-1)).toMatchObject({ kind: 'assistant_thinking', content: 'considering' })
    const textEvents = onEvent.mock.calls.map(([e]) => e).filter((e) => e.kind === 'assistant_text')
    expect(textEvents.at(-1)).toMatchObject({ kind: 'assistant_text', content: FULL_OUTPUT })
  })

  it('propagates cancellation as a raw AbortError (orchestration maps it)', async () => {
    const controller = new AbortController()
    const provider: ChatProvider = {
      async *completeStream(_messages: Message[], _tools: Tool[], signal?: AbortSignal) {
        yield { kind: 'thinking', delta: 'pre' }
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      },
    }
    const pending = runPersona(PLANNER, 'x', { provider, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an empty persona response', async () => {
    const provider = scriptedProvider([])
    await expect(runPersona(PLANNER, 'x', { provider })).rejects.toThrow('empty response')
  })
})

describe('personaTool', () => {
  const personaProvider: ChatProvider = {
    async *completeStream(): AsyncGenerator<StreamChunk> {
      yield { kind: 'text', delta: '## Conclusion\nall good' }
    },
  }

  it('routes through the registry and returns evidence as the tool result', async () => {
    const tool = personaTool(() => personaProvider)
    const result = await tool.execute({ persona: 'planner', task: 'assess risk' })
    expect(result).toContain('Persona "planner" evidence')
    expect(result).toContain('all good')
    expect(result).toContain('you decide')
  })

  it('unknown personas return an error text', async () => {
    const tool = personaTool(() => personaProvider)
    const result = await tool.execute({ persona: 'oracle', task: 'x' })
    expect(result).toContain('unknown persona "oracle"')
    expect(result).toContain('planner')
  })

  it('empty tasks are rejected', async () => {
    const tool = personaTool(() => personaProvider)
    expect(await tool.execute({ persona: 'planner', task: '  ' })).toContain('must not be empty')
  })

  it('aborts propagate unchanged through the tool', async () => {
    const controller = new AbortController()
    const hanging: ChatProvider = {
      async *completeStream(_m: Message[], _t: Tool[], signal?: AbortSignal) {
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      },
    }
    const tool = personaTool(() => hanging)
    const pending = tool.execute({ persona: 'planner', task: 'x' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 0)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('wires into an agent run as a normal tool call', async () => {
    const { Agent } = await import('../src/agent/loop.js')
    const responses: ModelResponse[] = [
      { kind: 'tool_calls', tool_calls: [{
        id: 'c1', type: 'function', function: { name: 'persona', arguments: '{"persona":"planner","task":"plan"}' },
      }] },
      { kind: 'text', content: 'decided' },
    ]
    const calls: Message[][] = []
    const main: ChatProvider = {
      async *completeStream(messages: Message[]): AsyncGenerator<StreamChunk> {
        calls.push(structuredClone(messages))
        const next = responses.shift()!
        if (next.kind === 'tool_calls') yield { kind: 'tool_calls', tool_calls: next.tool_calls }
        else {
          for (const part of (next.content.match(/[\s\S]{1,10}/g) ?? [])) {
            yield { kind: 'text', delta: part }
          }
        }
      },
    }
    const agent = new Agent({ provider: main, tools: [personaTool(() => personaProvider)], systemPrompt: 'sys' })
    const answer = await agent.run('plan something')
    expect(answer).toBe('decided')
    const toolMessage = calls[1]![3]
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(toolMessage!.content).toContain('all good')
    // The persona evidence entered the state through the reducer (tool result).
  })
})

describe('persona markdown files', () => {
  const originalHome = process.env.HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mortis-persona-home-'))
    process.env.HOME = home
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    process.env.HOME = originalHome
  })

  it('round-trips serialize and parse', () => {
    const markdown = serializePersonaMarkdown(PLANNER)
    const parsed = parsePersonaMarkdown(markdown, 'fallback')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe(PLANNER.name)
    expect(parsed!.description).toBe(PLANNER.description)
    expect(parsed!.systemPrompt).toContain('Never write complete implementation code')
  })

  it('parses optional model and thinking-effort overrides', () => {
    const parsed = parsePersonaMarkdown(
      '---\nname: reviewer\ndescription: reviews code\nmodel: gpt-4o\nthinking-effort: high\n---\n\nYou review.',
      'fallback',
    )
    expect(parsed).toMatchObject({ name: 'reviewer', model: 'gpt-4o', thinkingEffort: 'high' })
    expect(parsed!.systemPrompt).toBe('You review.')
  })

  it('falls back to the filename when name is missing; empty body is invalid', () => {
    expect(parsePersonaMarkdown('---\ndescription: x\n---\n\nBody here.', 'codedude')!.name).toBe('codedude')
    expect(parsePersonaMarkdown('---\nname: empty\n---\n\n   ', 'x')).toBeNull()
    expect(parsePersonaMarkdown('no frontmatter at all', 'x')).toBeNull()
  })

  it('ensureDefaultPersonas creates the default planner and compact personas once', () => {
    ensureDefaultPersonas()
    const plannerPath = join(personasDir(), 'planner.md')
    const compactPath = join(personasDir(), 'compact.md')
    expect(existsSync(plannerPath)).toBe(true)
    expect(existsSync(compactPath)).toBe(true)
    const original = readFileSync(plannerPath, 'utf8')

    writeFileSync(plannerPath, '---\nname: planner\ndescription: custom\n---\n\nMy custom prompt.')
    ensureDefaultPersonas()
    expect(readFileSync(plannerPath, 'utf8')).toContain('My custom prompt.') // never overwritten
    expect(original).toContain('You are Planner')
    expect(readFileSync(compactPath, 'utf8')).toContain('You are Compact')
    expect(COMPACT.name).toBe('compact')
  })

  it('loadPersonas reads every valid md and skips broken ones', () => {
    ensureDefaultPersonas()
    mkdirSync(personasDir(), { recursive: true })
    writeFileSync(join(personasDir(), 'reviewer.md'), '---\nname: reviewer\ndescription: r\n---\n\nReviews things.')
    writeFileSync(join(personasDir(), 'broken.md'), 'not a persona file')

    const personas = loadPersonas()
    expect(Object.keys(personas).sort()).toEqual(['compact', 'planner', 'reviewer'])
    expect(personas['reviewer']!.systemPrompt).toBe('Reviews things.')
  })
})
