/**
 * Built-in tools for the coding agent: read, write, edit, bash.
 *
 * Each tool is created from a FilesystemPolicy and enforces it on every
 * path it touches: read/write/edit are strict; bash only checks its working
 * directory (arbitrary shell cannot be path-constrained — no sandbox).
 * Denials are returned as text to the model, never thrown.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { Tool } from '../types.js'
import { FilesystemPolicy, openPolicy, type PolicyDecision } from '../fs-policy.js'
import type { SandboxRunner } from '../sandbox.js'

const execFileAsync = promisify(execFile)

/** Cap tool output so a single call cannot flood the model's context. */
const READ_MAX_CHARS = 64 * 1024

/** Truncate any tool output to the same cap, with a visible notice. */
function truncateOutput(text: string, max = READ_MAX_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... (truncated: showing the first ${max} of ${text.length} characters)`
}

/** Default shell command timeout, in seconds. */
const BASH_DEFAULT_TIMEOUT_S = 120
const BASH_MAX_TIMEOUT_S = 600

/** Reject with a standard AbortError when the signal fires first. */
function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abortError = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) {
      abortError()
      return
    }
    signal.addEventListener('abort', abortError)
    const settle = (callback: () => void) => {
      signal.removeEventListener('abort', abortError)
      callback()
    }
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    )
  })
}

/** Denial text for the model. */
function deny(decision: PolicyDecision): string {
  return `error: ${decision.reason ?? 'permission denied'}`
}

/** Read a file's contents as numbered lines, paged by offset. */
export function readTool(policy: FilesystemPolicy): Tool {
  return {
    name: 'read',
    description:
      'Read a file as numbered lines (line-number prefix per line). Pass offset (1-based line) to page ' +
      'through large files. Output is truncated beyond 64 KiB. Denied paths are rejected.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
        offset: { type: 'number', description: '1-based line number to start reading from (default 1).' },
      },
      required: ['path'],
    },
    async execute(args) {
      const path = String(args.path)
      const decision = policy.check(path, 'read')
      if (!decision.allowed) return deny(decision)
      try {
        const content = await readFile(path, 'utf8')
        const startLine = Math.max(Math.floor(Number(args.offset ?? 1)) || 1, 1)
        const lines = content.split('\n').slice(startLine - 1)
        const width = String(lines.length).length
        const numbered = lines
          .map((line, index) => `${String(startLine + index).padStart(width)}\t${line}`)
          .join('\n')
        return truncateOutput(numbered)
      } catch (error) {
        return `error reading ${path}: ${(error as Error).message}`
      }
    },
  }
}

/** Write a file, overwriting any existing content. */
export function writeTool(policy: FilesystemPolicy): Tool {
  return {
    name: 'write',
    description:
      'Write content to a file, overwriting it. Only allowed inside the workspace, scratch, or custom rw directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        content: { type: 'string', description: 'The full content to write.' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const path = String(args.path)
      const content = String(args.content)
      const decision = policy.check(path, 'write')
      if (!decision.allowed) return deny(decision)
      try {
        await writeFile(path, content, 'utf8')
        return `wrote ${path} (${content.length} bytes)`
      } catch (error) {
        return `error writing ${path}: ${(error as Error).message}`
      }
    },
  }
}

/** Apply a string replacement to a file. The match must be unique. */
export function editTool(policy: FilesystemPolicy): Tool {
  return {
    name: 'edit',
    description:
      'Replace an exact string in a file with a new string. The old_string must appear exactly once. Writable zones only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit.' },
        old_string: { type: 'string', description: 'The exact text to find.' },
        new_string: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(args) {
      const path = String(args.path)
      const oldString = String(args.old_string)
      const newString = String(args.new_string)
      const decision = policy.check(path, 'write')
      if (!decision.allowed) return deny(decision)
      try {
        const content = await readFile(path, 'utf8')
        const matches = content.split(oldString).length - 1
        if (matches === 0) {
          return `error: old_string not found in ${path}`
        }
        if (matches > 1) {
          return `error: old_string matches ${matches} times in ${path}; add surrounding context to make it unique`
        }
        // A function replacement keeps `$&` and friends in newString literal.
        const updated = content.replace(oldString, () => newString)
        await writeFile(path, updated, 'utf8')
        return `edited ${path}`
      } catch (error) {
        return `error editing ${path}: ${(error as Error).message}`
      }
    },
  }
}

/** Run a shell command and capture its output. Commands time out. */
export function bashTool(policy: FilesystemPolicy, sandbox?: SandboxRunner | null): Tool {
  return {
    name: 'bash',
    description: sandbox
      ? 'Run a shell command and return its stdout and stderr. Runs inside an OS sandbox: writes are confined to writable directories and denied directories are unreadable.'
      : 'Run a shell command and return its stdout and stderr. Not sandboxed: only the working directory is checked against denied paths.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: "Working directory; defaults to the agent's working directory." },
        timeout: { type: 'number', description: `Timeout in seconds (default ${BASH_DEFAULT_TIMEOUT_S}, max ${BASH_MAX_TIMEOUT_S}).` },
      },
      required: ['command'],
    },
    async execute(args, context?) {
      const command = String(args.command)
      const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd()
      const cwdDecision = policy.check(cwd, 'read')
      if (!cwdDecision.allowed) return deny(cwdDecision)
      const timeoutS = Math.min(
        Math.max(Number(args.timeout ?? BASH_DEFAULT_TIMEOUT_S) || BASH_DEFAULT_TIMEOUT_S, 1),
        BASH_MAX_TIMEOUT_S,
      )
      const exec = sandbox ? sandbox.wrap(command) : { file: '/bin/sh', args: ['-c', command] }
      try {
        const { stdout, stderr } = await execFileAsync(exec.file, exec.args, {
          cwd,
          timeout: timeoutS * 1000,
          maxBuffer: 10 * 1024 * 1024,
          signal: context?.signal,
        })
        const parts = [stdout, stderr].filter(Boolean)
        return truncateOutput(parts.join('\n')) || '(no output)'
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message: string }
        const output = truncateOutput([e.stdout, e.stderr].filter(Boolean).join(''))
        return truncateOutput(`command failed: ${e.message}\n${output}`)
      }
    },
  }
}

/** All built-in tools, bound to the given policy (and optional sandbox). */
export function createBuiltinTools(policy: FilesystemPolicy, sandbox?: SandboxRunner | null): Tool[] {
  return [readTool(policy), writeTool(policy), editTool(policy), bashTool(policy, sandbox)]
}

/** Permissive default (everything read-write); the CLI always builds a real policy. */
export const builtinTools: Tool[] = createBuiltinTools(openPolicy())

/** Default choices shown in the ask-user dialog. */
export const DEFAULT_ASK_OPTIONS = ['Approve', 'Reject', 'Revise']

/**
 * Ask the user a question via a dialog (Approve / Reject / Revise).
 * Blocks until the user answers; cancelling the run aborts with a standard
 * AbortError so the run_interrupted transition applies.
 */
export function askUserTool(ask: (question: string, options: string[]) => Promise<string>): Tool {
  return {
    name: 'ask_user',
    description:
      'Ask the user a question in a dialog with selectable options (default Approve/Reject/Revise). ' +
      'Use it before risky or ambiguous actions, or when instructions are unclear. ' +
      'On Revise, end the run with a brief status: the user will send a corrected instruction next.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to show (markdown supported).' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional custom choice labels.',
        },
      },
      required: ['question'],
    },
    async execute(args, context?) {
      const question = String(args.question ?? '')
      const options = Array.isArray(args.options) ? args.options.map(String) : [...DEFAULT_ASK_OPTIONS]
      const choice = await raceWithSignal(ask(question, options), context?.signal)
      if (choice === 'Revise') {
        return 'User chose: Revise. End this run with a brief status; they will send a corrected instruction next.'
      }
      return `User chose: ${choice}.`
    },
  }
}
