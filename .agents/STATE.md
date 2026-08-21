---
name: state
description: Dynamic progress, lessons learned, and next steps.
---

# Active Phase & Focus

* Current Sprint / Focus: Context-compaction architecture rework — runtime-owned direct execution (no model round-trip), split prefix/kept compaction, persona token budget guard, pre-compact forensic archive, stale-usage reset.
* Working tree: context, agent loop, state, session, cli, types, tests, and docs are modified and ready for review.

# Progress

## Done

* [Core architecture] State, reducer, ordered effects, scopes, sessions, TUI, filesystem policy, sandbox, and personas are implemented. [Verification Proof: prior feature milestones recorded 90/90 through 152/152 passing tests]
* [Multi-provider aliases] `providers` stores OpenAI connections. `models` maps each alias to a provider, literal model, and metadata. [Verification Proof: 19/19 config tests passed]
* [Main agent and persona] Top-level `Config.model` selects the main-agent alias. Persona `model` selects an independent alias or a literal model. [Verification Proof: dedicated LongCat and OpenCode resolution tests passed]
* [Safety] Automatic config creation removes top-level and provider API keys. [Verification Proof: provider-key persistence test passed]
* [Documentation] English and Chinese README files show the JSON equivalent of the multi-provider configuration. [Verification Proof: examples match `resolveConfig` and `resolveModelRef`]
* [Full regression before context compact] All test modules passed. [Verification Proof: `pnpm test` passed 159/159 tests]
* [Build] TypeScript build completed. [Verification Proof: `pnpm build` passed]
* [Diff hygiene] No whitespace errors exist in the working diff. [Verification Proof: `git diff --check` passed]
* [Lease-authorized compact] Agent creates one private lease only at the 80% threshold or `/compact`, then executes the direct action itself. [Superseded by runtime-owned compact below]
* [Persona boundary] The `compact` persona receives only structured non-system history and returns summary data. It never receives a lease, State, Effect, or replacement interface. [Verification Proof: ContextCompactor signature and Agent effect tests]
* [Atomic replacement] The authorized direct Effect calls the persona, then reducer commits the root-preserving untrusted summary. It stores no direct tool call or result. [Verification Proof: context reducer and Agent tests]
* [Capacity policy] Request JSON uses a conservative UTF-8 bytes/2 estimate. Compact triggers at 80% of `maxInputSize`, or `maxContextSize - maxOutputSize`. Missing metadata disables preflight. Provider context-limit errors do not retry or compact. [Verification Proof: context policy tests]
* [Failure boundaries] Missing, mixed, or malformed direct calls, persona failure, empty summary, cancellation, and provider context-limit errors retain current history. [Verification Proof: context Agent tests]
* [Compact persona] Default `compact.md` is generated without overwriting user edits. CLI uses its alias-aware model selection in interactive, TUI, and plain runs. [Verification Proof: persona and Agent tests]
* [Manual compact] Interactive `/compact` asks the main agent to authorize a lease. It never enters Agent history. [Verification Proof: manual compact test]
* [Final verification] Typecheck, build, full test suite, and diff whitespace check passed. [Verification Proof: `pnpm typecheck`, `pnpm build`, `pnpm test` passed 174/174 tests, `git diff --check` passed]
* [Edit safety] `edit` writes `new_string` literally; `$&`-style replacement patterns no longer corrupt files. [Verification Proof: dedicated `$&` literal test]
* [Output caps] bash stdout/stderr truncate at 64 KiB on success and failure, matching `read`. [Verification Proof: bash truncation test]
* [Provider retry] Connection-phase network errors, 429, and 5xx retry with exponential backoff honoring `Retry-After`; started streams never retry; 4xx never retries. [Verification Proof: mock-server retry and no-retry tests]
* [Atomic checkpoints] `saveSession` writes a temp file then renames, so a crash cannot truncate `latest.json`. [Verification Proof: no-temp-file-left test]
* [Usage-calibrated compact] Provider reports `prompt_tokens` via a `usage` StreamChunk (SSE `stream_options.include_usage` and non-SSE JSON); `shouldCompactContext` prefers it over the byte estimate. [Verification Proof: provider usage chunk tests and measured-token policy test]
* [Same-path serialization] `act()` chains write/edit effects that share a target path; distinct paths stay concurrent. [Verification Proof: racy read-modify-write agent test]
* [Paged read] `read` outputs numbered lines and accepts a 1-based `offset`. [Verification Proof: offset paging test]
* [Policy check] `FilesystemPolicy.check` canonicalizes once per check instead of twice. [Verification Proof: full suite green, behavior unchanged]
* [Runtime-owned compact] Compaction executes directly from the lease — no model round-trip, no `compact_context` tool, single commit site in `runContextCompact`. [Verification Proof: rewritten manual/threshold compaction tests]
* [Split compaction] `splitCompactionHistory` summarizes the prefix and keeps a self-contained verbatim tail (`keepRecentMessages`, default 8); reducer commits summary + kept. [Verification Proof: split and kept-tail reducer tests]
* [Persona budget] `buildCompactionTask` truncates oldest prefix messages to fit `compactorTokenLimit`; throws when nothing fits. [Verification Proof: truncation and overflow tests]
* [Pre-compact archive] `savePreCompactArchive` writes `latest.pre-compact.json` atomically via the injected `onBeforeCompact` observer. [Verification Proof: archive observer + session tests]
* [Stale usage reset] `lastPromptTokens` resets at compaction commit; a manual compaction no longer seeds a spurious threshold lease. [Verification Proof: stale-token regression test]

