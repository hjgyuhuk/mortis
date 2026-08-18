# Mortis — A Minimal Coding Agent

[English](./README.md) | [中文](./README.zh_CN.md)

A minimal coding agent built as a learning project. Core loop: **receive prompt → call LLM → execute tools → feed results back → repeat until done** — wrapped in a small state machine with structured effect lifetimes.

No multi-session management, no complex scoping: just one runnable, testable, minimal loop.

## Highlights

- **Side effects are the first-class concern**: a small state machine (`State → think → Decision → act → reduce`) where the reducer is the only mutation authority; tool calls run concurrently but commit in declaration order; normal history is append-only and prefix-cache friendly
- **Bounded context**: the Agent grants a private lease, then the main agent authorizes `compact_context`. Its direct Effect preserves the system root and replaces all other history with one untrusted summary. Compact is irreversible and has no undo or revision store
- **Full effect-lifecycle management**: parent-linked cancellation scopes (Agent > Run > Effect); Esc/Ctrl+C interrupt any run mid-flight, cancelling in-flight model requests and child processes while the session stays usable; interruption is a real state transition, not error handling
- **Contained effects**: a five-zone filesystem policy (custom R/RW/DENY > secrets > workspace > scratch > outside) strictly enforced on read/write/edit, and bash runs inside an OS-generated sandbox (macOS Seatbelt / Linux bubblewrap) derived from the same policy
- **Personas — cognition without side effects**: user-editable markdown cognitive roles in `~/.mortis/persona/*.md` that think and never act, returning structured evidence (Conclusion / Evidence / Proposal / Uncertainty / Effort); `/planner` hands the evidence to the main agent, which always asks the user before executing and writes the code itself
- **Human in the loop**: `ask_user` dialogs (Approve / Reject / Revise, keyboard-selected) gate risky decisions
- Streaming OpenAI-compatible provider with reasoning display, a chat-style TUI, and per-transition session checkpoints round out the loop

## Structure

```
src/
├── types.ts           # Message, Tool(+ToolContext), Decision, Effect, ChatProvider
├── config.ts          # Config resolution; defaultSystemPrompt(tools, agentsMd)
├── context.ts         # Direct compact action, context estimate, untrusted record envelope
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
  "model": "longcat/longcat-2.0",
  "providers": {
    "longcat": {
      "type": "openai",
      "apiKey": "xxxxx",
      "baseUrl": "https://api.longcat.chat/openai/v1"
    },
    "opencode": {
      "type": "openai",
      "apiKey": "xxxxx",
      "baseUrl": "https://opencode.ai/zen/v1"
    }
  },
  "models": {
    "longcat/longcat-2.0": {
      "provider": "longcat",
      "model": "LongCat-2.0",
      "maxContextSize": 1048576,
      "maxOutputSize": 131072,
      "capabilities": ["thinking", "tool_use"],
      "displayName": "LongCat-2.0"
    },
    "opencode/gpt-5.5-pro": {
      "provider": "opencode",
      "model": "gpt-5.5-pro",
      "maxContextSize": 1050000,
      "maxInputSize": 922000,
      "maxOutputSize": 128000,
      "capabilities": ["image_in", "always_thinking", "tool_use"],
      "displayName": "GPT-5.5 Pro",
      "supportEfforts": ["medium", "high", "xhigh"]
    }
  },
  "filesystem": {
    "scratchDir": "/tmp",
    "rules": [
      { "path": "/data/projects", "access": "rw" },
      { "path": "/etc/ssl/private", "access": "deny" },
      { "path": "/var/log", "access": "r" }
    ]
  }
}
```

`providers` stores OpenAI-compatible connections. Each `models` key is a
model alias that selects one provider and one literal model ID. Top-level
`model` selects the main-agent alias. Persona frontmatter uses the same
model aliases. A literal top-level model keeps the existing single-provider
fallback fields: `baseUrl`, `apiKey`, and `thinkingEffort`.

The file remains JSON. The TOML-style names `api_key`, `base_url`, and
`max_context_size` map to `apiKey`, `baseUrl`, and `maxContextSize`.

