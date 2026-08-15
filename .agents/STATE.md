---
name: state
description: Dynamic progress, lessons learned, and next steps.
---

# Active Phase & Focus

* Current: Streaming implementation complete, bug fixes validated

# Progress

## Done

* [Streaming Architecture] `ChatProvider` changed to `completeStream()` returning `AsyncIterable<StreamChunk>` — 29 tests pass
* [SSE Parser] Manual SSE parsing with UTF-8 cross-chunk handling, `[DONE]` marker, fallback to JSON
* [Tool-call Stitching] `ToolCallBuilder` accumulates index fragments, handles `id:null`/`name:null` from mimo-v2.5
* [Agent Loop] Consumes stream, emits `assistant_delta` events with cumulative content
* [TUI Streaming] `Text` component for live updates, `finalizeAnswer` replaces with `Markdown`
* [Regression Test] Added test for `id:null` fragments in tool-call stitching

## In Progress

* None — streaming implementation complete

## Blocked

* None

# Lessons Learned

## ❌ Anti-patterns & Failed Hypotheses

* **Null vs Undefined in Wire Protocols** — OpenAI-compatible endpoints may send `null` for optional fields in SSE delta fragments (e.g., `id:null`, `name:null`), not just omit them. Using `!== undefined` fails to filter these; use `!= null` to catch both.

## ✅ Viable Paths & Confirmed Patterns

* **SSE Manual Parsing** — Hand-rolled SSE parser with `TextDecoder` + buffer splitting works reliably across chunk boundaries when using `{ stream: true }`.
* **Streaming Text → Markdown Finalization** — Use `Text` for incremental updates during streaming, then replace with `Markdown` in `finalizeAnswer()` for rich formatting without per-token reflow cost.
* **Tool-call Index Stitching** — Accumulate `delta.tool_calls` by index; first chunk carries `id`/`name`, subsequent chunks only `arguments`. Filter out `null` fields explicitly.

# Key Decisions & Trade-offs

* **Single `completeStream` method** — Replaced `complete()` with streaming-only interface. Non-SSE endpoints handled by reading full JSON and yielding a single chunk.
* **`assistant_delta` carries cumulative text** — TUI receives full text so far, not incremental deltas. Simplifies TUI logic (no accumulation needed), but means each delta is O(n) in text length.
* **`!= null` over `!== undefined`** — Defensive against wire formats that use `null` for absent optional fields.

# Immediate Next Steps

* None — core streaming implementation validated end-to-end
