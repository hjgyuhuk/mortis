/**
 * Terminal UI built on pi-tui.
 *
 * Component tree: header → answers (all dynamic content) → loader → input.
 * Each tool row is an independent Text component in `answers`, so pi-tui's
 * differential renderer sees stable indices and only rewrites changed lines.
 */

import {
  Container,
  Input,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Text,
  truncateToWidth,
  TuiMainScreen,
} from '@earendil-works/pi-tui'

import type { AgentEvent } from '../agent/events.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const theme = {
  primary: (text: string) => `\u001b[36m${text}\u001b[0m`,
  muted: (text: string) => `\u001b[2m${text}\u001b[0m`,
  ok: (text: string) => `\u001b[32m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  error: (text: string) => `\u001b[31m${text}\u001b[0m`,
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

function summarize(json: string, maxLength = 100): string {
  if (!json) return ''
  const singleLine = json.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine
}

function summarizeResult(result: string, maxLength = 160): string {
  const singleLine = result.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine
}

export class AgentTui {
  private readonly terminal: ProcessTerminal
  private readonly ui: TuiMainScreen
  private readonly column = new Container()
  private readonly answers = new Container()
  private readonly loader: Loader
  private loaderActive = false
  private activeRowText: Text | null = null
  private activeRowLabel = ''
  private streamText: Text | null = null
  private started = false

  constructor(private readonly model: string, private readonly baseUrl: string) {
    const showHardwareCursor = process.env['PI_HARDWARE_CURSOR'] === '1'
    this.terminal = new ProcessTerminal()
    this.ui = new TuiMainScreen(this.terminal, showHardwareCursor || undefined)
    this.loader = new Loader(this.ui, theme.primary, theme.muted, '', { frames: SPINNER_FRAMES })
    this.column.addChild(new Text(theme.bold(`mortis — ${model} @ ${baseUrl}`), 0, 0))
    this.column.addChild(this.answers)
    this.ui.addChild(this.column)
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
      case 'assistant_delta':
        if (!this.streamText) {
          this.streamText = new Text('', 1, 0)
          this.answers.addChild(this.streamText)
          this.startLoader('composing…')
        }
        this.streamText.setText(event.content)
        break
      case 'tool_start': {
        this.streamText = null
        const args = summarize(event.argsSummary)
        const label = `${event.toolName}${args ? ` ${args}` : ''}`
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
        const resultSummary = summarizeResult(event.resultSummary)
        if (resultSummary) {
          this.answers.addChild(new Text(`    ${theme.muted(resultSummary)}`, 0, 0))
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
    const input = new Input()
    this.column.addChild(input)
    this.ui.setFocus(input)

    let running = false
    input.onSubmit = (text: string) => {
      const prompt = text.trim()
      if (!prompt) return
      input.setValue('')
      if (running) return
      running = true

      this.stopLoader()
      this.answers.clear()
      this.answers.addChild(new Text(theme.bold(`> ${prompt}`), 1, 0))
      this.activeRowText = null
      this.streamText = null
      this.ui.requestRender()

      void runPrompt(prompt)
        .then((answer) => { this.finalizeAnswer(answer) })
        .catch((error: unknown) => {
          this.answers.addChild(new Text(theme.error(`error: ${(error as Error).message}`), 1, 1))
        })
        .finally(() => { running = false; this.ui.requestRender() })
    }
    return input
  }

  async startInteractive(runPrompt: (prompt: string) => Promise<string>): Promise<void> {
    this.start()
    return new Promise<void>((resolve) => {
      const exit = () => { this.stop(); resolve(); process.exit(0) }
      this.wireInput(runPrompt)

      let slashBuffer = ''
      this.ui.addInputListener((data) => {
        if (matchesKey(data, 'ctrl+d')) { exit(); return { consume: true } }
        if (data === '\r' || data === '\n') {
          if (slashBuffer.trim() === '/q') { slashBuffer = ''; exit(); return { consume: true } }
          slashBuffer = ''
        } else if (data.length === 1 && data >= ' ') {
          slashBuffer += data
        } else if (data === '\x7f' || data === '\b') {
          slashBuffer = slashBuffer.slice(0, -1)
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
      this.column.addChild(this.loader)
      this.loaderActive = true
    }
    this.loader.start()
  }

  private stopLoader(): void {
    this.loader.stop()
    if (this.loaderActive) {
      this.column.removeChild(this.loader)
      this.loaderActive = false
    }
  }
}
