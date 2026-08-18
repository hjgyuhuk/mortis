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
import { createBuiltinTools, askUserTool } from './tools/index.js'
import { configPath, defaultSystemPrompt, ensureFileConfig, resolveConfig, resolveModelRef, writeFileConfig, type Config, type ResolvedModel } from './config.js'
import { AgentTui } from './tui/index.js'
import { findGitRoot, loadAgentsMd } from './instructions.js'
import { hydrateState, latestSession, saveSession, serializeState } from './session.js'
import type { AgentState } from './agent/state.js'
import { FilesystemPolicy, mergeRules, parseRules, type FsRule } from './fs-policy.js'
import { createSandbox } from './sandbox.js'
import { ensureDefaultPersonas, loadPersonas, personaTool, runPersona, type PersonaDefinition } from './persona.js'
import { Scope } from './agent/scope.js'
import { RunInterruptedError } from './agent/loop.js'
import {
  compactionTask,
  resolveInputTokenLimit,
  type ContextRuntime,
} from './context.js'

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
    '  --model <name>     Model alias or literal name (env: MORTIS_MODEL)',
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

function createProvider(model: ResolvedModel, thinkingEffort = model.thinkingEffort): OpenAIProvider {
  return new OpenAIProvider({
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey: model.apiKey,
    thinkingEffort,
  })
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
  ensureDefaultPersonas()
  const mainModel = resolveModelRef(undefined, config)
  const provider = createProvider(mainModel)
  const personas = loadPersonas()
  // Persona model values select the same aliases as the main agent.
  // Frontmatter thinkingEffort remains the most specific override.
  const personaProvider = (persona: PersonaDefinition): OpenAIProvider => {
    const ref = resolveModelRef(persona.model, config)
    return createProvider(ref, persona.thinkingEffort ?? ref.thinkingEffort)
  }
  const compactPersona = personas['compact']
  const context: ContextRuntime | undefined = compactPersona
    ? {
        policy: { maxInputTokens: resolveInputTokenLimit(mainModel) },
        compactor: {
          async compact(history, signal) {
            const result = await runPersona(compactPersona, compactionTask(history), {
              provider: personaProvider(compactPersona),
              signal,
            })
            return result.raw
          },
        },
      }
    : undefined
  // Compact is available only through the main agent's lease-authorized direct
  // effect. It is never an ordinary model-side persona tool.
  const callablePersonas = Object.fromEntries(
    Object.entries(personas).filter(([name]) => name !== 'compact'),
  ) as Record<string, PersonaDefinition>
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
  const systemPromptFor = (toolList: Parameters<typeof defaultSystemPrompt>[0]): string =>
    defaultSystemPrompt(toolList, agentsMd) + '\n\n' + policy.describe() + '\n' + sandboxNote + '\n' + denyNote
  if (sandboxEnabled && !sandbox) {
    console.error('mortis: no OS sandbox available on this platform; bash runs unsandboxed')
  }

  // Session resume + checkpointing: persistence observes state transitions
  // from outside the agent core, so a crash loses at most one transition.
  const resumedState: AgentState | null = values.continue ? hydrateState(latestSession()) : null
  const checkpoint = (state: AgentState): void => {
    saveSession(serializeState(state, mainModel.alias))
  }

  // Interactive mode: `pnpm dev` with no prompt drops straight into the TUI,
  // where the prompt is typed in the input box. Model/provider come from the
  // resolved config only — no setup phase.
  if (useTui && !argPrompt) {
    const tui = new AgentTui(mainModel.displayName ?? mainModel.alias, mainModel.baseUrl, {
      interactive: true,
      resumed: resumedState !== null,
    })
    // Only the interactive TUI can answer questions, so ask_user exists here.
    // Personas are user-editable markdown files under ~/.mortis/persona.
    const interactiveTools = [
      ...tools,
      askUserTool((question, options) => tui.askUser(question, options)),
      personaTool(personaProvider, callablePersonas),
    ]
    const agent = new Agent({
      provider,
      tools: interactiveTools,
      systemPrompt: systemPromptFor(interactiveTools),
      state: resumedState ?? undefined,
      onTransition: checkpoint,
      onEvent: (event) => tui.handle(event),
      context,
    })

    // Slash dispatch: /planner runs the planner persona, then hands the
    // evidence to the main agent. /compact grants the main agent a one-shot
    // direct action; everything else is a normal agent run. Cancellation is
    // unified across all phases.
    let cancelCurrent: (() => void) | null = null
    const runPrompt = async (prompt: string): Promise<string> => {
      if (prompt.trim() === '/compact') {
        cancelCurrent = () => agent.abort('user interrupt')
        try {
          const compacted = await agent.requestContextCompaction()
          if (compacted) return 'Context compacted. Previous context cannot be restored.'
          return context
            ? 'Context has no non-system history to compact.'
            : 'Compact is unavailable because no valid compact persona is loaded.'
        } finally {
          cancelCurrent = null
        }
      }
      if (prompt.startsWith('/planner')) {
        const task = prompt.slice('/planner'.length).trim()
        const planner = personas['planner']
        if (!task) {
          return 'Usage: `/planner <task>` — think the task through with the planner persona, then act on its evidence.'
        }
        if (!planner) {
          return 'No planner persona found. Create `~/.mortis/persona/planner.md` (or delete the folder and restart to restore the default).'
        }
        const scope = new Scope()
        cancelCurrent = () => scope.abort('user interrupt')
        let evidence: string
        try {
          evidence = (
            await runPersona(planner, task, {
              provider: personaProvider(planner),
              signal: scope.signal,
              onEvent: (event) => tui.handle(event),
            })
          ).raw
        } catch (error) {
          // Cancellation of the persona phase maps to the agent-layer term.
          if (error instanceof Error && error.name === 'AbortError') {
            throw new RunInterruptedError('user interrupt')
          }
          throw error
        } finally {
          cancelCurrent = null
        }
        const decision = [
          `The user ran /planner for this task: ${task}`,
          '',
          `Planner evidence (${planner.name}):`,
          '',
          evidence,
          '',
          'You are the main agent; the persona only plans. Proceed in this order:',
          '1. ALWAYS use ask_user first to confirm with the user whether to execute the plan. Never skip this step.',
          '2. If approved, implement it yourself — you write the code; the persona never does.',
          '3. If rejected or revised, adjust: consult the persona again for a revised plan, or gather more information first with your tools.',
        ].join('\n')
        cancelCurrent = () => agent.abort('user interrupt')
        try {
          return await agent.run(decision)
        } finally {
          cancelCurrent = null
        }
      }
      cancelCurrent = () => agent.abort('user interrupt')
      try {
        return await agent.run(prompt)
      } finally {
        cancelCurrent = null
      }
    }
    await tui.startInteractive(runPrompt, { onInterrupt: () => cancelCurrent?.() })
    return
  }

  const prompt = argPrompt || readFileSync(0, 'utf8').trim()
  if (!prompt) {
    console.error(usage())
    process.exit(1)
  }

  if (useTui) {
    const tui = new AgentTui(mainModel.displayName ?? mainModel.alias, mainModel.baseUrl)
    tui.start()
    const agent = new Agent({
      provider,
      tools,
      systemPrompt: systemPromptFor(tools),
      state: resumedState ?? undefined,
      onTransition: checkpoint,
      onEvent: (event) => tui.handle(event),
      context,
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
    systemPrompt: systemPromptFor(tools),
    state: resumedState ?? undefined,
    onTransition: checkpoint,
    context,
  })
  console.log('mortis: talking to ' + (mainModel.displayName ?? mainModel.alias) + ' @ ' + mainModel.baseUrl)
  const answer = await agent.run(prompt)
  console.log(answer)
}

main().catch((error: unknown) => {
  console.error(`mortis: ${(error as Error).message}`)
  process.exit(1)
})
