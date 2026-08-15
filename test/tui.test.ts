import { describe, expect, it } from 'vitest'
import { AgentTui } from '../src/tui/index.js'

/**
 * Test that the pi-tui component tree renders without throwing and produces
 * sensible output. The TUI lifecycle (raw mode, cursor escapes) is not
 * exercised — we only drive the panel/markdown components.
 */

describe('AgentTui rendering', () => {
  it('renders the status panel header', () => {
    const tui = new AgentTui('my-model', 'http://localhost:11434/v1')
    // Component tree render at a fixed width.
    const tuiAny = tui as unknown as { ui: { render(width: number): string[] }; column: { render(width: number): string[] } }
    const lines = tuiAny.ui.render(80)
    expect(lines.some((l) => l.includes('mortis'))).toBe(true)
    expect(lines.some((l) => l.includes('my-model'))).toBe(true)
    expect(lines.some((l) => l.includes('http://localhost:11434/v1'))).toBe(true)
  })

  it('shows tool rows after events', () => {
    const tui = new AgentTui('m', 'http://x/v1')
    tui.handle({ kind: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: '{"command":"ls"}' })
    const tuiAny = tui as unknown as { ui: { render(width: number): string[] } }
    const lines = tuiAny.ui.render(80)
    expect(lines.some((l) => l.includes('bash'))).toBe(true)
    expect(lines.some((l) => l.includes('ls'))).toBe(true)
  })

  it('renders markdown-only answer text', async () => {
    const { Markdown } = await import('@earendil-works/pi-tui')
    const tui = new AgentTui('m', 'http://x/v1')
    void tui
    // Directly exercise the markdown theme through pi-tui's component.
    const theme = {
      heading: (t: string) => `H:${t}`,
      link: (t: string) => t,
      linkUrl: (t: string) => t,
      code: (t: string) => t,
      codeBlock: (t: string) => t,
      codeBlockBorder: (t: string) => t,
      quote: (t: string) => t,
      quoteBorder: (t: string) => t,
      hr: (t: string) => t,
      listBullet: (t: string) => t,
      bold: (t: string) => `B:${t}`,
      italic: (t: string) => t,
      strikethrough: (t: string) => t,
      underline: (t: string) => t,
    }
    const md = new Markdown('# Hello **world**', 0, 0, theme)
    const lines = md.render(80)
    expect(lines.some((l) => l.includes('Hello'))).toBe(true)
    expect(lines.some((l) => l.includes('B:world'))).toBe(true)
  })
})

describe('AgentTui interactive', () => {
  /** Drive an interactive session without raw mode: wire input, submit a prompt, wait for rendering. */
  async function submit(tui: AgentTui, prompt: string) {
    const input = (tui as unknown as { wireInput(run: (p: string) => Promise<string>, onExit: () => void): { onSubmit(p: string): void } }).wireInput(
      async () => 'answer text',
      () => {},
    )
    input.onSubmit(prompt)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return (tui as unknown as { ui: { render(width: number): string[] } }).ui.render(80)
  }

  it('shows the submitted prompt and the answer', async () => {
    const lines = await submit(new AgentTui('m', 'http://x/v1'), 'add a readme')
    expect(lines.some((l) => l.includes('add a readme'))).toBe(true)
    expect(lines.some((l) => l.includes('answer text'))).toBe(true)
  })

  it('renders an error line when the run fails', async () => {
    const tui = new AgentTui('m', 'http://x/v1')
    const input = (tui as unknown as { wireInput(run: (p: string) => Promise<string>, onExit: () => void): { onSubmit(p: string): void } }).wireInput(
      async () => {
        throw new Error('boom')
      },
      () => {},
    )
    input.onSubmit('do something')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const lines = (tui as unknown as { ui: { render(width: number): string[] } }).ui.render(80)
    expect(lines.some((l) => l.includes('error: boom'))).toBe(true)
  })

  it('exits on /q without running the prompt', async () => {
    const tui = new AgentTui('m', 'http://x/v1')
    let exited = false
    let ran = false
    const input = (tui as unknown as { wireInput(run: (p: string) => Promise<string>, onExit: () => void): { onSubmit(p: string): void } }).wireInput(
      async () => {
        ran = true
        return 'answer text'
      },
      () => {
        exited = true
      },
    )
    input.onSubmit('/q')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(exited).toBe(true)
    expect(ran).toBe(false)
  })
})