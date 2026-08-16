---
name: code
description: Sparse directed semantic graph of the codebase. Keep only important code concepts and meaningful relationships to help an agent decide what to inspect next.
---

# Code Graph

Agent
├── owns → AgentState (via reduce only) + AgentScope
├── runs → think() → Decision; act() → effects (Promise.allSettled, ordered commit)
├── abort() → RunScope.abort → AbortError → run_interrupted → RunInterruptedError
└── notifies → onEvent (domain) + onTransition (state observers)

reduce / StateEvent
├── only-mutation-of → AgentState{messages, status}
├── derives → status from events (no transient fields)
├── run_interrupted / awaiting_user → fill dangling tool calls (isSendable guarantee)
└── tested-by → property-style invariant tests (seeded PRNG)

Scope
├── fork() → child (Agent > Run > Effect hierarchy)
├── abort(reason) → propagates to descendants
└── dispose() → detaches lifetime

Decision ← think interprets model output
├── respond / execute(effects) / wait / finish
Effect
└── tool_call (future: sub_agent, permission, sleep)

ChatProvider
├── implemented-by → OpenAIProvider
└── returns → AsyncIterable<StreamChunk>; signal cancels (AbortError)

OpenAIProvider
├── parses → SSE (ssePayloads, [DONE], \r\n, tail buffer)
├── stitches → ToolCallBuilder (index fragments, null-id tolerance)
└── falls-back → non-SSE JSON (array index as fragment index)

AgentTui
├── consumes → AgentEvent (domain only; derives spinner/truncation/markdown)
├── dual-layout → interactive (TuiAltScreen) | oneshot (TuiMainScreen)
├── interactive-tree → VStack[header, ScrollView(answers, follow:end), bottom(statusRow, multi-line Editor)]
├── tool rows → Map<toolCallId, {row, summary}> (parallel interleave; ✓/✗)
├── ctrl+c → busy ? onInterrupt(agent.abort) : exit
└── exits → /q (editor.getText()), Ctrl+D

Session (session.ts)
├── serializeState/hydrateState → SessionSnapshot{version:1}
├── checkpoint → saveSession latest.json (CLI onTransition observer)
└── latestSession → --continue resume (status reset idle)

Tool
├── read → readFile, 64KiB truncation
├── write → writeFile
├── edit → unique-match replace
└── bash → execFile, timeout s (120/600) + ToolContext.signal

Config → CLI > env > file > defaults; persists baseUrl/model only
loadAgentsMd → findGitRoot → root→leaf AGENTS.md → defaultSystemPrompt

# Source Paths

Agent / RunInterruptedError → src/agent/loop.ts
AgentState / reduce / isSendable → src/agent/state.ts
Scope        → src/agent/scope.ts
AgentEvent   → src/agent/events.ts
ChatProvider / Decision / Effect → src/types.ts
OpenAIProvider → src/provider/openai.ts
builtinTools   → src/tools/index.ts
AgentTui       → src/tui/index.ts
Session        → src/session.ts
Config         → src/config.ts
loadAgentsMd   → src/instructions.ts
cli.ts         → src/cli.ts
