# Mortis — A Minimal Coding Agent

[English](./README.md) | [中文](./README.zh_CN.md)

A minimal coding agent built as a learning project. Core loop: **receive prompt → call LLM → execute tools → feed results back → repeat until done** — wrapped in a small state machine with structured effect lifetimes.

No multi-session management, no complex scoping: just one runnable, testable, minimal loop.

## Highlights

- **Streaming OpenAI-compatible provider** — SSE parsing, incremental tool-call stitching, non-SSE fallback, reasoning streams (`reasoning_content` / `reasoning`), cancellable via `AbortSignal`
- **Chat-style TUI** — alt-screen layout with a scrolling transcript, multi-line editor, live thinking preview, and per-tool rows; the full transcript is printed into scrollback on exit
- **Interruptible** — Ctrl+C cancels the in-flight model request and child processes, finalizes the state, and keeps the session usable
- **Parallel tools, deterministic state** — tool calls in one turn run concurrently but commit in declaration order; history is append-only so provider prefix caching keeps hitting
- **Session resume** — checkpoints on every state transition; `--continue` picks the conversation back up

## Structure

```
src/
├── types.ts           # Message, Tool(+ToolContext), Decision, Effect, ChatProvider
├── config.ts          # Config resolution; defaultSystemPrompt(tools, agentsMd)
├── instructions.ts    # AGENTS.md discovery (global + git root→cwd)
├── agent/
│   ├── state.ts       # AgentState + reduce() — the only mutation authority
│   ├── loop.ts        # Agent loop (think → act) + RunInterruptedError
│   ├── scope.ts       # Parent-linked cancellation scopes (Agent > Run > Effect)
│   └── events.ts      # Domain events (no UI semantics)
├── provider/
│   └── openai.ts      # OpenAI-compatible provider: SSE, tool-call stitching, reasoning
├── tools/
│   └── index.ts       # read / write / edit / bash
├── session.ts         # Versioned SessionSnapshot + latest.json checkpoints
├── tui/
│   └── index.ts       # pi-tui terminal UI (interactive chat + oneshot layouts)
├── cli.ts             # CLI entrypoint
└── index.ts           # Public library surface
test/                  # vitest suites, incl. property-based state invariants
```

## Usage

```sh
# Install
pnpm install

# Run against any OpenAI-compatible endpoint
MORTIS_BASE_URL=http://localhost:11434/v1 MORTIS_MODEL=qwen2.5-coder pnpm dev "write a README.md for this directory"

# Or with flags
pnpm build
node dist/cli.js --base-url http://localhost:11434/v1 --model qwen2.5-coder "list project files"

# Interactive TUI (alt-screen chat layout): type in the input box, Enter submits,
# /q or Ctrl+D exits; Ctrl+C interrupts the in-flight run and keeps the session
pnpm dev
pnpm dev "write fibonacci.ts and run it"
pnpm dev --plain "write fibonacci.ts and run it"

# Resume the latest session (checkpoints are written on every state transition)
pnpm dev --continue

# Control reasoning effort (sent as thinking_effort; also configurable via
# MORTIS_THINKING_EFFORT or ~/.mortis/config.json)
pnpm dev --thinking-effort high

# Tests
pnpm test
```

## Configuration

Config directory `~/.mortis`, config file `~/.mortis/config.json`. **First run creates both automatically** (only baseUrl and model are written; **apiKey is never auto-persisted** — keys from env vars or CLI flags live for that run only). No manual `--init` needed.

Precedence: **CLI args > environment variables > config file > defaults**.

```sh
# Initialize the config file explicitly; the first run does this too
pnpm dev --init --base-url http://localhost:11434/v1 --model qwen2.5-coder
```

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "qwen2.5-coder",
  "apiKey": "sk-...",
  "thinkingEffort": "high"
}
```

| Option | CLI flag | Env var | Default |
|---|---|---|---|
| Base URL | `--base-url` | `MORTIS_BASE_URL` | `https://api.openai.com/v1` |
| Model | `--model` | `MORTIS_MODEL` | `gpt-4o-mini` |
| API Key | `--api-key` | `MORTIS_API_KEY` | none |
| Thinking effort | `--thinking-effort` | `MORTIS_THINKING_EFFORT` | not sent |
| TUI | `--plain` disables | — | enabled |

