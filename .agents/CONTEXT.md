---
name: context
description: Static system invariants, architecture.
---

# Goal

- Build a minimal coding agent learning project.
- Support OpenAI-compatible streaming providers and tool calls.
- Provide interactive TUI and plain CLI modes.
- Let user-editable personas return planning evidence without tools.
- Enforce filesystem access through policy checks and an OS sandbox when available.

# Invariants & Constraints (Universal Properties)

- [State] State is plain, serializable data.
- [Reducer] `reduce()` is the only state mutation authority.
- [Decision] A Decision describes intent and never executes side effects.
- [Effect] Effects never mutate State directly.
- [Determinism] Effects may run concurrently, but transitions commit serially in declaration order.
- [Scope] Scope owns effect lifetime through the Agent > Run > Effect parent chain.
- [Boundary] Agent Core knows no TUI, persistence, or concrete runtime.
- [History] Normal conversation transitions append only. `context_compacted` is the sole irreversible replacement transition: it preserves the leading system root, replaces the summarized prefix with one untrusted user record, and keeps a self-contained verbatim tail.
- [Context] The Agent grants a private one-use lease only at the capacity threshold or interactive `/compact`, then executes compaction directly — no model round-trip. The persona receives only the prefix transcript (truncated to its own model budget) and never receives a lease, State, or replacement authority.
- [Sendability] Any non-running state can be sent. Interrupt and user-wait transitions fill dangling tool calls.
- [Persona] Personas think without tools. The main agent decides and executes.
- [Types] TypeScript uses strict checking, `noUncheckedIndexedAccess`, NodeNext imports, and explicit wire types.
- [Events] Domain events are concrete discriminated unions.
- [Cancellation] AbortError maps to RunInterruptedError at the agent boundary and becomes a UI notice.
- [Config] API keys never persist during automatic config creation. Explicit `--init` may write one.
- [Snapshot] Session snapshots use version 1, reject unknown versions, and write atomically via a temp file plus rename.

# Critical Environment & Boundaries

- [Runtime] Node.js >=22.19.0 and pnpm 10.33.0.
- [Provider] `OpenAIProvider` supports SSE and non-SSE JSON responses, preserves non-success HTTP status in `ProviderHttpError`, and retries connection-phase failures (network, 429, 5xx) with backoff; a started stream never retries.
- [Context] Preflight prefers the provider's last reported `prompt_tokens`, falling back to the conservative UTF-8 JSON byte estimate at 80% of `maxInputSize`, or `maxContextSize - maxOutputSize`. Missing metadata disables preflight. Provider context-limit errors do not compact or retry.
- [TUI] Interactive mode uses pi-tui AltScreen with a scrolling transcript and multiline Editor.
- [Filesystem] Read, write, and edit enforce FilesystemPolicy. Workspace and scratch are writable by default.
- [Sandbox] Bash uses Seatbelt on macOS or bubblewrap on Linux when available. The CLI reports unsandboxed fallback honestly.
- [Config] Config lives under `~/.mortis`. Resolution order is CLI > environment > file > defaults.
- [Models] `providers` stores OpenAI-compatible connections. `models` maps aliases to providers, literal model IDs, and model metadata.
- [Personas] Persona files live under `~/.mortis/persona/*.md`. Default planner and compact files never overwrite user edits. Compact is reachable only through the leased main-agent action.
- [Testing] Vitest uses local mock providers and HTTP servers. macOS runs Seatbelt enforcement tests.

# Architecture

```text
src/
├── types.ts           # Message, Tool, Decision, Effect, ChatProvider
├── config.ts          # Config resolution, provider and model aliases, system prompt
├── context.ts         # Compact capability, token estimate, untrusted context envelope
├── instructions.ts    # AGENTS.md discovery and git-root lookup
├── fs-policy.ts       # Custom, secret, workspace, scratch, outside zones
├── sandbox.ts         # Seatbelt and bubblewrap command wrappers
├── persona.ts         # Persona files, planner/compact, parsing, persona tool
├── agent/
│   ├── state.ts       # AgentState, StateEvent, reduce, sendability
│   ├── loop.ts        # Think, act, ordered effects, interruption
│   ├── scope.ts       # Parent-linked cancellation scopes
│   └── events.ts      # Domain AgentEvent union
├── provider/openai.ts # SSE parsing, reasoning, tool-call stitching
├── tools/index.ts     # Policy-bound read, write, edit, bash, ask_user
├── session.ts         # Versioned snapshot and latest checkpoint
├── tui/index.ts       # Interactive and oneshot terminal layouts
├── cli.ts             # Config, policy, sandbox, personas, runtime wiring
└── index.ts           # Public library surface
test/                  # Vitest coverage for the modules and invariants
```
