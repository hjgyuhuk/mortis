---
name: code
description: Sparse directed semantic graph of the codebase. Keep only important code concepts and meaningful relationships to help an agent decide what to inspect next.
---

# Code Graph

Agent
├── uses → ChatProvider (completeStream)
├── uses → Tool[]
├── emits → AgentEvent (assistant_text carries cumulative text)
└── executes → tools with JSON-parsed args; unknown tool → error text

ChatProvider
├── implemented-by → OpenAIProvider
└── returns → AsyncIterable<StreamChunk>

OpenAIProvider
├── parses → SSE stream (ssePayloads, [DONE], \r\n, tail buffer)
├── stitches → ToolCallBuilder (index fragments, null-id tolerance)
├── falls-back → non-SSE JSON (array index as fragment index)
└── translates → WireMessage ↔ Message

AgentTui
├── consumes → AgentEvent
├── dual-layout → interactive (TuiAltScreen) | oneshot (TuiMainScreen)
├── interactive-tree → VStack[header, ScrollView(answers, follow:end), bottom(statusRow, BorderedBox(BareInput))]
├── renders → Text (tool rows, yellow prompt echo) → Markdown (final answer)
├── loader → attached to loaderHost only while a run is active
└── exits → /q (input.getValue()), Ctrl+C, Ctrl+D

BorderedBox → wraps Component in rounded frame (width-safe, invalidate passthrough)
BareInput → strips Input's hardcoded "> " prefix (renders at width+2, slices)

Config
├── resolves → CLI args > env vars > ~/.mortis/config.json > defaults
├── persists → baseUrl/model only (never apiKey outside --init)
└── generates → defaultSystemPrompt(tools, agentsMd)

loadAgentsMd
├── walks → findGitRoot(cwd) → cwd, root→leaf AGENTS.md
└── feeds → defaultSystemPrompt via cli.ts

Tool
├── read → readFile, 64KiB truncation
├── write → writeFile
├── edit → unique-match replace (0 or >1 matches → error text)
└── bash → execFile /bin/sh -c, timeout seconds (default 120, max 600)

# Source Paths

Agent          → src/agent/loop.ts
AgentEvent     → src/agent/events.ts
ChatProvider   → src/types.ts
OpenAIProvider → src/provider/openai.ts
builtinTools   → src/tools/index.ts
AgentTui       → src/tui/index.ts
Config         → src/config.ts
loadAgentsMd   → src/instructions.ts
cli.ts         → src/cli.ts