## In Progress

* None

## Blocked

* None

# Lessons Learned (Monadic Abstraction)

## ❌ Anti-patterns & Failed Hypotheses

* **Putting provider settings inside model aliases** — providers need independent reuse and credentials — resolve model alias through a provider registry.
* **Treating host sandbox availability as implementation proof** — `sandbox-exec` exists but the host denies `sandbox_apply` — separate policy generation checks from enforcement checks.
* **Committing effects by completion order** — timing would leak into replay and snapshots — commit in declaration order.
* **Treating cancellation as tool failure** — aborts must become `run_interrupted` — propagate AbortError through the agent boundary.
* **Giving a generic context replace API to tools or personas** — it bypasses reducer authority and creates an undo surface — keep the lease inside Agent memory and expose only a zero-argument direct action to the main agent.

## ✅ Viable Paths & Confirmed Patterns

* **Provider and model separation** — one provider may serve many aliases — model metadata stays independent from credentials.
* **Alias resolution** — main-agent and persona selectors use `resolveModelRef` — both paths send the configured literal model to the provider.
* **Persona boundary** — personas run one completion without tools — the main agent retains execution authority.
* **Reducer-owned invariant repair** — interruption and user-wait transitions synthesize missing tool results — every non-running state remains sendable.
* **Policy-derived sandbox** — writable and denied roots come from FilesystemPolicy — the CLI reports when kernel enforcement is unavailable.
* **Observer checkpointing** — persistence observes transitions — Agent Core stays independent of session storage.
* **Root-preserving compact** — compact only between requests with no dangling calls — reducer can replace the non-system suffix without breaking wire pairing.
* **Runtime-owned compact** — compact persona supplies data, the Agent lease authorizes and directly executes, and the reducer commits State — no one layer crosses the other two boundaries, and no model round-trip sits in the middle.

# Key Decisions & Trade-offs

* **Two-level model registry** — model aliases reference provider aliases — credentials and endpoints are not duplicated for each model.
* **API key non-persistence** — automatic config creation omits keys — plaintext credential leaks are avoided.
* **Single latest session** — one checkpoint file limits storage churn — crash recovery keeps the latest transition only.
* **Irreversible compact** — discard old context after the reducer transition — no undo, revision storage, or restoration UI exists.
* **No overflow bypass** — provider rejection cannot create a lease retroactively — configure capacity metadata and compact before the threshold.

# Immediate Next Steps

* Review and commit the context-compaction rework diff.
