/**
 * Terminal UI built on pi-tui.
 *
 * structure: a `ProcessTerminal` + `TUI` pair owns the
 * screen, a status panel component shows the tool-call log with a spinning
 * loader, and the final answer renders as markdown. When stdout is not a TTY
 * or `--plain` is set, the CLI skips the UI entirely.
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
  type Component,
} from '@earendil-works/pi-tui';

import type { AgentEvent } from '../agent/events.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface ToolRow {
  toolName: string;
  argsSummary: string;
  done: boolean;
  resultSummary?: string;
}

/** Small lexical theme applied through SGR sequences (dark-terminal friendly). */
const theme = {
  primary: (text: string) => `\u001b[36m${text}\u001b[0m`,
  muted: (text: string) => `\u001b[2m${text}\u001b[0m`,
  ok: (text: string) => `\u001b[32m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  error: (text: string) => `\u001b[31m${text}\u001b[0m`,
};

/** Minimal markdown theme for the final answer. */
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
};

/** One-line summary of tool arguments for the status panel. */
function summarize(json: string, maxLength = 100): string {
  if (!json) return '';
  const singleLine = json.replace(/\s+/g, ' ').trim();
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine;
}

/** One-line summary of a tool result. */
function summarizeResult(result: string, maxLength = 160): string {
  const singleLine = result.replace(/\s+/g, ' ').trim();
  return singleLine.length > maxLength ? singleLine.slice(0, maxLength) + '…' : singleLine;
}

/**
 * Status panel: a header line plus one row per tool call. The in-flight row
 * shows a spinner; completed rows show a check mark and a one-line result.
 */
class StatusPanel implements Component {
  private readonly headerText = new Text('', 0, 0);
  private readonly loader: Loader;
  private rows: ToolRow[] = [];

  constructor(ui: TuiMainScreen, model: string, baseUrl: string) {
    this.headerText.setText(theme.bold(`mortis — ${model} @ ${baseUrl}`));
    this.loader = new Loader(ui, theme.primary, theme.muted, '', { frames: [] });
  }

  invalidate(): void {
    this.headerText.invalidate();
    this.loader.invalidate();
  }

  setPending(): void {
    this.loader.stop();
  }

  toolStart(name: string, argsSummary: string): void {
    this.rows.push({ toolName: name, argsSummary, done: false });
    this.loader.start();
  }

  setActiveLabel(label: string): void {
    this.loader.setMessage(label);
  }

  toolResult(resultSummary: string): void {
    const row = this.rows[this.rows.length - 1];
    if (row) {
      row.done = true;
      row.resultSummary = summarizeResult(resultSummary);
    }
    this.loader.stop();
  }

  /** Clear all tool rows for a fresh turn. */
  reset(): void {
    this.rows = [];
    this.loader.stop();
  }

  render(width: number): string[] {
    const lines: string[] = this.headerText.render(width);

    for (const row of this.rows) {
      if (row.done) {
        lines.push(truncateToWidth(`${theme.ok('✓')} ${row.toolName} ${row.argsSummary}`, width));
        if (row.resultSummary) lines.push(truncateToWidth(`  ${theme.muted(row.resultSummary)}`, width));
      }
    }

    const active = this.rows[this.rows.length - 1];
    if (active && !active.done) {
      this.loader.setMessage(`${active.toolName} ${active.argsSummary}`);
      lines.push(...this.loader.render(width));
    }
    return lines;
  }
}

/**
 * pi-tui driven agent UI. Owns the terminal lifecycle: `start()` puts the
 * terminal in raw mode, `handle()` feeds agent events, `finish()` renders the
 * answer as markdown, and `stop()` restores the terminal.
 *
 * `startInteractive()` opens a chat loop: the panel shows tool activity, an
 * input box collects the next prompt, and answers accumulate as markdown.
 */
export class AgentTui {
  private readonly terminal: ProcessTerminal;
  private readonly ui: TuiMainScreen;
  private readonly panel: StatusPanel;
  private readonly column = new Container();
  private readonly answers = new Container();
  private started = false;
  /** Text component streaming the current answer; null while the model works. */
  private streamText: Text | null = null;

  constructor(model: string, baseUrl: string) {
    const showHardwareCursor = process.env['PI_HARDWARE_CURSOR'] === '1';
    this.terminal = new ProcessTerminal();
    this.ui = new TuiMainScreen(this.terminal, showHardwareCursor || undefined);
    this.panel = new StatusPanel(this.ui, model, baseUrl);
    this.column.addChild(this.panel);
    this.column.addChild(this.answers);
    this.ui.addChild(this.column);
  }

  /** Put the terminal in raw mode and render the initial state. */
  start(): void {
    this.panel.setPending();
    this.ui.start();
    this.started = true;
  }

  /** Feed one agent event into the UI. */
  handle(event: AgentEvent): void {
    switch (event.kind) {
      case 'model_request':
        // A new model turn starts: clear stale tool rows from the previous turn.
        this.panel.reset();
        this.streamText = null;
        break;
      case 'assistant_delta':
        if (!this.streamText) {
          this.streamText = new Text('', 1, 0);
          this.answers.addChild(this.streamText);
        }
        this.streamText.setText(event.content);
        break;
      case 'tool_start':
        this.panel.toolStart(event.toolName, summarize(event.argsSummary));
        this.streamText = null;
        break;
      case 'tool_result':
        this.panel.toolResult(event.resultSummary);
        break;
    }
    this.ui.requestRender();
  }

  /** Replace the streamed text (if any) with a finalized markdown answer. */
  private finalizeAnswer(answer: string): void {
    if (this.streamText) {
      this.answers.removeChild(this.streamText);
      this.streamText = null;
    }
    this.answers.addChild(new Markdown(answer, 1, 1, markdownTheme));
    this.ui.requestRender();
  }

  /** Render the final answer as markdown, then stop and restore the terminal. */
  finish(answer: string): void {
    if (!this.started) return;
    this.finalizeAnswer(answer);
    this.ui.requestRender(true);
    this.stop();
  }

  /**
   * Build the prompt input box and wire submission to `runPrompt`. Answer turns
   * accumulate beneath the status panel. Typing `/q` invokes `onExit`. Does not
   * put the terminal in raw mode—call `start()` first for a live session.
   */
  private wireInput(runPrompt: (prompt: string) => Promise<string>, onExit: () => void): Input {
    const input = new Input();
    this.column.addChild(input);
    this.ui.setFocus(input);

    let running = false;
    input.onSubmit = (text: string) => {
      const prompt = text.trim();
      if (!prompt) return;
      input.setValue('');
      if (prompt === '/q') {
        onExit();
        return;
      }
      if (running) return;
      running = true;
      this.panel.reset();
      // Clear old answers from previous turns.
      this.answers.clear();
      this.answers.addChild(new Text(theme.bold(`> ${prompt}`), 1, 0));
      this.ui.requestRender();
      void runPrompt(prompt)
        .then((answer) => {
          this.finalizeAnswer(answer);
        })
        .catch((error: unknown) => {
          this.answers.addChild(new Text(theme.error(`error: ${(error as Error).message}`), 1, 1));
        })
        .finally(() => {
          running = false;
          this.ui.requestRender();
        });
    };
    return input;
  }

  /**
   * Run an interactive chat loop. Each submitted prompt triggers `runPrompt`;
   * the returned text renders as a markdown answer. The input box stays open
   * for the next prompt. The returned promise resolves when the user exits
   * with `/q` or Ctrl+D.
   */
  async startInteractive(runPrompt: (prompt: string) => Promise<string>): Promise<void> {
    this.start();
    return new Promise<void>((resolve) => {
      this.wireInput(runPrompt, () => {
        this.stop();
        resolve();
      });
      this.ui.addInputListener((data) => {
        if (matchesKey(data, 'ctrl+d')) {
          this.stop();
          resolve();
          return { consume: true };
        }
        return undefined;
      });
    });
  }

  /** Restore the terminal and raw-mode state. */
  stop(): void {
    if (!this.started) return;
    this.ui.stop();
    this.started = false;
  }
}