| Option | CLI flag | Env var | Default |
|---|---|---|---|
| Base URL | `--base-url` | `MORTIS_BASE_URL` | `https://api.openai.com/v1` |
| Model | `--model` | `MORTIS_MODEL` | `gpt-4o-mini` |
| API Key | `--api-key` | `MORTIS_API_KEY` | none |
| Thinking effort | `--thinking-effort` | `MORTIS_THINKING_EFFORT` | not sent |
| TUI | `--plain` disables | — | enabled |

## Context compact

`compact_context` is the sole direct context replacement action. Before a
normal model request, Mortis estimates `JSON({ messages, tools })` at two
UTF-8 bytes per token. It grants the main agent a private, one-use lease when
the estimate reaches 80% of the configured input limit:

- Prefer a model alias `maxInputSize`.
- Otherwise reserve `maxOutputSize` from `maxContextSize`.
- Without either limit, do not preflight compact.

Only a request with a lease exposes `compact_context`, with no arguments and
no ordinary tools. The main agent must call it alone. Its direct Effect sends
complete non-system history to the user-editable `compact` persona as JSON.
The persona only returns summary data. It receives no lease, State, Effect, or
replacement interface. The Agent then immediately commits `context_compacted`.
The reducer keeps every leading system message and replaces the rest with one
`<mortis-compacted-context>` user record. The root prompt treats this record
as untrusted data, never as instructions.

Mixed, missing, or malformed direct actions discard the lease without changing
State. Persona errors, empty summaries, and cancellation do the same. A
provider context-limit error reports the error directly. Configure model
capacity metadata and compact before the threshold. Compact cannot be undone,
old messages are not persisted, and no revision UI exists.

In interactive mode, type `/compact` to request a manual lease before the
threshold fires. The command itself does not enter history. On success the
manual flow ends after its status record. An automatic flow continues the
original task after compaction. Tools and personas cannot request compaction.

## Terminal UI

Built on pi-tui. **Enabled by default**; `--plain` is the only off switch:

