/**
 * Terminal UI built on pi-tui, in two layouts:
 *
 * - Oneshot (default): a TuiMainScreen column — header → answers → loader.
 *   Used for a single prompt argument; content streams into the terminal's
 *   own scrollback as it grows.
 * - Interactive: a TuiAltScreen chat layout — header, a ScrollView transcript
 *   that follows new output (mouse wheel / PageUp / Home / End to scroll,
 *   Ctrl+Shift+F to search), and the input pinned at the bottom. Answers
 *   accumulate across turns; on exit the whole transcript is printed back
 *   into the terminal's main buffer.
 *
 * The TUI only observes domain events and derives all display concerns
 * (spinner text, truncation, markdown) from them.
 */

import {
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'

import type { AgentEvent } from '../agent/events.js'
import { RunInterruptedError } from '../agent/loop.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const theme = {
  primary: (text: string) => `\u001b[36m${text}\u001b[0m`,
  muted: (text: string) => `\u001b[2m${text}\u001b[0m`,
  ok: (text: string) => `\u001b[32m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  error: (text: string) => `\u001b[31m${text}\u001b[0m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[0m`,
  thinking: (text: string) => `\u001b[2;3m${text}\u001b[0m`,
}

const markdownTheme = {
  heading: (text: string) => theme.bold(theme.primary(text)),
  link: (text: string) => theme.primary(text),
  linkUrl: (text: string) => theme.muted(text),
  code: (text: string) => theme.primary(text),
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => theme.muted(text),
  quote: (text: string) => theme.muted(text),
  quoteBorder: (text: string) => theme.muted(text),
  hr: (text: string) => theme.muted(text),
  listBullet: (text: string) => `${theme.primary('•')} ${text.replace(/^-/, '')}`,
  bold: (text: string) => theme.bold(text),
  italic: (text: string) => `\u001b[3m${text}\u001b[0m`,
  strikethrough: (text: string) => `\u001b[9m${text}\u001b[0m`,
  underline: (text: string) => `\u001b[4m${text}\u001b[0m`,
}

/** UI-side display truncation; domain events carry full content. */
function summarizeResult(content: string, maxLength = 160): string {
  const singleLine = content.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine
}

/** Clip thinking text to its last non-empty lines, tail-truncating long ones. */
function clipThinking(content: string, maxWidth: number, maxLines = 2): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  return lines
    .slice(-maxLines)
    .map((line) => (line.length > maxWidth ? `…${line.slice(-(maxWidth - 1))}` : line))
    .join('\n')
}

export interface AgentTuiOptions {
  /** Interactive chat layout: alt screen, scrolling transcript, input box. */
  interactive?: boolean
  /** Mark the session as restored (header suffix). */
  resumed?: boolean
}

/**
 * Close the editor's open top/bottom borders with side bars and rounded
 * corners. Rendering only — focus and input go to the wrapped editor.
 */
class FramedEditor implements Component {
  constructor(
    private readonly editor: Editor,
    private readonly frame: (text: string) => string,
  ) {}

  invalidate(): void {
    this.editor.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    const lines = this.editor.render(innerWidth)
    return lines.map((line, index) => {
      const isFirst = index === 0
      const isLast = index === lines.length - 1
      if (isFirst || isLast) {
        const open = this.frame(isFirst ? '╭' : '╰')
        const close = this.frame(isFirst ? '╮' : '╯')
        const visible = stripTerminalSequences(line)
        if (/^─+$/.test(visible)) {
          return open + this.frame('─'.repeat(Math.max(0, width - 2))) + close
        }
        // Scroll-indicator border (e.g. "─── ↑ 3 more ───"): keep the info,
        // pad to fit between the corners.
        return open + truncateToWidth(line, Math.max(1, width - 2), undefined, true) + close
      }
      const clipped = visibleWidth(line) > innerWidth ? truncateToWidth(line, innerWidth) : line
      const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))
      return `${this.frame('│')} ${clipped}${padding} ${this.frame('│')}`
    })
  }
}

/** One tool's transcript row plus its reserved result-summary line. */
interface ToolRow {
  row: Text
  summary: Text
  label: string
}

export class AgentTui {
  private readonly terminal: ProcessTerminal
  private readonly ui: TuiMainScreen | TuiAltScreen
  private readonly answers = new Container()
  private readonly loader: Loader
  /** Container the loader is attached to while a run is in flight. */
  private readonly loaderHost: Container
  /** Live thinking preview (bottom area); renders zero lines when empty. */
  private readonly thinkingPreview = new Text('', 1, 0)
  private pendingThinking = ''
  private readonly editor?: Editor
  /** Tool rows in flight, keyed by tool call id (parallel tools interleave). */
  private readonly rows = new Map<string, ToolRow>()
  private loaderActive = false
  private streamText: Text | null = null
  private started = false
  private busy = false

  constructor(model: string, baseUrl: string, options: AgentTuiOptions = {}) {
    const showHardwareCursor = process.env['PI_HARDWARE_CURSOR'] === '1'
    this.terminal = new ProcessTerminal()
    const title = `mortis — ${model} @ ${baseUrl}${options.resumed ? ' (resumed)' : ''}`
    const header = new Text(theme.bold(title), 0, 0)

    if (options.interactive) {
      const ui = new TuiAltScreen(this.terminal, showHardwareCursor || undefined)
      this.ui = ui
      this.loader = new Loader(ui, theme.primary, theme.muted, '', { frames: SPINNER_FRAMES })
      // Empty containers render zero lines, so the status row collapses when
      // the loader is detached and the layout stays stable while it spins.
      const statusRow = new Container()
      this.loaderHost = statusRow
      // Multi-line editor: Enter submits, Shift+Enter (or "\"+Enter) breaks
      // the line, up/down recalls history; it renders its own box frame and
      // scrolls once the text exceeds ~30% of the terminal height.
      const editor = new Editor(ui, {
        borderColor: theme.muted,
        selectList: {
          selectedPrefix: theme.primary,
          selectedText: theme.bold,
          description: theme.muted,
          scrollInfo: theme.muted,
          noMatch: theme.muted,
        },
      })
      this.editor = editor
      const bottom = new Container()
      bottom.addChild(statusRow)
      bottom.addChild(this.thinkingPreview)
      bottom.addChild(new FramedEditor(editor, theme.muted))
      ui.setLayoutRoot(
        new VStack([
          { component: header, basis: 'auto', shrink: 0, minSize: 1 },
          // basis 'auto' (not 0): the live viewport shrinks this region to the
          // terminal height, while the unbounded direct render — used when the
          // alt screen prints the final transcript on exit — keeps full content.
          { component: new ScrollView(this.answers, { follow: 'end', primary: true }), basis: 'auto', grow: 1, shrink: 1, minSize: 1 },
          { component: bottom, basis: 'auto', shrink: 0, minSize: 1 },
        ]),
      )
    } else {
      const ui = new TuiMainScreen(this.terminal, showHardwareCursor || undefined)
      this.ui = ui
      this.loader = new Loader(ui, theme.primary, theme.muted, '', { frames: SPINNER_FRAMES })
      const column = new Container()
      column.addChild(header)
      column.addChild(this.answers)
      column.addChild(this.thinkingPreview)
      this.loaderHost = column
      ui.addChild(column)
    }
  }

  start(): void {
    this.ui.start()
    this.started = true
  }

  handle(event: AgentEvent): void {
    switch (event.kind) {
      case 'model_request':
        this.streamText = null
        this.pendingThinking = ''
        this.thinkingPreview.setText('')
        this.startLoader('thinking…')
        break
      case 'assistant_thinking':
        // Live preview under the loader, above the input: last two lines.
        this.pendingThinking = event.content
        this.thinkingPreview.setText(theme.thinking(clipThinking(event.content, this.clipWidth())))
        this.startLoader('reasoning…')
        break
      case 'assistant_text':
        this.commitThinking()
        if (!this.streamText) {
          this.streamText = new Text('', 1, 0)
          this.answers.addChild(this.streamText)
          this.startLoader('composing…')
        }
        this.streamText.setText(event.content)
        break
      case 'tool_start': {
        this.commitThinking()
        this.streamText = null
        const label = `${event.toolName}${event.argsSummary ? ` ${event.argsSummary}` : ''}`
        const row = new Text(`  ${label}`, 0, 0)
        const summary = new Text('', 0, 0)
        this.answers.addChild(row)
        this.answers.addChild(summary)
        this.rows.set(event.toolCallId, { row, summary, label })
        this.startLoader(label)
        break
      }
      case 'tool_result': {
        const entry = this.rows.get(event.toolCallId)
        if (entry) {
          const mark = event.isError ? theme.error('✗') : theme.ok('✓')
          entry.row.setText(truncateToWidth(`${mark} ${entry.label}`, this.terminal.columns))
          if (event.content) {
            entry.summary.setText(`    ${theme.muted(summarizeResult(event.content))}`)
          }
          this.rows.delete(event.toolCallId)
        }
        if (this.rows.size === 0) this.startLoader('thinking…')
        break
      }
      case 'run_interrupted':
        this.commitThinking()
        this.streamText = null
        this.rows.clear()
        this.answers.addChild(new Text(theme.muted(`(interrupted: ${event.reason})`), 1, 0))
        this.stopLoader()
        break
    }
    this.ui.requestRender()
  }

  /**
   * Move the streamed thinking into the transcript as a gray two-line block
   * and collapse the live preview. Called when thinking ends (first answer
   * text, tool start, interruption, or finalization).
   */
  private commitThinking(): void {
    const content = this.pendingThinking
    this.pendingThinking = ''
    this.thinkingPreview.setText('')
    if (!content.trim()) return
    this.answers.addChild(new Text(theme.muted('✻ thinking'), 1, 0))
    this.answers.addChild(new Text(theme.thinking(clipThinking(content, this.clipWidth())), 1, 1))
  }

  private clipWidth(): number {
    return Math.max(10, (this.terminal.columns || 80) - 4)
  }

  private finalizeAnswer(answer: string): void {
    this.commitThinking()
    if (this.streamText) {
      this.answers.removeChild(this.streamText)
      this.streamText = null
    }
    this.answers.addChild(new Markdown(answer, 1, 1, markdownTheme))
    this.stopLoader()
    this.ui.requestRender()
  }

  finish(answer: string): void {
    if (!this.started) return
    this.finalizeAnswer(answer)
    this.ui.requestRender()
    this.stop()
  }

  private wireInput(runPrompt: (prompt: string) => Promise<string>): Editor {
    const editor = this.editor
    if (!editor) throw new Error('wireInput requires the interactive layout')

    this.ui.setFocus(editor)

    editor.onSubmit = (text: string) => {
      const prompt = text.trim()
      if (!prompt) return
      if (this.busy) {
        // The editor already cleared itself on submit; restore the text so it
        // is not lost and can be resubmitted once the run finishes.
        editor.setText(prompt)
        this.startLoader('busy…')
        return
      }
      this.busy = true

      editor.addToHistory(prompt)

      this.streamText = null
      this.pendingThinking = ''
      this.thinkingPreview.setText('')
      this.rows.clear()
      this.answers.addChild(new Text(theme.bold(theme.yellow(`> ${prompt}`)), 1, 0))
      this.ui.requestRender()

      void runPrompt(prompt)
        .then((answer) => { this.finalizeAnswer(answer) })
        .catch((error: unknown) => {
          // Interruption is already shown via the run_interrupted event.
          if (error instanceof RunInterruptedError) return
          this.commitThinking()
          this.answers.addChild(new Text(theme.error(`error: ${(error as Error).message}`), 1, 1))
          this.stopLoader()
        })
        .finally(() => { this.busy = false; this.ui.requestRender() })
    }
    return editor
  }

  async startInteractive(
    runPrompt: (prompt: string) => Promise<string>,
    options: { onInterrupt?: () => void } = {},
  ): Promise<void> {
    this.start()
    return new Promise<void>((resolve) => {
      const exit = () => { this.stop(); resolve(); process.exit(0) }
      const input = this.wireInput(runPrompt)

      this.ui.addInputListener((data) => {
        // Ctrl+C interrupts the in-flight run; when idle it exits.
        if (matchesKey(data, 'ctrl+c')) {
          if (this.busy) options.onInterrupt?.()
          else exit()
          return { consume: true }
        }
        if (matchesKey(data, 'ctrl+d')) { exit(); return { consume: true } }
        // /q is matched against the editor's real text, so paste and cursor
        // movement cannot desynchronize the check. The listener runs before
        // the focused editor, so consuming Enter keeps /q away from onSubmit.
        if ((data === '\r' || data === '\n') && input.getText().trim() === '/q') {
          exit()
          return { consume: true }
        }
        return undefined
      })
    })
  }

  stop(): void {
    if (!this.started) return
    this.ui.stop()
    this.started = false
  }

  private startLoader(message: string): void {
    this.loader.setMessage(message)
    if (!this.loaderActive) {
      this.loaderHost.addChild(this.loader)
      this.loaderActive = true
    }
    this.loader.start()
  }

  private stopLoader(): void {
    this.loader.stop()
    if (this.loaderActive) {
      this.loaderHost.removeChild(this.loader)
      this.loaderActive = false
    }
  }
}
