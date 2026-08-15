---
name: code
description: Sparse directed semantic graph of the codebase.
---

# Code Graph

Agent
├── uses → ChatProvider (completeStream)
├── uses → Tool[]
├── emits → AgentEvent
└── orchestrates → tool execution loop

ChatProvider
├── implemented-by → OpenAIProvider
└── returns → AsyncIterable<StreamChunk>

OpenAIProvider
├── parses → SSE stream (ssePayloads)
├── stitches → ToolCallBuilder (index fragments)
└── translates → WireMessage ↔ Message

AgentTui
├── consumes → AgentEvent
├── renders → StatusPanel (tool progress)
├── renders → Text (streaming) → Markdown (finalized)
└── owns → ProcessTerminal lifecycle

Config
├── resolves → CLI args > env vars > ~/.mortis/config.json > defaults
└── used-by → cli.ts → OpenAIProvider

# Key Relationships

Agent.run() ←→ provider.completeStream() ←→ SSE parsing
Agent.onEvent → AgentTui.handle → StatusPanel + streaming Text

Tool
├── read → readFile
├── write → writeFile
├── edit → readFile + replace + writeFile
└── bash → execFile

# Source Paths

Agent          → src/agent/loop.ts
AgentEvent     → src/agent/events.ts
ChatProvider   → src/types.ts
OpenAIProvider → src/provider/openai.ts
Tool           → src/types.ts
builtinTools   → src/tools/index.ts
AgentTui       → src/tui/index.ts
Config         → src/config.ts
cli.ts         → src/cli.ts
