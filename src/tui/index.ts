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
 */

import {
  Container,
  Input,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'

import type { AgentEvent } from '../agent/events.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const theme = {
  primary: (text: string) => `\u001b[36m${text}\u001b[0m`,
  muted: (text: string) => `\u001b[2m${text}\u001b[0m`,
  ok: (text: string) => `\u001b[32m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  error: (text: string) => `\u001b[31m${text}\u001b[0m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[0m`,
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

export interface AgentTuiOptions {
  /** Interactive chat layout: alt screen, scrolling transcript, input box. */
  interactive?: boolean
}

/** Strip pi-tui Input's hardcoded "> " prompt so the box shows bare text. */
class BareInput implements Component {
  constructor(private readonly input: Input) {}

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
    return this.input.render(width + 2).map((line) => (line.startsWith('> ') ? line.slice(2) : line))
  }
}

/** Wrap a component in a rounded box frame (e.g. the chat input). */
class BorderedBox implements Component {
  constructor(
    private readonly child: Component,
    private readonly frame: (text: string) => string = (text) => text,
  ) {}

  invalidate(): void {
    this.child.invalidate?.()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    const content = this.child.render(innerWidth).map((line) => {
      const clipped = visibleWidth(line) > innerWidth ? truncateToWidth(line, innerWidth) : line
      const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))
      return `${this.frame('│')} ${clipped}${padding} ${this.frame('│')}`
    })
    const horizontal = '─'.repeat(Math.max(0, width - 2))
    return [
      this.frame(`╭${horizontal}╮`),
      ...content,
      this.frame(`╰${horizontal}╯`),
    ]
  }
}

export class AgentTui {
  private readonly terminal: ProcessTerminal
  private readonly ui: TuiMainScreen | TuiAltScreen
  private readonly answers = new Container()
  private readonly loader: Loader
  /** Container the loader is attached to while a run is in flight. */
  private readonly loaderHost: Container
  private readonly input?: Input
  private loaderActive = false
  private activeRowText: Text | null = null
  private activeRowLabel = ''
  private streamText: Text | null = null
  private started = false

  constructor(model: string, baseUrl: string, options: AgentTuiOptions = {}) {
    const showHardwareCursor = process.env['PI_HARDWARE_CURSOR'] === '1'
    this.terminal = new ProcessTerminal()
    const header = new Text(theme.bold(`mortis — ${model} @ ${baseUrl}`), 0, 0)

    if (options.interactive) {
      const ui = new TuiAltScreen(this.terminal, showHardwareCursor || undefined)
      this.ui = ui
      this.loader = new Loader(ui, theme.primary, theme.muted, '', { frames: SPINNER_FRAMES })
      // Empty containers render zero lines, so the status row collapses when
      // the loader is detached and the layout stays stable while it spins.
      const statusRow = new Container()
      this.loaderHost = statusRow
      const input = new Input()
      this.input = input
      const bottom = new Container()
      bottom.addChild(statusRow)
      bottom.addChild(new BorderedBox(new BareInput(input), theme.muted))
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
        this.activeRowText = null
        this.streamText = null
        this.startLoader('thinking…')
        break
      case 'assistant_text':
        if (!this.streamText) {
          this.streamText = new Text('', 1, 0)
          this.answers.addChild(this.streamText)
          this.startLoader('composing…')
        }
        this.streamText.setText(event.content)
        break
      case 'tool_start': {
        this.streamText = null
        const label = `${event.toolName}${event.argsSummary ? ` ${event.argsSummary}` : ''}`
        const row = new Text(`  ${label}`, 0, 0)
        this.answers.addChild(row)
        this.activeRowText = row
        this.activeRowLabel = label
        this.startLoader(label)
        break
      }
      case 'tool_result': {
        if (this.activeRowText) {
          this.activeRowText.setText(truncateToWidth(
            `${theme.ok('✓')} ${this.activeRowLabel}`,
            this.terminal.columns,
          ))
        }
        if (event.resultSummary) {
          this.answers.addChild(new Text(`    ${theme.muted(event.resultSummary)}`, 0, 0))
        }
        this.activeRowText = null
        this.startLoader('thinking…')
        break
      }
    }
    this.ui.requestRender()
  }

  private finalizeAnswer(answer: string): void {
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

  private wireInput(runPrompt: (prompt: string) => Promise<string>): Input {
    const input = this.input
    if (!input) throw new Error('wireInput requires the interactive layout')

    this.ui.setFocus(input)

    let running = false
    input.onSubmit = (text: string) => {
      const prompt = text.trim()
      if (!prompt) return
      if (running) {
        // A turn is in flight: keep the typed text so it is not lost, and let
        // the user resubmit once the run finishes.
        this.startLoader('busy…')
        return
      }
      running = true

      input.setValue('')

      this.activeRowText = null
      this.streamText = null
      this.answers.addChild(new Text(theme.bold(theme.yellow(`> ${prompt}`)), 1, 0))
      this.ui.requestRender()

      void runPrompt(prompt)
        .then((answer) => { this.finalizeAnswer(answer) })
        .catch((error: unknown) => {
          this.answers.addChild(new Text(theme.error(`error: ${(error as Error).message}`), 1, 1))
          this.stopLoader()
        })
        .finally(() => { running = false; this.ui.requestRender() })
    }
    return input
  }

  async startInteractive(runPrompt: (prompt: string) => Promise<string>): Promise<void> {
    this.start()
    return new Promise<void>((resolve) => {
      const exit = () => { this.stop(); resolve(); process.exit(0) }
      const input = this.wireInput(runPrompt)

      this.ui.addInputListener((data) => {
        if (matchesKey(data, 'ctrl+d') || matchesKey(data, 'ctrl+c')) { exit(); return { consume: true } }
        // /q is matched against the input's real value, so paste and cursor
        // movement cannot desynchronize the check. The listener runs before
        // the focused Input, so consuming Enter keeps /q away from onSubmit.
        if ((data === '\r' || data === '\n') && input.getValue().trim() === '/q') {
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
