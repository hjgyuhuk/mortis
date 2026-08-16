---
name: context
description: Static system invariants, architecture.
---

# Goal
- Minimal coding agent learning project
- OpenAI-compatible custom provider with streaming support
- Chat-style interactive TUI: scrolling transcript, accumulating answers, boxed input

# Invariants & Constraints (Universal Properties)

Six core invariants (see AGENTS.md for the full contract):
1. State is plain, serializable data (messages + derived status)
2. reduce() is the only state mutation authority
3. Decision describes intent, never executes; Effects never mutate state
4. Effects may run concurrently; transitions are serial and deterministic (concurrent execution, ordered commit)
5. Scopes own effect lifetimes; run end must clean up (Agent > Run > Effect parent chain)
6. Agent core knows no TUI / Persistence / Runtime — they observe state/events
7. History is append-only: every event (incl. interrupt fill / awaiting_user) only appends; request prefix stays byte-stable so provider prefix caching hits. System prompt is built once per process; --continue restores snapshot messages verbatim

- [Type System] strict + noUncheckedIndexedAccess, types as contracts
- [Wire Format] Messages mirror OpenAI wire vocabulary; omit `tools` field when empty
- [Event Contract] Events are specific discriminated unions — no catch-all (string type + unknown payload)
- [Status Guarantee] Any state with status !== 'running' is directly sendable; run_interrupted/awaiting_user fill dangling tool calls
- [Cancellation Layers] effects see AbortError → loop maps to RunInterruptedError → UI maps to a notice
- [Config Hygiene] apiKey is never auto-persisted; explicit `--init` is the only path that writes a key
- [Snapshot Format] SessionSnapshot {version, model, messages, savedAt}; hydrate validates and skips unknown versions
- [Typecheck] `pnpm typecheck` runs both tsconfig.json (src) and tsconfig.test.json (test)

# Critical Environment & Boundaries
- [Runtime] Node.js >=22.19.0, pnpm 10.33.0
- [TUI] pi-tui 0.84.2. Interactive = TuiAltScreen chat layout; oneshot = TuiMainScreen. Ctrl+C interrupts a running turn (idle: exits); scroll: wheel/PageUp/Home/End; search: Ctrl+Shift+F; exit: /q, Ctrl+D
- [Security] No sandbox: write/edit/bash accept arbitrary absolute paths
- [Testing] vitest with local mock HTTP servers and scripted mock providers; reducer has property-style invariant tests
- [Config] `~/.mortis/` (config.json + sessions/latest.json) + env vars; precedence CLI > env > file > defaults

# Architecture
```
src/
├── types.ts           # Message, Tool(+ToolContext), Decision, Effect, ChatProvider
├── config.ts          # Config resolution; defaultSystemPrompt(tools, agentsMd)
├── instructions.ts    # AGENTS.md discovery (global + git root→cwd), findGitRoot
├── agent/
│   ├── state.ts       # AgentState{messages,status} + reduce + isSendable (invariants)
│   ├── loop.ts        # Agent: run → think(Decision) → act(effects); RunInterruptedError
│   ├── scope.ts       # Scope: parent-linked abort (fork/abort/dispose)
│   └── events.ts      # Domain AgentEvent (no UI semantics)
├── provider/
│   └── openai.ts      # OpenAIProvider: SSE parsing, signal cancellation, JSON fallback
├── tools/
│   └── index.ts       # read (64KiB cap), write, edit (unique match), bash (timeout+signal)
├── session.ts         # SessionSnapshot v1 + latest.json checkpoint (hydrate/serialize)
├── tui/
│   └── index.ts       # AgentTui dual layout + BorderedBox/BareInput; derives UI from events
├── cli.ts             # CLI entrypoint: flags, --continue, checkpoint observer
└── index.ts           # Public library surface
test/                  # vitest: agent, provider, tools, tui, instructions, config, state, scope, session
tsconfig.test.json     # noEmit typecheck for test/
```
