import { describe, expect, it } from 'vitest'
import { Markdown } from '@earendil-works/pi-tui'
import { AgentTui, OptionsBar } from '../src/tui/index.js'

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

  it('renders context compaction as status only, without the summary', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'context_compacting', reason: 'manual' })
    tui.handle({ kind: 'context_compacted', reason: 'manual', removedMessages: 12 })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('compacting context'))).toBe(true)
    expect(lines.some((l) => l.includes('compacted context (12 messages)'))).toBe(true)
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

describe('AgentTui global keys', () => {
  function handle(
    tui: AgentTui,
    data: string,
    exit: () => void,
    onInterrupt?: () => void,
  ): { consume: boolean } | undefined {
    return (tui as unknown as {
      handleGlobalKey(data: string, exit: () => void, onInterrupt?: () => void): { consume: boolean } | undefined
    }).handleGlobalKey(data, exit, onInterrupt)
  }

  it('interrupts the running turn on Esc, falls through when idle', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    let exited = false
    let interrupted = 0
    const exit = () => { exited = true }
    const onInterrupt = () => { interrupted++ }

    expect(handle(tui, '\x1b', exit, onInterrupt)).toBeUndefined()
    expect(interrupted).toBe(0)

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const input = wire(tui, async () => {
      await gate
      return 'done'
    })
    input.onSubmit('work')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handle(tui, '\x1b', exit, onInterrupt)).toEqual({ consume: true })
    expect(interrupted).toBe(1)
    expect(exited).toBe(false)

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('exits via Ctrl+C when idle and interrupts when busy', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    let exited = false
    let interrupted = 0
    const exit = () => { exited = true }
    const onInterrupt = () => { interrupted++ }

    expect(handle(tui, '\x03', exit, onInterrupt)).toEqual({ consume: true })
    expect(exited).toBe(true)

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const input = wire(tui, async () => {
      await gate
      return 'done'
    })
    input.onSubmit('work')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handle(tui, '\x03', exit, onInterrupt)).toEqual({ consume: true })
    expect(interrupted).toBe(1)

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('exits on Ctrl+D and on /q + Enter', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    let exits = 0
    const exit = () => { exits++ }

    expect(handle(tui, '\x04', exit)).toEqual({ consume: true })
    expect(exits).toBe(1)

    const input = wire(tui)
    ;(input as unknown as { setText(text: string): void }).setText('/q')
    expect(handle(tui, '\r', exit)).toEqual({ consume: true })
    expect(exits).toBe(2)
  })
})

describe('OptionsBar', () => {
  it('renders every choice with the first selected', () => {
    const bar = new OptionsBar(['Approve', 'Reject', 'Revise'], () => {}, () => {})
    const [line] = bar.render(80)
    expect(line).toContain('Approve')
    expect(line).toContain('Reject')
    expect(line).toContain('Revise')
    expect(line).toContain('\u001b[7m')
    expect(bar.selected).toBe('Approve')
  })

  it('moves the selection with up/down and confirms with Enter', () => {
    const choices: string[] = []
    const bar = new OptionsBar(['Approve', 'Reject', 'Revise'], (c) => choices.push(c), () => {})
    bar.handleInput('\x1b[B') // down
    expect(bar.selected).toBe('Reject')
    bar.handleInput('\x1b[A') // up
    expect(bar.selected).toBe('Approve')
    bar.handleInput('\x1b[A') // wraps to the last
    expect(bar.selected).toBe('Revise')
    bar.handleInput('\r')
    expect(choices).toEqual(['Revise'])
  })
})

describe('AgentTui ask-user panel', () => {
  it('shows the question and options, resolves on close, and Esc rejects', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    const pending = tui.askUser('Shall we **proceed**?', ['Approve', 'Reject', 'Revise'])

    let lines = render(tui)
    expect(lines.some((l) => l.includes('✻ question'))).toBe(true)
    expect(lines.some((l) => l.includes('proceed'))).toBe(true)
    expect(lines.some((l) => l.includes('Approve') && l.includes('Revise'))).toBe(true)

    const handle = (data: string): { consume: boolean } | undefined =>
      (tui as unknown as {
        handleGlobalKey(d: string, exit: () => void, onInterrupt?: () => void): { consume: boolean } | undefined
      }).handleGlobalKey(data, () => {}, () => {})
    expect(handle('\x1b')).toEqual({ consume: true })

    await expect(pending).resolves.toBe('Reject')
    lines = render(tui)
    expect(lines.some((l) => l.includes('✻ question'))).toBe(false)
  })

  it('resolves with the chosen option', async () => {
    const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
    const pending = tui.askUser('ok?', ['Approve', 'Reject', 'Revise'])
    ;(tui as unknown as { pendingAsk: { close(choice: string): void } }).pendingAsk.close('Approve')
    await expect(pending).resolves.toBe('Approve')
  })
})
