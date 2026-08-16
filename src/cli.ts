#!/usr/bin/env node
/**
 * CLI entrypoint for Mortis.
 *
 * Parses flags, resolves config, and runs the agent with the built-in tools.
 * The prompt may be passed as an argument or read from stdin.
 */

import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { Agent } from './agent/loop.js'
import { OpenAIProvider } from './provider/openai.js'
import { createBuiltinTools } from './tools/index.js'
import { configPath, defaultSystemPrompt, ensureFileConfig, resolveConfig, writeFileConfig, type Config } from './config.js'
import { AgentTui } from './tui/index.js'
import { findGitRoot, loadAgentsMd } from './instructions.js'
import { hydrateState, latestSession, saveSession, serializeState } from './session.js'
import type { AgentState } from './agent/state.js'
import { FilesystemPolicy, mergeRules, parseRules, type FsRule } from './fs-policy.js'
import { createSandbox } from './sandbox.js'

function parseCliArgs(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string' } as const,
      model: { type: 'string' } as const,
      'api-key': { type: 'string' } as const,
      'thinking-effort': { type: 'string' } as const,
      cwd: { type: 'string' } as const,
      help: { type: 'boolean', short: 'h' } as const,
      init: { type: 'boolean' } as const,
      plain: { type: 'boolean' } as const,
      continue: { type: 'boolean' } as const,
      scratch: { type: 'string' } as const,
      'fs-rw': { type: 'string', multiple: true } as const,
      'fs-r': { type: 'string', multiple: true } as const,
      'fs-deny': { type: 'string', multiple: true } as const,
      'no-sandbox': { type: 'boolean' } as const,
    },
    allowPositionals: true,
  })
  return { values: parsed.values, prompt: positionalsOf(parsed) }
}

function positionalsOf(parsed: { positionals: string[] }): string {
  return parsed.positionals.join(' ')
}

function usage(): string {
  return [
    'Usage: mortis [options] <prompt>',
    '       mortis --init',
    '',
    'Run the Mortis coding agent.',
    'With no prompt, opens the interactive TUI and reads the prompt in the input box.',
    'With no prompt and --plain, reads it from stdin.',
    '',
    'Options:',
    '  --base-url <url>   OpenAI-compatible base URL (env: MORTIS_BASE_URL)',
    '  --model <name>     Model name (env: MORTIS_MODEL)',
    '  --api-key <key>    API key (env: MORTIS_API_KEY)',
    '  --thinking-effort <level>  Reasoning effort, sent as thinking_effort (env: MORTIS_THINKING_EFFORT)',
    '  --cwd <path>       Working directory for the agent',
    '  --plain            Disable the terminal UI (no animations)',
    '  --continue         Resume the latest saved session (~/.mortis/sessions/latest.json)',
    '  --scratch <dir>    Scratch directory (rw zone; default /tmp)',
    '  --fs-rw <dir>      Grant read/write on a directory (repeatable)',
    '  --fs-r <dir>       Grant read-only on a directory (repeatable)',
    '  --fs-deny <dir>    Deny all access on a directory (repeatable)',
    '  --no-sandbox       Disable the OS sandbox for bash (dangerous)',
    '  --init             Write a config file to ~/.mortis/config.json',
    '  -h, --help         Show this help',
  ].join('\n')
}

