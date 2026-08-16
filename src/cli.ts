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
import { builtinTools } from './tools/index.js'
import { configPath, defaultSystemPrompt, ensureFileConfig, resolveConfig, writeFileConfig, type Config } from './config.js'
import { AgentTui } from './tui/index.js'
import { loadAgentsMd } from './instructions.js'

function parseCliArgs(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string' } as const,
      model: { type: 'string' } as const,
      'api-key': { type: 'string' } as const,
      cwd: { type: 'string' } as const,
      help: { type: 'boolean', short: 'h' } as const,
      init: { type: 'boolean' } as const,
      plain: { type: 'boolean' } as const,
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
    '  --cwd <path>       Working directory for the agent',
    '  --plain            Disable the terminal UI (no animations)',
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
  })
  ensureFileConfig(config)
  const provider = new OpenAIProvider(config)
  const useTui = !values.plain
  const agentsMd = loadAgentsMd(process.cwd())

  // Interactive mode: `pnpm dev` with no prompt drops straight into the TUI,
  // where the prompt is typed in the input box. Model/provider come from the
  // resolved config only — no setup phase.
  if (useTui && !argPrompt) {
    const tui = new AgentTui(config.model, config.baseUrl)
    const agent = new Agent({
      provider,
      tools: builtinTools,
      systemPrompt: defaultSystemPrompt(builtinTools, agentsMd),
      onEvent: (event) => tui.handle(event),
    })
    await tui.startInteractive((prompt) => agent.run(prompt))
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
      tools: builtinTools,
      systemPrompt: defaultSystemPrompt(builtinTools, agentsMd),
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
    tools: builtinTools,
    systemPrompt: defaultSystemPrompt(builtinTools, agentsMd),
  })
  console.log(`mortis: talking to ${config.model} @ ${config.baseUrl}`)
  const answer = await agent.run(prompt)
  console.log(answer)
}

main().catch((error: unknown) => {
  console.error(`mortis: ${(error as Error).message}`)
  process.exit(1)
})