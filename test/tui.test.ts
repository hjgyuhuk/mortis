import { describe, expect, it } from 'vitest'
import { AgentTui } from '../src/tui/index.js'

/** Render the TUI component tree at a fixed width without starting the terminal. */
function render(tui: AgentTui, width = 80): string[] {
  return (tui as unknown as { ui: { render(w: number): string[] } }).ui.render(width)
}

/** Wire input without raw mode and submit a prompt. */
async function submit(tui: AgentTui, prompt: string, run?: (p: string) => Promise<string>) {
  const input = (tui as unknown as {
    wireInput(run: (p: string) => Promise<string>): { onSubmit(p: string): void }
  }).wireInput(run ?? (async () => 'answer text'))
  input.onSubmit(prompt)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return render(tui)
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
    tui.handle({ kind: 'tool_result', toolCallId: 'c1', resultSummary: '"ok"' })
    const lines = render(tui)
    expect(lines.some((l) => l.includes('✓'))).toBe(true)
  })

  it('renders markdown answer text', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{}' })
    tui.handle({ kind: 'tool_result', toolCallId: 'c1', resultSummary: '"ok"' })
    const { Markdown } = require('@earendil-works/pi-tui')
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
  it('shows the submitted prompt and the answer', async () => {
    const lines = await submit(new AgentTui('m', 'http://x/v1'), 'add a readme')
    expect(lines.some((l) => l.includes('add a readme'))).toBe(true)
    expect(lines.some((l) => l.includes('answer text'))).toBe(true)
  })

  it('renders an error line when the run fails', async () => {
    const lines = await submit(
      new AgentTui('m', 'http://x/v1'),
      'do something',
      async () => { throw new Error('boom') },
    )
    expect(lines.some((l) => l.includes('error: boom'))).toBe(true)
  })

  it('passes /q to runPrompt when addInputListener is not active', async () => {
    const tui = new AgentTui('m', 'http://x/v1')
    let ran = false
    const input = (tui as unknown as {
      wireInput(run: (p: string) => Promise<string>): { onSubmit(p: string): void }
    }).wireInput(async () => { ran = true; return 'answer text' })
    input.onSubmit('/q')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toBe(true)
  })
})
