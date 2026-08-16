---
name: context
description: Static system invariants, architecture.
---

# Goal
- Minimal coding agent learning project
- OpenAI-compatible custom provider with streaming support
- Chat-style interactive TUI: scrolling transcript, accumulating answers, boxed input

# Invariants & Constraints (Universal Properties)
- [Type System] strict + noUncheckedIndexedAccess, types as contracts
- [Wire Format] Messages mirror OpenAI wire vocabulary (system/user/assistant/tool)
- [Import Style] Relative imports with `.js` extension (NodeNext + verbatimModuleSyntax)
- [Tool Contract] Tools return text to model on failure, never throw exceptions
- [Provider Contract] `completeStream` returns `AsyncIterable<StreamChunk>` (text deltas, then one tool_calls chunk); omit the `tools` wire field when the list is empty
- [Config Hygiene] apiKey is never auto-persisted; `ensureFileConfig` writes baseUrl/model only. Explicit `--init` is the only path that writes a key
- [Typecheck] `pnpm typecheck` runs both tsconfig.json (src) and tsconfig.test.json (test)

# Critical Environment & Boundaries
- [Runtime] Node.js >=22.19.0, pnpm 10.33.0
- [TUI] pi-tui 0.84.2. Interactive = TuiAltScreen chat layout (ScrollView transcript, exit prints full transcript to scrollback); oneshot = TuiMainScreen. Scroll: wheel/PageUp/Home/End; search: Ctrl+Shift+F; exit: /q, Ctrl+C, Ctrl+D
- [Security] No sandbox: write/edit/bash accept arbitrary absolute paths
- [Testing] vitest with local mock HTTP servers and scripted mock providers; no real API calls
- [Config] `~/.mortis/config.json` + env vars (MORTIS_BASE_URL, MORTIS_MODEL, MORTIS_API_KEY); precedence CLI > env > file > defaults

# Architecture
```
src/
├── types.ts           # Message, Tool, ChatProvider, StreamChunk, ModelResponse
├── config.ts          # Config resolution; defaultSystemPrompt(tools, agentsMd)
├── instructions.ts    # AGENTS.md discovery (global + git root→cwd), findGitRoot
├── agent/
│   ├── loop.ts        # Agent: run() loop, maxTurns, event emission, tool dispatch
│   └── events.ts      # AgentEvent: model_request | assistant_text | tool_start | tool_result
├── provider/
│   └── openai.ts      # OpenAIProvider: SSE parsing, ToolCallBuilder, non-SSE JSON fallback
├── tools/
│   └── index.ts       # read (64KiB cap), write, edit (unique match), bash (timeout)
├── tui/
│   └── index.ts       # AgentTui dual layout + BorderedBox/BareInput wrappers
├── cli.ts             # CLI entrypoint: flags, config, TUI vs plain routing
└── index.ts           # Public library surface
test/                  # vitest: agent, provider, tools, tui, instructions, config
tsconfig.test.json     # noEmit typecheck for test/
```