## Terminal UI

Built on pi-tui. **Enabled by default**; `--plain` is the only off switch:

- No prompt argument drops into **interactive mode** (alt-screen chat layout): a **multi-line input box** — Enter submits, Shift+Enter breaks the line (`\`+Enter on terminals without Shift+Enter), ↑/↓ recalls history — with `/q` or Ctrl+D to exit and **answers accumulating** in a scrolling transcript
- **Ctrl+C interrupts the in-flight run**: pending model requests and shell commands are cancelled, the session survives, and you can keep asking; when idle, Ctrl+C exits
- Transcript scrolling: mouse wheel / PageUp / PageDown / Home / End, auto-following new output; `Ctrl+Shift+F` full-text search; on exit the complete transcript is printed into the terminal's scrollback
- **Thinking display**: model reasoning (`reasoning_content` / `reasoning` streams) shows as a live two-line preview above the input box while streaming, then settles into a gray `✻ thinking` block in the transcript; `--thinking-effort` controls reasoning effort
- Tool calls within one turn **run concurrently**, commit in declaration order, and each row shows ✓ / ✗
- A single prompt argument uses the main-screen streaming view: one row per tool call, ✓ and a result summary when done, final answer rendered as markdown

Implementation: the agent emits **domain events** (`model_request` / `assistant_thinking` / `assistant_text` / `tool_start` / `tool_result` / `run_interrupted`) via `onEvent`; `AgentTui` subscribes and derives all display concerns from them. Model and endpoint come from the resolved config only — no setup phase.

## Architecture

The core is a small state machine; everything else observes it:

```
State → think → Decision → act (effects) → results → reduce → State
```

Seven invariants (see [AGENTS.md](./AGENTS.md)):

1. State is plain, serializable data (`messages` + a derived `status`)
2. `reduce()` is the only state mutation authority
3. Decisions describe intent and never execute; Effects never mutate state
4. Effects may run concurrently; transitions are serial and deterministic — concurrent execution, ordered commit
5. Scopes own effect lifetimes; every run cleans up (Agent > Run > Effect parent chain)
6. The agent core knows no TUI, persistence, or runtime — they only observe state/events
7. History is append-only — every event (including interrupt fill) only appends, so request prefixes stay byte-stable and provider prefix caching keeps hitting

Consequences:

- **Decision ≠ model output**: the model's response is interpreted as intent (`respond` / `execute` / `wait` / `finish`); tool calls are one kind of `Effect`
- **Interruption is a real transition**: `run_interrupted` appends synthetic results for dangling tool calls, so any non-running state is directly sendable and a session survives cancel/crash/resume
- **Cancellation is layer-mapped**: effects see a native `AbortError`, the loop raises `RunInterruptedError`, the UI renders a notice — no error class crosses all layers
- **Observers at the boundary**: the TUI and session persistence only observe; checkpoints (`SessionSnapshot` versioned, validated on hydrate) are written after every transition, so a crash loses at most the transition in flight
- **Explicit failure**: tools return error text to the model instead of throwing; timeouts and cancellation are built in (bash: default 120s, max 600s)
- **Tested as contracts**: mock HTTP servers for the provider, scripted providers for the loop, and property-based tests that replay random event sequences against the state invariants

## Custom Providers

`ChatProvider` is the only abstraction. Any OpenAI-compatible endpoint works out of the box; other protocols implement the interface:

```ts
import type { ChatProvider, Message, StreamChunk, Tool } from 'mortis-agent'

class MyProvider implements ChatProvider {
  async *completeStream(messages: Message[], tools: Tool[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // your protocol: yield { kind: 'thinking' | 'text', delta } chunks, then
    // one { kind: 'tool_calls', tool_calls } chunk; honor the signal for cancel
  }
}
```

## Security Boundary

Mortis has **no sandbox**. The system prompt asks it to work inside the current repository, but `write` / `edit` / `bash` accept arbitrary absolute paths and run arbitrary shell commands with no path or permission restrictions. Run it only with models and endpoints you trust.
