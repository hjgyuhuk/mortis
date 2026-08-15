---
name: context
description: Static system invariants, architecture.
---

# Goal
- Minimal coding agent learning project
- OpenAI-compatible custom provider with streaming support

# Invariants & Constraints (Universal Properties)
- [Type System] strict + noUncheckedIndexedAccess, types as contracts
- [Wire Format] Messages mirror OpenAI wire vocabulary (system/user/assistant/tool)
- [Import Style] Relative imports with `.js` extension (NodeNext + verbatimModuleSyntax)
- [Tool Contract] Tools return text to model on failure, never throw exceptions
- [Provider Contract] `completeStream` returns `AsyncIterable<StreamChunk>` (text deltas or final tool_calls)

# Critical Environment & Boundaries
- [Runtime] Node.js >=22.19.0, pnpm 10.33.0
- [TUI] pi-tui 0.84.2 for terminal UI
- [Testing] vitest with local mock HTTP servers for provider tests
- [Config] `~/.mortis/config.json` + env vars (MORTIS_BASE_URL, MORTIS_MODEL, MORTIS_API_KEY)

# Architecture
```
src/
├── types.ts           # Message, Tool, ChatProvider, StreamChunk
├── config.ts          # Config resolution: CLI > env > file > defaults
├── agent/
│   ├── loop.ts        # Agent class: run() → completeStream + tool execution
│   └── events.ts      # AgentEvent union type
├── provider/
│   └── openai.ts      # OpenAIProvider: SSE parsing, tool-call stitching
├── tools/
│   └── index.ts       # read, write, edit, bash tools
├── tui/
│   └── index.ts       # AgentTui: StatusPanel + streaming Text → Markdown
├── cli.ts             # CLI entrypoint: parse flags, resolve config, run agent
└── index.ts           # Public library surface
```