- No prompt argument drops into **interactive mode** (alt-screen chat layout): a **multi-line input box** — Enter submits, Shift+Enter breaks the line (`\`+Enter on terminals without Shift+Enter), ↑/↓ recalls history — with `/q` or Ctrl+D to exit and **answers accumulating** in a scrolling transcript
- **Esc interrupts the in-flight run immediately**: pending model requests and shell commands are cancelled and you are back in the input box; Ctrl+C interrupts too, and exits when idle
- Transcript scrolling: mouse wheel / PageUp / PageDown / Home / End, auto-following new output; `Ctrl+Shift+F` full-text search; on exit the complete transcript is printed into the terminal's scrollback
- **Thinking display**: model reasoning (`reasoning_content` / `reasoning` streams) shows as a live two-line preview above the input box while streaming, then settles into a gray `✻ thinking` block in the transcript; `--thinking-effort` controls reasoning effort
- **Context compact status**: compact flows show status rows only. The compact persona's internal output never enters the transcript
- **Ask-user panel (ask_user)**: the model can call the `ask_user` tool to ask you — a `✻ question` panel appears between the transcript and the input (markdown rendered, mouse-wheel scrollable) with `[ Approve ] [ Reject ] [ Revise ]` below; select with ↑/↓/←/→, confirm with Enter, Esc quick-rejects; on Revise the model wraps up and your next message is the correction; Ctrl+C interrupts the whole run
- Tool calls within one turn **run concurrently**, commit in declaration order, and each row shows ✓ / ✗
- A single prompt argument uses the main-screen streaming view: one row per tool call, ✓ and a result summary when done, final answer rendered as markdown

Implementation: the agent emits **domain events** (`model_request` / `context_compacting` / `context_compacted` / `assistant_thinking` / `assistant_text` / `tool_start` / `tool_result` / `run_interrupted`) via `onEvent`; `AgentTui` subscribes and derives all display concerns from them. Model and endpoint come from the resolved config only — no setup phase.

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
7. Normal history is append-only. The sole exception is an irreversible, main-agent-authorized `context_compacted` direct Effect, which keeps the system root and replaces all other messages with one untrusted user summary

Consequences:

- **Decision ≠ model output**: the model's response is interpreted as intent (`respond` / `execute` / `wait` / `finish`); tool calls are one kind of `Effect`
- **Interruption is a real transition**: `run_interrupted` appends synthetic results for dangling tool calls, so any non-running state is directly sendable and a session survives cancel/crash/resume
- **Cancellation is layer-mapped**: effects see a native `AbortError`, the loop raises `RunInterruptedError`, the UI renders a notice — no error class crosses all layers
- **Observers at the boundary**: the TUI and session persistence only observe; checkpoints (`SessionSnapshot` versioned, validated on hydrate) are written after every transition, so a crash loses at most the transition in flight
- **Explicit failure**: tools return error text to the model instead of throwing; timeouts and cancellation are built in (bash: default 120s, max 600s)
- **Tested as contracts**: mock HTTP servers for the provider, scripted providers for the loop, and property-based tests that replay random event sequences against the state invariants

## Personas (cognitive roles)

**Personas think, the main agent decides, effects change the world.** A persona is a cognitive viewpoint invoked temporarily: it has a model / prompt / context / budget but **no tools** — it cannot read files, run commands, or touch the network. Its output is structured evidence for a decision, not commands:

```
Conclusion  the recommended approach and why
Evidence    supporting observations (facts vs assumptions)
Proposal    an ordered, executable plan
Uncertainty what is unknown or risky, and how to resolve it
Effort      low | medium | high + expected scope
```

In interactive mode, type `/planner <task>`: the persona thinks first (streamed, reasoning included), then the **evidence is handed to the main agent, which decides** — the planner only provides an overview (steps, files, signatures, edge cases — never full implementation code), the main agent **always confirms with ask_user before executing**, and the main agent always writes the code itself. It may also reject, consult the persona again (the `persona` tool), or gather more information first. Esc/Ctrl+C interrupt either phase.

**Personas are user-editable markdown files** in `~/.mortis/persona/` (default `planner.md` and `compact.md` files are created on first run and never overwritten). Format: frontmatter (`name` / `description`, optional `model` / `thinking-effort` overrides) + the system prompt as the body:

```markdown
---
name: reviewer
description: Reviews code changes for bugs and style.
model: opencode/gpt-5.5-pro # optional: a config model alias or literal model
thinking-effort: high       # optional: different reasoning effort
---

You are Reviewer, a cognitive persona invoked by the Mortis main agent.
You think; you do not act. ...
```

When a persona uses an alias, it receives the referenced provider endpoint,
API key, literal model, and model metadata. Persona frontmatter
`thinking-effort` overrides the model default.

At startup every valid `*.md` in the directory is registered (broken files are skipped; a missing name falls back to the filename). The model can consult ordinary roles through the `persona` tool. `compact` is only reachable through a leased main-agent `compact_context` action. It summarizes history but cannot replace it directly.

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

## Filesystem Permissions

`read` / `write` / `edit` are strictly governed by a five-zone policy (`src/fs-policy.ts`):

| Precedence | Zone | Default | Access |
|---|---|---|---|
| 1 | custom | config.json `filesystem.rules` / CLI `--fs-rw` `--fs-r` `--fs-deny` | per rule: R / RW / DENY; longest prefix wins, overrides every built-in zone |
| 2 | secrets | `~/.ssh`, `~/.mortis` | all access denied |
| 3 | workspace | git root of cwd | read/write |
| 4 | scratch | `/tmp` (configurable via `--scratch` / `filesystem.scratchDir`) | read/write |
| 5 | outside | everything else | read-only |

Paths are canonicalized through `realpath`, so symlink escapes are detected. Denials are returned to the model as text it can react to.

## Security Boundary

The file tools (read/write/edit) are strictly governed by the five-zone policy; **bash is confined by an OS-level sandbox**:

- **macOS**: `sandbox-exec` (Seatbelt) — a global write deny with subpath allows for rw zones and read denies on denied zones, generated from the policy. Paths are realpath-normalized (the `/tmp` → `/private/tmp` alias is handled), so symlink escapes don't work; timeouts terminate the sandboxed child processes too
- **Linux**: bubblewrap (`bwrap`, must be installed) — read-only root bind, rw zones bind-mounted writable, denied zones masked with tmpfs
- **Unavailable or `--no-sandbox`**: honest degradation — a startup warning, and both the system prompt and the tool description state plainly that bash is unsandboxed

Seatbelt has known historical escapes; this is a strong constraint, not an absolute boundary. Stay careful with fully untrusted models.
