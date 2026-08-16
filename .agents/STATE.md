---
name: state
description: Dynamic progress, lessons learned, and next steps.
---

# Active Phase & Focus

* Current: four-layer architecture refactor (State/Decision/Effect-Scope/Transition) complete per user's 14-point review

# Progress

## Done

* [Two-stage thinking display] live reasoning preview in the bottom area (below the loader's 'reasoning…', above the input; last two lines, long lines tail-truncated with leading ellipsis, zero lines when empty) commits to the transcript as a `✻ thinking` gray two-line block when thinking ends (first answer text / tool start / interrupt / finalize / error) — 98/98 tests, LongCat real-endpoint pty verified both stages
* [Thinking support] `thinking_effort` request field (CLI/env/config, omitted when unset) + reasoning streams parsed from `reasoning_content` (primary) and `reasoning` (alias), SSE and non-SSE; `assistant_thinking` domain event carries cumulative text; TUI shows `✻ thinking` dim-italic block with 'reasoning…' loader; reasoning never enters State (display-only) — 97/97 tests, real-endpoint pty verified (LongCat reasoning stream rendered)
* [Multi-line input] interactive editor replaced single-line Input: pi-tui Editor (Enter submits, Shift+Enter / backslash-Enter breaks line, up/down history, self-drawn frame, scrolls past ~30% terminal height); BorderedBox/BareInput wrappers deleted; busy path restores text via setText — 90/90 tests, pty verified two-line editing
* [Phase A: State + reducer] AgentState{messages, status} with derived status; StateEvent discriminated union; run_interrupted/awaiting_user fill dangling tool calls; loop split into think/act; all transitions via reduce — 90/90 tests
* [Phase B: Effect scope + cancellation] parent-linked Scope (fork/abort/dispose); completeStream/Tool.execute take optional signal (fetch + execFile native abort); layer-mapped cancellation (AbortError → RunInterruptedError → UI notice); Ctrl+C interrupts the running turn, idle exits — abort tests for provider/agent/tool pass
* [Phase C: concurrent effects, ordered commit] act uses Promise.allSettled, commits tool_result/tool_error in declaration order; abort is not committed as failure; TUI rows tracked by Map<toolCallId> with reserved summary lines and ✓/✗ — order test (B finishes first, commits second) passes
* [Phase D: sessions] SessionSnapshot{version:1} serialize/hydrate with validation (unknown versions → null); checkpoint on every transition via onTransition observer → ~/.mortis/sessions/latest.json; --continue resumes, header shows (resumed)
* [Invariants] property-style test: seeded PRNG event sequences → status valid, non-running states sendable, structuredClone-stable
* [Docs] AGENTS.md six invariants + responsibility boundaries; README architecture section; .agents/ synced

## In Progress

* None

## Blocked

* None

# Lessons Learned (Monadic Abstraction)

## ❌ Anti-patterns & Failed Hypotheses

* **Deriving 'done' from event shape alone** — plain assistant_message after unanswered tool calls claimed done but wasn't sendable — caught by the random-sequence invariant test; fix: done requires zero dangling calls
* **Committing by completion order** — real timing would leak into replay/snapshots/tests; commit in declaration order instead
* **Cancellation as tool failure** — an abort rejected by allSettled must propagate (run_interrupted), never commit as tool_error
* **`basis: 0` in unbounded render** — pi-tui exit document truncates grow entries to minSize; use `basis: 'auto'` for the transcript
* **Mirroring keystrokes to track input state** — read `input.getValue()` at event time
* **Null vs undefined in wire protocols** — use `!= null` for optional SSE fragment fields

## ✅ Viable Paths & Confirmed Patterns

* **Reducer-owns-invariant pattern** — transitions that leave 'running' (run_interrupted, awaiting_user) synthesize missing tool results inside reduce; helpers never patch messages from outside
* **Parent-linked Scope** — ~50 lines: fork for Agent/Run/Effect lifetimes, abort propagates down, dispose detaches; execFile/fetch accept signals natively so effects need no custom kill logic
* **allSettled + ordered commit loop** — concurrency inside act(), determinism at the transition boundary; first abort in declaration order re-thrown
* **Observers at the boundary** — onTransition drives checkpointing; the loop never knows persistence exists
* **Alt-screen chat layout** — TuiAltScreen + VStack[header, ScrollView(follow:end), bottom]; basis 'auto' for the transcript entry

# Key Decisions & Trade-offs

* **Status derived, not stored per-field** — State records what a resume needs; no currentTool/currentTurn transient detail
* **Single latest.json checkpoint (not timestamped files)** — per-transition writes would spam many files; one overwritten file gives crash-resilience at the same guarantee
* **agent_message plain text keeps 'running' when calls dangle** — never fabricate results for a finish; only interrupt/wait transitions synthesize
* **Domain events carry full tool content** — truncation moved back into the TUI (display concern), fixing the layering the earlier "double truncation" removal got wrong

# Immediate Next Steps

* Optional: fast-check for richer property tests; per-effect cancel handles (EffectHandle) when sub-agents arrive; respond/wait decisions are defined but no protocol produces them yet
