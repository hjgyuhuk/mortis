import { describe, expect, it } from 'vitest'
import { Markdown } from '@earendil-works/pi-tui'
import { AgentTui } from '../src/tui/index.js'

/** Render the TUI component tree at a fixed width without starting the terminal. */
function render(tui: AgentTui, width = 80): string[] {
  return (tui as unknown as { ui: { render(w: number): string[] } }).ui.render(width)
}

/** Wire input without raw mode and submit a prompt. */
async function submit(tui: AgentTui, prompt: string, run?: (p: string) => Promise<string>) {
  const input = wire(tui, run)
  input.onSubmit(prompt)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return render(tui)
}

/** Access the interactive-mode input wiring. */
function wire(tui: AgentTui, run?: (p: string) => Promise<string>): { onSubmit(p: string): void } {
  return (tui as unknown as {
    wireInput(run: (p: string) => Promise<string>): { onSubmit(p: string): void }
  }).wireInput(run ?? (async () => 'answer text'))
}

describe('AgentTui rendering', () => {
  it('renders the header with model and url', () => {
    const lines = render(new AgentTui('my-model', 'http://localhost:11434/v1'))
    expect(lines.some((l) => l.includes('mortis'))).toBe(true)
    expect(lines.some((l) => l.includes('my-model'))).toBe(true)
    expect(lines.some((l) => l.includes('http://localhost:11434/v1'))).toBe(true)
  })

  it('shows tool rows after tool_start event', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{"command":"ls"}' })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('bash'))).toBe(true)
    expect(lines.some((l) => l.includes('ls'))).toBe(true)
  })

  it('shows check mark after tool_result event', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{"command":"ls"}' })
    tui.handle({ kind: 'tool_result', toolCallId: 'c1', content: 'ok', isError: false })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('✓'))).toBe(true)
  })

  it('marks failed tools with a cross', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{}' })
    tui.handle({ kind: 'tool_result', toolCallId: 'c1', content: 'error: boom', isError: true })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('✗'))).toBe(true)
  })

  it('renders an interrupted notice from the run_interrupted event', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'run_interrupted', reason: 'user interrupt' })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('(interrupted: user interrupt)'))).toBe(true)
  })

  it('previews thinking live, then commits a two-line gray block to the transcript', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'model_request' })
    tui.handle({ kind: 'assistant_thinking', content: 'line one\nline two\nline three' })

    // While streaming: tail preview only, nothing committed yet.
    let lines = render(tui)
    expect(lines.some((l) => l.includes('line three'))).toBe(true)
    expect(lines.some((l) => l.includes('✻ thinking'))).toBe(false)

    tui.handle({ kind: 'assistant_text', content: 'answer' })

    // After thinking ends: gray block in the transcript, clipped to the last
    // two non-empty lines; the preview is gone.
    lines = render(tui)
    expect(lines.some((l) => l.includes('✻ thinking'))).toBe(true)
    expect(lines.some((l) => l.includes('line two'))).toBe(true)
    expect(lines.some((l) => l.includes('line three'))).toBe(true)
    expect(lines.filter((l) => l.includes('line ')).length).toBe(2)
  })

  it('shows the live thinking preview above the input box', () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    tui.handle({ kind: 'model_request' })
    tui.handle({ kind: 'assistant_thinking', content: 'reasoning tail' })
    const lines = render(tui)
    const previewIndex = lines.findIndex((l) => l.includes('reasoning tail'))
    const editorIndex = lines.findIndex((l) => l.includes('╭'))
    expect(previewIndex).toBeGreaterThanOrEqual(0)
    expect(editorIndex).toBeGreaterThan(previewIndex)
  })

  it('renders markdown answer text', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{}' })
    tui.handle({ kind: 'tool_result', toolCallId: 'c1', content: 'ok', isError: false })
    const md = new Markdown('# Hello **world**', 0, 0, {
      heading: (t: string) => `H:${t}`,
      bold: (t: string) => `B:${t}`,
      link: (t: string) => t, linkUrl: (t: string) => t,
      code: (t: string) => t, codeBlock: (t: string) => t, codeBlockBorder: (t: string) => t,
      quote: (t: string) => t, quoteBorder: (t: string) => t, hr: (t: string) => t,
      listBullet: (t: string) => t, italic: (t: string) => t,
      strikethrough: (t: string) => t, underline: (t: string) => t,
    })
    const lines = md.render(80)
    expect(lines.some((l) => l.includes('Hello'))).toBe(true)
    expect(lines.some((l) => l.includes('B:world'))).toBe(true)
  })
})

describe('AgentTui interactive', () => {
  it('renders the chat layout with header and a closed editor frame', () => {
    const lines = render(new AgentTui('my-model', 'http://x/v1', { interactive: true }))
    expect(lines.some((l) => l.includes('mortis — my-model'))).toBe(true)
    // The editor's borders are closed by FramedEditor: corners + side bars.
    expect(lines.some((l) => l.includes('╭'))).toBe(true)
    expect(lines.some((l) => l.includes('╰'))).toBe(true)
    expect(lines.some((l) => l.includes('│'))).toBe(true)
  })

  it('renders tool rows in the interactive transcript', () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    tui.handle({ kind: 'model_request' })
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{"command":"ls"}' })
    tui.handle({ kind: 'tool_result', toolCallId: 'c1', content: 'ok', isError: false })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('bash'))).toBe(true)
    expect(lines.some((l) => l.includes('✓'))).toBe(true)
  })

  it('shows the submitted prompt and the answer', async () => {
    const lines = await submit(new AgentTui('m', 'http://x/v1', { interactive: true }), 'add a readme')
    expect(lines.some((l) => l.includes('add a readme'))).toBe(true)
    expect(lines.some((l) => l.includes('answer text'))).toBe(true)
    // The echoed prompt is dark yellow; the input box has no "> " prefix.
    expect(lines.some((l) => l.includes('add a readme') && l.includes('\u001b[33m'))).toBe(true)
    expect(lines.some((l) => l.includes('│ >'))).toBe(false)
  })

  it('accumulates answers across multiple submissions', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    const input = wire(tui)
    input.onSubmit('first prompt')
    await new Promise((resolve) => setTimeout(resolve, 0))
    input.onSubmit('second prompt')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const lines = render(tui)
    expect(lines.some((l) => l.includes('first prompt'))).toBe(true)
    expect(lines.some((l) => l.includes('second prompt'))).toBe(true)
    expect(lines.filter((l) => l.includes('answer text')).length).toBeGreaterThanOrEqual(2)
  })

  it('renders an error line when the run fails', async () => {
    const lines = await submit(
      new AgentTui('m', 'http://x/v1', { interactive: true }),
      'do something',
      async () => { throw new Error('boom') },
    )
    expect(lines.some((l) => l.includes('error: boom'))).toBe(true)
  })

  it('ignores submissions while a run is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    const input = wire(tui, async () => {
      await gate
      return 'first answer'
    })

    input.onSubmit('first')
    await new Promise((resolve) => setTimeout(resolve, 0))
    input.onSubmit('second')
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const lines = render(tui)
    expect(lines.some((l) => l.includes('first answer'))).toBe(true)
    expect(lines.some((l) => l.includes('> second'))).toBe(false)
  })

  it('passes /q to runPrompt when addInputListener is not active', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    let ran = false
    const input = (tui as unknown as {
      wireInput(run: (p: string) => Promise<string>): { onSubmit(p: string): void }
    }).wireInput(async () => { ran = true; return 'answer text' })
    input.onSubmit('/q')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toBe(true)
  })
})
