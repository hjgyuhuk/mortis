---
name: code
description: Sparse directed semantic graph of the codebase. Keep only important code concepts and meaningful relationships to help an agent decide what to inspect next.
---

# Code Graph

Agent
├── owns → AgentState + AgentScope
├── runs → think() → Decision → act() → Effects
├── serializes → same-path write/edit effects; others run concurrently
├── grants → private ContextLease at threshold or `/compact`
├── executes → compaction directly (no model round-trip), single commit site
├── commits → reduce(StateEvent) in declaration order
├── aborts → RunScope → AbortError → run_interrupted
└── notifies → AgentEvent and transition observers

AgentState / reduce
├── owns → normal append-only Message history and derived status
├── accepts → context_compacted → system root + untrusted summary
├── fills → dangling tool calls on interruption or user wait
└── tested-by → seeded invariant sequences

Scope
├── forks → Agent, Run, and Effect child scopes
├── propagates → abort to descendants
└── disposes → lifetime links

ChatProvider
├── implemented-by → OpenAIProvider
└── returns → AsyncIterable<StreamChunk> with signal cancellation

OpenAIProvider
├── parses → SSE and non-SSE JSON
├── streams → text and thinking chunks
├── stitches → fragmented tool calls by index
├── retries → connection-phase network / 429 / 5xx failures with backoff
└── reports → usage chunk carrying the endpoint's prompt_tokens

ContextRuntime
├── estimates → measured prompt_tokens, else UTF-8 request JSON / 2 tokens
├── splits → history into summarized prefix + self-contained kept tail
├── truncates → the persona transcript to the compact model's own budget
├── supplies → compact persona summary data to Agent
└── never → State replacement, lease creation, or provider-limit retry

Config
├── resolves → CLI, environment, file, and default settings
├── selects → main-agent model alias or literal model
├── expands → ModelConfig → ProviderConfig → ResolvedModel
└── supplies → main-agent and persona provider settings

FilesystemPolicy
├── classifies → custom, secrets, workspace, scratch, and outside zones
├── guards → read, write, and edit tools
└── generates → sandbox writable and denied roots

Sandbox
├── wraps → bash with Seatbelt or bubblewrap
└── falls-back → honest unsandboxed runtime warning

Persona
├── loads → `~/.mortis/persona/*.md`
├── runs → one completion without tools
├── parses → conclusion, evidence, proposal, uncertainty, and effort
├── returns → evidence for the main agent or persona tool
└── provides → lease-authorized compact summary data

CLI
├── builds → Config → ContextRuntime → FilesystemPolicy → Sandbox → bound Tools
├── wires → Agent, TUI, Session, transition checkpointing, and the approval gate
└── dispatches → `/planner`, `/compact`, `/sessions`, `/resume <id>`, and model-side `persona`

Session
├── serializes → SessionSnapshot{version:1}
├── stores → one `<id>.json` per session + index.json (title, latest pointer)
├── checkpoints → atomically (temp file + rename)
├── archives → latest.pre-compact.json before each compaction commit
└── resumes → `--continue` (latest) or `/resume <id>`, status reset to idle

AgentTui
├── consumes → domain AgentEvent
├── renders → transcript, reasoning, tool rows, and ask_user panel
└── handles → multiline input, interrupt, search, scroll, and exit

# Source Paths

Agent / RunInterruptedError → src/agent/loop.ts
AgentState / reduce / isSendable → src/agent/state.ts
Scope → src/agent/scope.ts
AgentEvent → src/agent/events.ts
ContextRuntime / ContextCompactor → src/context.ts
ChatProvider / Decision / Effect → src/types.ts
OpenAIProvider / ProviderHttpError → src/provider/openai.ts
FilesystemPolicy → src/fs-policy.ts
SandboxRunner → src/sandbox.ts
PersonaDefinition / COMPACT / personaTool → src/persona.ts
Config / ProviderConfig / ModelConfig / resolveModelRef → src/config.ts
builtinTools / askUserTool → src/tools/index.ts
Session → src/session.ts
AgentTui → src/tui/index.ts
loadAgentsMd → src/instructions.ts
CLI wiring → src/cli.ts