async function main() {
  const { values, prompt: argPrompt } = parseCliArgs(process.argv.slice(2))

  if (values.cwd) {
    process.chdir(values.cwd)
  }

  if (values.help) {
    console.log(usage())
    return
  }

  if (values.init) {
    const overrides = {
      baseUrl: values['base-url'] ?? process.env.MORTIS_BASE_URL,
      model: values.model ?? process.env.MORTIS_MODEL,
      apiKey: values['api-key'] ?? process.env.MORTIS_API_KEY,
      thinkingEffort: values['thinking-effort'] ?? process.env.MORTIS_THINKING_EFFORT,
    }
    writeFileConfig(
      Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) as Partial<Config>,
    )
    console.log(`wrote ${configPath()}`)
    return
  }

  const config = resolveConfig({
    baseUrl: values['base-url'],
    model: values.model,
    apiKey: values['api-key'],
    thinkingEffort: values['thinking-effort'],
  })
  ensureFileConfig(config)
  const provider = new OpenAIProvider(config)
  const useTui = !values.plain
  const agentsMd = loadAgentsMd(process.cwd())

  // Filesystem policy: workspace = git root, scratch = /tmp (configurable),
  // custom rules from config + CLI override everything.
  const cliRules: FsRule[] = [
    ...(values['fs-rw'] ?? []).map((path) => ({ path, access: 'rw' as const })),
    ...(values['fs-r'] ?? []).map((path) => ({ path, access: 'r' as const })),
    ...(values['fs-deny'] ?? []).map((path) => ({ path, access: 'deny' as const })),
  ]
  const policy = new FilesystemPolicy({
    workspaceRoot: findGitRoot(process.cwd()) ?? process.cwd(),
    scratchRoot: values.scratch ?? config.filesystem?.scratchDir,
    rules: mergeRules(parseRules(config.filesystem?.rules), cliRules),
  })
  const sandboxEnabled = values['no-sandbox'] ? false : (config.filesystem?.sandbox ?? true)
  const sandbox = createSandbox(policy, sandboxEnabled)
  const tools = createBuiltinTools(policy, sandbox)
  const sandboxNote = sandbox
    ? 'Shell commands run inside an OS sandbox: writes are confined to the writable directories above and denied directories are unreadable.'
    : 'WARNING: shell commands are NOT sandboxed — the filesystem policy does not constrain them.'
  const denyNote =
    'If an operation is denied by the filesystem policy or the sandbox ("permission denied" / "Operation not permitted"), ' +
    'do not retry it or attempt workarounds — stop immediately and report the failure and its reason to the user.'
  const systemPrompt =
    defaultSystemPrompt(tools, agentsMd) + '\n\n' + policy.describe() + '\n' + sandboxNote + '\n' + denyNote
  if (sandboxEnabled && !sandbox) {
    console.error('mortis: no OS sandbox available on this platform; bash runs unsandboxed')
  }

  // Session resume + checkpointing: persistence observes state transitions
  // from outside the agent core, so a crash loses at most one transition.
  const resumedState: AgentState | null = values.continue ? hydrateState(latestSession()) : null
  const checkpoint = (state: AgentState): void => {
    saveSession(serializeState(state, config.model))
  }

  // Interactive mode: `pnpm dev` with no prompt drops straight into the TUI,
  // where the prompt is typed in the input box. Model/provider come from the
  // resolved config only — no setup phase.
  if (useTui && !argPrompt) {
    const tui = new AgentTui(config.model, config.baseUrl, {
      interactive: true,
      resumed: resumedState !== null,
    })
    const agent = new Agent({
      provider,
      tools,
      systemPrompt,
      state: resumedState ?? undefined,
      onTransition: checkpoint,
      onEvent: (event) => tui.handle(event),
    })
    await tui.startInteractive(
      (prompt) => agent.run(prompt),
      { onInterrupt: () => agent.abort('user interrupt') },
    )
    return
  }

  const prompt = argPrompt || readFileSync(0, 'utf8').trim()
  if (!prompt) {
    console.error(usage())
    process.exit(1)
  }

  if (useTui) {
    const tui = new AgentTui(config.model, config.baseUrl)
    tui.start()
    const agent = new Agent({
      provider,
      tools,
      systemPrompt,
      state: resumedState ?? undefined,
      onTransition: checkpoint,
      onEvent: (event) => tui.handle(event),
    })
    try {
      const answer = await agent.run(prompt)
      tui.finish(answer)
    } finally {
      tui.stop()
    }
    return
  }

  const agent = new Agent({
    provider,
    tools,
    systemPrompt,
    state: resumedState ?? undefined,
    onTransition: checkpoint,
  })
  console.log(`mortis: talking to ${config.model} @ ${config.baseUrl}`)
  const answer = await agent.run(prompt)
  console.log(answer)
}

main().catch((error: unknown) => {
  console.error(`mortis: ${(error as Error).message}`)
  process.exit(1)
})