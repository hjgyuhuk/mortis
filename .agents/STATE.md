---
name: state
description: Dynamic progress, lessons learned, and next steps.
---

# Active Phase & Focus

* Current: TUI chat-layout refactor and full code-review fix pass complete; feature-complete for the minimal loop

# Progress

## Done

* [Code-review fixes] non-SSE multi tool_calls kept separate; empty `tools` omitted from wire; baseUrl strips all trailing slashes; SSE JSON.parse errors carry payload context — tests pass
* [Config hygiene] `ensureFileConfig` never persists apiKey — test asserts file has no key after env-key run
* [Tool hardening] edit requires unique match; read truncates at 64KiB; bash has timeout param (120s default, 600s max) — test/tools.test.ts (11 cases)
* [Event rename] `assistant_delta` → `assistant_text` (payload is cumulative text)
* [TUI refactor] interactive mode → TuiAltScreen chat layout: ScrollView transcript (follow:end), loader status row, boxed input; answers accumulate (removed `answers.clear()`); exit prints full transcript to scrollback — 61/61 tests, pty smoke verified
* [Input polish] BorderedBox frame + BareInput (no "> " prefix); prompt echo in dark yellow (ANSI 33); Ctrl+C exit added
* [System prompt] `defaultSystemPrompt(tools, agentsMd?)` builds tool list from actual Tools
* [Typecheck] tsconfig.test.json; `pnpm typecheck` covers src + test

## In Progress

* None

## Blocked

* None

# Lessons Learned (Monadic Abstraction)

## ❌ Anti-patterns & Failed Hypotheses

* **`basis: 0` in unbounded render** — pi-tui `VStack.render()` (used for the alt-screen exit document) gives grow entries their basis, clamped to minSize — official README pattern (`basis:0, grow:1`) silently truncates the exit transcript to 1 line — detected by asserting full content in `ui.render()` tests
* **Mirroring keystrokes to track input state** — manually accumulating a char buffer desyncs on paste/cursor movement — read `input.getValue()` at event time instead
* **Null vs undefined in wire protocols** — OpenAI-compatible endpoints send `id:null`/`name:null` in delta fragments; `!== undefined` fails to filter — use `!= null`

## ✅ Viable Paths & Confirmed Patterns

* **Alt-screen chat layout** — `TuiAltScreen` + `VStack[header, ScrollView(transcript, follow:'end', primary), bottom]`: in-session scrollback, Ctrl+Shift+F search, stable resize, full transcript printed to scrollback on exit. Transcript entry must use `basis:'auto', grow:1, shrink:1`
* **pi-tui input listener ordering** — `addInputListener` callbacks run before the focused component; `{consume:true}` intercepts keys (e.g. `/q` on Enter). Default `lineUp/lineDown` are unbound, so arrows reach the Input
* **Wrapping over forking** — `BareInput`/`BorderedBox` wrap pi-tui components (render at adjusted width, slice/pad, pass through invalidate) instead of duplicating component internals
* **SSE manual parsing** — TextDecoder + buffer splitting with `{stream:true}`, `[DONE]` marker, non-SSE JSON fallback
* **Streaming Text → Markdown finalization** — live `Text` during streaming, swap to `Markdown` in `finalizeAnswer()`
* **Tool-call index stitching** — accumulate by index; filter `null` fields; non-SSE path uses array index

# Key Decisions & Trade-offs

* **Transcript accumulation via alt screen (not main-screen scrollback)** — in-session scrolling/search, no resize scrollback wipe — rejected the 1-line `answers.clear()` removal for worse UX
* **`assistant_text` carries cumulative text** — TUI needs no accumulation; each event O(n) in text length
* **Empty containers render 0 lines in pi-tui** — status row with transient Loader collapses naturally; no placeholder needed

# Immediate Next Steps

* Optional: AbortSignal through `ChatProvider.completeStream` + cancel key in TUI (only remaining review item; changes public interface)
